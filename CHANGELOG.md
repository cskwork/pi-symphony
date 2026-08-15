# Changelog

## 1.0.0 — production general availability

Everything below, hardening pass complete: compatibility matrix, threat model with test traceability, adversarial path corpus, migration journal, performance budgets, pagination, centralized resource limits, reproducible packaging metadata, and full documentation (install, workflow, security model, threat model, troubleshooting, per-version reports).

## 0.9.0 — release-candidate hardening

Compatibility gating (fail-closed), traceable threat model, adversarial path corpus, resumable migration journal, performance budgets, pagination for large sets.

## 0.8.0 — integrations, CI evidence, observability

Adapter capability contracts, conflict-safe field sync (remote never overwrites local-owned fields; remote labels map to validated commands only), idempotent outbound operations with receipts, push preflight (no force, divergence aborts), CI evidence gating on subject SHAs, polling budgets, default-off exports, usage provenance (unavailable ≠ zero), credential redaction, audit correlation.

## 0.7.0 — detached runtime, resumability, headless RPC

Supervisor authority (pid-locked, epoch invalidation), reconciliation gate, idempotent RPC command log, detachment contracts (approved stage/role/tool/attempt/time budgets with drift stops), durable event log with watermark continuity, typed timers idempotent across restarts, protocol negotiation, redacted diagnostics.

## 0.6.0 — multi-task scheduler

Validated dependency DAG, deterministic candidate selection with starvation bound, pause gating with reason codes, idempotent dispatch (intent→ack→reconcile→resolve), all-or-nothing multi-lease admission, exclusive resource ownership, failure taxonomy with circuit breakers.

## 0.5.0 — worktrees and controlled delivery

Typed git mutations (five fixed command kinds), managed worktree registry with sanitized collision-safe branches, fenced write leases (atomic CAS, monotonic tokens, stale-report rejection), delivery preflight with separate blockers, IntegratedUnverified disposition, manual-integration containment proof, safe cleanup.

## 0.4.0 — delegation and handoffs

Immutable role launch manifests, role lifecycle state machine, read-only enforcement for delegated roles, Quick/Standard/Deep topologies, durable validated handoff ledger with idempotency keys and append-only audit.

## 0.3.0 — workflow customization and skills

Typed data-only condition AST, graph validation with invariant enforcement (no evidence-free path to Done), dry simulation with explanations, compileWorkflow runtime, skill manifests/catalogs/progressive disclosure/pinning/capability intersection/lint/fixtures, config v1→v2 migration.

## 0.2.0 — synchronized local HTML control plane

Loopback token-authenticated server, frozen protocol contract, SSE with Last-Event-ID replay, config draft→validate→diff→apply, constrained command endpoint, zero-dependency SPA.

## 0.1.1 — review fixes

All findings from two adversarial reviews fixed: blocked-edge contracts, review provenance invariant, trust boundary (.symphony + env protection, bash redirects, realpath), evidence digest binding, file-vs-ledger reconciliation, stale-evidence hole, plan-approval binding, zero-check config rejection, lease mutual exclusion, resume-vs-retry, HEAD resolution, O_EXCL allocation, git option allowlist, redaction, process-tree kills, parser tolerance, durability.

## 0.1.0 — Pi-native foundation

SymphonyCore command service, workflow engine with output contracts, fresh-context reviewer, deterministic checks with redaction, crash recovery, /sym command router, overlay, tools, guard.
