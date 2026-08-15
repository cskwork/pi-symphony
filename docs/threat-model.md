# Threat model (v0.9 traceability)

Symphony is **not a sandbox**: it runs with the user's permissions, and any same-user process can read or write `.symphony/`. The controls below bound what the *model* and *remote surfaces* can do, and make tampering *detectable*.

| ID | Asset | Actor | Entry point | Threat | Control | Tests | Residual risk |
|---|---|---|---|---|---|---|---|
| T1 | task/evidence files | model (implementer) | write/edit/bash tools | forged Ready/Done by editing state | protected paths (tasks/evidence always block), redirect-target classification, realpath/cwd-escape checks, file-vs-ledger reconciliation | security.test, extension-wiring.test | same-user processes outside Pi (documented) |
| T2 | workflow gates | model | sym_* tools | self-certified review, evidence-free completion | review-provenance invariant, contract-enforced transitions, async-only check gates, zero-check config rejection | blockers.test, security.test | none known |
| T3 | check evidence | local process | .symphony/evidence | tampered artifact flips failure→pass | sha256 digest in ledger, mismatch → broken | security.test | ledger rewrite by privileged user |
| T4 | web control plane | malicious local page | loopback HTTP | CSRF/DNS-rebind mutation, token theft | host/origin/credential/content-type checks, fragment token never logged, bounded bodies, strict CSP | web-server.test, web-protocol.test | same-user memory access |
| T5 | detached runtime | stale supervisor | RPC reports | post-takeover mutations | epoch + fencing-token validation | runtime-supervisor.test | none known |
| T6 | credential material | logs/exports | every persistence surface | secret leakage | redaction before persistence/transport everywhere | checks.test, security.test, integrations.test | novel secret formats |
| T7 | git repository | any surface | git argv | destructive git via argument smuggling | read-only subcommand+option allowlist; mutations only via 5 typed command kinds | gitinfo.test, worktrees.test | exotic future git flags |
