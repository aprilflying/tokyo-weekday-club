import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
let now=Date.parse('2026-11-08T00:00:00+09:00');const Date0=Date;class Clock extends Date0{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
class Sheet{constructor(){this.rows=[];}getLastRow(){return this.rows.length;}appendRow(v){this.rows.push([...v]);}getRange(r,c,n=1,m=1){const self=this;return{getValues:()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>self.rows[r+i-1]?.[c+j-1]??'')),getValue:()=>self.rows[r-1]?.[c-1]??'',setValue(v){return this.setValues([[v]]);},setValues(v){for(let i=0;i<n;i++){self.rows[r+i-1]||=[];for(let j=0;j<m;j++)self.rows[r+i-1][c+j-1]=v[i][j];}return this;}};}}
const sheets=new Map(),properties=new Map(),messages=[];const sheet=()=>{if(!sheets.has('Bookings')){const sh=new Sheet();sh.appendRow(Array(17).fill('header'));sheets.set('Bookings',sh);}return sheets.get('Bookings');};
const ctx=vm.createContext({console,Date:Clock,JSON,Number,String,Math,Set,Error,
 Utilities:{formatDate(d,tz,format){if(format==='yyyy-MM-dd')return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);if(format==='MMM d')return new Intl.DateTimeFormat('en-US',{timeZone:tz,month:'short',day:'numeric'}).format(d);return d.toISOString();}},
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k),setProperty:(k,v)=>properties.set(k,v)})},
 SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:n=>sheets.get(n),insertSheet:n=>{const sh=new Sheet();sheets.set(n,sh);return sh;}}),flush(){}},
 LockService:{getScriptLock:()=>({waitLock(){},tryLock(){return true;},releaseLock(){}})},
 sheet_:sheet,json_:o=>({getContent:()=>JSON.stringify(o)}),ymdMs_:s=>Date.parse(s+'T00:00:00Z'),todayMs_:()=>Date.parse(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now))+'T00:00:00Z'),
 s_:String,sendEmail_:(d,msg)=>messages.push({ref:d.ref,...msg}),addNote_:(sh,row,n)=>sh.getRange(row,16).setValue(sh.getRange(row,16).getValue()+' | '+n),
 esc_:s=>String(s),childNames_:d=>d.kids,childDetailsBlock_:()=>'',directions_:()=>'',bring_:()=>'',signoff_:()=>'',cancelLink_:()=>'',sessTimes_:()=>({}),
 rowData_:(sh,row)=>{const v=sh.rows[row-1];return{ref:v[1],name:v[2],email:v[3],kids:v[5],kidsCount:v[6],weeks:v[7],codes:v[8],amount:v[11],lang:v[12],status:v[14],notes:v[15]||''};},
 appendBooking_:b=>{sheet().appendRow(['',b.ref,b.name,b.email,'',b.kids,b.kidsCount,b.weeks,b.weekCodes,b.weeksCount,b.tier,b.amountJpy,b.lang,'','form only','','']);return{};},
});
const constants=`const SHARED_TOKEN='test';const HEADERS=Array(17);const COL={ref:2,name:3,email:4,kids:6,kidsCount:7,weeks:8,codes:9,amount:12,lang:13,status:15,notes:16};const WEEK_MONDAYS=Array.from({length:12},(_,i)=>new Date(Date.parse('2026-10-05')+i*7*86400000).toISOString().slice(0,10));const DAYS=WEEK_MONDAYS;function zhDay_(d){return d;}`;
new vm.Script(constants+fs.readFileSync('operations/daily-booking.gs','utf8')).runInContext(ctx);
const read=r=>JSON.parse(r.getContent());
function reserve(ref,codes,kids=1){return read(ctx.reserveBooking_({ref,weekCodes:codes,kidsCount:kids,name:'Test',email:ref+'@example.invalid',kids:'Test Child',terms:'yes',amountJpy:1,lang:'en'}));}
function activate(ref,codes,kids=1){return read(ctx.activateBooking_({ref,weekCodes:codes,kidsCount:kids}));}
assert.equal(reserve('WEEKTEST01','W8AM',2).amountJpy,96000);
assert.equal(activate('WEEKTEST01','W8AM',2).activated,true);
assert.equal(reserve('DAYTEST001','D20261123AM').amountJpy,14000);
activate('DAYTEST001','D20261123AM');
assert.equal(ctx.confirmedClasses_().D20261123AM,undefined,'Two provisional week children cannot confirm a day unless the whole weekly booking qualifies');
assert.equal(reserve('LASTSEAT01','D20261123AM',3).ok,true);
assert.equal(reserve('LASTSEAT02','D20261123AM').code,'full','Atomic holds prevent simultaneous last-seat bookings');
ctx.clearHold_('LASTSEAT01');
for(const [i,date]of ['20261124','20261125','20261126'].entries()){const ref='DAYOTHER0'+i;reserve(ref,'D'+date+'AM');activate(ref,'D'+date+'AM');}
assert.equal(ctx.counts_(true).classes.D20261123AM,'confirmed');
assert.equal(read(ctx.chargeableBooking_({ref:'WEEKTEST01',code:'W8AM'})).chargeable,true);
assert.equal(ctx.counts_(true).sessions.D20261123AM,3);
assert.equal(ctx.counts_(true).W8AM,3);
assert.equal(reserve('TAMPER001','D20261123AM',2).amountJpy,28000);
assert.equal(reserve('TAMPER001','D20261124AM',2).code,'ref_conflict');
ctx.clearHold_('TAMPER001');
// Pending classes for next week are allowed inside the former 14-day window.
now=Date.parse('2026-11-13T12:00:00+09:00');
assert.equal(reserve('NEXTWEEK01','D20261117AM').ok,true);
ctx.clearHold_('NEXTWEEK01');
now=Date.parse('2026-11-12T12:00:00+09:00');
assert.equal(reserve('NEXTWEEK02','W7PM').ok,true);
ctx.clearHold_('NEXTWEEK02');
assert.equal(ctx.counts_(true).confirmationDays,3);
// Both AM and PM close at midnight, 3 calendar days before the class.
now=Date.parse('2026-11-19T23:59:59+09:00');
assert.equal(reserve('TOOLATE01','D20261123AM').ok,true);
assert.equal(reserve('TOOLATE02','D20261123PM').ok,true);
ctx.clearHold_('TOOLATE02');now=Date.parse('2026-11-20T00:00:00+09:00');
assert.equal(reserve('TOOLATE03','D20261123PM').code,'booking_closed');
now=Date.parse('2026-11-22T23:59:59+09:00');assert.equal(reserve('LATETOPUP1','D20261123AM').ok,true);
now=Date.parse('2026-11-23T00:00:00+09:00');assert.equal(reserve('SAMEDAY01','D20261123AM').code,'booking_closed');
// A checkout completing after the cutoff cannot activate or create an invoice.
now=Date.parse('2026-11-20T23:59:00+09:00');reserve('EXPIRED001','D20261124PM');now=Date.parse('2026-11-21T00:00:00+09:00');assert.equal(activate('EXPIRED001','D20261124PM').activated,false);
// The daily schedule cancels an underfilled class exactly once and releases its seats.
now=Date.parse('2026-11-20T12:00:00+09:00');
reserve('UNDERFILL1','D20261124PM');activate('UNDERFILL1','D20261124PM');
sheet().getRange(ctx.bookingRow_('UNDERFILL1'),15).setValue('card saved');
ctx.dailyEmails();assert.equal(messages.filter(m=>m.ref==='UNDERFILL1').length,0);
now=Date.parse('2026-11-21T08:00:00+09:00');ctx.dailyEmails();ctx.dailyEmails();
const cancellations=messages.filter(m=>m.ref==='UNDERFILL1');
assert.equal(cancellations.length,1);
assert.match(cancellations[0].body,/3 days before class/);
assert.equal(ctx.counts_(true).sessions.D20261124PM,0);
assert.equal(read(ctx.chargeableBooking_({ref:'UNDERFILL1',code:'D20261124PM'})).chargeable,false);
assert.equal(ctx.holdEmail_({name:'Test',kids:'Test',kidsCount:1,codes:'D20261123AM',amount:14000,ref:'TESTREF',lang:'en'}).body.includes('¥14,000'),true);
assert.match(ctx.holdEmail_({name:'Test',kids:'Test',kidsCount:1,codes:'D20261123AM',amount:14000,ref:'TESTREF',lang:'zh'}).body,/最少 3 日/);
console.log('Sheet reservation, shared capacity, next-week bookings, 3-day confirmation, daily cancellation, late top-ups and bilingual email tests passed. All services are mocked.');
