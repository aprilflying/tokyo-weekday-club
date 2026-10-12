/**
 * Preserve the original site exports; add the Tokyo booking deadline/history.
 * Currency strings contain $ followed by a quote. NEVER use source text as a
 * String.replace replacement string: it would inject closing script tags.
 * Validate the emitted HTML, not only the pre-serialization JavaScript.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const MARKER = 'TWC_BOOKING_HISTORY_V2';
const FIRST_CUTOFF = Date.parse('2026-10-06T00:00:00+09:00');
const WEEK = 7 * 86400000;
const SCRIPT = /<script\b[^>]*\bdata-dc-script\b[^>]*>([\s\S]*?)<\/script>/gi;
const METHODS = `
  // TWC_BOOKING_HISTORY_V2: original week IDs, 14-day closed-week history.
  static bookingCutoff(i) {
    return Date.parse('2026-10-06T00:00:00+09:00') + i * 7 * 86400000;
  }
  static bookingWeekOpen(i, now = Date.now()) {
    return Number.isInteger(i) && i >= 0 && i < 12 && now < Component.bookingCutoff(i);
  }
  static bookingWeekVisible(i, now = Date.now()) {
    return Number.isInteger(i) && i >= 0 && i < 12 && now < Component.bookingCutoff(i) + 14 * 86400000;
  }
  openBookingSelections() {
    return Object.fromEntries(Object.entries(this.state.sels || {}).filter(([i]) => Component.bookingWeekOpen(Number(i))));
  }
  rejectClosedBooking() {
    const sels = this.openBookingSelections();
    const zh = (this.state.lang ?? this.props.lang ?? 'en') === 'zh';
    this.setState({ sels, sent: false, holding: false, booking: null,
      noWeeks: Object.keys(sels).length === 0,
      holdError: zh ? '所選的星期已截止預約，請選擇其他星期。' : 'A selected week has closed for booking. Please choose an upcoming week.' });
  }
  startBookingClock() {
    this.stopBookingClock();
    this._bookingClockRefresh = () => {
      const now = Date.now();
      const expiredSelection = Object.keys(this.state.sels || {}).some(i => !Component.bookingWeekOpen(Number(i), now));
      const pending = this.state.booking;
      const expiredPending = pending && Array.isArray(pending.weeksSel) && pending.weeksSel.some(w => !Component.bookingWeekOpen(w.i, now));
      const q = new URLSearchParams(window.location.search);
      if (!q.has('held') && !q.has('cancel') && !this.state.cancelRef && (expiredSelection || expiredPending)) this.rejectClosedBooking();
      this.setState({ _bookingClockTime: now });
      clearTimeout(this._bookingClockTimer);
      const events = Array.from({ length: 12 }, (_, i) => Component.bookingCutoff(i)).flatMap(t => [t, t + 14 * 86400000]);
      const next = events.filter(t => t > now).sort((a, b) => a - b)[0];
      this._bookingClockTimer = next === undefined ? null : setTimeout(this._bookingClockRefresh, Math.min(next - now + 1, 86400000));
    };
    window.addEventListener('focus', this._bookingClockRefresh);
    window.addEventListener('pageshow', this._bookingClockRefresh);
    document.addEventListener('visibilitychange', this._bookingClockRefresh);
    this._bookingClockRefresh();
  }
  stopBookingClock() {
    clearTimeout(this._bookingClockTimer);
    if (!this._bookingClockRefresh) return;
    window.removeEventListener('focus', this._bookingClockRefresh);
    window.removeEventListener('pageshow', this._bookingClockRefresh);
    document.removeEventListener('visibilitychange', this._bookingClockRefresh);
    this._bookingClockRefresh = null;
  }
`;

function once(text, before, after, label) {
  assert.equal(text.split(before).length - 1, 1, `Expected exactly one ${label}`);
  return text.replace(before, () => after);
}
function scriptSource(html) {
  const matches = [...html.matchAll(SCRIPT)];
  assert.equal(matches.length, 1, 'Expected exactly one booking component');
  return matches[0];
}

export function patchHtml(html) {
  assert(!html.includes(MARKER), 'Use the unmodified repository export');
  const match = scriptSource(html);
  const original = match[1];
  let source = original;
  source = once(source, 'class Component extends DCLogic {', 'class Component extends DCLogic {' + METHODS, 'Component declaration');
  source = once(source, '  componentDidMount() {', '  componentDidMount() {\n    this.startBookingClock();', 'mount hook');
  source = once(source, '  componentWillUnmount() {', '  componentWillUnmount() { this.stopBookingClock();', 'unmount hook');
  source = once(source, '    const sels = this.state.sels;', '    const sels = this.openBookingSelections();', 'booking selections');
  source = once(source, '      const full = amFull && pmFull;', '      const full = amFull && pmFull;\n      const closed = !Component.bookingWeekOpen(i);', 'capacity and deadline');
  source = once(source, 'days: en ? d : zhD(d), selected, full,', 'days: en ? d : zhD(d), selected, full, closed, closedNotFull: closed && !full,', 'tile states');
  source = once(source, '(!selected && !full) ?', '(!selected && !full && !closed) ?', 'tile hint');
  source = once(source, "cursor: full ? 'not-allowed'", "cursor: (full || closed) ? 'not-allowed'", 'tile cursor');
  source = once(source, "borderStyle: full ? 'dashed'", "borderStyle: (full || closed) ? 'dashed'", 'tile border');
  source = once(source, "bg: full ? '#F1EAE0'", "bg: (full || closed) ? '#F1EAE0'", 'tile background');
  source = once(source, "fg: full ? 'rgba(15,15,18,.38)'", "fg: (full || closed) ? 'rgba(15,15,18,.38)'", 'tile text');
  source = once(source, '    });\n    const picked = Object.keys(sels)', '    }).filter((w, i) => Component.bookingWeekVisible(i));\n    const picked = Object.keys(sels)', 'week map boundary');
  source = once(source, 'pick: () => { if (full) return;', 'pick: () => { if (!Component.bookingWeekOpen(i) || full) return;', 'week picker');
  source = once(source, 'e.stopPropagation(); if (amFull) return;', 'e.stopPropagation(); if (!Component.bookingWeekOpen(i) || amFull) return;', 'AM picker');
  source = once(source, 'e.stopPropagation(); if (pmFull) return;', 'e.stopPropagation(); if (!Component.bookingWeekOpen(i) || pmFull) return;', 'PM picker');
  source = once(source, '        const fd = new FormData(e.target);', `        if (picked.some(i => !Component.bookingWeekOpen(i)) || Object.keys(this.state.sels || {}).some(i => !Component.bookingWeekOpen(Number(i)))) { this.rejectClosedBooking(); return; }
        if (picked.length === 0) { this.setState({ noWeeks: true }); return; }
        const fd = new FormData(e.target);`, 'form submission guard');
  source = once(source, '        if (!b || this.state.holding) return;', `        if (!b || this.state.holding) return;
        if (!Array.isArray(b.weeksSel) || !b.weeksSel.length || b.weeksSel.some(w => !Component.bookingWeekOpen(w.i))) { this.rejectClosedBooking(); return; }`, 'checkout guard');
  source = once(source, "          if (j.code === 'full') {", "          if (j.code === 'week_closed') { this.rejectClosedBooking(); return; }\n          if (j.code === 'full') {", 'server deadline response');
  source = once(source, '      weeks, selDays, selDaysZh,', '      noUpcomingWeeks: !weeks.some(w => !w.closed),\n      weeks, selDays, selDaysZh,', 'empty-term state');
  new vm.Script(source);
  // Literal slicing prevents $ currency strings from becoming replacement tokens.
  const offset = match.index + match[0].indexOf('>') + 1;
  let output = html.slice(0, offset) + source + html.slice(offset + original.length);
  output = once(output, '            <sc-for list="{{ weeks }}" as="w" hint-placeholder-count="6">', `            <sc-if value="{{ noUpcomingWeeks }}" hint-placeholder-val="{{ false }}"><p style="color:#FAF7F2;margin:0"><sc-if value="{{ en }}"><span>New dates will be announced soon. Please contact us about future weeks.</span></sc-if><sc-if value="{{ zh }}"><span>新一期日期將會公布，歡迎聯絡我們查詢。</span></sc-if></p></sc-if>
            <sc-for list="{{ weeks }}" as="w" hint-placeholder-count="6">`, 'empty-term message');
  output = once(output, '                <sc-if value="{{ w.full }}"', `                <sc-if value="{{ w.closedNotFull }}" hint-placeholder-val="{{ false }}"><div style="font-family:'JetBrains Mono',monospace;font-size:10.5px;margin-top:4px;letter-spacing:0.06em"><sc-if value="{{ en }}"><span>Bookings closed</span></sc-if><sc-if value="{{ zh }}"><span>預約已截止</span></sc-if></div></sc-if>
                <sc-if value="{{ w.full }}"`, 'closed label');
  output = once(output, '>full · 已滿</div>', '>fully booked · 已滿</div>', 'full label');
  // Critical regression: test the exact bytes browsers will read from the HTML.
  const emitted = scriptSource(output)[1];
  assert.equal(emitted, source, 'Emitted script was truncated or altered');
  new vm.Script(emitted);
  assert.equal((output.match(/<\/script>/gi) || []).length, (html.match(/<\/script>/gi) || []).length, 'Extra closing script tags');
  const images = s => [...s.matchAll(/data:image\/[^\s"']+/g)].map(m => m[0]);
  assert.deepEqual(images(output), images(html), 'Inline image assets changed');
  return { html: output, source: emitted, original };
}

function harness(source, language) {
  let now = FIRST_CUTOFF - 1;
  let nextId = 0;
  const timers = new Map(), listeners = new Map(), requests = [];
  const BaseDate = Date;
  class TestDate extends BaseDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  class Logic {
    constructor() { this.props = { lang: language }; this.state = {}; }
    setState(change) { this.state = { ...this.state, ...(typeof change === 'function' ? change(this.state) : change) }; }
  }
  const events = prefix => ({
    addEventListener: (type, fn) => listeners.set(prefix + type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(prefix + type) === fn) listeners.delete(prefix + type); },
  });
  const location = { search: '', href: 'https://www.tokyoweekdayclub.com/', pathname: '/' };
  const ctx = vm.createContext({
    DCLogic: Logic, React: { createRef: () => ({ current: null }) }, Date: TestDate, Intl,
    URLSearchParams, URL, FormData, Response, Request,
    window: { location, ...events('window:'), scrollTo() {}, matchMedia: () => ({ matches: true }) },
    document: { documentElement: { lang: language === 'zh' ? 'zh-Hant' : 'en' }, ...events('document:'), getElementById: () => null },
    location,
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { requests.push({ url, options }); return Response.json({ ok: true, url: '/checkout-test' }); },
    console: { log() {}, warn() {}, error() {} },
  });
  new vm.Script(source + '\nglobalThis.BookingComponent = Component;').runInContext(ctx, { timeout: 2000 });
  return { C: ctx.BookingComponent, clock: value => { now = value; }, timers, listeners, requests, ctx };
}

export async function verifyComponent(source, file) {
  let checks = 0;
  const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
  for (const lang of ['en', 'zh']) {
    const h = harness(source, lang), c = new h.C();
    const labels = Array.from(c.renderVals().weeks, w => w.days);
    check(labels.length, 12);
    for (let i = 0; i < 14; i++) {
      for (const delta of [-1, 0, 1]) {
        const now = FIRST_CUTOFF + i * WEEK + delta;
        h.clock(now);
        const expected = labels.filter((_, j) => now < FIRST_CUTOFF + (j + 2) * WEEK);
        const v = c.renderVals();
        check(Array.from(v.weeks, w => w.days), expected);
        check(v.weeks.filter(w => w.closed).length <= 2, true);
        check(v.noUpcomingWeeks, now >= FIRST_CUTOFF + 11 * WEEK);
      }
    }
    h.clock(FIRST_CUTOFF);
    check(c.renderVals().weeks[0].closedNotFull, true);
    check(c.renderVals().weeks[0].full, false);
    c.renderVals().weeks[0].pick();
    check(Object.keys(c.state.sels), []);
    c.renderVals().weeks[1].pick();
    c.renderVals().weeks[1].pickPm({ stopPropagation() {} });
    check(c.state.sels[1], 'pm');
    c.state.counts = { W1AM: 6, W1PM: 6, W2AM: 6, W2PM: 0 };
    check(c.renderVals().weeks[0].full, true);
    check(c.renderVals().weeks[0].closedNotFull, false);
    check(c.renderVals().weeks[1].full, false);
    c.state.counts = { W2AM: 6, W2PM: 6 };
    check(c.renderVals().weeks[1].full, true);
    c.state.counts = {};
    h.clock(FIRST_CUTOFF - 1);
    c.state.sels = { 0: 'am', 1: 'pm' };
    const stale = c.renderVals();
    h.clock(FIRST_CUTOFF);
    stale.submit({ preventDefault() {}, target: null });
    check(h.requests.length, 0);
    check(Object.keys(c.state.sels), ['1']);
    const before = JSON.stringify(c.state.sels);
    stale.weeks[0].pick(); stale.weeks[0].pickPm({ stopPropagation() {} });
    check(JSON.stringify(c.state.sels), before);
    c.state.booking = { weeksSel: [{ i: 0, s: 'am' }] }; c.state.sent = true;
    await c.renderVals().pay({ preventDefault() {} });
    check(h.requests.length, 0); check(c.state.sent, false);
    c.state.booking = { weeksSel: [{ i: 1, s: 'pm' }], ref: 'fixture-ref', kidsCount: 1, lang };
    c.state.holding = false;
    await c.renderVals().pay({ preventDefault() {} });
    check(h.requests.length, 1);
    check(JSON.parse(h.requests[0].options.body).weeks, [{ i: 1, s: 'pm' }]);
    h.clock(FIRST_CUTOFF - 1);
    c.state.sels = { 0: 'am', 1: 'pm' };
    c.state.booking = { weeksSel: [{ i: 0, s: 'am' }] }; c.state.sent = true;
    c.startBookingClock();
    check(h.listeners.size, 3);
    const timer = [...h.timers.values()][0]; check(timer.ms, 2);
    h.clock(FIRST_CUTOFF); timer.fn();
    check(Object.keys(c.state.sels), ['1']); check(c.state.sent, false);
    h.clock(FIRST_CUTOFF + 2 * WEEK);
    h.listeners.get('window:focus')();
    check(c.renderVals().weeks[0].days, labels[1]);
    c.stopBookingClock(); check(h.listeners.size, 0); check(h.timers.size, 0);
    // Retained history must disappear even after the last scheduled class closes.
    h.clock(FIRST_CUTOFF + 13 * WEEK); check(c.renderVals().weeks.length, 0);
    c.state.sels = { 0: 'am' }; c.state.booking = { weeksSel: [{ i: 0, s: 'am' }] };
    h.ctx.location.search = '?held=1'; c.startBookingClock();
    check(Object.keys(c.state.sels), ['0']); c.stopBookingClock();
    h.ctx.location.search = '?cancel=fixture'; c.startBookingClock();
    check(Object.keys(c.state.sels), ['0']); c.stopBookingClock();
  }
  console.log(`${file}: ${checks} rolling-history assertions passed; emitted script and images preserved`);
}

export async function build() {
  const pending = [];
  for (const file of ['index.html', 'hk.html']) {
    const patched = patchHtml(fs.readFileSync(file, 'utf8'));
    await verifyComponent(patched.source, file);
    pending.push({ file, ...patched });
  }
  for (const page of pending) fs.writeFileSync(page.file, page.html);
  console.log('Two-week booking history applied safely to both original HTML pages.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await build();
