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

## Status

- **v0.2** — Pi-native foundation + synchronized local HTML control plane.
- v0.3 adds workflow customization and composable skills.

See `docs/` for version reports and review records.
