import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { monotonicId } from "./ids.ts";
import { redactSecrets } from "./redact.ts";
import type { CommandDefinition, CheckRunEvidence, CheckStatus } from "./types.ts";

/** Executor abstraction so tests can inject a fake process runner. */
export type CommandExecutor = (
	argv: string[],
	options: { cwd: string; timeoutMs: number; env: Record<string, string> },
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }>;

const MAX_BUFFERED_BYTES = 5 * 1024 * 1024;

export const nodeExecutor: CommandExecutor = (argv, options) =>
	new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let dropped = 0;
		let timedOut = false;
		let settled = false;
		// detached → own process group, so the timeout kill reaps the whole
		// tree (npm/vitest spawn children that otherwise hold the pipes open).
		const child = spawn(argv[0]!, argv.slice(1), {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false, // never shell:true (PRD security model)
			detached: true,
		});
		const killTree = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, options.timeoutMs);
		const append = (buffer: string, chunk: Buffer): string => {
			if (buffer.length >= MAX_BUFFERED_BYTES) {
				dropped += chunk.length;
				return buffer;
			}
			return buffer + chunk.toString("utf8");
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		const finish = (code: number | null, error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const note = dropped > 0 ? `\n[output buffer capped: ${dropped} bytes dropped]` : "";
			resolve({ code, stdout: stdout + note, stderr, timedOut, error });
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
	// Redact BEFORE slicing so secrets past the cap are never partially kept.
	const redacted = redactSecrets(result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ""));
	const combined = redacted.slice(0, maxBytes * 2);
	const truncated = combined.length > maxBytes;
	const output = truncated ? `${combined.slice(0, maxBytes)}\n[truncated at ${maxBytes} bytes]` : combined;

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

/**
 * Persist a check evidence artifact atomically; returns (path, digest).
 * The digest is recorded in the event ledger so post-hoc tampering with the
 * artifact is detectable on rehydration.
 */
export function persistCheckEvidence(
	checksDir: string,
	evidence: CheckRunEvidence,
): { path: string; digest: string } {
	mkdirSync(checksDir, { recursive: true });
	const path = join(checksDir, `${evidence.check}-${evidence.runId}.json`);
	const body = JSON.stringify(evidence, null, "\t") + "\n";
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, body, "utf8");
	renameSync(tmp, path);
	return { path, digest: createHash("sha256").update(body).digest("hex").slice(0, 32) };
}

/** Verify an artifact still matches the digest recorded when it was written. */
export function verifyCheckEvidenceDigest(checksDir: string, evidence: CheckRunEvidence, digest: string): boolean {
	try {
		const body = readFileSync(join(checksDir, `${evidence.check}-${evidence.runId}.json`), "utf8");
		return createHash("sha256").update(body).digest("hex").slice(0, 32) === digest;
	} catch {
		return false;
	}
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
export function isStale(evidence: { revision: string | null }, currentRevision: string | null): boolean {
	if (currentRevision === null || evidence.revision === null) return false;
	return evidence.revision !== currentRevision;
}
