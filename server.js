'use strict';
// FleetPulse: predictive maintenance for connected fleets. Zero dependencies, Node 22+.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('./store'), vec = require('./vector');

const N = +process.env.VEHICLES || 100000, RATE = +process.env.RATE || 20000;
const PORT = +process.env.PORT || 3000, PARTS = 8, FLEETS = 20, SECRET = crypto.randomBytes(32);
const now = () => Date.now();

// ---------- VINs (17 chars, no I/O/Q) ----------
const ALPHA = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';
const vinOf = i => { let s = '', n = i; for (let k = 0; k < 14; k++) { s = ALPHA[n % 33] + s; n = Math.floor(n / 33); } return '1TR' + s; };
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const idxOf = new Map(); for (let i = 0; i < N; i++) idxOf.set(vinOf(i), i);

// ---------- Relational store (SQLite, ACID): fleets, drivers, vehicles, alerts, audit, users ----------
const DB_PATH = process.env.DB_PATH || 'data/fleet.db';
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS fleets(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drivers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, fleet_id INTEGER NOT NULL REFERENCES fleets(id));
CREATE TABLE IF NOT EXISTS vehicles(id INTEGER PRIMARY KEY, vin TEXT UNIQUE NOT NULL, fleet_id INTEGER NOT NULL REFERENCES fleets(id), driver_id INTEGER REFERENCES drivers(id), model TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, vehicle_id INTEGER NOT NULL REFERENCES vehicles(id), fleet_id INTEGER NOT NULL, ts INTEGER NOT NULL, risk REAL NOT NULL, reason TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_alert_fleet ON alerts(fleet_id, id DESC);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, salt TEXT, hash TEXT, role TEXT NOT NULL, fleet_id INTEGER NOT NULL);`);
const MODELS = ['Volvo XC40 EV', 'Subaru Outback', 'Jeep Compass', 'Tata Nexon EV', 'Mahindra XUV700'];
const fix = [];
{
  const fleetCount = db.prepare('SELECT COUNT(*) c FROM fleets').get().c;
  if (fleetCount === 0) {
    db.exec('BEGIN');
    const f = db.prepare('INSERT INTO fleets VALUES(?,?)'), d = db.prepare('INSERT INTO drivers VALUES(?,?,?)'), v = db.prepare('INSERT INTO vehicles VALUES(?,?,?,?,?)');
    for (let i = 1; i <= FLEETS; i++) f.run(i, 'Fleet ' + i);
    for (let i = 0; i < N; i++) {
      const fl = (i % FLEETS) + 1, dr = Math.floor(i / 4) + 1;
      if (i % 4 === 0) d.run(dr, 'Driver ' + dr, fl);
      v.run(i, vinOf(i), fl, dr, MODELS[i % MODELS.length]);
    }
    const u = db.prepare('INSERT INTO users VALUES(?,?,?,?,?)');
    for (const [n, p, r, fl] of [['admin', 'admin123', 'admin', 0], ['manager1', 'fleet123', 'manager', 1]]) {
      const salt = crypto.randomBytes(8).toString('hex'); u.run(n, salt, crypto.scryptSync(p, salt, 32).toString('hex'), r, fl);
    }
    db.exec('COMMIT');
  }
}
const q = { fleetOf: null };
const insAlert = db.prepare('INSERT INTO alerts(vehicle_id,fleet_id,ts,risk,reason) VALUES(?,?,?,?,?)');
const insAudit = db.prepare('INSERT INTO audit(ts,username,action,detail) VALUES(?,?,?,?)');
const audit = (u, a, d) => insAudit.run(now(), u, a, d || '');
const STORE_DIR = process.env.STORE_DIR || (DB_PATH === ':memory:' ? fs.mkdtempSync(path.join(require('os').tmpdir(), 'fp-')) : 'data');
const store = new Store({ dir: STORE_DIR, segMs: +process.env.SEG_MS || 60000, coldAfterMs: +process.env.COLD_AFTER_MS || 180000, retainMs: +process.env.RETAIN_MS || 3600000, sample: +process.env.WARM_SAMPLE || 50 });

// ---------- Hot state (in memory typed arrays, one slot per vehicle) ----------
const fleetOf = new Uint8Array(N), faulty = new Uint8Array(N), simSeq = new Uint32Array(N);
const lat = new Float32Array(N), lon = new Float32Array(N);
const eTemp = new Float32Array(N), eSpd = new Float32Array(N), soc0 = new Float32Array(N), soc = new Float32Array(N);
const dtcN = new Uint16Array(N), harsh = new Uint16Array(N), evN = new Uint32Array(N), risk = new Float32Array(N), alerted = new Uint8Array(N);
const lastDtc = new Array(N);
for (let i = 0; i < N; i++) { fleetOf[i] = (i % FLEETS) + 1; faulty[i] = Math.random() < 0.03 ? 1 : 0; lat[i] = 12.5 + Math.random() * 1.5; lon[i] = 79.5 + Math.random() * 1.5; }

// ---------- Physics shared by simulator and model trainer ----------
const DTCS = ['P0301', 'P0217', 'P0562', 'P0420'];
const rnd = () => Math.random();
function phys(f, k) { // k-th event of a vehicle
  return {
    temp: 88 + rnd() * 6 + (f ? Math.min(35, 2.5 * k) : 0),
    socDrop: k * (f ? 1.2 : 0.3) + rnd(),
    dtc: (f && k > 4 && rnd() < 0.35) || rnd() < 0.002 ? [DTCS[(rnd() * 4) | 0]] : [],
    hb: rnd() < (f ? 0.08 : 0.02)
  };
}

// ---------- ML: logistic regression vs threshold baseline ----------
const feat = (t, d, s, h, n) => [(t - 90) / 20, d / 3, s / 20, (h / Math.max(n, 1)) * 10];
const sig = z => 1 / (1 + Math.exp(-z));
const model = { w: [0, 0, 0, 0], b: -2, metrics: null };
function synth() {
  const f = rnd() < 0.2 ? 1 : 0, n = 4 + ((rnd() * 12) | 0); let t = 0, d = 0, h = 0, s = 0;
  for (let k = 1; k <= n; k++) { const p = phys(f, k); t = k === 1 ? p.temp : 0.7 * t + 0.3 * p.temp; d += p.dtc.length; h += p.hb; s = p.socDrop; }
  return { x: feat(t, d, s, h, n), y: f, t };
}
(function train() {
  const data = Array.from({ length: 8000 }, synth), cut = 6400, tr = data.slice(0, cut), te = data.slice(cut);
  for (let e = 0; e < 300; e++) {
    const g = [0, 0, 0, 0]; let gb = 0;
    for (const { x, y } of tr) { const err = sig(model.b + x.reduce((a, v, i) => a + v * model.w[i], 0)) - y; x.forEach((v, i) => g[i] += err * v); gb += err; }
    model.w = model.w.map((w, i) => w - 0.5 * g[i] / cut); model.b -= 0.5 * gb / cut;
  }
  const score = pred => { let tp = 0, fp = 0, fn = 0; for (const s of te) { const p = pred(s); if (p && s.y) tp++; else if (p) fp++; else if (s.y) fn++; }
    const pr = tp / (tp + fp || 1), rc = tp / (tp + fn || 1); return { precision: +pr.toFixed(3), recall: +rc.toFixed(3), f1: +(2 * pr * rc / (pr + rc || 1)).toFixed(3) }; };
  model.metrics = { holdout: te.length, baseline_rule: 'engine temp > 105C', baseline: score(s => s.t > 105),
    logistic: score(s => sig(model.b + s.x.reduce((a, v, i) => a + v * model.w[i], 0)) > 0.5) };
})();

// ---------- Bloom filter de-duplication (8 MB, 3 hashes) ----------
const BITS = 1 << 26, bloom = new Uint8Array(BITS >> 3);
const h32 = (s, seed) => { let h = 2166136261 ^ seed; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % BITS; };
function seenBefore(key) { let all = true; for (let s = 0; s < 3; s++) { const b = h32(key, s * 7919); if (!(bloom[b >> 3] & (1 << (b & 7)))) { all = false; bloom[b >> 3] |= 1 << (b & 7); } } return all; }

// ---------- Partitioned in-process log (Kafka-style: partition by VIN hash) ----------
const parts = Array.from({ length: PARTS }, () => ({ q: [], head: 0, offset: 0 }));
const stats = { ingested: 0, dups: 0, invalid: 0, throttled: 0, processed: 0, alerts: 0, active: 0, eps: 0, burst: false, erasedDropped: 0 };
const lat95 = new Float32Array(2048); let latI = 0;

function ingest(e) { // validate -> dedupe -> partition (back-pressure when backlog > 200k)
  if (!e || typeof e.vin !== 'string' || !VIN_RE.test(e.vin) || !idxOf.has(e.vin) || !(e.speed_kmh >= 0 && e.speed_kmh <= 300) || !(e.soc_pct >= 0 && e.soc_pct <= 100) || !Number.isFinite(e.ts)) { stats.invalid++; return; }
  if (store.erased.has(e.vin)) { stats.erasedDropped++; return; }
  if (seenBefore(e.vin + ':' + e.seq)) { stats.dups++; return; }
  const p = parts[h32(e.vin, 1) % PARTS]; if (p.q.length - p.head > 25000) { stats.throttled++; return; }
  e.recv = now(); p.q.push(e); stats.ingested++;
}

const FEATURE_LABELS = ['high engine temperature', 'fault codes', 'fast battery drain', 'harsh braking'];
function process_(e) {
  const i = idxOf.get(e.vin);
  if (evN[i] === 0) { stats.active++; eTemp[i] = e.temp_c; soc0[i] = e.soc_pct; } else eTemp[i] = 0.7 * eTemp[i] + 0.3 * e.temp_c;
  eSpd[i] = 0.8 * eSpd[i] + 0.2 * e.speed_kmh; lat[i] = e.lat; lon[i] = e.lon; soc[i] = e.soc_pct;
  evN[i]++; dtcN[i] += e.dtc.length; if (e.dtc.length) lastDtc[i] = e.dtc[0]; if (e.evt === 'HARSH_BRAKE') harsh[i]++;
  store.append({ vin: e.vin, ts: e.ts, fleet: fleetOf[i], lat: e.lat, lon: e.lon, speed_kmh: +e.speed_kmh.toFixed(1), soc_pct: +e.soc_pct.toFixed(1), temp_c: +e.temp_c.toFixed(1), dtc: e.dtc, evt: e.evt, seq: e.seq });
  if (evN[i] < 4) { lat95[latI++ & 2047] = now() - e.recv; stats.processed++; return; } // need history before scoring
  const x = feat(eTemp[i], dtcN[i], soc0[i] - soc[i], harsh[i], evN[i]);
  const r = sig(model.b + x.reduce((a, v, k) => a + v * model.w[k], 0)); risk[i] = r;
  if (r > 0.9 && !alerted[i]) {
    alerted[i] = 1; const top = x.map((v, k) => v * model.w[k]).reduce((m, v, k, a) => v > a[m] ? k : m, 0);
    const reason = `Likely failure within 7 days: ${FEATURE_LABELS[top]}`; const ts = now();
    insAlert.run(i, fleetOf[i], ts, r, reason); stats.alerts++;
    push('alert', { vin: e.vin, fleet: fleetOf[i], risk: +r.toFixed(3), reason, ts });
  }
  lat95[latI++ & 2047] = now() - e.recv; stats.processed++;
}
function consume() {
  let n = 0; for (const p of parts) { let c = 0; while (p.head < p.q.length && c++ < 4000) { process_(p.q[p.head++]); p.offset++; n++; } if (p.head > 50000) { p.q = p.q.slice(p.head); p.head = 0; } }
  setImmediate(consume);
}

// ---------- Simulator: bursts, duplicates, out-of-order, bad payloads ----------
let late = [];
function simulate() {
  const mult = stats.burst ? 3 : 1, n = (RATE / 10) * mult, out = late; late = [];
  for (const e of out) ingest(e);
  for (let j = 0; j < n; j++) {
    const i = (rnd() * N) | 0, k = ++simSeq[i], p = phys(faulty[i], k);
    const e = { vin: vinOf(i), ts: now(), seq: k, lat: lat[i] + (rnd() - 0.5) * 0.002, lon: lon[i] + (rnd() - 0.5) * 0.002,
      speed_kmh: Math.min(120, 20 + rnd() * 90), soc_pct: Math.max(5, 80 - p.socDrop), temp_c: p.temp, dtc: p.dtc, evt: p.hb ? 'HARSH_BRAKE' : 'NONE' };
    const r = rnd();
    if (r < 0.03) late.push(e); else { ingest(e); if (r > 0.98) ingest({ ...e }); if (r > 0.999) ingest({ vin: 'BAD', ts: 'x' }); }
  }
}
function startTimers() {
  let lastP = 0; setInterval(() => { stats.eps = stats.processed - lastP; lastP = stats.processed; push('stats', pubStats()); }, 1000);
  setInterval(() => { stats.burst = true; setTimeout(() => stats.burst = false, 5000); }, 30000);
  setInterval(() => store.rotate(Date.now()), 10000);
}
const pubStats = () => { const a = Array.from(lat95.slice(0, Math.min(latI, 2048))).sort((x, y) => x - y);
  return { vehicles: N, eps: stats.eps, ...stats, backlog: parts.reduce((s, p) => s + p.q.length - p.head, 0), p95_ms: a.length ? a[Math.floor(a.length * 0.95)] : 0, partitions: parts.map(p => p.offset) }; };

// ---------- Auth, RBAC, rate limit, SSE ----------
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const mint = u => { const b = b64({ u: u.username, r: u.role, f: u.fleet_id, exp: now() + 3600e3 }); return b + '.' + sign(b); };
function verify(t) { if (!t) return null; const [b, s] = t.split('.'); if (!s || sign(b) !== s) return null; const o = JSON.parse(Buffer.from(b, 'base64url')); return o.exp > now() ? o : null; }
const inScope = (u, i) => u.r === 'admin' || fleetOf[i] === u.f;
const buckets = new Map();
const limited = ip => { const t = now(), b = buckets.get(ip) || { n: 0, t }; if (t - b.t > 10000) { b.n = 0; b.t = t; } b.n++; buckets.set(ip, b); return b.n > 200; };
const clients = new Set();
function push(ev, data) { for (const c of clients) if (ev === 'stats' || c.u.r === 'admin' || c.u.f === data.fleet) c.res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); }

// ---------- Query layer ----------
const vehicleView = (i, u) => { const d = u && u.r !== 'admin' ? 2 : 4; return ({ vin: vinOf(i), fleet: fleetOf[i], risk: +risk[i].toFixed(3), temp_c: +eTemp[i].toFixed(1), soc_pct: +soc[i].toFixed(1), dtc_count: dtcN[i], last_dtc: lastDtc[i] || null, harsh_brakes: harsh[i], events: evN[i], lat: +lat[i].toFixed(d), lon: +lon[i].toFixed(d) }); };
function topRisk(u, limit, cursor) { // keyset pagination on (risk desc, idx asc)
  const [cr, ci] = cursor ? cursor.split('_').map(Number) : [Infinity, -1], c = [];
  for (let i = 0; i < N; i++) if (risk[i] >= 0.5 && inScope(u, i)) { const r = +risk[i].toFixed(6); if (r < cr || (r === cr && i > ci)) c.push([r, i]); }
  c.sort((a, b) => b[0] - a[0] || a[1] - b[1]); const page = c.slice(0, limit), l = page[page.length - 1];
  return { total_candidates: c.length, items: page.map(([, i]) => vehicleView(i, u)), cursor: page.length === limit ? `${l[0]}_${l[1]}` : null };
}
const ACTION = { 'high engine temperature': 'Inspect coolant system and thermostat', 'fault codes': 'Run OBD-II diagnostics', 'fast battery drain': 'Test battery and charging system', 'harsh braking': 'Check brake pads and coach the driver' };
const TOOLS = { // the agent can only call these read-only tools
  top_risk: (u) => topRisk(u, 5).items,
  vehicle: (u, vin) => { const i = idxOf.get(vin); return i !== undefined && inScope(u, i) ? vehicleView(i, u) : null; },
  fleet_summary: (u) => { let n = 0, hi = 0, act = 0; for (let i = 0; i < N; i++) if (inScope(u, i)) { n++; if (evN[i]) act++; if (risk[i] > 0.9) hi++; } return { vehicles: n, reporting: act, high_risk: hi }; },
  similar_cases: (u, vin) => { const i = idxOf.get(vin); return i !== undefined && inScope(u, i) ? vec.nearestCases(embedOf(i), 3) : []; },
  low_battery: (u) => { const c = []; for (let i = 0; i < N; i++) if (evN[i] && inScope(u, i)) c.push([soc0[i] - soc[i], i]); return c.sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, i]) => vehicleView(i, u)); }
};
function copilot(u, text) {
  const t = text.toLowerCase().slice(0, 300), used = [];
  const call = (n, ...a) => { used.push(n); audit(u.u, 'agent_tool:' + n, a.join(',')); return TOOLS[n](u, ...a); };
  let ans;
  if (/delete|schedule|order|update|change|send|ignore previous/.test(t)) ans = 'Guardrail: I can only read fleet data. Scheduling or changing records must be done by a person.';
  else if (/1tr[a-hj-np-z0-9]{14}/i.test(t)) { const vin = t.match(/1tr[a-hj-np-z0-9]{14}/i)[0].toUpperCase(), v = call('vehicle', vin);
    ans = v && /similar|fix|recommend|what should|why/.test(t) ? similarAnswer(vin, call('similar_cases', vin)) : v ? `${vin}: risk ${v.risk}, engine ${v.temp_c}C, battery ${v.soc_pct}%, ${v.dtc_count} fault codes.` : 'No such vehicle in your fleet.'; }
  else if (/battery|soc/.test(t)) ans = 'Fastest battery drain: ' + call('low_battery').map(v => `${v.vin} (${v.soc_pct}%)`).join(', ');
  else if (/summary|overview|fleet/.test(t)) { const s = call('fleet_summary'); ans = `${s.vehicles} vehicles in scope, ${s.reporting} reporting, ${s.high_risk} at high risk.`; }
  else { const r = call('top_risk'); ans = r.length ? 'Highest risk of failure in 7 days:\n' + r.map(v => `${v.vin}: ${Math.round(v.risk * 100)}%`).join('\n') + '\nSuggested first step: ' + ACTION['fault codes'] + ' on the top vehicle.' : 'No vehicles flagged yet. The simulator needs a few seconds to build history.'; }
  audit(u.u, 'agent_query', text.slice(0, 120)); return { answer: ans, tools_used: used };
}

// ---------- Vector search, privacy erasure, metrics ----------
const embedOf = i => vec.embed({ temp: eTemp[i], socDrop: soc0[i] - soc[i], dtc: dtcN[i], harsh: harsh[i], events: evN[i], lastDtc: lastDtc[i] });
const similarAnswer = (vin, c) => c.length ? `${vin} looks most like: ${c[0].title} (${Math.round(c[0].similarity * 100)}% match). Suggested action: ${c[0].action}.` : 'No similar cases found.';
function similar(u, i) {
  const q = embedOf(i), cand = [];
  for (let j = 0; j < N; j++) if (j !== i && evN[j] >= 4 && risk[j] > 0.3 && inScope(u, j)) cand.push({ id: j, vec: embedOf(j) });
  return { cases: vec.nearestCases(q, 3), similar_vehicles: vec.topK(q, cand, 5).map(r => ({ vin: vinOf(r.id), similarity: r.similarity, risk: +risk[r.id].toFixed(3) })) };
}
function eraseVehicle(u, vin) {
  const i = idxOf.get(vin); if (i === undefined) return null;
  const files = store.erase(vin), alertsRemoved = db.prepare('DELETE FROM alerts WHERE vehicle_id=?').run(i).changes;
  const dr = db.prepare('SELECT driver_id d FROM vehicles WHERE id=?').get(i).d;
  db.prepare('UPDATE vehicles SET driver_id=NULL WHERE id=?').run(i);
  if (dr) db.prepare('DELETE FROM drivers WHERE id=? AND NOT EXISTS(SELECT 1 FROM vehicles WHERE driver_id=?)').run(dr, dr);
  if (evN[i]) stats.active--;
  risk[i] = 0; evN[i] = 0; dtcN[i] = 0; harsh[i] = 0; alerted[i] = 0; lastDtc[i] = undefined; soc0[i] = soc[i] = eTemp[i] = eSpd[i] = 0; lat[i] = lon[i] = 0;
  audit(u.u, 'erasure', vin); return { erased: true, vin, alerts_removed: alertsRemoved, files_rewritten: files };
}
const apiLat = new Float32Array(1024); let apiI = 0;
function metrics(res) {
  const p = pubStats(), a = Array.from(apiLat.slice(0, Math.min(apiI, 1024))).sort((x, y) => x - y), st = store.stats();
  const m = { events_processed_total: p.processed, duplicates_dropped_total: p.dups, invalid_dropped_total: p.invalid, throttled_total: p.throttled, alerts_total: p.alerts, backlog: p.backlog, events_per_second: p.eps,
    ingest_p95_ms: +p.p95_ms.toFixed(2), api_p95_ms: a.length ? +a[Math.floor(a.length * 0.95)].toFixed(2) : 0, warm_bytes: st.warm_bytes, cold_bytes: st.cold_bytes, erased_vehicles: store.erased.size };
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }); res.end(Object.entries(m).map(([k, v]) => `# TYPE fleetpulse_${k} gauge\nfleetpulse_${k} ${v}`).join('\n') + '\n');
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const send = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(o)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, ip = req.socket.remoteAddress;
  const t0 = process.hrtime.bigint(); res.on('finish', () => { if (p.startsWith('/api/')) apiLat[apiI++ & 1023] = Number(process.hrtime.bigint() - t0) / 1e6; });
  if (p === '/health') return send(res, 200, { status: 'ok', uptime_s: Math.round(process.uptime()) });
  if (p === '/metrics') return metrics(res);
  if (!p.startsWith('/api/')) { const f = path.join(__dirname, 'public', p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    return fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'", 'X-Content-Type-Options': 'nosniff' }); res.end(b); }); }
  if (limited(ip)) return send(res, 429, { error: 'Too many requests. Wait a few seconds.' });
  if (p === '/api/login' && req.method === 'POST') { let b = ''; req.on('data', d => { b += d; if (b.length > 2000) req.destroy(); });
    return req.on('end', () => { try { const { username, password } = JSON.parse(b), u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
      if (u && crypto.timingSafeEqual(crypto.scryptSync(String(password), u.salt, 32), Buffer.from(u.hash, 'hex'))) { audit(username, 'login'); return send(res, 200, { token: mint(u), role: u.role, fleet: u.fleet_id }); }
      audit(String(username).slice(0, 40), 'login_failed'); send(res, 401, { error: 'Wrong username or password.' }); } catch { send(res, 400, { error: 'Bad request.' }); } }); }
  const u = verify((req.headers.authorization || '').replace('Bearer ', '') || url.searchParams.get('token'));
  if (!u) return send(res, 401, { error: 'Sign in required.' });
  const lim = Math.min(+url.searchParams.get('limit') || 25, 100);
  if (p === '/api/stream') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); const c = { u, res }; clients.add(c); req.on('close', () => clients.delete(c)); return; }
  if (p === '/api/stats') return send(res, 200, pubStats());
  if (p === '/api/model') return send(res, 200, model.metrics);
  if (p === '/api/at-risk') { audit(u.u, 'read_at_risk'); return send(res, 200, topRisk(u, lim, url.searchParams.get('cursor'))); }
  if (p === '/api/alerts') { const after = +url.searchParams.get('before') || 9e15;
    const rows = u.r === 'admin' ? db.prepare('SELECT a.id,v.vin,a.ts,a.risk,a.reason FROM alerts a JOIN vehicles v ON v.id=a.vehicle_id WHERE a.id<? ORDER BY a.id DESC LIMIT ?').all(after, lim)
      : db.prepare('SELECT a.id,v.vin,a.ts,a.risk,a.reason FROM alerts a JOIN vehicles v ON v.id=a.vehicle_id WHERE a.fleet_id=? AND a.id<? ORDER BY a.id DESC LIMIT ?').all(u.f, after, lim);
    return send(res, 200, { items: rows, next_before: rows.length === lim ? rows[rows.length - 1].id : null }); }
  if (p.startsWith('/api/vehicle/')) { const [v0, sub] = p.slice(13).split('/'), vin = v0.toUpperCase(), i = idxOf.get(vin); audit(u.u, 'read_vehicle', vin);
    if (i === undefined || !inScope(u, i)) return send(res, 404, { error: 'Vehicle not found in your fleet.' });
    if (sub === 'similar') return send(res, 200, similar(u, i));
    if (sub === 'history') { const d = u.r === 'admin' ? 4 : 2; return send(res, 200, { vin, events: store.history(vin, 20).map(e => ({ ...e, lat: +e.lat.toFixed(d), lon: +e.lon.toFixed(d) })) }); }
    return send(res, 200, vehicleView(i, u)); }
  if (p === '/api/analytics/batch') { audit(u.u, 'read_batch'); return send(res, 200, { analytics: store.batchAnalytics(u.r === 'admin' ? 0 : u.f), storage: store.stats() }); }
  if (p === '/api/erasure' && req.method === 'POST') { if (u.r !== 'admin') return send(res, 403, { error: 'Only admins can erase data.' }); let b = ''; req.on('data', d => { b += d; if (b.length > 2000) req.destroy(); });
    return req.on('end', () => { try { const r = eraseVehicle(u, String(JSON.parse(b).vin || '').toUpperCase()); send(res, r ? 200 : 404, r || { error: 'Unknown VIN.' }); } catch { send(res, 400, { error: 'Bad request.' }); } }); }
  if (p === '/api/audit' && u.r === 'admin') return send(res, 200, db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(lim));
  if (p === '/api/copilot' && req.method === 'POST') { let b = ''; req.on('data', d => { b += d; if (b.length > 2000) req.destroy(); });
    return req.on('end', () => { try { send(res, 200, copilot(u, String(JSON.parse(b).q || ''))); } catch { send(res, 400, { error: 'Bad request.' }); } }); }
  send(res, 404, { error: 'Unknown endpoint.' });
});
function drain() { for (const p of parts) { while (p.head < p.q.length) { process_(p.q[p.head++]); p.offset++; } } }
function main() {
  const listen = (port) => {
    server.once('error', err => {
      if (err.code === 'EADDRINUSE') {
        const nextPort = port + 1;
        console.warn(`Port ${port} is busy; retrying on ${nextPort}...`);
        listen(nextPort);
        return;
      }
      throw err;
    });

    server.listen(port, '0.0.0.0', () => {
      const actualPort = server.address().port;
      console.log(`FleetPulse: ${N} vehicles, ~${RATE} events/s -> http://localhost:${actualPort}  (admin/admin123, manager1/fleet123)`);
      console.log('Model holdout:', JSON.stringify(model.metrics));
      setInterval(simulate, 100); consume();
    });
  };

  startTimers();
  listen(PORT);
}
if (require.main === module) main();
module.exports = { main, server, N, vinOf, VIN_RE, idxOf, seenBefore, model, sig, synth, feat, phys, ingest, process_, drain, simulate, stats, pubStats, parts,
  risk, alerted, evN, fleetOf, inScope, mint, verify, copilot, topRisk, buckets, db, store, eraseVehicle, vehicleView, similar };
