export const DAILY_PRICE = 14000;
export const WEEKLY_PRICE = 48000;
export const PRICING_VERSION = 'family-v2';
export function familyDiscount(kids) { return kids >= 3 ? 20 : kids === 2 ? 10 : 0; }
export function bookingAmount(price, kids, version = PRICING_VERSION) {
  if (version && ![PRICING_VERSION, 'daily-v1-min3'].includes(version)) throw new Error('Unknown pricing version');
  return Math.round(price * kids * (100 - (version === PRICING_VERSION ? familyDiscount(kids) : 0)) / 100);
}
export const MAX_CHILDREN = 6;
export const MIN_CHILDREN = 3;
export const CONFIRMATION_DAYS = 3;
export const FIRST_MONDAY = '2026-10-05';
export const WEEK_COUNT = 21;
const DAY = 86400000;
const FIRST = Date.parse(FIRST_MONDAY + 'T00:00:00Z');

export function dateAt(week, day = 0) {
  return new Date(FIRST + (week * 7 + day) * DAY).toISOString().slice(0, 10);
}
export function dayCode(date, session, venue = 'musashi-koyama') { return (venue === 'kaminoge' ? 'K' : '') + 'D' + date.replaceAll('-', '') + session.toUpperCase(); }
export function parseCode(code) {
  const venue = code.startsWith('K') ? 'kaminoge' : 'musashi-koyama';
  const raw = venue === 'kaminoge' ? code.slice(1) : code;
  let m = /^W([1-9]|1[0-9]|2[01])(AM|PM)$/.exec(raw);
  if (m) {
    const i = Number(m[1]) - 1;
    return { code, venue, type: 'week', price: WEEKLY_PRICE, date: dateAt(i), session: m[2].toLowerCase(),
      dates: Array.from({ length: 4 }, (_, d) => dateAt(i, d)) };
  }
  m = /^D(2026|2027)(\d{2})(\d{2})(AM|PM)$/.exec(raw);
  if (!m) throw new Error('Invalid class');
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const offset = (Date.parse(date + 'T00:00:00Z') - FIRST) / DAY;
  if (!Number.isInteger(offset) || offset < 0 || offset >= WEEK_COUNT * 7 || offset % 7 > 3 ||
      new Date(FIRST + offset * DAY).toISOString().slice(0, 10) !== date) throw new Error('Invalid class date');
  return { code, venue, type: 'day', price: DAILY_PRICE, date, dates: [date], session: m[4].toLowerCase() };
}
export function sessionCodes(unit) { return unit.dates.map(d => dayCode(d, unit.session, unit.venue)); }
export function isOpen(unit, now = Date.now()) {
  // Preserve the existing weekly Tuesday-midnight cutoff. Single days close
  // at midnight Tokyo time on the selected date (no same-day bookings).
  const cutoff = Date.parse(unit.date + 'T00:00:00+09:00') + (unit.type === 'week' ? DAY : 0);
  return now < cutoff;
}
export function hasStarted(unit, now = Date.now()) {
  return now >= Date.parse(unit.date + (unit.session === 'am' ? 'T09:00:00+09:00' : 'T14:00:00+09:00'));
}
export function confirmationDeadline(unit) {
  // Close unconfirmed classes at the start of the third calendar day before
  // class in Tokyo. The daily morning job can notify parents that same day.
  return Date.parse(unit.date + 'T00:00:00+09:00') - CONFIRMATION_DAYS * DAY;
}
export function canBook(unit, counts, now = Date.now()) {
  // Both new and confirmed bookings close before the first booked date.
  if (now >= Date.parse(unit.date + 'T00:00:00+09:00')) return false;
  return now < confirmationDeadline(unit) || sessionCodes(unit).every(c => counts.classes?.[c] === 'confirmed');
}
export function label(unit, lang = 'en') {
  const zh = lang === 'zh';
  const fmt = d => new Intl.DateTimeFormat(zh ? 'zh-Hant' : 'en-GB', {month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(d+'T00:00:00Z'));
  return `${venueLabel(unit.venue, lang)} · ${fmt(unit.date)}${unit.type === 'week' ? ' – ' + fmt(unit.dates[3]) : ''} · ${unit.session === 'am' ? '09:00–12:00' : '14:00–17:00'} (JST)`;
}
export function venueLabel(venue, lang = 'en') { return venue === 'kaminoge' ? (lang === 'zh' ? '上野毛' : 'Kaminoge') : (lang === 'zh' ? '武藏小山' : 'Musashi-Koyama'); }
export function normaliseBooking(body, now = Date.now()) {
  const venue = body.venue || 'musashi-koyama';
  if (!['musashi-koyama', 'kaminoge'].includes(venue)) throw new Error('Choose a valid venue');
  const type = body.bookingType || 'week';
  const input = type === 'day' ? body.days : body.weeks;
  if (!['day','week'].includes(type) || !Array.isArray(input) || !input.length || input.length > (type === 'day' ? 20 : WEEK_COUNT)) throw new Error('Choose valid dates');
  const kids = Number(body.kidsCount);
  if (!Number.isInteger(kids) || kids < 1 || kids > MAX_CHILDREN) throw new Error('Choose 1–6 children');
  const units = input.map(v => {
    if (!['am','pm'].includes(v.s)) throw new Error('Choose morning or afternoon');
    if (type === 'week' && (!Number.isInteger(v.i) || v.i < 0 || v.i >= WEEK_COUNT)) throw new Error('Invalid week');
    if (type === 'day' && !/^(2026|2027)-\d{2}-\d{2}$/.test(v.date)) throw new Error('Invalid date');
    return parseCode(type === 'day' ? dayCode(v.date,v.s,venue) : `${venue === 'kaminoge' ? 'K' : ''}W${v.i + 1}${v.s.toUpperCase()}`);
  }).sort((a,b)=>a.date.localeCompare(b.date));
  if (new Set(units.map(u=>u.date)).size !== units.length) throw new Error('Choose one session per date');
  if (units.some(u=>!isOpen(u,now))) {
    const error = new Error('A selected date has closed for booking. Please choose an upcoming date.');
    error.code = type === 'week' ? 'week_closed' : 'day_closed';
    throw error;
  }
  return { type, venue, kids, units, codes: units.map(u=>u.code), discountPercent: familyDiscount(kids), total: units.reduce((sum,u)=>sum+bookingAmount(u.price,kids),0) };
}
export function readyToCharge(unit, counts, now = Date.now()) {
  return !hasStarted(unit,now) && sessionCodes(unit).every(code => counts.classes?.[code] === 'confirmed' && Number(counts.confirmed?.[code]) >= MIN_CHILDREN);
}
