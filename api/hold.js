/**
 * POST /api/hold
 *
 * Saves a parent's card WITHOUT charging it, so the class can be charged
 * later once it reaches the minimum of 3 children.
 *
 * Called by the booking form on the site. Creates a Stripe Customer and a
 * Checkout Session in "setup" mode, then returns the Checkout URL for the
 * browser to redirect to. Nothing is charged here.
 *
 * Environment variables (Vercel → Project → Settings → Environment Variables):
 *   STRIPE_SECRET_KEY   sk_live_… or sk_test_…
 *   SITE_TOKEN          same string as SHEET_TOKEN in the site snippet
 *   SITE_URL            https://tokyoweekdayclub.com   (no trailing slash)
 *   REQUIRE_TERMS       "1" to show the terms checkbox. Needs a terms URL
 *                       saved in Stripe → Settings → Public details first.
 */

import Stripe from 'stripe';

const PRICE_PER_WEEK_JPY = 48000;   // per child, per week. Change here only.
const MAX_WEEKS  = 12;
const MAX_KIDS   = 4;

// Must match the order on the site. Index 0 = week 1.
const DAYS = [
  'Oct 5–8', 'Oct 12–15', 'Oct 19–22', 'Oct 26–29',
  'Nov 2–5', 'Nov 9–12', 'Nov 16–19', 'Nov 23–26',
  'Nov 30–Dec 3', 'Dec 7–10', 'Dec 14–17', 'Dec 21–24',
];

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(request) {
  try {
    return await handle(request);
  } catch (err) {
    // Surface the reason instead of a bare 500. Stripe messages never contain secrets.
    console.error('hold error', err);
    const missing = ['STRIPE_SECRET_KEY', 'SITE_TOKEN', 'SITE_URL'].filter(k => !process.env[k]);
    return Response.json({ ok: false, error: String(err && err.message || err), type: err && err.type, missingEnv: missing }, { status: 500 });
  }
}

const SITE_URL = process.env.SITE_URL || 'https://tokyoweekdayclub.com';

async function handle(request) {
  let body;
  try { body = await request.json(); } catch { return bad('invalid json'); }

  if (body.token !== process.env.SITE_TOKEN) return bad('unauthorised', 401);
  if (body.website) return Response.json({ ok: true, url: process.env.SITE_URL }); // honeypot

  // ---- validate, and recompute the money server-side (never trust the browser) ----
  const email = String(body.email || '').trim().toLowerCase();
  const name  = String(body.name  || '').trim().slice(0, 120);
  const ref   = String(body.ref   || '').trim();
  const lang  = body.lang === 'zh' ? 'zh' : 'en';
  const kids  = Math.min(MAX_KIDS, Math.max(1, parseInt(body.kidsCount, 10) || 1));

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad('email');
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(ref))       return bad('ref');

  // weeks: [{ i: 2, s: 'am' }, { i: 3, s: 'pm' }]
  const weeks = Array.isArray(body.weeks) ? body.weeks
    .map(w => ({ i: parseInt(w.i, 10), s: w.s === 'pm' ? 'pm' : 'am' }))
    .filter(w => Number.isInteger(w.i) && w.i >= 0 && w.i < MAX_WEEKS)
    .sort((a, b) => a.i - b.i) : [];
  if (weeks.length === 0) return bad('no weeks');

  const weekCodes = weeks.map(w => `W${w.i + 1}${w.s.toUpperCase()}`);
  const totalJpy  = PRICE_PER_WEEK_JPY * weeks.length * kids;
  const weeksText = weeks.map(w => `${DAYS[w.i]} ${w.s.toUpperCase()}`).join('; ');

  // ---- customer ----
  const customer = await stripe.customers.create({
    email, name,
    phone: body.whatsapp ? String(body.whatsapp).slice(0, 40) : undefined,
    preferred_locales: [lang === 'zh' ? 'zh-HK' : 'en'],
    metadata: {
      ref,
      kids: String(kids),
      kids_detail: String(body.kids || '').slice(0, 400),
      weeks: weekCodes.join('-'),
      weeks_text: weeksText,
      total_jpy: String(totalJpy),
    },
  }, { idempotencyKey: `cus-${ref}` });

  // ---- checkout in setup mode: saves the card, charges nothing ----
  const jp = totalJpy.toLocaleString('en-US');
  const message = lang === 'zh'
    ? `今日不會扣款。當你所選的班別確認開班(每班至少3位小朋友),我們會以此卡收取 ¥${jp}(${weeks.length} 星期 × ${kids} 位小朋友)。如班別未能開辦,不會收費。`
    : `Nothing is charged today. When your class is confirmed (minimum 3 children), we will charge ¥${jp} to this card (${weeks.length} week${weeks.length > 1 ? 's' : ''} × ${kids} child${kids > 1 ? 'ren' : ''}). If a week does not run, you are not charged for it.`;

  const params = {
    mode: 'setup',
    currency: 'jpy',
    customer: customer.id,
    client_reference_id: ref,
    locale: lang === 'zh' ? 'zh-HK' : 'en',
    phone_number_collection: { enabled: true },
    custom_text: { submit: { message } },
    setup_intent_data: {
      metadata: { ref, weeks: weekCodes.join('-'), kids: String(kids), total_jpy: String(totalJpy) },
    },
    metadata: { ref, weeks: weekCodes.join('-'), kids: String(kids), total_jpy: String(totalJpy) },
    success_url: `${SITE_URL}/?held=1&ref=${encodeURIComponent(ref)}#book`,
    cancel_url:  `${SITE_URL}/#book`,
  };
  if (process.env.REQUIRE_TERMS === '1') {
    params.consent_collection = { terms_of_service: 'required' };
  }

  const session = await stripe.checkout.sessions.create(params, { idempotencyKey: `cs-${ref}` });

  return Response.json({ ok: true, url: session.url, totalJpy, weekCodes });
}

function bad(msg, status = 400) {
  return Response.json({ ok: false, error: msg }, { status });
}
