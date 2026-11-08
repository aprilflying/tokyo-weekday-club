/* TWC booking v9: ¥14,000/day, ¥48,000/four-day week; three children
 * in each actual dated session before charging. Applied to the existing
 * Apps Script without changing credentials, destinations, or triggers. */
function bookingUnit_(code) {
  var m=/^W([1-9]|1[0-2])(AM|PM)$/.exec(code), dates=[], type, session;
  if(m){type='week';session=m[2];var first=ymdMs_(WEEK_MONDAYS[Number(m[1])-1]);for(var d=0;d<4;d++)dates.push(Utilities.formatDate(new Date(first+d*86400000),'UTC','yyyy-MM-dd'));}
  else {
    m=/^D(2026)(\d{2})(\d{2})(AM|PM)$/.exec(code);
    if(!m)throw new Error('Invalid class code');
    var date=m[1]+'-'+m[2]+'-'+m[3], offset=(ymdMs_(date)-ymdMs_(WEEK_MONDAYS[0]))/86400000;
    if(!Number.isInteger(offset)||offset<0||offset>=84||offset%7>3||Utilities.formatDate(new Date(ymdMs_(date)),'UTC','yyyy-MM-dd')!==date)throw new Error('Invalid date');
    dates=[date];type='day';session=m[4];
  }
  return {code:code,type:type,dates:dates,date:dates[0],session:session,price:type==='day'?14000:48000,
    sessions:dates.map(function(d){return 'D'+d.replace(/-/g,'')+session;})};
}
function bookingUnits_(codes){return String(codes||'').split('-').filter(Boolean).map(bookingUnit_);}
function bookingOpen_(u){return Date.now()<new Date(u.date+'T00:00:00+09:00').getTime()+(u.type==='week'?86400000:0);}
function bookingStarted_(u){return Date.now()>=new Date(u.date+(u.session==='AM'?'T09:00:00+09:00':'T14:00:00+09:00')).getTime();}
function bookingHolds_(){var ss=SpreadsheetApp.getActiveSpreadsheet(),sh=ss.getSheetByName('TWC Booking Holds');if(!sh){sh=ss.insertSheet('TWC Booking Holds');sh.appendRow(['Ref','Expires at (ms)','Class codes','Children']);}return sh;}
function bookingRow_(ref){var sh=sheet_();if(sh.getLastRow()<2)return 0;var refs=sh.getRange(2,COL.ref,sh.getLastRow()-1,1).getValues();for(var i=0;i<refs.length;i++)if(String(refs[i][0])===String(ref))return i+2;return 0;}
function clearHold_(ref){var sh=bookingHolds_();if(sh.getLastRow()<2)return;var rows=sh.getRange(2,1,sh.getLastRow()-1,4).getValues();rows.forEach(function(v,i){if(String(v[0])===String(ref))sh.getRange(i+2,2).setValue(0);});}
function putHold_(ref,codes,kids){var sh=bookingHolds_(),row=0;var rows=sh.getLastRow()>1?sh.getRange(2,1,sh.getLastRow()-1,4).getValues():[];rows.forEach(function(v,i){if(String(v[0])===String(ref))row=i+2;});var value=[ref,Date.now()+35*60000,codes,kids];if(row)sh.getRange(row,1,1,4).setValues([value]);else sh.appendRow(value);}
function counts_(fresh,excludeRef){
  var savedClasses=confirmedClasses_();var out={bookingVersion:9,max:6,min:3,sessions:{},confirmed:{},classes:{},closedWeeks:{}};Object.keys(savedClasses).forEach(function(c){out.classes[c]='confirmed';});
  for(var w=1;w<=12;w++)['AM','PM'].forEach(function(s){bookingUnit_('W'+w+s).sessions.forEach(function(c){out.sessions[c]=0;out.confirmed[c]=0;});});
  var sh=sheet_(),active={};
  var rows=sh.getLastRow()>1?sh.getRange(2,1,sh.getLastRow()-1,HEADERS.length).getValues():[];
  rows.forEach(function(v){
    var ref=String(v[COL.ref-1]),status=String(v[COL.status-1]);
    if(ref===excludeRef||active[ref]||!['card active','card saved','paid'].includes(status))return;
    active[ref]=true;var n=Number(v[COL.kidsCount-1])||1;
    bookingUnits_(v[COL.codes-1]).forEach(function(u){if(String(v[COL.notes-1]||'').indexOf('not running '+u.code+' ')!==-1)return;if(Date.now()>=confirmationDeadline_(u)&&!u.sessions.every(function(c){return !!savedClasses[c];}))return;u.sessions.forEach(function(c){out.sessions[c]+=n;out.confirmed[c]+=n;});});
  });
  var holds=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('TWC Booking Holds');
  if(holds&&holds.getLastRow()>1)holds.getRange(2,1,holds.getLastRow()-1,4).getValues().forEach(function(v){
    if(String(v[0])===excludeRef||active[String(v[0])]||Number(v[1])<=Date.now())return;
    bookingUnits_(v[2]).forEach(function(u){u.sessions.forEach(function(c){out.sessions[c]+=Number(v[3])||1;});});
  });
  for(var i=1;i<=12;i++)['AM','PM'].forEach(function(s){var code='W'+i+s,u=bookingUnit_(code);out.closedWeeks[code]=!canBookClass_(u,savedClasses);out[code]=out.closedWeeks[code]?6:Math.max.apply(null,u.sessions.map(function(c){return out.sessions[c];}));});
  return out;
}
function reserveBooking_(b){
  var kids=Number(b.kidsCount),units=bookingUnits_(b.weekCodes),ref=String(b.ref||'');
  if(!/^[A-Za-z0-9_-]{8,200}$/.test(ref)||!Number.isInteger(kids)||kids<1||kids>6||!units.length||units.length>20||b.terms!=='yes')return json_({ok:false,error:'Invalid booking'});
  if(units.some(function(u){return u.type!==units[0].type;})||new Set(units.map(function(u){return u.date;})).size!==units.length)return json_({ok:false,error:'Duplicate or mixed dates'});
  if(units.some(function(u){return !canBookClass_(u,confirmedClasses_());}))return json_({ok:false,code:'booking_closed',error:'A selected date has closed.'});
  var row=bookingRow_(ref),sh=sheet_();
  if(row){var old=rowData_(sh,row);if(old.status==='cancelled')return json_({ok:false,code:'cancelled',error:'This booking was cancelled.'});
    if(old.codes!==b.weekCodes||old.kidsCount!==kids||String(old.email).toLowerCase()!==String(b.email).toLowerCase())return json_({ok:false,code:'ref_conflict',error:'Please start a new booking after changing your dates.'});
    if(['card active','card saved','paid'].includes(old.status))return json_({ok:false,code:'ref_conflict',error:'Your card has already been saved. Check your email.'});}
  var counts=counts_(true,ref),full=[];units.forEach(function(u){u.sessions.forEach(function(c){if(counts.sessions[c]+kids>6)full.push(c);});});
  if(full.length)return json_({ok:false,code:'full',full:full,error:'A selected session has insufficient places.'});
  b.amountJpy=units.reduce(function(n,u){return n+u.price*kids;},0);b.weeksCount=units.length;b.tier=units[0].type;b.weeks=units.map(function(u){return weekLabel_(u.code,b.lang==='zh');}).join('; ');
  if(!row){appendBooking_(b);row=bookingRow_(ref);}else{sh.getRange(row,COL.weeks).setValue(s_(b.weeks));sh.getRange(row,COL.amount).setValue(b.amountJpy);sh.getRange(row,11).setValue(b.tier);}
  putHold_(ref,b.weekCodes,kids);SpreadsheetApp.flush();
  return json_({ok:true,bookingVersion:9,amountJpy:b.amountJpy});
}
function activateBooking_(b){
  var sh=sheet_(),row=bookingRow_(b.ref);if(!row)return json_({ok:false,error:'Booking not found'});
  var d=rowData_(sh,row);
  if(d.codes!==b.weekCodes||d.kidsCount!==Number(b.kidsCount))return json_({ok:false,error:'Booking metadata mismatch'});
  if(['cancelled','needs review'].includes(d.status))return json_({ok:true,activated:false});
  if(['card active','card saved','paid'].includes(d.status)){reconcileClasses_();return json_({ok:true,activated:true});}
  var units=bookingUnits_(d.codes),counts=counts_(true,d.ref);
  if(units.some(function(u){return !canBookClass_(u,confirmedClasses_())||u.sessions.some(function(c){return counts.sessions[c]+d.kidsCount>6;});})){
    sh.getRange(row,COL.status).setValue('needs review');clearHold_(d.ref);
    sendEmail_(d,{subject:d.lang==='zh'?'預約需要跟進 · 未收費':'Booking needs attention · no charge',body:d.lang==='zh'?'<p>信用卡設定完成時，所選時段已額滿或開始，預約未能確認，沒有收費。請回覆此電郵安排其他日期。</p>':'<p>When card setup completed, a selected session was full or had started. Your booking is not confirmed and has not been charged. Please reply to arrange another date.</p>'});
    return json_({ok:true,activated:false});
  }
  sh.getRange(row,COL.status).setValue('card active');clearHold_(d.ref);SpreadsheetApp.flush();reconcileClasses_();return json_({ok:true,activated:true});
}
function chargeableBooking_(b){
  var row=bookingRow_(b.ref);if(!row)return json_({ok:true,chargeable:false});
  var d=rowData_(sheet_(),row),u=bookingUnit_(b.code),c=counts_(true);
  var active=['card active','card saved','paid'].includes(d.status)&&d.codes.split('-').includes(b.code);
  return json_({ok:true,chargeable:active&&d.notes.indexOf('not running '+u.code+' ')===-1&&!bookingStarted_(u)&&u.sessions.every(function(s){return c.classes[s]==='confirmed'&&c.confirmed[s]>=3;})});
}
function doPost(e){
  var lock=LockService.getScriptLock();try{lock.waitLock(20000);var b=JSON.parse((e&&e.postData&&e.postData.contents)||'{}');
    if(b.token!==SHARED_TOKEN)return json_({ok:false,error:'unauthorised'});if(b.website)return json_({ok:true});
    if(b.action==='reserve')return reserveBooking_(b);if(b.action==='activate')return activateBooking_(b);if(b.action==='chargeable')return chargeableBooking_(b);
    if(b.action==='status')return setStatus_(b);return appendBooking_(b);
  }catch(err){return json_({ok:false,error:String(err)});}finally{try{lock.releaseLock();}catch(_){}}
}
function doGet(e){if(e&&e.parameter&&e.parameter.counts==='1')return json_(counts_(true));return json_({ok:true,service:'twc-bookings',version:9,bookingVersion:9});}
function daysToMonday_(code){try{return Math.round((ymdMs_(bookingUnit_(code).date)-todayMs_())/86400000);}catch(_){return null;}}
function weekLabel_(code,zh){
  var u;try{u=bookingUnit_(code);}catch(_){return String(code||'');}
  var date=u.type==='week'?DAYS[Number(/^W(\d+)/.exec(code)[1])-1]:Utilities.formatDate(new Date(ymdMs_(u.date)),'UTC','MMM d');
  var display=zh?(u.type==='week'?zhDay_(date):Number(u.date.slice(5,7))+'月'+Number(u.date.slice(8))+'日'):date;
  return display+' · '+(u.session==='AM'?'09:00–12:00':'14:00–17:00')+(zh?'（東京時間）':' (Tokyo time)');
}
function bookingSubjectWeeks_(d,zh){var codes=String(d.codes||'').split('-').filter(Boolean);return codes.length===1?weekLabel_(codes[0],zh):(zh?codes.length+' 個班別':codes.length+' classes');}
function holdEmail_(d){
  var zh=d.lang==='zh',codes=String(d.codes).split('-').filter(Boolean),dates=codes.map(function(c){return weekLabel_(c,zh);}).join('; '),yen='¥'+Number(d.amount).toLocaleString('en-US');
  var body=zh?`<p>${esc_(d.name)} 你好，</p>${childDetailsBlock_(d,true)}<p>已收到你的預約及信用卡設定：<b>${esc_(dates)}</b>。</p><p><b>總額：${yen}</b>，共 ${d.kidsCount} 位小朋友。</p><p>同一日、同一時段須於上課前最少 14 日滿 3 人確認開班後才收費；最多 6 人。整週預約須四日均符合開班條件。已確認班可預約至前一日。已確認班別可隨即扣款，未能開班不收費。</p><p>確認及扣款前可<a href="${cancelLink_(d.ref)}">免費取消</a>。確認後，上課前 14 日或以上可退 50%；少於 14 日或缺席恕不退款。單日按所選日期、整週按第一日計算。</p>${directions_(true)}${bring_(true)}${signoff_(true,d.ref)}`:
    `<p>Hi ${esc_(d.name)},</p>${childDetailsBlock_(d,false)}<p>We have received your booking and saved card: <b>${esc_(dates)}</b>.</p><p><b>Total: ${yen}</b> for ${d.kidsCount} child(ren).</p><p>Each dated session needs at least 3 children confirmed at least 14 days before class, with a maximum of 6. We charge after confirmation. Weekly bookings require all 4 days to qualify. Confirmed classes accept late bookings until the day before. Confirmed classes may be charged immediately. Classes that do not run are not charged.</p><p><a href="${cancelLink_(d.ref)}">Cancel free before confirmation and charging</a>. After confirmation: 50% refund with 14+ days' notice; less than 14 days and no-shows are non-refundable. Notice is measured from the selected day, or the first day of a weekly booking.</p>${directions_(false)}${bring_(false)}${signoff_(false,d.ref)}`;
  return {subject:zh?'已收到預約 · '+bookingSubjectWeeks_(d,true):'Booking received · '+bookingSubjectWeeks_(d,false),body:body};
}
function confirmedEmail_(d,code,charged){var zh=d.lang==='zh',date=weekLabel_(code,zh),t=sessTimes_(code,zh);return {subject:zh?'預約確認 · '+date:'Confirmed · '+date,body:zh?`<p>${esc_(d.name)} 你好，</p>${childDetailsBlock_(d,true)}<p>你所選的 <b>${esc_(date)}</b> 已確認開班。</p><p><b>已收費 ${esc_(charged)}</b>。Stripe 會另外寄出收據。</p><p>${t.doors}，${t.line}。</p>${directions_(true)}${bring_(true)}${signoff_(true,d.ref)}`:`<p>Hi ${esc_(d.name)},</p>${childDetailsBlock_(d,false)}<p>Your booked class, <b>${esc_(date)}</b>, is confirmed.</p><p><b>Charged: ${esc_(charged)}</b>. Your Stripe receipt will arrive separately.</p><p>${t.doors}, ${t.line}.</p>${directions_(false)}${bring_(false)}${signoff_(false,d.ref)}`};}
function reminderEmail_(d,code){var zh=d.lang==='zh',date=weekLabel_(code,zh),t=sessTimes_(code,zh);return {subject:zh?'上課提醒 · '+date:'Class reminder · '+date,body:zh?`<p>${esc_(d.name)} 你好，</p><p>期待在 <b>${esc_(date)}</b> 見到 ${esc_(childNames_(d,true))}。</p><p>${t.doorsStart}。${t.pickup}。</p>${directions_(true)}${bring_(true)}${signoff_(true,d.ref)}`:`<p>Hi ${esc_(d.name)},</p><p>We look forward to seeing ${esc_(childNames_(d,false))} for <b>${esc_(date)}</b>.</p><p>${t.doorsStart}. ${t.pickup}.</p>${directions_(false)}${bring_(false)}${signoff_(false,d.ref)}`};}
function thanksEmail_(d){var zh=d.lang==='zh';return {subject:zh?'多謝你，'+childNames_(d,true)+'！':'Thank you, '+childNames_(d,false)+'!',body:zh?`<p>${esc_(d.name)} 你好，</p><p>多謝你讓 ${esc_(childNames_(d,true))} 和我們一起學日文！希望下次來東京再見。</p>${signoff_(true,'')}`:`<p>Hi ${esc_(d.name)},</p><p>Thank you for letting ${esc_(childNames_(d,false))} learn Japanese with us! We hope to see you next time you are in Tokyo.</p>${signoff_(false,'')}`};}
function statusEmail_(d,status,note){if(!d.email)return;if(status==='card saved')return sendEmail_(d,holdEmail_(d));if(status==='cancelled')return sendEmail_(d,cancelledEmail_(d));if(status==='paid'){var m=/paid ((?:W\d+|D\d{8})(?:AM|PM))(?: (¥[\d,]+))?/.exec(String(note||''));if(!m)throw new Error('Missing paid class');return sendEmail_(d,confirmedEmail_(d,m[1],m[2]||'¥'+(bookingUnit_(m[1]).price*d.kidsCount).toLocaleString('en-US')));}}
function dailyEmails(){
  var lock=LockService.getScriptLock();if(!lock.tryLock(20000))return;try{
  var classes=reconcileClasses_();
  // The existing daily trigger now sends reminders only. Charging is governed
  // by dated session counts in the Stripe webhook, never by a 14-day timer.
  var sh=sheet_();for(var row=2;row<=sh.getLastRow();row++){
    var d=rowData_(sh,row);if(!d.email||!['card saved','paid'].includes(d.status))continue;
    bookingUnits_(d.codes).forEach(function(u){var diff=daysToMonday_(u.code),paid=d.notes.indexOf('paid '+u.code+' ')!==-1;
      if(!paid&&Date.now()>=confirmationDeadline_(u)&&!u.sessions.every(function(c){return !!classes[c];})&&d.notes.indexOf('not running '+u.code+' ')===-1){sendEmail_(d,classNotRunningEmail_(d,u));addNote_(sh,row,'not running '+u.code+' deadline');}

      if(!paid)return;
      if(diff>=1&&diff<=3&&d.notes.indexOf('r3 '+u.code)===-1){sendEmail_(d,reminderEmail_(d,u.code));addNote_(sh,row,'r3 '+u.code);}
    });
    var units=bookingUnits_(d.codes),last=units.map(function(u){return ymdMs_(u.dates[u.dates.length-1]);}).sort(function(a,b){return b-a;})[0];
    if(last&&todayMs_()>last&&todayMs_-last<=7*86400000&&units.every(function(u){return d.notes.indexOf('paid '+u.code+' ')!==-1;})&&d.notes.indexOf('thx booking')===-1){sendEmail_(d,thanksEmail_(d));addNote_(sh,row,'thx booking');}
  }
  }finally{lock.releaseLock();}
}
function confirmationDeadline_(u){return new Date(u.date+(u.session==='AM'?'T09:00:00+09:00':'T14:00:00+09:00')).getTime()-14*86400000;}
function confirmedClasses_(){return JSON.parse(PropertiesService.getScriptProperties().getProperty('TWC_CONFIRMED_CLASSES_V9')||'{}');}
function canBookClass_(u,classes){return Date.now()<new Date(u.date+'T00:00:00+09:00').getTime()&&(Date.now()<confirmationDeadline_(u)||u.sessions.every(function(c){return !!classes[c];}));}
function reconcileClasses_(){
  var classes=confirmedClasses_(),sh=sheet_(),entries=[];
  for(var row=2;row<=sh.getLastRow();row++){
    var d=rowData_(sh,row);if(!['card active','card saved','paid'].includes(d.status))continue;
    bookingUnits_(d.codes).forEach(function(u){
      if(d.notes.indexOf('not running '+u.code+' ')!==-1)return;
      // Previously paid classes already have a confirmation; retain it.
      if(d.notes.indexOf('paid '+u.code+' ')!==-1)u.sessions.forEach(function(c){classes[c]=classes[c]||'legacy-paid';});
      if(Date.now()<confirmationDeadline_(u)||u.sessions.every(function(c){return !!classes[c];}))entries.push({unit:u,kids:d.kidsCount});
    });
  }
  // Weekly participants only count towards a class that can actually run as
  // their full four-day booking. Remove provisional units until stable.
  var candidates=entries.slice(),changed=true;
  while(changed){var numbers={};candidates.forEach(function(e){e.unit.sessions.forEach(function(c){numbers[c]=(numbers[c]||0)+e.kids;});});var next=candidates.filter(function(e){return e.unit.sessions.every(function(c){return !!classes[c]||(numbers[c]||0)>=3;});});changed=next.length!==candidates.length;candidates=next;}
  candidates.forEach(function(e){if(Date.now()<confirmationDeadline_(e.unit))e.unit.sessions.forEach(function(c){classes[c]=classes[c]||new Date().toISOString();});});
  PropertiesService.getScriptProperties().setProperty('TWC_CONFIRMED_CLASSES_V9',JSON.stringify(classes));return classes;
}
function classNotRunningEmail_(d,u){var zh=d.lang==='zh',date=weekLabel_(u.code,zh);return {subject:zh?'班別未能開辦 · '+date:'Class will not run · '+date,body:zh?`<p>${esc_(d.name)} 你好，</p><p>${esc_(date)} 未能在上課前 14 日達到開班條件，因此不會開辦，亦不會收取該班費用。</p><p>歡迎回覆電郵，讓我們為你安排其他可選班別。</p>${signoff_(true,d.ref)}`:`<p>Hi ${esc_(d.name)},</p><p>${esc_(date)} did not meet the confirmation requirements 14 days before class, so it will not run. You will not be charged for that class.</p><p>Please reply if you would like help choosing another available class.</p>${signoff_(false,d.ref)}`};}

function checkClassDeadlinesV9(){
  var lock=LockService.getScriptLock();if(!lock.tryLock(20000))return;
  try{var classes=reconcileClasses_(),sh=sheet_();
    for(var row=2;row<=sh.getLastRow();row++){var d=rowData_(sh,row);if(!d.email||!['card active','card saved','paid'].includes(d.status))continue;
      bookingUnits_(d.codes).forEach(function(u){if(Date.now()>=confirmationDeadline_(u)&&!u.sessions.every(function(c){return !!classes[c];})&&d.notes.indexOf('paid '+u.code+' ')===-1&&d.notes.indexOf('not running '+u.code+' ')===-1){sendEmail_(d,classNotRunningEmail_(d,u));addNote_(sh,row,'not running '+u.code+' deadline');}});
    }
  }finally{lock.releaseLock();}
}
function installDailyBookingV9(){
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  if(!ss||ss.getId()!=='149xWTGnS1FtzWZeMEteNSS249RYIjNdLBEeJ3zHgHdk')throw new Error('Wrong booking spreadsheet; no changes made');
  var lock=LockService.getScriptLock();lock.waitLock(20000);
  try{bookingHolds_();reconcileClasses_();
    if(!ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()==='checkClassDeadlinesV9';}))ScriptApp.newTrigger('checkClassDeadlinesV9').timeBased().everyMinutes(15).create();
    if(!ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()==='dailyEmails';}))ScriptApp.newTrigger('dailyEmails').timeBased().everyDays(1).atHour(8).inTimezone('Asia/Tokyo').create();
    console.log('TWC booking v9 ready: correct spreadsheet, daily price 14000, weekly price 48000, 3–6 children, 14-day confirmation. Existing data and triggers preserved. No emails sent by setup.');
  }finally{lock.releaseLock();}
}
