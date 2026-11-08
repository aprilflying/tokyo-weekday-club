import assert from 'node:assert/strict';
import { normaliseBooking, parseCode, sessionCodes, canBook, confirmationDeadline, readyToCharge } from '../lib/bookings.js';
import { createHoldHandler } from '../lib/checkout.js';
import { createBilling } from '../lib/billing.js';
const now=Date.parse('2026-11-08T00:00:00+09:00');
const day={bookingType:'day',days:[{date:'2026-11-23',s:'am'}],kidsCount:2};
assert.equal(normaliseBooking(day,now).total,28000);
assert.equal(normaliseBooking({...day,amountJpy:1},now).total,28000);
assert.equal(normaliseBooking({weeks:[{i:7,s:'am'}],kidsCount:6},now).total,288000);
for(const bad of [
 {...day,kidsCount:7},{...day,kidsCount:0},{...day,kidsCount:1.5},
 {...day,days:[{date:'2026-11-27',s:'am'}]}, {...day,days:[{date:'2026-11-31',s:'am'}]},
 {...day,days:[{date:'2026-11-23',s:'bad'}]}, {...day,days:[...day.days,...day.days]},
 {...day,days:[{date:'2026-11-23',s:'am'},{date:'2026-11-23',s:'pm'}]},
])assert.throws(()=>normaliseBooking(bad,now));
const unit=parseCode('D20261123AM'),week=parseCode('W8AM');
assert.equal(canBook(unit,{classes:{}},confirmationDeadline(unit)-1),true);
assert.equal(canBook(unit,{classes:{}},confirmationDeadline(unit)),false);
const confirmed={classes:Object.fromEntries(sessionCodes(week).map(c=>[c,'confirmed'])),confirmed:Object.fromEntries(sessionCodes(week).map(c=>[c,3]))};
assert.equal(canBook(unit,confirmed,Date.parse('2026-11-22T23:59:59+09:00')),true);
assert.equal(canBook(unit,confirmed,Date.parse('2026-11-23T00:00:00+09:00')),false);
assert.equal(readyToCharge(week,confirmed,now),true);
assert.equal(readyToCharge(week,{...confirmed,confirmed:{...confirmed.confirmed,D20261123AM:2}},now),false);
assert.equal(readyToCharge(week,{classes:{D20261123AM:'confirmed'}},now),false);
let calls=[];
const stripe={customers:{create:async p=>{calls.push(['customer',p]);return{id:'cus_test'};}},checkout:{sessions:{list:async()=>({data:[]}),create:async p=>{calls.push(['checkout',p]);return{url:'https://checkout.example.invalid'};}}}};
const body={...day,token:'test',terms:'yes',ref:'TESTREF12345',name:'Test Parent',email:'parent@example.invalid'};
const handler=createHoldHandler({stripe,sheet:async p=>{calls.push(['reserve',p]);return{ok:true};},token:'test',siteUrl:'https://example.invalid',now:()=>now});
let response=await handler({json:async()=>body});let data=await response.json();
assert.equal(data.totalJpy,28000);assert.equal(calls[0][0],'reserve');assert.equal(calls[2][1].mode,'setup');assert.equal(calls[2][1].metadata.weeks,'D20261123AM');
assert.equal(calls[2][1].expires_at,Math.floor(now/1000)+1800);
calls=[];response=await handler({json:async()=>({...body,terms:''})});assert.equal(response.status,400);assert.equal(calls.length,0);
const blocked=createHoldHandler({stripe,sheet:async()=>{throw Object.assign(new Error('Full'),{code:'full'});},token:'test',siteUrl:'https://example.invalid',now:()=>now});
response=await blocked({json:async()=>body});assert.equal(response.status,409);assert.equal(calls.length,0);
// Stripe invoice replay, mixed day/week thresholds and exact JPY amounts.
const invoices=new Map(),items=new Map(),payments=[],sheetCalls=[];
const billingStripe={setupIntents:{retrieve:async()=>({payment_method:'pm_test'})},customers:{update:async()=>({})},
 invoices:{create:async(p,{idempotencyKey:k})=>{if(!invoices.has(k))invoices.set(k,{...p,id:k,status:'draft',total:0});return invoices.get(k);},
 list:p=>({async *[Symbol.asyncIterator](){for(const inv of invoices.values())if(!p.status||inv.status===p.status)yield inv;}}),
 finalizeInvoice:async id=>{[...invoices.values()].find(i=>i.id===id).status='open';},pay:async id=>{payments.push(id);[...invoices.values()].find(i=>i.id===id).status='paid';}},
 invoiceItems:{create:async(p,{idempotencyKey:k})=>{if(!items.has(k)){items.set(k,p);[...invoices.values()].find(i=>i.id===p.invoice).total+=p.amount;}return{};}}};
let availability={classes:{}};
const billing=createBilling({stripe:billingStripe,sheet:async p=>{sheetCalls.push(p);return{ok:true,activated:true,chargeable:true};},counts:async()=>availability,now:()=>now});
const session={client_reference_id:'TESTREF12345',customer:'cus_test',setup_intent:'si_test',metadata:{weeks:'D20261123AM',kids:'2'}};
await billing.cardSaved(session);assert.equal(items.size,1);assert.equal([...items.values()][0].amount,28000);assert.equal(payments.length,0);
availability={classes:{D20261123AM:'confirmed'},confirmed:{D20261123AM:3}};
await billing.confirm(['D20261126AM']);assert.equal(payments.length,1,'Another day can confirm a waiting Monday invoice');
await billing.cardSaved(session);await billing.cardSaved(session);assert.equal(items.size,1);assert.equal(payments.length,1);
await billing.invoicePaid({metadata:{ref:'TESTREF12345',week:'D20261123AM'},amount_paid:28000});assert.match(sheetCalls.at(-1).note,/paid D20261123AM ¥28,000/);
const rejected=createBilling({stripe:{},sheet:async()=>({activated:false}),counts:async()=>{throw Error('must not run');}});await rejected.cardSaved(session);
console.log('Booking validation, JPY pricing, 14-day deadline, late top-ups, fail-closed reservations and invoice replay tests passed. No live Stripe calls.');
