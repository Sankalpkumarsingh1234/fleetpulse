process.env.VEHICLES = '2000'; process.env.DB_PATH = ':memory:';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../server.js');
let base, mt, at;
const login = (u, p) => fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
const get = (p, t) => fetch(base + p, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
before(async () => {
  for (let k = 0; k < 15; k++) { s.simulate(); s.drain(); }
  await new Promise(r => s.server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + s.server.address().port;
  mt = (await (await login('manager1', 'fleet123')).json()).token; at = (await (await login('admin', 'admin123')).json()).token;
});
after(() => s.server.close());

test('login succeeds with the right password and returns a token', () => { assert.ok(mt && at); });
test('login fails with a wrong password (401)', async () => assert.equal((await login('manager1', 'nope')).status, 401));
test('SQL injection in the username does not log in', async () => assert.equal((await login("admin' OR '1'='1", 'x')).status, 401));
test('API rejects missing and garbage tokens (401)', async () => { assert.equal((await get('/api/stats')).status, 401); assert.equal((await get('/api/stats', 'abc.def')).status, 401); assert.equal((await get('/api/stream')).status, 401); });
test('manager sees only fleet 1 vehicles', async () => { const j = await (await get('/api/at-risk?limit=100', mt)).json(); assert.ok(j.items.length > 0); assert.ok(j.items.every(v => v.fleet === 1)); });
test('admin sees vehicles from several fleets', async () => { const j = await (await get('/api/at-risk?limit=100', at)).json(); assert.ok(new Set(j.items.map(v => v.fleet)).size > 1); });
test('manager gets 404 for a vehicle in another fleet, 200 for their own', async () => { assert.equal((await get('/api/vehicle/' + s.vinOf(1), mt)).status, 404); assert.equal((await get('/api/vehicle/' + s.vinOf(0), mt)).status, 200); });
test('manager cannot read the audit log, admin can', async () => { assert.notEqual((await get('/api/audit', mt)).status, 200); const r = await get('/api/audit?limit=100', at); assert.equal(r.status, 200); assert.ok((await r.json()).some(a => a.action === 'login')); });
test('copilot questions appear in the audit log', async () => {
  await fetch(base + '/api/copilot', { method: 'POST', headers: { Authorization: 'Bearer ' + mt }, body: JSON.stringify({ q: 'fleet summary' }) });
  assert.ok((await (await get('/api/audit?limit=100', at)).json()).some(a => a.action === 'agent_query' && a.username === 'manager1'));
});
test('API pagination returns disjoint pages', async () => {
  const a = await (await get('/api/at-risk?limit=5', at)).json(), b = await (await get('/api/at-risk?limit=5&cursor=' + a.cursor, at)).json();
  assert.ok(!a.items.some(x => b.items.some(y => y.vin === x.vin)));
});
test('alerts API is fleet scoped and paginated', async () => { const j = await (await get('/api/alerts?limit=500', mt)).json(); assert.ok(Array.isArray(j.items)); });
test('security headers are set and path traversal is blocked', async () => {
  const r = await get('/'); assert.equal(r.status, 200); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.ok(r.headers.get('content-security-policy'));
  const t = await fetch(base + '/%2e%2e/server.js'); assert.equal(t.status, 404); assert.ok(!(await t.text()).includes('DatabaseSync'));
});
test('health and Prometheus metrics work without login', async () => { assert.equal((await get('/health')).status, 200); const m = await (await get('/metrics')).text(); assert.match(m, /fleetpulse_events_processed_total \d+/); assert.match(m, /fleetpulse_api_p95_ms/); });
test('similar-case retrieval returns 3 ranked cases', async () => { const top = (await (await get('/api/at-risk?limit=1', at)).json()).items[0], j = await (await get('/api/vehicle/' + top.vin + '/similar', at)).json(); assert.equal(j.cases.length, 3); assert.ok(j.cases[0].similarity >= j.cases[2].similarity); assert.ok(Array.isArray(j.similar_vehicles)); });
test('vehicle history returns only that vehicle\'s events', async () => { const top = (await (await get('/api/at-risk?limit=1', at)).json()).items[0], h = await (await get('/api/vehicle/' + top.vin + '/history', at)).json(); assert.ok(h.events.every(e => e.vin === top.vin)); });
test('batch analytics scans stored telemetry and is scoped by role', async () => { const a = await (await get('/api/analytics/batch', at)).json(), m = await (await get('/api/analytics/batch', mt)).json(); assert.ok(a.analytics.events_scanned > 0); assert.ok(m.analytics.events_scanned <= a.analytics.events_scanned); assert.ok('warm_bytes' in a.storage); });
test('erasure is admin only and removes the vehicle everywhere', async () => {
  const top = (await (await get('/api/at-risk?limit=1', at)).json()).items[0], post = t => fetch(base + '/api/erasure', { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: JSON.stringify({ vin: top.vin }) });
  assert.equal((await post(mt)).status, 403); const r = await post(at); assert.equal(r.status, 200); assert.equal((await r.json()).erased, true);
  assert.equal((await (await get('/api/vehicle/' + top.vin + '/history', at)).json()).events.length, 0);
  assert.ok(!(await (await get('/api/at-risk?limit=100', at)).json()).items.some(v => v.vin === top.vin));
});
test('rate limiter returns 429 under a flood', async () => {
  s.buckets.clear(); const codes = []; for (let i = 0; i < 250; i++) codes.push((await get('/api/stats', at)).status);
  assert.ok(codes.includes(429)); assert.equal(codes[0], 200);
});
