#!/usr/bin/env node
/**
 * Load smoke test: boots the real pi runtime with the Symphony extension and
 * exercises read-only commands. Exits non-zero on any failure (V01-E8).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "src", "extension", "index.ts");

const runs = [
	{ label: "load + /sym doctor", prompt: "/sym doctor" },
	{ label: "load + /sym status", prompt: "/sym status" },
	{ label: "load + /sym web status", prompt: "/sym web status" },
	{ label: "load + /sym recover", prompt: "/sym recover" },
	{ label: "reload (repeat load)", prompt: "/sym doctor" },
];

let failures = 0;
for (const run of runs) {
	const result = spawnSync("pi", ["-e", ext, "-p", run.prompt], {
		encoding: "utf8",
		timeout: 120_000,
		cwd: here,
	});
	const ok = result.status === 0;
	console.log(`${ok ? "PASS" : "FAIL"}  ${run.label} (exit ${result.status})`);
	if (!ok) {
		failures += 1;
		console.log((result.stderr || result.stdout || "").slice(0, 2000));
	}
}
process.exit(failures > 0 ? 1 : 0);
