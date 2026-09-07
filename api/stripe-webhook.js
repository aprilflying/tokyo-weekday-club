/**
 * POST /api/stripe-webhook
 *
 * Stripe calls this. Two events matter:
 *
 *  checkout.session.completed (mode=setup)
 *      The parent has saved a card. We:
 *        1. make that card the customer's default for invoices
 *        2. create ONE DRAFT INVOICE PER WEEK booked, so you can charge
 *           exactly the weeks that reach 3 children and leave the rest
 *        3. mark the sheet row "card saved"
 *
 *  invoice.paid
 *      A week has been charged. Mark the sheet row "paid" and note the week.
 *
 * Drafts never charge on their own (auto_advance is off). You finalise a
 * draft in the Dashboard when its class is confirmed; Stripe then charges
 * the saved card and emails the receipt.
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY       sk_live_… or sk_test_…
 *   STRIPE_WEBHOOK_SECRET   whsec_… from Developers → Webhooks → this endpoint
 *   SHEET_URL               the Apps Script /exec URL
 *   SHEET_TOKEN             SHARED_TOKEN from Code.gs
 */

import Stripe from 'stripe';

const PRICE_PER_WEEK_JPY = 48000;   // keep in step with api/hold.js

const DAYS = [
  'Oct 5–8', 'Oct 12–15', 'Oct 19–22', 'Oct 26–29',
  'Nov 2–5', 'Nov 9–12', 'Nov 16–19', 'Nov 23–26',
  'Nov 30–Dec 3', 'Dec 7–10', 'Dec 14–17', 'Dec 21–24',
];

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(request) {
  const raw = await request.text();
  const sig = request.headers.get('stripe-signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response(`Webhook signature failed: ${err.message}`, { status: 400 });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode === 'setup') await onCardSaved(session);
    } else if (event.type === 'invoice.paid') {
      await onInvoicePaid(event.data.object);
    }
  } catch (err) {
    // Return 500 so Stripe retries, and say why so it shows in Stripe's delivery log.
    console.error('webhook handler error', err);
    return Response.json({
      ok: false,
      error: String(err && err.message || err),
      type: err && err.type,
      param: err && err.param,
      step: err && err.__step,
    }, { status: 500 });
  }

  return Response.json({ received: true });
}

async function onCardSaved(session) {
  const ref        = session.client_reference_id || session.metadata?.ref || '';
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const weeks      = String(session.metadata?.weeks || '').split('-').filter(Boolean); // ["W3AM","W4PM"]
  const kids       = Math.max(1, parseInt(session.metadata?.kids, 10) || 1);

  // 1. make the saved card the default for automatic invoice charging
  const si = await step('retrieve setup intent', () => stripe.setupIntents.retrieve(session.setup_intent));
  const pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
  if (pm) {
    await step('set default payment method', () => stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pm },
    }));
  }

  // 2. one draft invoice per week
  const customer = await step('retrieve customer', () => stripe.customers.retrieve(customerId));
  for (const code of weeks) {
    const m = /^W(\d+)(AM|PM)$/.exec(code);
    if (!m) continue;
    const idx  = parseInt(m[1], 10) - 1;
    const sess = m[2] === 'AM' ? 'mornings 9–12' : 'afternoons 2–5';
    const label = `${DAYS[idx] || code} · ${sess}`;
    const amount = PRICE_PER_WEEK_JPY * kids;

    const invoice = await step('create invoice ' + code, () => stripe.invoices.create({
      customer: customerId,
      currency: 'jpy',
      collection_method: 'charge_automatically',
      auto_advance: false,                       // stays a draft until you finalise it
      pending_invoice_item_behavior: 'exclude',
      description: `Tokyo Weekday Club · ${label} · ${kids} child${kids > 1 ? 'ren' : ''} · ref ${ref}`,
      metadata: { ref, week: code, kids: String(kids), parent: customer.name || '' },
      footer: 'Charged to your saved card once the class was confirmed. 50% refund with 14+ days notice.',
    }, { idempotencyKey: `inv-${ref}-${code}` }));

    await step('create invoice item ' + code, () => stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      currency: 'jpy',
      amount,
      description: `Japanese for kids · ${label} · ${kids} × ¥${PRICE_PER_WEEK_JPY.toLocaleString('en-US')}`,
      metadata: { ref, week: code },
    }, { idempotencyKey: `item-${ref}-${code}` }));
  }

  // 3. sheet
  await sheet({ action: 'status', ref, status: 'card saved', note: `stripe customer ${customerId}` });
}

async function onInvoicePaid(invoice) {
  const ref  = invoice.metadata?.ref;
  const week = invoice.metadata?.week;
  if (!ref) return;
  await sheet({ action: 'status', ref, status: 'paid', note: `paid ${week} ¥${(invoice.amount_paid || 0).toLocaleString('en-US')}` });
}

async function step(name, fn) {
  try { return await fn(); }
  catch (err) { if (err && typeof err === 'object') err.__step = name; throw err; }
}

async function sheet(payload) {
  if (!process.env.SHEET_URL) return;
  try {
    await fetch(process.env.SHEET_URL, {
      method: 'POST',
      body: JSON.stringify({ token: process.env.SHEET_TOKEN, ...payload }),
      redirect: 'follow',
    });
  } catch (err) {
    console.error('sheet update failed', err);   // never fail the webhook over the sheet
  }
}
