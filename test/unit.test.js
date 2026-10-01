process.env.VEHICLES = '2000'; process.env.DB_PATH = ':memory:';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../server.js'), vec = require('../vector.js'), { Store } = require('../store.js');
const fs = require('fs'), os = require('os'), path = require('path');
const ev = (i, o = {}) => ({ vin: s.vinOf(i), ts: Date.now(), seq: Math.floor(Math.random() * 1e9), lat: 13, lon: 80, speed_kmh: 50, soc_pct: 70, temp_c: 90, dtc: [], evt: 'NONE', ...o });
const adm = { u: 'a', r: 'admin', f: 0 }, mgr = { u: 'm', r: 'manager', f: 1 };

describe('VIN rules', () => {
  test('generated VINs are 17 characters with no I, O or Q', () => { for (let i = 0; i < 2000; i++) { const v = s.vinOf(i); assert.equal(v.length, 17); assert.match(v, s.VIN_RE); assert.doesNotMatch(v, /[IOQ]/); } });
  test('VINs are unique', () => assert.equal(new Set(Array.from({ length: 2000 }, (_, i) => s.vinOf(i))).size, 2000));
  test('validator rejects bad VINs', () => { for (const b of ['', 'short', '1TRIOQ0000000000A', '1TR000000000000000']) assert.doesNotMatch(b, s.VIN_RE); });
});

describe('Bloom filter de-duplication', () => {
  test('first sighting is new, repeat is a duplicate', () => { const k = 'k:' + Math.random(); assert.equal(s.seenBefore(k), false); assert.equal(s.seenBefore(k), true); });
  test('false-positive rate stays under 1%', () => { let fp = 0; for (let i = 0; i < 20000; i++) if (s.seenBefore('fp' + i + ':' + Math.random())) fp++; assert.ok(fp / 20000 < 0.01); });
});

describe('Failure-risk model', () => {
  test('beats the threshold baseline on F1 and recall', () => { const m = s.model.metrics; assert.ok(m.logistic.f1 > m.baseline.f1); assert.ok(m.logistic.recall > m.baseline.recall); });
  test('faulty vehicles score higher than healthy ones on average', () => {
    const avg = y => { let t = 0, n = 0; while (n < 300) { const d = s.synth(); if (d.y === y) { t += s.sig(s.model.b + d.x.reduce((a, v, i) => a + v * s.model.w[i], 0)); n++; } } return t / n; };
    assert.ok(avg(1) > avg(0) + 0.3);
  });
  test('simulated physics: faults degrade temperature and battery', () => { assert.ok(s.phys(1, 10).temp > s.phys(0, 10).temp); assert.ok(s.phys(1, 10).socDrop > s.phys(0, 10).socDrop); });
});

describe('Ingest validation', () => {
  test('accepts a valid event', () => { const n = s.stats.ingested; s.ingest(ev(1)); assert.equal(s.stats.ingested, n + 1); s.drain(); });
  test('drops an exact duplicate (same vin and seq)', () => { const e = ev(2); s.ingest(e); const d = s.stats.dups; s.ingest({ ...e }); assert.equal(s.stats.dups, d + 1); s.drain(); });
  test('rejects malformed events and counts them', () => {
    for (const bad of [null, {}, { vin: 'x' }, ev(3, { speed_kmh: 999 }), ev(3, { soc_pct: -5 }), ev(3, { ts: 'x' }), ev(3, { vin: '1TR99999999999999' })]) { const n = s.stats.invalid; s.ingest(bad); assert.equal(s.stats.invalid, n + 1); }
  });
  test('survives 1000 junk payloads without throwing', () => { for (let i = 0; i < 1000; i++) assert.doesNotThrow(() => s.ingest(i % 2 ? { vin: '<script>' + i } : [i, {}, 'x'])); });
});

describe('Stream scoring and alerts', () => {
  test('a degrading vehicle raises exactly one alert', () => {
    const i = 1999, before = s.stats.alerts;
    for (let k = 1; k <= 12; k++) { s.ingest(ev(i, { seq: 900000 + k, temp_c: 90 + k * 3, soc_pct: 80 - k * 2, dtc: k > 3 ? ['P0301'] : [], evt: 'HARSH_BRAKE' })); s.drain(); }
    assert.ok(s.risk[i] > 0.9); assert.equal(s.alerted[i], 1); assert.equal(s.stats.alerts, before + 1);
  });
  test('a healthy vehicle stays low risk', () => { for (let k = 1; k <= 12; k++) { s.ingest(ev(1998, { seq: 800000 + k, soc_pct: 80 })); s.drain(); } assert.ok(s.risk[1998] < 0.5); });
  test('no score until a vehicle has 4 events of history', () => { for (let k = 1; k <= 3; k++) { s.ingest(ev(1997, { seq: 700000 + k, temp_c: 140, dtc: ['P0301'] })); s.drain(); } assert.equal(s.risk[1997], 0); });
});

describe('Access control and tokens', () => {
  test('a manager only sees their own fleet; admin sees all', () => { for (let i = 0; i < 2000; i++) assert.equal(s.inScope(mgr, i), s.fleetOf[i] === 1); assert.ok(s.inScope(adm, 5)); });
  test('token round trip works', () => assert.equal(s.verify(s.mint({ username: 'm', role: 'manager', fleet_id: 1 })).u, 'm'));
  test('forged and garbage tokens are rejected', () => {
    const sig = s.mint({ username: 'm', role: 'manager', fleet_id: 1 }).split('.')[1];
    const forged = Buffer.from(JSON.stringify({ u: 'm', r: 'admin', f: 0, exp: Date.now() + 1e6 })).toString('base64url') + '.' + sig;
    for (const t of [forged, 'garbage', '', null]) assert.equal(s.verify(t), null);
  });
  test('expired tokens are rejected', () => { const t = s.mint({ username: 'm', role: 'manager', fleet_id: 1 }), real = Date.now; Date.now = () => real() + 7200e3; try { assert.equal(s.verify(t), null); } finally { Date.now = real; } });
});

describe('Vector search', () => {
  test('cosine similarity: identical is 1, orthogonal is 0', () => { assert.equal(vec.cosine([1, 0], [1, 0]), 1); assert.equal(vec.cosine([1, 0], [0, 1]), 0); assert.equal(vec.cosine([0, 0], [1, 1]), 0); });
  test('an overheating signature retrieves the overheating repair case first', () => {
    const q = vec.embed({ temp: 119, socDrop: 5, dtc: 3, harsh: 0, events: 10, lastDtc: 'P0217' }); assert.equal(vec.nearestCases(q, 1)[0].id, 'C1');
  });
  test('a brake-wear signature retrieves the brake case first', () => { assert.equal(vec.nearestCases(vec.embed({ temp: 92, socDrop: 4, dtc: 0, harsh: 7, events: 10, lastDtc: null }), 1)[0].id, 'C5'); });
  test('topK returns the K most similar, best first', () => {
    const items = [[1, 0], [0.9, 0.1], [0, 1], [-1, 0]].map((v, id) => ({ id, vec: v })), r = vec.topK([1, 0], items, 2);
    assert.deepEqual(r.map(x => x.id), [0, 1]); assert.ok(r[0].similarity >= r[1].similarity);
  });
});

describe('Warm/cold document store', () => {
  const mk = (o = {}) => new Store({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), segMs: 1000, coldAfterMs: 3000, retainMs: 10000, sample: 1, ...o });
  const e = (vin, o = {}) => ({ vin, ts: 1, fleet: 1, lat: 1, lon: 1, speed_kmh: 5, soc_pct: 50, temp_c: 100, dtc: [], evt: 'NONE', seq: 1, ...o });
  test('history returns a vehicle\'s stored events, newest first', () => { const st = mk(), t = 1000000; st.append(e('A', { dtc: ['P0301'], seq: 1 }), t); st.append(e('A', { seq: 2, evt: 'HARSH_BRAKE' }), t + 10); st.append(e('B'), t); const h = st.history('A'); assert.equal(h.length, 2); assert.equal(h[0].seq, 2); });
  test('only 1 in N ordinary events is kept, but faults are always kept', () => { const st = mk({ sample: 10 }); for (let i = 0; i < 100; i++) st.append(e('A', { seq: i })); assert.equal(st.kept, 10); assert.equal(st.append(e('A', { dtc: ['P0420'] })), true); });
  test('old segments are compacted to gzip cold storage and still queryable', () => {
    const st = mk(); st.append(e('A', { dtc: ['P0420'] }), 1000000); st.append(e('A', { dtc: ['P0420'], seq: 2 }), 1005000);
    assert.deepEqual(st.rotate(1005000), { moved_to_cold: 1, deleted: 0 }); const s2 = st.stats(); assert.equal(s2.cold_files, 1); assert.equal(s2.warm_files, 1);
    const a = st.batchAnalytics(); assert.equal(a.events_scanned, 2); assert.deepEqual(a.top_fault_codes[0], ['P0420', 2]);
  });
  test('retention deletes expired cold files', () => { const st = mk(); st.append(e('A', { dtc: ['P0420'] }), 1000000); st.append(e('A', { dtc: ['P0420'], seq: 2 }), 1005000); st.rotate(1005000); assert.equal(st.rotate(1020000).deleted, 1); assert.equal(st.stats().cold_files, 0); });
  test('batch analytics respects the fleet filter', () => { const st = mk(); st.append(e('A', { fleet: 1, dtc: ['P0301'] }), 1000000); st.append(e('B', { fleet: 2, dtc: ['P0301'] }), 1000000); assert.equal(st.batchAnalytics(1).events_scanned, 1); assert.equal(st.batchAnalytics(0).events_scanned, 2); });
  test('erasure removes a vehicle from warm and cold tiers and blocks re-storing', () => {
    const st = mk(); st.append(e('A', { dtc: ['P0301'] }), 1000000); st.append(e('B', { dtc: ['P0301'] }), 1000000); st.append(e('A', { dtc: ['P0301'], seq: 2 }), 1005000); st.rotate(1005000);
    assert.ok(st.erase('A') >= 1); assert.equal(st.batchAnalytics().events_scanned, 1); assert.equal(st.history('A').length, 0); assert.equal(st.append(e('A', { dtc: ['x'] })), false); assert.deepEqual(st.batchAnalytics().top_fault_codes[0], ['P0301', 1]);
  });
});

describe('Privacy: location masking and erasure', () => {
  test('non-admins see coordinates rounded to 2 decimals, admins keep 4', () => {
    const a = s.vehicleView(0, adm), m = s.vehicleView(0, mgr); assert.ok(Math.abs(m.lat * 100 - Math.round(m.lat * 100)) < 1e-6); assert.ok(Math.abs(m.lat - a.lat) < 0.006);
  });
  test('erasure wipes hot state, alerts, history and blocks new events', () => {
    const i = 1999, vin = s.vinOf(i); assert.ok(s.risk[i] > 0.9);
    const r = s.eraseVehicle(adm, vin); assert.equal(r.erased, true); assert.ok(r.alerts_removed >= 1);
    assert.equal(s.risk[i], 0); assert.equal(s.store.history(vin).length, 0); assert.equal(s.db.prepare('SELECT COUNT(*) c FROM alerts WHERE vehicle_id=?').get(i).c, 0);
    const n = s.stats.erasedDropped; s.ingest(ev(i, { seq: 123456789 })); assert.equal(s.stats.erasedDropped, n + 1);
    assert.ok(s.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='erasure'").get().c >= 1);
  });
  test('erasing an unknown VIN returns null', () => assert.equal(s.eraseVehicle(adm, '1TR99999999999999'), null));
});

describe('Queries and copilot', () => {
  before(() => { for (let k = 0; k < 15; k++) { s.simulate(); s.drain(); } });
  test('keyset pagination has no overlap and no gaps', () => {
    const all = s.topRisk(adm, 1000).items.map(v => v.vin); assert.ok(all.length > 0);
    const seen = []; let cur = null; do { const p = s.topRisk(adm, 7, cur); seen.push(...p.items.map(v => v.vin)); cur = p.cursor; } while (cur);
    assert.deepEqual(seen, all);
  });
  test('results are sorted by risk, highest first', () => { const r = s.topRisk(adm, 100).items.map(v => v.risk); assert.deepEqual(r, [...r].sort((a, b) => b - a)); });
  test('manager queries never leak other fleets', () => { assert.ok(s.topRisk(mgr, 100).items.every(v => v.fleet === 1)); });
  test('copilot refuses write actions and calls no tools', () => { const r = s.copilot(adm, 'please schedule a repair and delete the alert'); assert.match(r.answer, /Guardrail/); assert.deepEqual(r.tools_used, []); });
  test('copilot uses only read-only tools and every call is audited', () => {
    const before = s.db.prepare("SELECT COUNT(*) c FROM audit WHERE action LIKE 'agent%'").get().c;
    const r = s.copilot(mgr, 'which vehicles need attention'); assert.ok(r.tools_used.every(t => ['top_risk', 'vehicle', 'fleet_summary', 'low_battery', 'similar_cases'].includes(t)));
    assert.equal(s.db.prepare("SELECT COUNT(*) c FROM audit WHERE action LIKE 'agent%'").get().c, before + r.tools_used.length + 1);
  });
  test('copilot cannot look up a vehicle from another fleet', () => assert.match(s.copilot(mgr, 'status of ' + s.vinOf(1)).answer, /No such vehicle/));
});
test('copilot recommends an action from similar past cases', () => { const top = s.topRisk(adm, 1).items[0], r = s.copilot(adm, 'what should I do about ' + top.vin); assert.match(r.answer, /Suggested action/); assert.deepEqual(r.tools_used, ['vehicle', 'similar_cases']); });
