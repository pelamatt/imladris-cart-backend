// server.js — Softr × Airtable × Stripe Cart Backend
// ---------------------------------------------------
// Exposes:
//   POST /api/cart/price
//   POST /api/checkout/create
//   GET  /api/checkout/link     // NEW (redirects straight to Stripe)
//   POST /api/stripe/webhook
//   GET  /api/health
//
// Env vars required (set in your host):
//   STRIPE_SECRET_KEY=sk_test_...
//   STRIPE_WEBHOOK_SECRET=whsec_...   // add after creating your webhook endpoint
//   AIRTABLE_API_KEY=pat_...
//   AIRTABLE_BASE_ID=appXXXXXXXXXXXXXX
//   AIRTABLE_PRODUCTS_TABLE=Products
//   AIRTABLE_ORDERS_TABLE=Orders
//   AIRTABLE_ORDER_ITEMS_TABLE=OrderItems
//   AIRTABLE_SHIPPING_TABLE=ShippingRates
//   SITE_URL=https://imladrisarchives.com
//   HOLD_MINUTES=30
//
// NOTE: If hosting on a separate domain from Softr, restrict CORS below.

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import bodyParser from 'body-parser';
import Airtable from 'airtable';

const app = express();
const port = process.env.PORT || 8787;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-07-30.basil' });

// Use JSON for normal routes; raw body for webhook verification
app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/api/stripe/webhook')) {
    next();
  } else {
    express.json({ limit: '1mb' })(req, res, next);
  }
});

// TODO: in production, change origin to your Softr domain only, e.g. 'https://imladrisarchives.com'
app.use(cors({ origin: true }));

// Airtable setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const T = {
  products: process.env.AIRTABLE_PRODUCTS_TABLE || 'Products',
  orders: process.env.AIRTABLE_ORDERS_TABLE || 'Orders',
  items: process.env.AIRTABLE_ORDER_ITEMS_TABLE || 'OrderItems',
  shipping: process.env.AIRTABLE_SHIPPING_TABLE || 'ShippingRates',
};

// Helpers
const HOLD_MINUTES = Number(process.env.HOLD_MINUTES || 30);
const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);

async function fetchProductsByIds(ids) {
  if (!ids?.length) return [];
  const formula = `OR(${ids.map(id => `RECORD_ID() = '${id}'`).join(',')})`;
  const records = await base(T.products).select({ filterByFormula: formula, maxRecords: ids.length }).all();
  return records.map(r => ({
    id: r.id,
    Name: r.get('Name'),
    Price: Number(r.get('Price (cents)') || 0), // cents
    Currency: r.get('Currency') || 'usd',
    SKU: r.get('SKU'),
    Quantity: Number(r.get('Quantity') || 1),
    Status: r.get('Status') || 'Available',
    ShippingTier: r.get('Shipping Tier') || 'Tube-M',
    Image: (r.get('Images')?.[0]?.url) || null,
  }));
}

async function getShippingRate(tier, country) {
  const formula = `AND({Tier} = '${tier}', {Country} = '${country}')`;
  const [rec] = await base(T.shipping).select({ filterByFormula: formula, maxRecords: 1 }).all();
  if (!rec) return null;
  return {
    amount: Number(rec.get('Amount (cents)') || 0),
    label: rec.get('Label') || `${tier} shipping`,
  };
}

function consolidateShippingTiers(items) {
  const tiers = items.map(i => i.ShippingTier).filter(Boolean);
  const hasFlat = tiers.some(t => /Flat/i.test(t));
  const tubeOrder = ['Tube-S', 'Tube-M', 'Tube-L', 'Tube-XL'];
  const tubes = tiers.filter(t => t.startsWith('Tube'));
  let largestTube = null;
  for (let i = tubeOrder.length - 1; i >= 0; i--) {
    if (tubes.includes(tubeOrder[i])) { largestTube = tubeOrder[i]; break; }
  }
  const needed = [];
  if (largestTube) needed.push(largestTube);
  if (hasFlat) needed.push('FlatPack');
  return needed;
}

function validateAndMerge(cart, products) {
  const out = [];
  const notFound = [];
  const outOfStock = [];
  for (const ci of cart) {
    const p = products.find(x => x.id === ci.id);
    if (!p) { notFound.push(ci.id); continue; }
    const qty = Math.max(1, Number(ci.qty || 1));
    if (p.Status !== 'Available' || p.Quantity < qty) {
      outOfStock.push({ id: p.id, name: p.Name });
      continue;
    }
    out.push({ ...p, qty });
  }
  return { items: out, notFound, outOfStock };
}

async function placeHolds(items) {
  const holdUntil = addMinutes(new Date(), HOLD_MINUTES).toISOString();
  const updates = items.map(i => ({ id: i.id, fields: { Status: 'On Hold', HoldUntil: holdUntil } }));
  for (let i = 0; i < updates.length; i += 10) {
    await base(T.products).update(updates.slice(i, i + 10));
  }
  return holdUntil;
}

async function releaseHoldsByIds(ids) {
  if (!ids.length) return;
  const updates = ids.map(id => ({ id, fields: { Status: 'Available', HoldUntil: null } }));
  for (let i = 0; i < updates.length; i += 10) {
    await base(T.products).update(updates.slice(i, i + 10));
  }
}

async function markSold(items, orderId) {
  const updates = items.map(i => ({ id: i.id, fields: { Status: 'Sold', Quantity: 0, SoldInOrder: [orderId] } }));
  for (let i = 0; i < updates.length; i += 10) {
    await base(T.products).update(updates.slice(i, i + 10));
  }
}

/* -----------------------------
   SHARED CHECKOUT HELPER (NEW)
------------------------------*/
async function createCheckoutFromCart(cart, country = 'US', customer_email) {
  const ids = cart.map(c => c.id);
  const products = await fetchProductsByIds(ids);
  const { items, outOfStock } = validateAndMerge(cart, products);
  if (outOfStock.length) return { error: 'out_of_stock', outOfStock };

  const holdUntil = await placeHolds(items);

  const line_items = items.map(i => ({
    price_data: {
      currency: i.Currency || 'usd',
      product_data: { name: i.Name, metadata: { airtable_id: i.id, sku: i.SKU } },
      unit_amount: i.Price,
    },
    quantity: i.qty,
  }));

  const neededTiers = consolidateShippingTiers(items);
  const shipping_options = [];
  for (const tier of neededTiers) {
    const rate = await getShippingRate(tier, country);
    if (rate) {
      shipping_options.push({
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: rate.amount, currency: items[0]?.Currency || 'usd' },
          display_name: rate.label,
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 3 },
            maximum: { unit: 'business_day', value: 10 },
          },
        },
      });
    }
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email,
    allow_promotion_codes: true,
    shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'IE', 'FR', 'DE', 'ES', 'IT', 'AU', 'NZ'] },
    shipping_options,
    automatic_tax: { enabled: true },
    line_items,
    success_url: `${process.env.SITE_URL}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.SITE_URL}/cart?canceled=1`,
    metadata: {
      airtable_ids: items.map(i => i.id).join(','),
      hold_until: holdUntil,
    },
  });

  return { url: session.url };
}

// ----- Routes -----

// Price endpoint — returns trusted totals
app.post('/api/cart/price', async (req, res) => {
  try {
    const { items: cart, country = 'US' } = req.body || {};
    if (!Array.isArray(cart) || cart.length === 0) return res.json({ items: [], subtotal: 0, shipping: 0, total: 0, currency: 'usd' });
    const ids = cart.map(c => c.id);
    const products = await fetchProductsByIds(ids);
    const { items, notFound, outOfStock } = validateAndMerge(cart, products);
    const currency = items[0]?.Currency || 'usd';
    const subtotal = items.reduce((s, p) => s + p.Price * p.qty, 0);

    const neededTiers = consolidateShippingTiers(items);
    let shipping = 0; let shippingBreakdown = [];
    for (const tier of neededTiers) {
      const rate = await getShippingRate(tier, country);
      if (rate) { shipping += rate.amount; shippingBreakdown.push({ tier, ...rate }); }
    }

    return res.json({
      items: items.map(i => ({ id: i.id, name: i.Name, price: i.Price, qty: i.qty, sku: i.SKU, image: i.Image, tier: i.ShippingTier })),
      notFound, outOfStock,
      subtotal, shipping, total: subtotal + shipping, currency, shippingBreakdown
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'pricing_failed' });
  }
});

// Checkout Session creation (reuses helper)
app.post('/api/checkout/create', async (req, res) => {
  try {
    const { items: cart, customer_email, country = 'US' } = req.body || {};
    if (!Array.isArray(cart) || cart.length === 0) return res.status(400).json({ error: 'empty_cart' });

    const out = await createCheckoutFromCart(cart, country, customer_email);
    if (out.error) return res.status(409).json(out);
    return res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'session_failed' });
  }
});

// NEW: simple link endpoint for Softr "Open URL" buttons
// Example: GET /api/checkout/link?id=recXXXX&qty=1&country=US&email=jenny%40example.com
app.get('/api/checkout/link', async (req, res) => {
  try {
    const id = req.query.id;
    const qty = Math.max(1, Number(req.query.qty || 1));
    const country = (req.query.country || 'US').toUpperCase();
    const email = req.query.email;
    if (!id) return res.status(400).send('missing id');

    const out = await createCheckoutFromCart([{ id, qty }], country, email);
    if (out.error === 'out_of_stock') {
      return res.redirect(`${process.env.SITE_URL}/sold-out`);
    }
    if (!out.url) return res.status(500).send('session_failed');

    return res.redirect(out.url);
  } catch (e) {
    console.error(e);
    res.status(500).send('link_error');
  }
});

// Stripe Webhook
app.post('/api/stripe/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const ids = (session.metadata?.airtable_ids || '').split(',').filter(Boolean);

      // Create Order in Airtable
      const order = await base(T.orders).create({
        Status: 'Paid',
        StripeSessionId: session.id,
        Email: session.customer_details?.email || session.customer_email,
        Currency: session.currency?.toUpperCase() || 'USD',
        AmountTotal: session.amount_total || 0,
        ShippingName: session.customer_details?.name || '',
        ShippingCountry: session.customer_details?.address?.country || '',
        ShippingCity: session.customer_details?.address?.city || '',
        ShippingPostal: session.customer_details?.address?.postal_code || '',
        ShippingLine1: session.customer_details?.address?.line1 || '',
        ShippingLine2: session.customer_details?.address?.line2 || '',
      });

      const orderId = order.id;

      // Fetch items for context (optional)
      const productRecords = await fetchProductsByIds(ids);

      // Create OrderItems & mark products Sold
      const orderItemCreates = productRecords.map((p) => ({
        fields: {
          Order: [orderId],
          Product: [p.id],
          Name: p.Name,
          SKU: p.SKU,
          Price: p.Price,
          Qty: 1,
        }
      }));
      for (let i = 0; i < orderItemCreates.length; i += 10) {
        await base(T.items).create(orderItemCreates.slice(i, i + 10));
      }

      await markSold(productRecords, orderId);
    }

    if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed' || event.type === 'payment_intent.payment_failed') {
      const session = event.data.object;
      const ids = (session.metadata?.airtable_ids || '').split(',').filter(Boolean);
      await releaseHoldsByIds(ids);
    }

    res.json({ received: true });
  } catch (e) {
    console.error('Webhook handling error', e);
    res.status(500).send('webhook_error');
  }
});

app.get('/api/health', (_req, res) => res.send('ok'));

app.listen(port, () => console.log(`Cart backend running on :${port}`));
