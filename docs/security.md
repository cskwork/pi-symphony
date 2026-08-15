# Security model

**Symphony for Pi runs with your full user permissions. It is not a sandbox.**

## What is enforced

| Surface | Mechanism |
|---|---|
| Check execution | executable + argument vector (no `shell:true`), mandatory `timeout_ms`, `max_output_bytes` cap, environment allowlist (`PATH`, `HOME`, explicit `env_allowlist`) |
| Git operations | read-only subcommand allowlist (status/diff/rev-parse/log/branch/show/merge-base/ls-files/config); push/merge/reset/clean/… rejected before spawn |
| Task text | cannot redefine commands, protected paths, approval policy, or credentials — config comes only from `.symphony/config.yaml` |
| Model tools | report submission and read-only queries only; no transition, check, or arbitrary mutation capability |
| Evidence | secrets redacted before persistence/display/transport; credentials never enter artifacts |
| Reviewer session | fresh session, `noExtensions/noSkills/noContextFiles`, read-only tool set, bounded manifest, turn cap |
| Web UI (v0.2) | loopback-only bind, host+origin+credential validation on mutations, CSP `frame-ancestors 'none'`, bounded bodies/artifacts, no shell/file/deploy endpoints |

## What is *not* a boundary

- Another process under the same user account can read or modify `.symphony/` files.
- The check commands you configure run with your permissions. Configure only commands you trust.
- The v0.2 local server binds loopback but any local page/process may attempt requests; token+origin checks mitigate, they do not sandbox.
