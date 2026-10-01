// Single-process load test: generator + validation + dedupe + partitions + scoring, 100K vehicles.
process.env.VEHICLES ||= '100000'; process.env.RATE ||= '500000'; process.env.DB_PATH = ':memory:';
const s = require('../server.js'), SECS = +process.env.SECS || 8;
function phase(name, secs, burst) {
  s.stats.burst = burst; const p0 = s.stats.processed, i0 = s.stats.ingested, th0 = s.stats.throttled, t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) { s.simulate(); s.drain(); }
  s.stats.burst = false; const el = (Date.now() - t0) / 1000, done = s.stats.processed - p0, ing = s.stats.ingested - i0;
  return { phase: name, seconds: +el.toFixed(1), events_per_sec: Math.round(done / el), accepted: ing, processed: done, lost: ing - done, throttled: s.stats.throttled - th0 };
}
const normal = phase('steady', SECS, false), burst = phase('3x burst', Math.max(3, SECS / 2), true), p = s.pubStats();
console.table([normal, burst]);
console.log({ vehicles: p.vehicles, p95_ms: +p.p95_ms.toFixed(1), duplicates_dropped: p.dups, invalid_dropped: p.invalid, alerts: p.alerts, heap_mb: Math.round(process.memoryUsage().heapUsed / 1e6) });
const checks = { 'sustains 100K+ events/s': normal.events_per_sec >= 100000, 'no loss in burst': burst.lost === 0 && burst.throttled === 0, 'p95 under 2000 ms': p.p95_ms < 2000 };
console.log(checks); process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
