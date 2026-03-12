// netlify/functions/stripe.js
// Handles: create checkout session + webhook confirmation
// Deploy to Netlify — never runs in the browser

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const path = event.path.replace('/.netlify/functions/stripe', '');

  // ── CREATE CHECKOUT SESSION ──────────────────────────────
  if (event.httpMethod === 'POST' && path === '/create-checkout') {
    try {
      const { priceId, userId, userEmail, plan } = JSON.parse(event.body);

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        customer_email: userEmail,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${process.env.URL}/scanner.html?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
        cancel_url: `${process.env.URL}/?canceled=true`,
        metadata: { userId, plan },
        subscription_data: {
          metadata: { userId, plan }
        }
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ url: session.url })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message })
      };
    }
  }

  // ── STRIPE WEBHOOK (subscription confirmed) ──────────────
  if (event.httpMethod === 'POST' && path === '/webhook') {
    const sig = event.headers['stripe-signature'];
    let stripeEvent;

    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return { statusCode: 400, headers, body: `Webhook Error: ${err.message}` };
    }

    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan;

      // Update Supabase user plan
      if (userId && plan) {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_KEY
        );
        await supabase
          .from('profiles')
          .update({
            plan,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            plan_expires_at: null // active subscription, no expiry
          })
          .eq('id', userId);
      }
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      const sub = stripeEvent.data.object;
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );
      await supabase
        .from('profiles')
        .update({ plan: 'free' })
        .eq('stripe_subscription_id', sub.id);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
  }

  return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
};
