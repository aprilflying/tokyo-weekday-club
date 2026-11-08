import { DAILY_PRICE, WEEKLY_PRICE, dateAt, dayCode, parseCode, isOpen, canBook, label } from '../lib/bookings.js';
const params = new URLSearchParams(location.search);
const zh = params.get('lang') === 'zh';
const lang = zh ? 'zh' : 'en';
const $ = id => document.getElementById(id);
const t = (en,cn) => zh?cn:en;
document.documentElement.lang = zh?'zh-Hant':'en';
document.title = t('Book a day · Tokyo Weekday Club','單日預約 · Tokyo Weekday Club');
document.querySelectorAll('[data-en]').forEach(el => el.textContent = (el.dataset[lang==='zh'?'zh':'en']||'').replaceAll('\\n','\n'));
$('weekly-link').href = zh?'/hk#book':'/#book';
$('terms-link').href = zh?'/terms?lang=zh':'/terms';
const selected = new Map();
let availability = null, busy = false, pendingRef = null, pendingFingerprint = null;
const kids = () => Number($('kids-count').value);
const money = n => '¥'+n.toLocaleString('en-US');
function track(event, properties) { try { window.posthog?.capture(event,{booking_type:'day',lang,...properties}); } catch {} }
function error(message) { $('error').textContent = message; }
function choices() { return [...selected].sort(([a],[b])=>a.localeCompare(b)).map(([date,s])=>({date,s})); }
function allowed(date,s) {
  return !!availability && canBook(parseCode(dayCode(date,s)),availability) &&
    Number(availability.sessions[dayCode(date,s)]||0)+kids() <= 6;
}
function renderDates() {
  $('dates').replaceChildren();
  if (!availability || !$('week').value) return;
  const i = Number($('week').value);
  for(let d=0;d<4;d++) {
    const date = dateAt(i,d), div = document.createElement('div'); div.className='date';
    const heading=document.createElement('strong');
    heading.textContent=new Intl.DateTimeFormat(zh?'zh-Hant':'en-GB',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(date+'T00:00:00Z'));
    div.append(heading);
    const status=document.createElement('small');status.textContent=t('New classes confirm at least 14 days ahead.','新班須提前最少 14 日確認。');div.append(status);
    const sessions=document.createElement('div');sessions.className='sessions';
    for(const s of ['am','pm']) {
      const button=document.createElement('button');button.type='button';
      const open=canBook(parseCode(dayCode(date,s)),availability);
      const room=6-Number(availability.sessions[dayCode(date,s)]||0);
      button.textContent=(s==='am'?'09:00–12:00':'14:00–17:00')+(!open?t(' · closed',' · 已截止'):room<kids()?t(' · full',' · 名額不足'):availability.classes?.[dayCode(date,s)]==='confirmed'?t(' · confirmed',' · 已確認'):t(' · pending',' · 待開班'));
      button.setAttribute('aria-label',heading.textContent+' '+button.textContent);
      button.setAttribute('aria-pressed',String(selected.get(date)===s));
      button.disabled=!allowed(date,s)||busy;
      button.addEventListener('click',()=>{if(selected.get(date)===s)selected.delete(date);else selected.set(date,s);error('');track('booking_started',{});renderDates();renderSummary();});
      sessions.append(button);
    }
    div.append(sessions);$('dates').append(div);
  }
}
function renderSummary() {
  $('selected').replaceChildren();
  for(const {date,s} of choices()) {
    const row=document.createElement('div');row.className='selected-row';
    const span=document.createElement('span');span.textContent=label(parseCode(dayCode(date,s)),lang);
    const remove=document.createElement('button');remove.type='button';remove.className='remove';remove.textContent=t('Remove','移除');remove.setAttribute('aria-label',t('Remove ','移除 ')+span.textContent);
    remove.onclick=()=>{selected.delete(date);renderDates();renderSummary();};row.append(span,remove);$('selected').append(row);
  }
  $('total').textContent=money(selected.size*kids()*DAILY_PRICE);
  $('breakdown').textContent=zh?`${selected.size} 日 × ${kids()} 位 × ¥14,000`:`${selected.size} day(s) × ${kids()} child(ren) × ¥14,000`;
  const groups=new Map();for(const {date,s} of choices()){const offset=Math.floor((Date.parse(date)-Date.parse('2026-10-05'))/86400000/7);const key=offset+s;groups.set(key,(groups.get(key)||0)+1);}
  const fullWeek=[...groups.values()].some(n=>n===4);
  $('weekly-saving').hidden=!fullWeek;
  $('weekly-saving').textContent=t('Choosing all 4 days in the same session? A weekly booking is ¥48,000 per child, saving ¥8,000. Use “4-day week” above for that price.','同一星期、同一時段報四日？整週每位 ¥48,000，比逐日報名節省 ¥8,000。可選上方「4 日整週課程」享用週費。');
  $('submit').disabled=busy||!availability||!selected.size||choices().some(({date,s})=>!allowed(date,s));
}
function renderChildren() {
  const previous=[...$('children').querySelectorAll('.child')].map(row=>({name:row.querySelector('input').value,age:row.querySelector('select').value}));
  $('children').replaceChildren();
  for(let i=0;i<kids();i++) {
    const row=document.createElement('div');row.className='child';
    const nameLabel=document.createElement('label');nameLabel.textContent=t(`Child ${i+1} · full name`,`小朋友 ${i+1} · 姓名`);
    const input=document.createElement('input');input.name='childName';input.required=true;input.maxLength=60;input.value=previous[i]?.name||'';nameLabel.append(input);
    const ageLabel=document.createElement('label');ageLabel.textContent=t('Age','年齡');
    const age=document.createElement('select');age.name='childAge';age.required=true;age.add(new Option(t('Age','年齡'),''));for(let n=6;n<=12;n++)age.add(new Option(String(n),String(n)));age.value=previous[i]?.age||'';ageLabel.append(age);
    row.append(nameLabel,ageLabel);$('children').append(row);
  }
  renderDates();renderSummary();
}
async function refresh() {
  try {
    const response=await fetch('/api/availability',{cache:'no-store'});const data=await response.json();
    if(!response.ok||data.bookingVersion!==9||!data.sessions)throw new Error('availability');
    availability=data;const before=$('week').value;$('week').replaceChildren();
    for(let i=0;i<12;i++)if(Array.from({length:4},(_,d)=>dateAt(i,d)).some(date=>isOpen(parseCode(dayCode(date,'am'))))){$('week').add(new Option(label(parseCode(`W${i+1}AM`),lang).split(' · ')[0],String(i)));}
    if([...$('week').options].some(o=>o.value===before))$('week').value=before;
    $('week').disabled=!$('week').options.length;
    $('availability-status').textContent=$('week').options.length?'':t('New dates will be announced soon. Please email us about future dates.','新一期日期將會公布，歡迎電郵查詢。');
    let removed=false;for(const [date,s]of selected)if(!allowed(date,s)){selected.delete(date);removed=true;}
    if(removed)error(t('Some selected sessions are no longer available. Please review your dates.','部分所選時段已截止或額滿，請重新核對日期。'));
  } catch {
    availability=null;$('availability-status').textContent=t('We could not load availability. Please refresh or email hello@tokyoweekdayclub.com.','暫時未能載入名額。請重新整理或電郵 hello@tokyoweekdayclub.com。');
  }
  renderDates();renderSummary();
}
$('week').addEventListener('change',renderDates);
$('kids-count').addEventListener('change',()=>{renderChildren();for(const [date,s]of selected)if(!allowed(date,s))selected.delete(date);renderDates();renderSummary();});
$('daily-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;error('');
  if(!selected.size||choices().some(({date,s})=>!allowed(date,s))){error(t('Choose available dates first.','請先選擇有名額的日期。'));return;}
  const form=new FormData(event.target);
  const payload={bookingType:'day',days:choices(),kidsCount:kids(),lang,terms:form.get('terms'),website:form.get('website'),
    name:zh?form.get('lastname')+form.get('firstname'):form.get('firstname')+' '+form.get('lastname'),email:form.get('email'),
    whatsapp:form.get('whatsapp'),referral:form.get('referral'),kids:form.getAll('childName').map((n,i)=>n+' ('+form.getAll('childAge')[i]+')').join(', '),
    token:'CHANGE-ME-to-a-long-random-string'};
  const fingerprint=JSON.stringify(payload);if(fingerprint!==pendingFingerprint){pendingRef='TWC-'+crypto.randomUUID();pendingFingerprint=fingerprint;}payload.ref=pendingRef;
  busy=true;renderDates();renderSummary();$('submit').textContent=t('Opening secure page…','正在開啟安全頁面⋯');
  try {
    const response=await fetch('/api/hold',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json();
    if(!response.ok||!data.ok||!data.url)throw Object.assign(new Error(data.error||'Unable to reserve'),{code:data.code});
    track('booking_submitted',{days:payload.days.length,children:payload.kidsCount,amount_jpy:data.totalJpy});
    location.assign(data.url);
  }catch(e){error(zh?'暫時未能完成留位，請核對日期後再試，或電郵 hello@tokyoweekdayclub.com。':e.message);if(['full','day_closed','booking_closed','ref_conflict','cancelled'].includes(e.code)){pendingFingerprint=null;await refresh();}busy=false;$('submit').textContent=t('Save card securely →','安全儲存信用卡 →');renderDates();renderSummary();}
});
if(params.has('held')){$('success').hidden=false;$('daily-form').hidden=true;$('booking-ref').textContent=t('Reference: ','預約編號：')+(params.get('ref')||'');}
else{renderChildren();refresh();window.addEventListener('focus',refresh);setInterval(refresh,60000);}
