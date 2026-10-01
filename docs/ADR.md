# Architecture Decision Records

## ADR-1: In-process partitioned log instead of Kafka
Status: accepted for the hackathon build. Context: the build must run with one command and no Docker. Decision: an 8-partition in-process log keyed by VIN hash with the same semantics as Kafka (ordering per vehicle, offsets, back-pressure). Consequences: no durability across restarts and no replay. In production, swap the log for Kafka or Redpanda; the stream processor already works per partition.

## ADR-2: Polyglot storage with one reason per store
Decision: SQLite for ACID entities, typed arrays for hot state, NDJSON/gzip for raw documents, a vector layer for similarity. Consequences: each store matches its access pattern, but cross-store consistency is by design only eventual (see ADR-3).

## ADR-3: CP for entities, AP for telemetry
Decision: users, ownership, alerts and audit sit in one ACID store; telemetry is eventually consistent and de-duplicated. Consequences: telemetry can lag the alert table by seconds, which the dashboard tolerates.

## ADR-4: Logistic regression with an explicit baseline
Decision: a four-feature logistic model beats a plain temperature-threshold rule (F1 0.91 vs 0.76 on simulated held-out data). Consequences: it is explainable (top contributing feature becomes the alert reason) and runs in O(1) per event. Limitation: trained on simulator data, so real-world accuracy is unproven.

## ADR-5: Read-only audited copilot
Decision: the agent can call only four read-only tools plus case retrieval, refuses write verbs, is scoped to the caller's fleet, and every query and tool call is written to the audit table. Consequences: it cannot change data, which keeps the blast radius small. It is rule-based, not an LLM; an LLM could be added behind the same tool whitelist.

## ADR-6: Zero dependencies
Decision: Node 22 built-ins only (http, node:sqlite, crypto, zlib). Consequences: nothing to install and no supply-chain surface, but we hand-wrote items a framework would give us (routing, rate limiting).
