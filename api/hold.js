import Stripe from 'stripe';
import { createHoldHandler } from '../lib/checkout.js';
import { sheetRequest } from '../lib/sheet.js';

export async function POST(request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return createHoldHandler({stripe,sheet:sheetRequest,token:process.env.SITE_TOKEN,
    requireTerms:process.env.REQUIRE_TERMS === '1',siteUrl:process.env.SITE_URL || 'https://www.tokyoweekdayclub.com'})(request);
}
