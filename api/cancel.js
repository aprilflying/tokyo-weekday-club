/**
 * POST /api/cancel
 *
 * Self-service cancellation, only while nothing has been charged.
 * The parent arrives from the link in their confirmation email:
 *   https://www.tokyoweekdayclub.com/?cancel=TWC-…&t=<signature>
 * The site posts { ref, t } here.
 *
 * Checks the signature, finds the booking's invoices in Stripe:
 *   - all still drafts  → deletes them, detaches the saved card, tells the sheet "cancelled"
 *   - any already charged → refuses; refund policy applies, parent emails us
 *
 * Environment variables: STRIPE_SECRET_KEY, SITE_TOKEN, SHEET_URL, SHEET_TOKEN
 */

import Stripe from 'stripe';
import { createHmac, timingSafeEqual } from 'node:crypto';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(request) {
  try {
    return await handle(request);
  } catch (err) {
    console.error('cancel error', err);
    return Response.json({ ok: false, error: String(err && err.message || err) }, { status: 500 });
  }
}

async function handle(request) {
  let body;
  try { body = await request.json(); } catch { return bad('invalid json'); }

  const ref = String(body.ref || '').trim();
  const t   = String(body.t || '').trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(ref)) return bad('ref');
  if (!validSig(ref, t)) return bad('This cancel link is not valid.', 403);

  // Find the customer for this booking (created by /api/hold with metadata.ref)
  const found = await stripe.customers.search({ query: `metadata['ref']:'${ref}'`, limit: 1 });
  const customer = found.data[0];
  if (!customer) return bad('Booking not found.', 404);

  // Every invoice for this customer that carries the booking ref
  const invoices = await stripe.invoices.list({ customer: customer.id, limit: 100 });
  const mine = invoices.data.filter(inv => inv.metadata && inv.metadata.ref === ref);

  const charged = mine.filter(inv => inv.status !== 'draft' && inv.status !== 'void');
  if (charged.length > 0) {
    return Response.json({
      ok: false,
      code: 'already_confirmed',
      error: 'At least one of your weeks has already been confirmed and charged. Email hello@tokyoweekdayclub.com and we will apply the refund policy.',
    }, { status: 409 });
  }

  // Delete the drafts (nothing was ever charged)
  for (const inv of mine) {
    if (inv.status === 'draft') await stripe.invoices.del(inv.id);
  }

  // Detach the saved card so nothing can be charged later
  const pms = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 10 });
  for (const pm of pms.data) {
    try { await stripe.paymentMethods.detach(pm.id); } catch (_) {}
  }
  await stripe.customers.update(customer.id, { metadata: { cancelled: new Date().toISOString() } });

  await sheet({ action: 'status', ref, status: 'cancelled', note: 'cancelled by parent' });

  return Response.json({ ok: true, ref, weeks: mine.length });
}

function validSig(ref, t) {
  const expected = createHmac('sha256', process.env.SITE_TOKEN || '').update(ref).digest('hex').slice(0, 16);
  if (t.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(t), Buffer.from(expected));
}

async function sheet(payload) {
  if (!process.env.SHEET_URL) return;
  try {
    await fetch(process.env.SHEET_URL, { method: 'POST', body: JSON.stringify({ token: process.env.SHEET_TOKEN, ...payload }), redirect: 'follow' });
  } catch (err) { console.error('sheet update failed', err); }
}

function bad(msg, status = 400) {
  return Response.json({ ok: false, error: msg }, { status });
}
