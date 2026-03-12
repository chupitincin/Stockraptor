# StockRaptor — Setup & Deployment Guide
**Time to launch: ~30 minutes**

---

## What you have

```
stockraptor-app/
├── index.html                    ← Landing + Login + Register + Pricing
├── scanner.html                  ← The scanner (protected, login required)
├── supabase-setup.sql            ← Run once in Supabase to create the DB
├── netlify/
│   └── functions/
│       └── stripe.js             ← Handles Stripe payments (runs on server)
└── SETUP.md                      ← This file
```

---

## STEP 1 — Supabase (database + login)
**Time: ~5 min | Cost: Free**

1. Go to **supabase.com** → Create account → New project
2. Choose a name (e.g. `stockraptor`) and a strong database password → Create
3. Wait ~2 minutes for the project to be ready
4. Go to **SQL Editor** (left sidebar) → **New Query**
5. Copy the entire contents of `supabase-setup.sql` → Paste → **Run**
6. Go to **Settings → API** and copy:
   - `Project URL`  → this is your `SUPABASE_URL`
   - `anon public` key → this is your `SUPABASE_ANON_KEY`
   - `service_role` key → this is your `SUPABASE_SERVICE_KEY` ⚠️ keep secret

---

## STEP 2 — Stripe (payments)
**Time: ~10 min | Cost: 1.5% per transaction, no monthly fee**

1. Log in to **dashboard.stripe.com**
2. Go to **Products** → **Add product**
3. Create **Pro Plan**:
   - Name: `StockRaptor Pro`
   - Pricing: Recurring · $19/month
   - Copy the **Price ID** (starts with `price_...`) → `STRIPE_PRO_PRICE_ID`
4. Create **Elite Plan**:
   - Name: `StockRaptor Elite`
   - Pricing: Recurring · $49/month
   - Copy the **Price ID** → `STRIPE_ELITE_PRICE_ID`
5. Go to **Developers → API Keys** and copy:
   - `Publishable key` → not needed (handled server-side)
   - `Secret key` → `STRIPE_SECRET_KEY` ⚠️ keep secret
6. Go to **Developers → Webhooks** → Add endpoint:
   - URL: `https://YOUR-SITE.netlify.app/.netlify/functions/stripe/webhook`
   - Events to listen: `checkout.session.completed`, `customer.subscription.deleted`
   - Copy **Signing secret** → `STRIPE_WEBHOOK_SECRET`

---

## STEP 3 — Configure the files
**Time: ~5 min**

### In `index.html` — find the CONFIG block (line ~60):
```javascript
const CONFIG = {
  supabaseUrl:  'YOUR_SUPABASE_URL',         // ← paste Project URL
  supabaseKey:  'YOUR_SUPABASE_ANON_KEY',    // ← paste anon key
  stripeProPriceId:   'price_xxxxx',         // ← paste Pro price ID
  stripeElitePriceId: 'price_xxxxx',         // ← paste Elite price ID
  netlifyFnUrl: '/.netlify/functions/stripe', // ← leave as-is
};
```

### In `scanner.html` — find the CONFIG block (near top of file):
```javascript
const CONFIG = {
  supabaseUrl: 'YOUR_SUPABASE_URL',       // ← paste Project URL
  supabaseKey: 'YOUR_SUPABASE_ANON_KEY',  // ← paste anon key
};
```

---

## STEP 4 — Deploy to Netlify
**Time: ~5 min | Cost: Free**

1. Go to **netlify.com** → Log in / Create account
2. From the dashboard: **Add new site → Deploy manually**
3. Drag the entire `stockraptor-app/` folder into the drop zone
4. Netlify will give you a URL like `https://random-name.netlify.app`

### Set environment variables (for the Stripe function):
5. Go to **Site configuration → Environment variables → Add variable**:

| Key | Value |
|-----|-------|
| `STRIPE_SECRET_KEY` | sk_live_... |
| `STRIPE_WEBHOOK_SECRET` | whsec_... |
| `SUPABASE_URL` | https://xxx.supabase.co |
| `SUPABASE_SERVICE_KEY` | eyJ... (service_role key) |
| `URL` | https://your-site.netlify.app |

6. **Trigger a redeploy** (Deploys → Trigger deploy) for env vars to take effect

### Update the Stripe webhook URL:
7. Go back to Stripe → Webhooks → update the endpoint URL with your real Netlify URL

---

## STEP 5 — Custom domain (optional)
**Time: ~10 min | Cost: ~$10-15/year for the domain**

1. Buy `stockraptor.com` or `stockraptor.io` on **namecheap.com**
2. In Netlify → **Domain management → Add custom domain**
3. Follow the DNS instructions Netlify gives you
4. SSL/HTTPS is automatic and free

---

## STEP 6 — Test everything

| Test | Expected result |
|------|----------------|
| Visit your site | Landing page loads |
| Click "Create Free Account" | Auth modal opens |
| Register with email | Confirmation email sent |
| Confirm email + log in | Dashboard shows, plan = FREE |
| Click "Open Scanner" | Scanner opens with 40 companies |
| Click "Upgrade to Pro" | Redirects to Stripe checkout |
| Complete test payment | Plan updates to PRO, scanner unlocks 200 companies |

### Stripe test cards:
- ✅ Success: `4242 4242 4242 4242` · any future date · any CVC
- ❌ Decline: `4000 0000 0000 0002`

---

## Plan limits summary

| Plan | Companies | Features |
|------|-----------|----------|
| Free | 40 | Manual scan, all 14 factors |
| Pro ($19/mo) | 200 | + AI summaries, daily digest |
| Elite ($49/mo) | 400+ | + AI chat, 2× daily, priority support |

---

## Need help?

The most common issues:
- **Stripe webhook 400 error** → check `STRIPE_WEBHOOK_SECRET` env var is correct
- **Login not working** → check Supabase URL and anon key in CONFIG
- **Scanner shows "not logged in"** → confirm email via the link Supabase sends
- **Functions not deploying** → make sure the `netlify/functions/` folder structure is inside the uploaded folder

---

*StockRaptor · Not financial advice · Educational use only*
