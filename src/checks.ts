import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { monotonicId } from "./ids.ts";
import { redactSecrets } from "./redact.ts";
import type { CommandDefinition, CheckRunEvidence, CheckStatus } from "./types.ts";

/** Executor abstraction so tests can inject a fake process runner. */
export type CommandExecutor = (
	argv: string[],
	options: { cwd: string; timeoutMs: number; env: Record<string, string> },
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }>;

export const nodeExecutor: CommandExecutor = (argv, options) =>
	new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const child = spawn(argv[0]!, argv.slice(1), {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false, // never shell:true (PRD security model)
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const finish = (code: number | null, error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut, error });
		};
		child.on("error", (err) => finish(null, err.message));
		child.on("close", (code) => finish(code));
	});

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface CheckRunOptions {
	cwd: string;
	revision: string | null;
	/** Base environment passed to the command (already allowlisted). */
	env: Record<string, string>;
	executor?: CommandExecutor;
	now?: () => Date;
}

export interface CheckOutcome {
	status: CheckStatus;
	evidence: CheckRunEvidence;
	/** Path where evidence was persisted (caller decides where). */
}

/** Run one deterministic check and produce redacted, bounded evidence. */
export async function runCheck(
	name: string,
	def: CommandDefinition,
	options: CheckRunOptions,
): Promise<CheckOutcome> {
	const runId = monotonicId().toLowerCase();
	const startedAt = new Date();
	const maxBytes = def.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	let result: Awaited<ReturnType<CommandExecutor>>;
	try {
		result = await (options.executor ?? nodeExecutor)(def.argv, {
			cwd: def.cwd ? join(options.cwd, def.cwd) : options.cwd,
			timeoutMs: def.timeoutMs,
			env: options.env,
		});
	} catch (err) {
		result = { code: null, stdout: "", stderr: "", timedOut: false, error: (err as Error).message };
	}
	const finishedAt = new Date();
	const combined = (result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : "")).slice(0, maxBytes * 2);
	const redacted = redactSecrets(combined);
	const truncated = redacted.length > maxBytes;
	const output = truncated ? `${redacted.slice(0, maxBytes)}\n[truncated at ${maxBytes} bytes]` : redacted;

	let status: CheckStatus;
	if (result.error && result.code === null && !result.timedOut) status = "unavailable";
	else if (result.timedOut) status = "timeout";
	else if (result.code === 0) status = "passed";
	else status = "failed";

	const evidence: CheckRunEvidence = {
		check: name,
		runId,
		status,
		exitCode: result.code,
		durationMs: finishedAt.getTime() - startedAt.getTime(),
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		output,
		truncated,
		revision: options.revision,
		command: def.argv,
	};
	return { status, evidence };
}

/** Persist a check evidence artifact atomically. */
export function persistCheckEvidence(
	checksDir: string,
	evidence: CheckRunEvidence,
): string {
	mkdirSync(checksDir, { recursive: true });
	const path = join(checksDir, `${evidence.check}-${evidence.runId}.json`);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(evidence, null, "\t") + "\n", "utf8");
	renameSync(tmp, path);
	return path;
}

/** Build the allowlisted environment for a check (PATH plus explicit entries). */
export function buildCheckEnv(def: CommandDefinition, baseEnv: NodeJS.ProcessEnv): Record<string, string> {
	const env: Record<string, string> = { PATH: baseEnv["PATH"] ?? "" };
	if (baseEnv["HOME"]) env["HOME"] = baseEnv["HOME"];
	for (const key of def.envAllowlist ?? []) {
		const value = baseEnv[key];
		if (value !== undefined) env[key] = value;
	}
	// Never pass credential-like variables implicitly.
	return env;
}

/** Mark evidence stale when it ran against a different revision. */
export function isStale(evidence: CheckRunEvidence, currentRevision: string | null): boolean {
	// Non-git repositories (or artifacts recorded without a revision) have no
	// freshness anchor: staleness is untracked rather than assumed.
	if (currentRevision === null || evidence.revision === null) return false;
	return evidence.revision !== currentRevision;
}
