'use strict';
// Document store with hot/warm/cold tiers (NoSQL role): schemaless raw events in NDJSON segments,
// gzip compaction to cold, retention delete, per-vehicle offset index, batch scans and true erasure.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const segOf = f => +path.basename(f).match(/seg-(\d+)/)[1];
class Store {
  constructor({ dir, segMs = 60000, coldAfterMs = 180000, retainMs = 3600000, sample = 50 }) {
    Object.assign(this, { segMs, coldAfterMs, retainMs, sample });
    this.warm = path.join(dir, 'warm'); this.cold = path.join(dir, 'cold');
    for (const d of [this.warm, this.cold]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
    this.index = new Map(); this.erased = new Set(); this.buf = []; this.file = null; this.size = 0; this.seen = 0; this.kept = 0;
  }
  append(e, t = Date.now()) { // keeps every fault/harsh-brake event plus 1 in `sample` ordinary events
    if (this.erased.has(e.vin) || !(e.dtc.length || e.evt !== 'NONE' || ++this.seen % this.sample === 0)) return false;
    const file = path.join(this.warm, `seg-${Math.floor(t / this.segMs) * this.segMs}.ndjson`);
    if (file !== this.file) { this.flush(); this.file = file; this.size = fs.existsSync(file) ? fs.statSync(file).size : 0; }
    const line = JSON.stringify(e) + '\n', len = Buffer.byteLength(line), refs = this.index.get(e.vin) || [];
    refs.push({ f: file, pos: this.size, len }); if (refs.length > 20) refs.shift(); this.index.set(e.vin, refs);
    this.buf.push(line); this.size += len; this.kept++; if (this.buf.length >= 2000) this.flush(); return true;
  }
  flush() { if (this.buf.length) { fs.appendFileSync(this.file, this.buf.join('')); this.buf = []; } }
  history(vin, n = 20) { // newest first, read by byte offset (no scan)
    this.flush(); const out = [];
    for (const r of (this.index.get(vin) || []).slice(-n)) { try { const fd = fs.openSync(r.f, 'r'), b = Buffer.alloc(r.len); fs.readSync(fd, b, 0, r.len, r.pos); fs.closeSync(fd); out.push(JSON.parse(b.toString())); } catch {} }
    return out.reverse();
  }
  files(dir) { return fs.readdirSync(dir).filter(f => /^seg-/.test(f)).map(f => path.join(dir, f)).sort(); }
  lines(f) { const raw = fs.readFileSync(f); return (f.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString().split('\n').filter(Boolean); }
  dropRefs(f) { for (const [v, refs] of this.index) { const k = refs.filter(r => r.f !== f); k.length ? this.index.set(v, k) : this.index.delete(v); } }
  rotate(t = Date.now()) { // warm -> cold (gzip) after coldAfterMs; cold deleted after retainMs
    this.flush(); let moved = 0, deleted = 0;
    for (const f of this.files(this.warm)) if (f !== this.file && t - segOf(f) >= this.coldAfterMs) {
      const keep = this.lines(f).filter(l => !this.erased.has(JSON.parse(l).vin));
      fs.writeFileSync(path.join(this.cold, path.basename(f) + '.gz'), zlib.gzipSync(keep.join('\n') + '\n')); fs.rmSync(f, { force: true }); this.dropRefs(f); moved++;
    }
    for (const f of this.files(this.cold)) if (t - segOf(f) >= this.retainMs) { fs.rmSync(f, { force: true }); deleted++; }
    return { moved_to_cold: moved, deleted };
  }
  batchAnalytics(fleet = 0) { // full scan over cold + warm: O(events)
    this.flush(); const t0 = Date.now(), dtc = {}, hb = {}, seg = {}; let total = 0, tsum = 0, files = 0;
    for (const f of [...this.files(this.cold), ...this.files(this.warm)]) { files++; const m = new Date(segOf(f)).toISOString().slice(11, 16);
      for (const l of this.lines(f)) { const e = JSON.parse(l); if (this.erased.has(e.vin) || (fleet && e.fleet !== fleet)) continue;
        total++; tsum += e.temp_c; for (const c of e.dtc) dtc[c] = (dtc[c] || 0) + 1; if (e.evt === 'HARSH_BRAKE') hb[e.fleet] = (hb[e.fleet] || 0) + 1; seg[m] = (seg[m] || 0) + 1; } }
    const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { events_scanned: total, files_scanned: files, avg_temp_c: total ? +(tsum / total).toFixed(1) : 0, top_fault_codes: top(dtc), harsh_brakes_by_fleet: top(hb), events_per_segment: seg, scan_ms: Date.now() - t0 };
  }
  erase(vin) { // right to erasure: rewrite every warm and cold file without the vehicle
    this.erased.add(vin); this.index.delete(vin); this.flush(); let n = 0; const needle = `"vin":"${vin}"`;
    for (const dir of [this.warm, this.cold]) for (const f of this.files(dir)) {
      const ls = this.lines(f), keep = ls.filter(l => !l.includes(needle)); if (keep.length === ls.length) continue; n++;
      const out = keep.length ? keep.join('\n') + '\n' : ''; fs.writeFileSync(f, f.endsWith('.gz') ? zlib.gzipSync(out) : out); if (f === this.file) this.reindex(f);
    }
    return n;
  }
  reindex(f) { this.dropRefs(f); let pos = 0; for (const l of this.lines(f)) { const len = Buffer.byteLength(l) + 1, v = JSON.parse(l).vin, refs = this.index.get(v) || []; refs.push({ f, pos, len }); if (refs.length > 20) refs.shift(); this.index.set(v, refs); pos += len; } this.size = pos; }
  stats() { this.flush(); const sz = d => this.files(d).reduce((s, f) => s + fs.statSync(f).size, 0);
    return { warm_files: this.files(this.warm).length, warm_bytes: sz(this.warm), cold_files: this.files(this.cold).length, cold_bytes: sz(this.cold), events_kept: this.kept, indexed_vehicles: this.index.size }; }
}
module.exports = { Store };
