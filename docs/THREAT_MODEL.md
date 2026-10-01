# STRIDE threat model

| Threat | Example | Mitigation in this build | Gap |
|---|---|---|---|
| Spoofing | Stolen or forged token; fake device | HMAC-signed tokens with expiry, scrypt password hashes, constant-time compare, tamper tests | No mTLS for devices, no token revocation |
| Tampering | Modified token claims, malformed events | Signature check, strict event validation, parameterised SQL, SQL-injection test | Simulator events are not signed |
| Repudiation | Denying a data read or agent action | Audit table for logins, reads, copilot calls and erasures | Audit rows are not hash-chained |
| Information disclosure | Cross-fleet data read, precise location leak | Fleet scope on every query, 2-decimal location masking for non-admins, CSP and nosniff headers, escaped output | No TLS in the demo, no encryption at rest |
| Denial of service | Request flood, event flood | Rate limit (429), body size caps, partition back-pressure with throttling | Rate limit is per process and per IP only |
| Elevation of privilege | Manager calls admin APIs | Role checks on audit and erasure, tests for 403/404 | Only two roles |

Privacy: right to erasure rewrites every storage tier and blocks future events for that VIN (DPDP/GDPR style). Retention deletes cold data automatically.
Not yet done: DAST (OWASP ZAP), dependency and image scans (Trivy). The project has no third-party dependencies to scan.
