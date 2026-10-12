/** Exercise the real booking handler with a fake clock and mocked Stripe. */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let now = 0;
const calls = [];
const Date0 = Date;
class TestDate extends Date0 {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
class StripeMock {
  customers = { create: async params => { calls.push(['customer', params]); return { id: 'test_customer' }; } };
  checkout = { sessions: { create: async params => { calls.push(['session', params]); return { url: 'https://checkout.example.invalid' }; } } };
}
const original = fs.readFileSync('api/hold.js', 'utf8');
assert.equal(original.split("import Stripe from 'stripe';").length, 2);
assert.equal(original.split('export async function POST').length, 2);
const source = original.replace("import Stripe from 'stripe';", '').replace('export async function POST', 'async function POST');
const ctx = vm.createContext({
  Stripe: StripeMock, Date: TestDate, Intl, Response,
  process: { env: { SITE_TOKEN: 'test-only', SITE_URL: 'https://example.invalid', STRIPE_SECRET_KEY: 'mock-only' } },
  console: { error() {} },
  fetch: async () => { throw new Error('Unexpected network call'); },
});
new vm.Script(source + '\nglobalThis.handler = POST;').runInContext(ctx, { timeout: 2000 });
const first = Date.parse('2026-10-06T00:00:00+09:00');
const week = 7 * 86400000;
const input = weeks => ({ token: 'test-only', email: 'parent@example.invalid', name: 'Test Parent', ref: 'TESTREF_1234', kidsCount: 1, weeks });
let checks = 0;
for (let i = 0; i < 12; i++) {
  for (const s of ['am', 'pm']) {
    for (const delta of [-1, 0, 1]) {
      now = first + i * week + delta;
      calls.length = 0;
      const response = await ctx.handler({ json: async () => input([{ i, s }]) });
      const data = await response.json();
      if (delta < 0) {
        assert.equal(response.status, 200);
        assert.equal(data.totalJpy, 48000);
        assert.deepEqual(data.weekCodes, [`W${i + 1}${s.toUpperCase()}`]);
        assert.equal(calls.length, 2);
        assert.equal(calls[1][1].mode, 'setup');
      } else {
        assert.equal(response.status, 409);
        assert.equal(data.code, 'week_closed');
        assert.equal(calls.length, 0, 'Expired weeks must never contact Stripe');
      }
      checks++;
    }
  }
}
now = first;
calls.length = 0;
const mixed = await ctx.handler({ json: async () => input([{ i: 0, s: 'am' }, { i: 1, s: 'pm' }]) });
assert.equal(mixed.status, 409);
assert.equal(calls.length, 0);
checks++;
console.log(`api/hold.js: ${checks} deadline cases passed; no live Stripe requests or charges`);
