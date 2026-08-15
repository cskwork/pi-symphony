# Troubleshooting

**`/sym` does nothing** — the extension must be loaded from a trusted location (`pi install …` or `~/.pi/agent/extensions/`). Check the startup extension list; untrusted project-local extensions stay disabled until you trust the project.

**"configuration is invalid"** — `/sym doctor` prints path-specific repair guidance. Read-only inspection stays available. Common causes: shell-string `argv`, missing `timeout_ms`, empty check sets, unknown check references.

**"another live Symphony process holds the execution lease"** — a second Pi process is running Symphony in this checkout. Either stop it or `/sym recover` after it dies (dead-owner leases are reclaimed automatically with confirmation).

**Checks stay "not run" after `/sym checks`** — the check command must exist in the allowlisted environment (`PATH`); the executor passes only `PATH`, `HOME`, and explicitly allowlisted variables. `unavailable` means the executable could not start.

**Task stuck in `postverify`: "current checkout is X but integration declares Y"** — check out the integrated revision and retry, or re-record integration at the current revision when it is itself on the target branch (Symphony offers the repair automatically).

**Review never advances past `review`** — review reports must come from the fresh reviewer session (`/sym continue` in review) or a recorded human approval. Implementer-session notes can never certify.

**Widget shows `⚠ interrupted`** — the previous process died mid-attempt. `/sym continue` offers Resume (same attempt, no retry budget) or Retry (new attempt).

**Web UI shows Disconnected** — the server lives inside the Pi process; Pi exit or `/sym web stop` disconnects it. Restart with `/sym web`.

**Integrity report mentions "task file was edited outside Symphony"** — someone edited a task file directly. Gates use the ledger view; fix the file or accept the ledger state via `/sym doctor`.
