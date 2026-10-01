# FleetPulse: predictive maintenance for connected fleets

Run (no Docker, no npm install; needs Node 22.5+):

    node server.js          # then open http://localhost:3000

For deployment, run the Node server itself and expose the configured `PORT` (default
`3000`). The dashboard calls `/api/*` on the same origin, so deploying only `public/`
to a static host such as GitHub Pages will show network errors because the API is not
running there. On a VM, use `npm start` and allow inbound TCP traffic on port 3000.

Logins: `manager1 / fleet123` (one fleet), `admin / admin123` (all fleets).
Env vars: `VEHICLES=100000 RATE=20000 PORT=3000 WARM_SAMPLE=50 SEG_MS=60000 COLD_AFTER_MS=180000 RETAIN_MS=3600000`.

## What it does
Simulator (100K vehicles, bursts, duplicates, out-of-order, bad payloads) -> validation -> Bloom-filter de-dup -> 8 partitions by VIN hash
-> stream scoring (EWMA features + logistic model) -> alerts + live push -> dashboard.

- Relational (SQLite): fleets, drivers, vehicles, alerts, audit, users.
- Document store: fault events in NDJSON (warm) compacted to gzip (cold) with retention; per-vehicle history by byte offset.
- Batch analytics: top fault codes and harsh brakes over warm + cold data (`/api/analytics/batch`).
- Vector layer: similar vehicles and similar past repair cases; the copilot uses it ("what should I do about <VIN>").
- Privacy: location masking for non-admins, admin-only right-to-erasure across every tier, audit log.
- Ops: `/health`, Prometheus-style `/metrics`, rate limiting, keyset pagination.

## Tests
    npm test          # unit + integration (45 tests)
    npm run coverage  # coverage report
    npm run load      # 100K-vehicle steady + 3x burst test
    npm run explain   # SQL plan and timing before/after an index

CI: `.github/workflows/ci.yml`. Design docs: `docs/DESIGN.md` (architecture, ER, CAP, lifecycle, complexity), `docs/ADR.md`, `docs/THREAT_MODEL.md`.
`deploy/terraform/main.tf` is an untested single-VM AWS example.
Not covered: DAST (ZAP), Pact, BDD, real Kafka/Postgres/Redis, a real LLM agent.
