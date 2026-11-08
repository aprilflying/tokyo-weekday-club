import Stripe from 'stripe';
import { createBilling } from '../lib/billing.js';
import { sheetRequest, readCounts } from '../lib/sheet.js';

export async function POST(request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try { event = stripe.webhooks.constructEvent(await request.text(), request.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return new Response('Invalid webhook signature',{status:400}); }
  try {
    const billing = createBilling({stripe,sheet:sheetRequest,counts:readCounts});
    if (event.type==='checkout.session.completed' && event.data.object.mode==='setup') await billing.cardSaved(event.data.object);
    if (event.type==='invoice.paid') await billing.invoicePaid(event.data.object);
    return Response.json({received:true});
  } catch (error) {
    console.error('Booking webhook failed',error.code||error.type||error.message);
    return Response.json({ok:false,error:'Booking update failed; please retry.'},{status:500});
  }
}
