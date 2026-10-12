/**
 * Add the booking deadline to the original exported pages at build time.
 * No design/assets are re-exported. Unexpected source changes fail the build.
 * The API remains authoritative; all dates below are explicitly Tokyo time.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const MARKER = 'TWC_BOOKING_CUTOFF_V1';
const FIRST_CUTOFF = Date.parse('2026-10-06T00:00:00+09:00');
const WEEK = 7 * 86400000;

const METHODS = `
  // TWC_BOOKING_CUTOFF_V1: keep these dates aligned with api/hold.js.
  static bookingCutoff(i) {
    return Date.parse('2026-10-06T00:00:00+09:00') + i * 7 * 86400000;
  }
  static bookingWeekOpen(i, now = Date.now()) {
    return Number.isInteger(i) && i >= 0 && i < 12 && now < Component.bookingCutoff(i);
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
      const sels = this.openBookingSelections();
      const expiredSelection = Object.keys(this.state.sels || {}).some(i => !Component.bookingWeekOpen(Number(i), now));
      const pending = this.state.booking;
      const expiredPending = pending && Array.isArray(pending.weeksSel) && pending.weeksSel.some(w => !Component.bookingWeekOpen(w.i, now));
      const q = new URLSearchParams(window.location.search);
      // Never modify an already-held booking or the cancellation flow.
      if (!q.has('held') && !q.has('cancel') && !this.state.cancelRef && (expiredSelection || expiredPending)) this.rejectClosedBooking();
      this.setState({ _bookingClockTime: now });
      clearTimeout(this._bookingClockTimer);
      const next = Array.from({ length: 12 }, (_, i) => Component.bookingCutoff(i)).find(t => t > now);
      this._bookingClockTimer = next === undefined ? null : setTimeout(this._bookingClockRefresh, next - now + 1);
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
  return text.replace(before, after);
}

export function patchHtml(html) {
  assert(!html.includes(MARKER), 'Page has already been patched; use the original repository export');
  const matches = [...html.matchAll(/<script\b[^>]*\bdata-dc-script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(matches.length, 1, 'Expected one original booking component');
  const match = matches[0];
  const original = match[1];
  let source = original;
  source = once(source, 'class Component extends DCLogic {', 'class Component extends DCLogic {' + METHODS, 'Component declaration');
  source = once(source, '  componentDidMount() {', '  componentDidMount() {\n    this.startBookingClock();', 'mount hook');
  source = once(source, '  componentWillUnmount() {', '  componentWillUnmount() { this.stopBookingClock();', 'unmount hook');
  source = once(source, '    const sels = this.state.sels;', '    const sels = this.openBookingSelections();', 'booking selections');
  source = once(source, '    });\n    const picked = Object.keys(sels)', '    }).filter((w, i) => Component.bookingWeekOpen(i));\n    const picked = Object.keys(sels)', 'week map boundary');
  source = once(source, 'pick: () => { if (full) return;', 'pick: () => { if (!Component.bookingWeekOpen(i) || full) return;', 'week picker');
  source = once(source, 'e.stopPropagation(); if (amFull) return;', 'e.stopPropagation(); if (!Component.bookingWeekOpen(i) || amFull) return;', 'AM picker');
  source = once(source, 'e.stopPropagation(); if (pmFull) return;', 'e.stopPropagation(); if (!Component.bookingWeekOpen(i) || pmFull) return;', 'PM picker');
  source = once(source, '        const fd = new FormData(e.target);', `        if (picked.some(i => !Component.bookingWeekOpen(i)) || Object.keys(this.state.sels || {}).some(i => !Component.bookingWeekOpen(Number(i)))) { this.rejectClosedBooking(); return; }
        if (picked.length === 0) { this.setState({ noWeeks: true }); return; }
        const fd = new FormData(e.target);`, 'form submission guard');
  source = once(source, '        if (!b || this.state.holding) return;', `        if (!b || this.state.holding) return;
        if (!Array.isArray(b.weeksSel) || !b.weeksSel.length || b.weeksSel.some(w => !Component.bookingWeekOpen(w.i))) { this.rejectClosedBooking(); return; }`, 'checkout guard');
  source = once(source, "          if (j.code === 'full') {", "          if (j.code === 'week_closed') { this.rejectClosedBooking(); return; }\n          if (j.code === 'full') {", 'server deadline response');
  source = once(source, '      weeks, selDays, selDaysZh,', '      noUpcomingWeeks: weeks.length === 0,\n      weeks, selDays, selDaysZh,', 'empty-term state');
  new vm.Script(source);
  let output = html.slice(0, match.index) + match[0].replace(original, source) + html.slice(match.index + match[0].length);
  output = once(output, '            <sc-for list="{{ weeks }}" as="w" hint-placeholder-count="6">', `            <sc-if value="{{ noUpcomingWeeks }}" hint-placeholder-val="{{ false }}"><p style="color:#FAF7F2;margin:0"><sc-if value="{{ en }}"><span>New dates will be announced soon. Please contact us about future weeks.</span></sc-if><sc-if value="{{ zh }}"><span>新一期日期將會公布，歡迎聯絡我們查詢。</span></sc-if></p></sc-if>
            <sc-for list="{{ weeks }}" as="w" hint-placeholder-count="6">`, 'empty-term message');
  // Verify large inline images and all other scripts remain byte-for-byte intact.
  const images = s => [...s.matchAll(/data:image\/[^\s"']+/g)].map(m => m[0]);
  assert.deepEqual(images(output), images(html), 'Inline image assets changed');
  return { html: output, source, original };
}

function harness(source, language = 'en') {
  let now = FIRST_CUTOFF - 1;
  let nextId = 0;
  const timers = new Map();
  const listeners = new Map();
  const requests = [];
  const Date0 = Date;
  class TestDate extends Date0 {
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
  for (const lang of ['en', 'zh']) {
    const h = harness(source, lang);
    const c = new h.C();
    assert.equal(c.renderVals().weeks.length, 12); checks++;
    const originalDays = Array.from(c.renderVals().weeks, w => w.days);
    for (let i = 0; i < 12; i++) {
      h.clock(FIRST_CUTOFF + i * WEEK - 1);
      assert.equal(c.renderVals().weeks.length, 12 - i); checks++;
      h.clock(FIRST_CUTOFF + i * WEEK);
      assert.deepEqual(Array.from(c.renderVals().weeks, w => w.days), originalDays.slice(i + 1)); checks++;
    }
    h.clock(FIRST_CUTOFF);
    c.state.sels = {};
    c.renderVals().weeks[0].pick();
    assert.deepEqual(Object.keys(c.state.sels), ['1']); checks++;
    c.renderVals().weeks[0].pickPm({ stopPropagation() {} });
    assert.equal(c.state.sels[1], 'pm'); checks++;
    // The first visible tile is still W2, including its original capacity key.
    c.state.counts = { W2AM: 6, W2PM: 6 };
    assert.equal(c.renderVals().weeks[0].full, true); checks++;
    c.state.counts = {};
    h.clock(FIRST_CUTOFF - 1);
    c.state.sels = { 0: 'am', 1: 'pm' };
    const staleView = c.renderVals();
    h.clock(FIRST_CUTOFF);
    staleView.submit({ preventDefault() {}, target: null });
    assert.equal(h.requests.length, 0); checks++;
    assert.deepEqual(Object.keys(c.state.sels), ['1']); checks++;
    assert.equal(c.state.sent, false); checks++;
    const before = JSON.stringify(c.state.sels);
    staleView.weeks[0].pick();
    staleView.weeks[0].pickPm({ stopPropagation() {} });
    assert.equal(JSON.stringify(c.state.sels), before); checks++;
    c.state.booking = { weeksSel: [{ i: 0, s: 'am' }] };
    c.state.sent = true;
    await c.renderVals().pay({ preventDefault() {} });
    assert.equal(h.requests.length, 0); checks++;
    assert.equal(c.state.sent, false); checks++;
    c.state.booking = { weeksSel: [{ i: 1, s: 'pm' }], ref: 'fixture-ref', kidsCount: 1, lang };
    c.state.holding = false;
    await c.renderVals().pay({ preventDefault() {} });
    assert.equal(h.requests.length, 1); checks++;
    assert.deepEqual(JSON.parse(h.requests[0].options.body).weeks, [{ i: 1, s: 'pm' }]); checks++;
    // A tab kept open over the boundary must clear the expired pending week.
    h.clock(FIRST_CUTOFF - 1);
    c.state.sels = { 0: 'am', 1: 'pm' };
    c.state.booking = { weeksSel: [{ i: 0, s: 'am' }] };
    c.state.sent = true;
    c.startBookingClock();
    assert.equal(h.listeners.size, 3); checks++;
    const timer = [...h.timers.values()][0];
    assert.equal(timer.ms, 2); checks++;
    h.clock(FIRST_CUTOFF);
    timer.fn();
    assert.deepEqual(Object.keys(c.state.sels), ['1']); checks++;
    assert.equal(c.state.sent, false); checks++;
    c.stopBookingClock();
    assert.equal(h.listeners.size, 0); checks++;
    h.clock(FIRST_CUTOFF + 12 * WEEK);
    assert.equal(c.renderVals().weeks.length, 0); checks++;
    assert.equal(c.renderVals().noUpcomingWeeks, true); checks++;
  }
  console.log(`${file}: ${checks} booking-cutoff assertions passed (EN + Chinese)`);
  return checks;
}

export async function build() {
  const pending = [];
  for (const file of ['index.html', 'hk.html']) {
    const original = fs.readFileSync(file, 'utf8');
    const patched = patchHtml(original);
    await verifyComponent(patched.source, file);
    pending.push({ file, ...patched });
  }
  // Write neither page unless both original components pass every test.
  for (const page of pending) fs.writeFileSync(page.file, page.html);
  console.log('Booking deadline applied to both original pages; existing images and design preserved.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await build();
