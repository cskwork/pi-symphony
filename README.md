# Symphony for Pi

Evidence-based software-development workflow for the [Pi coding agent](https://pi.dev). One repository-local extension takes a task through **Plan → Build → Review → Verify → Ready → Done** with durable evidence, an independent fresh-context reviewer, deterministic checks, and crash-safe recovery.

```text
SYMPHONY  DEV-014 · BUILD · ● running
Fix pagination race · AC 2/3 · checks not run
```

## Install

```bash
pi install npm:@cskwork/pi-symphony        # from npm (when published)
pi install /absolute/path/to/pi-symphony   # local checkout
```

Then inside a repository:

```text
/sym init        # inspect repo, propose checks, scaffold .symphony/ (no project scripts run)
/sym new         # create a task with acceptance criteria and risks
/sym continue    # the one action: advances the next valid step
/sym             # overlay: task list + detail (Overview/Contract/Changes/Review/Checks/History)
/sym doctor      # configuration, lease, recovery diagnostics
/sym complete    # post-integration verification against the integrated revision
/sym web         # local HTML control plane (loopback, token-authenticated)
```

## The workflow

```text
/sym new → BACKLOG → PLAN → BUILD → REVIEW → VERIFY → READY
                                                    ↓ (you merge to the target branch)
                                          POST-INTEGRATION VERIFY → DONE
```

Rules that cannot be bypassed by the model:

- Every transition is validated against the workflow graph **and** its output contract.
- A required check that failed, timed out, is unavailable, or is stale (different revision) **blocks Ready and Done**.
- Review runs in a **fresh session** with read-only tools and a bounded manifest — never the implementer transcript.
- Restarts mark in-flight attempts **Interrupted**; nothing resumes automatically or duplicates.
- Human notes outside managed markers in task files survive every machine write.

## Model-facing tools

| Tool | Purpose |
|---|---|
| `sym_task_read` | Read the task contract, reports, and state |
| `sym_diff_read` | Bounded diff + evidence manifest |
| `sym_plan_submit` | Structured plan (engine decides the transition) |
| `sym_build_report` | Structured implementation report |
| `sym_review_submit` | Structured review report (verdict + findings) |

## Repository layout

```text
.symphony/
├── config.yaml               # schema v1, committed
├── config.local.yaml         # optional, gitignored presentation overrides
├── tasks/DEV-014.md          # one markdown task record per task
├── evidence/DEV-014/         # checks/, review/, integration/ artifacts
└── runtime/                  # gitignored: events/, leases/, cache/, logs/
```

## Safety model

Symphony runs with **your user permissions — it is not a sandbox**. Protections are policy and confirmation:

- Checks are executable + argument arrays with mandatory timeouts. No `shell:true`. Environment is allowlisted; secrets are redacted from evidence.
- Git operations are read-only inspection (status/diff/rev-parse/log/branch/show/merge-base). No push/merge/reset/clean — integration is manual by design.
- Protected paths (`.env*`, `.git/**`, `.symphony/runtime/**`) block or require confirmation on write/edit.
- Destructive shell commands (`git push`, `reset --hard`, `rm -rf`, `sudo`, …) require confirmation.

## Development

```bash
npm install
npm test         # vitest — unit + integration + wiring suites
npm run typecheck
pi -e ./src/extension/index.ts -p "/sym doctor"   # load smoke test
```

## Local web UI (v0.2)

`/sym web` starts a loopback-only server owned by the Pi process and prints a one-time URL like `http://127.0.0.1:43127/#token=…`. The token lives in the URL fragment (never sent in an HTTP request, never logged) and is exchanged for an in-memory session credential by the SPA. Mutating routes validate host, origin, credential, content type, and body size; the SPA has no external assets and a strict CSP. `/sym web stop|status|open` control the lifecycle. The browser is a thin client: every action goes through the same `SymphonyCore` commands as the TUI, and SSE with `Last-Event-ID` replay keeps both surfaces synchronized.

## Workflow customization & skills (v0.3)

Repositories can define a validated stage graph in `config.yaml` (schema v2): structured stages with typed data-only conditions (`task_kind`, `task_field`, `changed_paths`, `all/any/not`), declared inputs/outputs, approval and check gates, plus enforced invariants — no path to Done can bypass deterministic verification or completion evidence, and independent-review provenance is never optional. Skills live in `.symphony/skills/<name>/skill.yaml` with declared capabilities; the model sees catalog entries only (`sym_skills`) and loads full instructions on selection (`sym_skill_select`). Skills are hash-pinned; content drift requires re-approval, and a skill can never grant a capability that role/repository policy forbids.

## Delegation & handoffs (v0.4)

`/sym roles` shows the active topology (Quick / Standard / Deep); `/sym delegate <role>` launches a read-only fresh session (scout, architect, security reviewer, QA analyst, reviewer) with an immutable manifest — declared inputs, tools, turn/wall-clock budgets, and explicitly *omitted* scope. Results return through a durable handoff ledger: validated envelopes referencing artifacts by digest (never inline copies), idempotent submission, acceptance gated on role/task/stage/attempt/topology match, and append-only audit events. Delegated roles never get write tools; the implementer stays the single writer.

## Worktrees & delivery (v0.5)

Managed worktrees give delegated roles isolated write surfaces: allocation happens only after a preview, paths are canonicalized outside the repository, and branch names are deterministic and collision-safe. Write ownership uses **fenced leases** — atomic compare-and-swap with monotonically increasing fencing tokens, so a stale owner's report can never be accepted after a transfer, and a moved head invalidates evidence before any gate trusts it. Delivery is typed, previewed, and audited: non-mutating preflight lists each blocker separately; a mutation that lands but fails checks yields `IntegratedUnverified` — no auto-reset, explicit operator disposition required; manual integration must prove the result contains the approved task head (squash equivalence needs an explicit acknowledgment). Git mutations in the product are limited to five typed command kinds — the read-only inspection allowlist covers everything else.

## Multi-task scheduling (v0.6)

Tasks can declare validated dependencies (`task_done`, `stage_reached`, `check_passed`) evaluated against durable state. The scheduler is deterministic: selection is a pure function of the snapshot (priority → aging → age tie-breaks), with a starvation bound so eligible work never waits forever. Dispatch is idempotent (intent → ack → reconcile → resolve); admission claims all required capacity or none; exclusive resources have exactly one owner; retries are classified (transient/deterministic/policy/user/unknown) with circuit breakers that halt retry storms.

## Detached runtime & RPC (v0.7)

A supervisor owns a repository fingerprint exclusively (pid-locked; dead owners are reclaimed into a new epoch that invalidates stale reports). Startup runs a reconciliation gate over processes, leases, timers, workspaces, state, and event offsets before any dispatch. Mutating RPCs are idempotent (command ID + idempotency key + actor + typed payload; identical retries return the original outcome). Detachment contracts authorize exactly the stages/roles/tools/attempts/time approved — expiry, policy drift, or task drift stops at the next safe boundary. The event log guarantees watermark continuity between snapshots and live streams; timers fire typed commands exactly once across restarts and clock skew; protocol mismatches refuse mutation with a concrete upgrade path.

## Integrations & observability (v0.8)

Adapters declare their capabilities (read/write surfaces, auth source, rate limits, error taxonomy) before registration and only ever return normalized snapshots — remote changes to local-owned fields become explicit conflicts, and remote labels map to validated commands (never direct stage jumps). Outbound mutations are typed, approval-linked, and idempotent (one remote effect per key, receipts replayed after lost responses); push preflight refuses divergence and never authorizes force. CI evidence gates on the expected head SHA with unambiguous context mapping; local checks and remote CI stay distinct. Export is off by default (operational metadata only), usage distinguishes provider-reported/estimated/unavailable, and every credential-bearing surface is redacted.

## Status

- **v0.8** — + adapter contracts, conflict-safe sync, idempotent outbound ops, CI evidence gating, redacted observability, audit correlation.
- v0.9 hardens the release candidate; v1.0 is GA.

See `docs/` for version reports and review records.
