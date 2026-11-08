import { parseCode, label, readyToCharge } from './bookings.js';

export function createBilling({stripe,sheet,counts,now=Date.now}) {
  async function cardSaved(session) {
    const ref = session.client_reference_id || session.metadata?.ref;
    const customerId = typeof session.customer==='string'?session.customer:session.customer?.id;
    const codes = String(session.metadata?.weeks||'').split('-').filter(Boolean);
    const kids = Number(session.metadata?.kids);
    if (!ref || !customerId || !codes.length || !Number.isInteger(kids) || kids<1 || kids>6) throw new Error('Invalid booking metadata');
    const units = codes.map(parseCode);
    // An expired reservation is rechecked under the sheet lock. Never charge
    // a late checkout if another family has taken those places.
    const active = await sheet({action:'activate',ref,weekCodes:codes.join('-'),kidsCount:kids});
    if (!active.activated) return;
    const si = await stripe.setupIntents.retrieve(session.setup_intent);
    const paymentMethod = typeof si.payment_method==='string'?si.payment_method:si.payment_method?.id;
    if (!paymentMethod) throw new Error('No saved card');
    await stripe.customers.update(customerId,{invoice_settings:{default_payment_method:paymentMethod}});
    for (const unit of units) {
      // Stripe idempotency keys expire. Also look up the durable invoice by
      // booking reference so a webhook replay days later cannot charge twice.
      let invoice;
      for await (const candidate of stripe.invoices.list({customer:customerId,limit:100})) {
        if (candidate.metadata?.ref === ref && candidate.metadata?.week === unit.code) { invoice=candidate; break; }
      }
      invoice ||= await stripe.invoices.create({customer:customerId,currency:'jpy',
        collection_method:'charge_automatically',auto_advance:false,pending_invoice_items_behavior:'exclude',
        description:`Tokyo Weekday Club · ${label(unit)} · ${kids} child(ren) · ref ${ref}`,
        metadata:{ref,week:unit.code,kids:String(kids),booking_type:unit.type,pricing_version:'daily-v1-min3'},
        footer:'Charged only after the booked class is confirmed. 50% refund with 14+ days notice; otherwise non-refundable.',
      },{idempotencyKey:`inv-${ref}-${unit.code}`});
      // A duplicate webhook after successful payment must not append an item.
      if (invoice.status === 'draft' && invoice.total === 0) {
        await stripe.invoiceItems.create({customer:customerId,invoice:invoice.id,currency:'jpy',
          amount:unit.price*kids,description:`Japanese for kids · ${label(unit)} · ${kids} × ¥${unit.price.toLocaleString('en-US')}`,
          metadata:{ref,week:unit.code},
        },{idempotencyKey:`item-${ref}-${unit.code}`});
      }
    }
    await sheet({action:'status',ref,status:'card saved',note:`stripe customer ${customerId}`});
    await confirm(codes);
  }
  async function confirm() {
    const availability = await counts();
    // A new Thursday booking can confirm an entire week, including Monday's
    // waiting single-day bookings. Recheck every eligible draft together.
    for await (const invoice of stripe.invoices.list({status:'draft',limit:100})) {
      if (!invoice.metadata?.ref || !invoice.metadata?.week) continue;
      let unit;
      try { unit = parseCode(invoice.metadata.week); } catch { continue; }
      if (!readyToCharge(unit,availability,now())) continue;
      // Confirm the booking still occupies its seats before charging. This
      // also prevents an old form-only / cancelled invoice from being billed.
      const check = await sheet({action:'chargeable',ref:invoice.metadata.ref,code:unit.code});
      if (!check.chargeable) continue;
      const kids = Number(invoice.metadata.kids);
      const expected = unit.price*kids;
      if (!Number.isInteger(kids)||kids<1||kids>6||invoice.total!==expected) throw new Error('Invoice amount mismatch');
      try {
        await stripe.invoices.finalizeInvoice(invoice.id,{auto_advance:true});
        await stripe.invoices.pay(invoice.id);
      } catch (error) {
        // Stripe handles declines / SCA using its invoice recovery flow.
        console.error('Class payment requires follow-up',invoice.id,error.code||error.type||'payment');
      }
    }
  }
  async function invoicePaid(invoice) {
    if (!invoice.metadata?.ref) return;
    await sheet({action:'status',ref:invoice.metadata.ref,status:'paid',
      note:`paid ${invoice.metadata.week} ¥${Number(invoice.amount_paid||0).toLocaleString('en-US')}`});
  }
  return {cardSaved,confirm,invoicePaid};
}
