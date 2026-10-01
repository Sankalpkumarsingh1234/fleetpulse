'use strict';
// Vector layer: fault-signature embeddings, cosine similarity, brute-force top-K, and a small repair-case knowledge base.
const CODES = ['P0301', 'P0217', 'P0562', 'P0420'];
const embed = f => [(f.temp - 90) / 30, f.socDrop / 30, Math.min(f.dtc, 6) / 6, Math.min(f.harsh / Math.max(f.events, 1) * 10, 1), ...CODES.map(c => (c === f.lastDtc ? 1 : 0))];
const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? d / Math.sqrt(na * nb) : 0; };
const CASES = [
  { id: 'C1', title: 'Overheating engine with coolant loss', f: { temp: 118, socDrop: 5, dtc: 3, harsh: 0, events: 10, lastDtc: 'P0217' }, action: 'Inspect coolant level, thermostat and radiator fan before the next trip' },
  { id: 'C2', title: 'Cylinder misfire (spark plug or coil)', f: { temp: 100, socDrop: 4, dtc: 5, harsh: 1, events: 10, lastDtc: 'P0301' }, action: 'Replace spark plugs and test the ignition coils' },
  { id: 'C3', title: 'Weak battery or alternator', f: { temp: 92, socDrop: 22, dtc: 2, harsh: 0, events: 10, lastDtc: 'P0562' }, action: 'Load-test the battery and check alternator output' },
  { id: 'C4', title: 'Catalytic converter degradation', f: { temp: 105, socDrop: 5, dtc: 3, harsh: 0, events: 10, lastDtc: 'P0420' }, action: 'Check the exhaust sensors and the catalytic converter' },
  { id: 'C5', title: 'Brake wear from aggressive driving', f: { temp: 93, socDrop: 4, dtc: 0, harsh: 6, events: 10, lastDtc: null }, action: 'Inspect brake pads and discs, and coach the driver' },
  { id: 'C6', title: 'Combined thermal and electrical failure', f: { temp: 120, socDrop: 24, dtc: 5, harsh: 2, events: 10, lastDtc: 'P0562' }, action: 'Take the vehicle out of service and run full diagnostics' }
].map(c => ({ ...c, vec: embed(c.f) }));
const nearestCases = (q, k = 3) => CASES.map(c => ({ id: c.id, title: c.title, action: c.action, similarity: +cosine(q, c.vec).toFixed(3) })).sort((a, b) => b.similarity - a.similarity).slice(0, k);
const topK = (q, items, k = 5) => { const out = []; for (const it of items) { const s = cosine(q, it.vec); if (out.length < k || s > out[out.length - 1].similarity) { out.push({ id: it.id, similarity: +s.toFixed(3) }); out.sort((a, b) => b.similarity - a.similarity); if (out.length > k) out.pop(); } } return out; };
module.exports = { embed, cosine, nearestCases, topK, CASES };
