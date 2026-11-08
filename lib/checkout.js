import { normaliseBooking, label } from './bookings.js';

export function createHoldHandler({ stripe, sheet, token, siteUrl, requireTerms = false, now = Date.now }) {
  return async function handle(request) {
    let body;
    try { body = await request.json(); } catch { return Response.json({ok:false,error:'Invalid request'}, {status:400}); }
    if (!token || body.token !== token) return Response.json({ok:false,error:'Unauthorised'}, {status:401});
    if (body.website) return Response.json({ok:true,url:siteUrl});
    let booking;
    try { booking = normaliseBooking(body, now()); }
    catch (error) { return Response.json({ok:false,code:error.code,error:error.message},{status:error.code ? 409 : 400}); }
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0,120);
    const ref = String(body.ref || '').trim();
    const lang = body.lang === 'zh' ? 'zh' : 'en';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name || !/^[A-Za-z0-9_-]{8,200}$/.test(ref) || body.terms !== 'yes') {
      return Response.json({ok:false,error:'Please complete your details and agree to the terms.'},{status:400});
    }
    const {kids, units, codes, type, total} = booking;
    const text = units.map(u=>label(u,lang)).join('; ');
    try {
      // Atomic reservation; the Sheet independently checks codes and prices.
      await sheet({action:'reserve',ref,name,email,whatsapp:String(body.whatsapp||'').slice(0,40),
        kids:String(body.kids||'').slice(0,400),kidsCount:kids,weekCodes:codes.join('-'),weeks:text,
        weeksCount:units.length,tier:type,amountJpy:total,lang,terms:'yes',referral:String(body.referral||'').slice(0,120)});
      const metadata = {ref,kids:String(kids),weeks:codes.join('-'),total_jpy:String(total),booking_type:type,pricing_version:'daily-v1-min3'};
      const customer = await stripe.customers.create({email,name,
        phone:body.whatsapp?String(body.whatsapp).slice(0,40):undefined,
        preferred_locales:[lang==='zh'?'zh-HK':'en'],
        metadata:{...metadata,kids_detail:String(body.kids||'').slice(0,400),weeks_text:text.slice(0,500)},
      },{idempotencyKey:`cus-${ref}`});
      const existingSessions = await stripe.checkout.sessions.list({customer:customer.id,limit:100});
      const existing = existingSessions.data.find(s => s.client_reference_id === ref && s.status === 'open');
      if (existing?.url) return Response.json({ok:true,url:existing.url,totalJpy:total,weekCodes:codes});
      const jp = total.toLocaleString('en-US');
      const returnPath = lang === 'zh' ? '/hk' : '/';
      const message = lang === 'zh'
        ? `預約總額 ¥${jp}（${units.length} ${type==='day'?'日':'週'} × ${kids} 位）。儲存信用卡本身不會收費。每班3–6人，須提前最少14日確認開班後才收費；整週須四日均確認。已確認的班別可隨即扣款，未能開班不收費。`
        : `Booking total ¥${jp} (${units.length} ${type==='day'?'day(s)':'week(s)'} × ${kids} child(ren)). Saving your card does not itself charge it. Classes require 3–6 children and confirmation at least 14 days ahead. We charge after confirmation; a week requires all 4 days to qualify. Confirmed classes may be charged immediately. No charge for classes that do not run.`;
      const session = await stripe.checkout.sessions.create({
        ...(requireTerms ? {consent_collection:{terms_of_service:'required'}} : {}),
        mode:'setup',currency:'jpy',customer:customer.id,client_reference_id:ref,
        locale:lang==='zh'?'zh-HK':'en',custom_text:{submit:{message}},
        setup_intent_data:{metadata},metadata,
        expires_at:Math.floor(now()/1000)+1800,
        success_url:`${siteUrl}${returnPath}?held=1&ref=${encodeURIComponent(ref)}&booking=${type}${lang==='zh'?'&lang=zh':''}#book`,
        cancel_url:`${siteUrl}${returnPath}?booking=${type}${lang==='zh'?'&lang=zh':''}#book`,
      },{idempotencyKey:`cs-${ref}`});
      return Response.json({ok:true,url:session.url,totalJpy:total,weekCodes:codes});
    } catch (error) {
      // Ambiguous Stripe/network errors retain the short hold: a Checkout
      // Session may exist. Sheet reservations expire after 35 minutes.
      console.error('Booking setup failed',error.type || error.code || 'service');
      const known = ['full','booking_closed','ref_conflict','cancelled'].includes(error.code);
      return Response.json({ok:false,code:error.code || 'unavailable',full:error.full,
        error:known ? error.message : 'We could not reserve these dates. Please try again shortly or contact hello@tokyoweekdayclub.com.'},
        {status:known?409:503});
    }
  };
}
