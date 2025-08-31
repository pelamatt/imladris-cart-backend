# Softr × Airtable × Stripe — Cart Backend (Deploy on Render/Vercel)
This is the Node/Express backend that powers your Softr cart + Stripe checkout.

## Endpoints
- `POST /api/cart/price` — returns trusted totals (subtotal, shipping, total)
- `POST /api/checkout/create` — creates a Stripe Checkout Session and places hold on items
- `POST /api/stripe/webhook` — Stripe webhook receiver (set this URL in the Stripe dashboard)
- `GET  /api/health` — health check

## Required environment variables
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...           # add after creating the webhook endpoint
AIRTABLE_API_KEY=pat_...
AIRTABLE_BASE_ID=appXXXXXXXXXXXXXX
AIRTABLE_PRODUCTS_TABLE=Products
AIRTABLE_ORDERS_TABLE=Orders
AIRTABLE_ORDER_ITEMS_TABLE=OrderItems
AIRTABLE_SHIPPING_TABLE=ShippingRates
SITE_URL=https://imladrisarchives.com
HOLD_MINUTES=30
```

## Quick start locally
```
npm install
# put env vars above in a .env or export them in your shell
node server.js
# health check
curl http://localhost:8787/api/health
```

For webhooks locally:
```
stripe login
stripe listen --forward-to http://localhost:8787/api/stripe/webhook
# copy the printed whsec_... into STRIPE_WEBHOOK_SECRET and restart node
```

## Deploy to Render (recommended quick host)
1. Push these files to a new GitHub repo.
2. In Render → New → Web Service → connect repo.
3. Build: `npm install` — Start: `node server.js`
4. Add the environment variables above (leave STRIPE_WEBHOOK_SECRET blank for now).
5. Deploy. Note the assigned URL, e.g. `https://ia-cart.onrender.com`.
6. In Stripe Dashboard → Developers → Webhooks → + Add destination:
   - Endpoint URL: `https://ia-cart.onrender.com/api/stripe/webhook`
   - Events: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_failed` (optional `payment_intent.payment_failed`)
   - Save, reveal the Signing secret (`whsec_...`).
7. Paste the `whsec_...` into Render env as STRIPE_WEBHOOK_SECRET and redeploy.
8. Test `Send test event` from Stripe (expect HTTP 200).

## CORS
If your frontend runs at `https://imladrisarchives.com`, restrict CORS:
Edit `server.js` line with `cors({ origin: true })` to:
```
app.use(cors({ origin: ['https://imladrisarchives.com'] }));
```

## Softr front-end
Set `API_BASE` in your cart.js to your backend base:
```
const API_BASE = 'https://ia-cart.onrender.com/api'
```
