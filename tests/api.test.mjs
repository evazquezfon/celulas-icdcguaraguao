import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../netlify/functions/api.mjs';

// Tests use isolated dummy credentials and never access the live spreadsheet.
for (const name of ['APPS_SCRIPT_URL', 'APPS_SCRIPT_SHARED_SECRET', 'ADMIN_PASSWORD', 'SESSION_SECRET']) process.env[name] = 'test-only';
const request = data => new Request('https://example.test/api', { method: 'POST', body: JSON.stringify(data) });
function upstream(available) {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return Response.json(body.action === 'getSpots' ? { ok: true, spots: { church: { available, limit: 15, used: 15 - available } } } : { ok: true, registeredCount: 1 + (body.companions?.length || 0) });
  };
  return calls;
}
test('rejects an entire group when capacity is insufficient without registering anyone', async () => {
  const calls = upstream(2);
  const result = await (await handler(request({ action: 'register', placeId: 'church', companions: ['Ana Rivera', 'Luis Pérez'] }))).json();
  assert.equal(result.full, true); assert.equal(result.requested, 3); assert.equal(result.available, 2);
  assert.deepEqual(calls.map(call => call.action), ['getSpots']);
});
test('forwards a complete group in one request when capacity exactly fits', async () => {
  const calls = upstream(3);
  const response = await handler(request({ action: 'register', placeId: 'church', field_name: 'Eva Cruz', companions: [' Ana Rivera ', 'Luis Pérez'] }));
  assert.equal((await response.json()).ok, true);
  assert.deepEqual(calls[1].companions, ['Ana Rivera', 'Luis Pérez']);
  assert.equal(calls[1].field_name, 'Eva Cruz');
  assert.equal(calls.length, 2);
});
test('preserves registration without companions', async () => {
  const calls = upstream(1);
  assert.equal((await (await handler(request({ action: 'register', placeId: 'church' }))).json()).ok, true);
  assert.deepEqual(calls[1].companions, []);
});
test('rejects malformed and empty companion names before upstream calls', async () => {
  const calls = upstream(10);
  for (const companions of ['Ana Rivera', [' '], [null], [{}], ['x'.repeat(201)], null, Array(21).fill('Ana Rivera')]) {
    assert.equal((await handler(request({ action: 'register', placeId: 'church', companions }))).status, 400);
  }
  assert.equal(calls.length, 0);
});
test('fails closed when availability cannot be verified', async () => {
  globalThis.fetch = async () => Response.json({ ok: false });
  assert.equal((await handler(request({ action: 'register', placeId: 'church', companions: [] }))).status, 502);
});
test('preserves admin authorization and waitlist forwarding', async () => {
  const calls = upstream(0);
  assert.equal((await handler(request({ action: 'getRegistrations' }))).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await (await handler(request({ action: 'waitlist', name: 'Eva Cruz', placeId: 'church' }))).json()).ok, true);
  assert.equal(calls[0].action, 'waitlist');
});
test('rejects false success when Apps Script does not confirm every participant', async () => {
  upstream(3);
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => JSON.parse(options.body).action === 'register'
    ? Response.json({ ok: true, registeredCount: 1 }) : baseFetch(url, options);
  const result = await (await handler(request({ action: 'register', placeId: 'church', companions: ['Ana Rivera'] }))).json();
  assert.equal(result.ok, false); assert.equal(result.uncertain, true);
});
test('marks transport failure after submission uncertain without retrying', async () => {
  const calls = upstream(3); const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (JSON.parse(options.body).action === 'register') throw new Error('simulated connection loss');
    return baseFetch(url, options);
  };
  const result = await (await handler(request({ action: 'register', placeId: 'church', companions: [] }))).json();
  assert.equal(result.uncertain, true); assert.equal(calls.length, 1);
});
test('retains uncertain write errors and capacity race responses from Apps Script', async () => {
  for (const upstreamResult of [{ ok: false, error: 'Error interno' }, { ok: false, full: true, available: 0, requested: 2 }]) {
    upstream(3); const baseFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => JSON.parse(options.body).action === 'register'
      ? Response.json(upstreamResult) : baseFetch(url, options);
    const result = await (await handler(request({ action: 'register', placeId: 'church', companions: ['Ana Rivera'] }))).json();
    if (upstreamResult.full) { assert.equal(result.full, true); assert.equal(result.available, 0); assert.equal(result.uncertain, undefined); }
    else assert.equal(result.uncertain, true);
  }
});
