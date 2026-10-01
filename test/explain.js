// SQL optimisation evidence: query plan and timing before/after a composite index (500K alert rows).
let DatabaseSync; try { ({ DatabaseSync } = require('node:sqlite')); } catch { DatabaseSync = require('better-sqlite3'); } const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, vehicle_id INT, fleet_id INT, ts INT, risk REAL, reason TEXT)'); db.exec('BEGIN');
const ins = db.prepare('INSERT INTO alerts(vehicle_id,fleet_id,ts,risk,reason) VALUES(?,?,?,?,?)'); for (let i = 0; i < 500000; i++) ins.run(i % 100000, (i % 20) + 1, i, Math.random(), 'r'); db.exec('COMMIT');
const Q = 'SELECT id,vehicle_id,risk FROM alerts WHERE fleet_id=7 ORDER BY risk DESC LIMIT 25';
function run(label) { const plan = db.prepare('EXPLAIN QUERY PLAN ' + Q).all().map(r => r.detail).join(' | '), t = process.hrtime.bigint(); for (let k = 0; k < 20; k++) db.prepare(Q).all();
  console.log(label + '\n  query: ' + Q + '\n  plan:  ' + plan + '\n  avg:   ' + (Number(process.hrtime.bigint() - t) / 1e6 / 20).toFixed(2) + ' ms\n'); }
run('BEFORE: no index on (fleet_id, risk)'); db.exec('CREATE INDEX idx_alert_fleet_risk ON alerts(fleet_id, risk DESC)'); db.exec('ANALYZE'); run('AFTER: composite index (fleet_id, risk DESC)');
