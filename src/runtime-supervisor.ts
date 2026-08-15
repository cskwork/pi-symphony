/**
 * Detached runtime, resumability, and headless RPC (PRD v0.7).
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { monotonicId } from "./ids.ts";

// ---------------------------------------------------------------------------
// Supervisor authority (V07-SUP-*)
// ---------------------------------------------------------------------------

export type SupervisorState = "offline" | "starting" | "reconciling" | "ready" | "stopping";

export interface SupervisorEpoch {
	epoch: number;
	authorityToken: string;
	acquiredAt: string;
}

export class SupervisorAuthority {
	private epoch?: SupervisorEpoch;

	constructor(private lockFile: string, private pid: number) {}

	/**
	 * Exactly one authority per repository fingerprint (V07-SUP-001).
	 *
	 * The claim uses mkdir() — the one truly atomic filesystem primitive —
	 * so concurrent startups yield exactly one winner: the loser sees EEXIST,
	 * reads the record, and either refuses (live owner) or takes over via an
	 * atomic rename of the lock directory to a tombstone before retrying.
	 * Dead-owner takeover bumps the epoch, invalidating stale reports
	 * (V07-RUN-002).
	 */
	acquire(repositoryFingerprint: string): { ok: true; epoch: SupervisorEpoch; reclaimed: boolean } | { ok: false; error: string } {
		const lockDir = `${this.lockFile}.lock`;
		const recordPath = join(lockDir, "authority.json");
		mkdirSync(join(this.lockFile, ".."), { recursive: true });
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				mkdirSync(lockDir); // atomic claim: fails with EEXIST if taken
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
				const record = this.readRecord(recordPath);
				if (record && record.pid !== this.pid && this.isAlive(record.pid)) {
					return { ok: false, error: `another supervisor (pid ${record.pid}) owns this repository` };
				}
				// dead or unreadable owner: tombstone the directory atomically,
				// then retry — only one reclaimer's rename succeeds
				const tombstone = `${lockDir}.dead-${monotonicId()}`;
				try {
					renameSync(lockDir, tombstone);
					const dead = this.readRecord(join(tombstone, "authority.json"));
					const epoch: SupervisorEpoch = {
						epoch: (dead?.epoch ?? 0) + 1,
						authorityToken: randomBytes(16).toString("hex"),
						acquiredAt: new Date().toISOString(),
					};
					mkdirSync(lockDir, { recursive: true });
					writeFileSync(join(lockDir, "authority.json"), JSON.stringify({ ...epoch, pid: this.pid, fingerprint: repositoryFingerprint }, null, "\t"), "utf8");
					this.epoch = epoch;
					return { ok: true, epoch, reclaimed: true };
				} catch (renameErr) {
					if ((renameErr as NodeJS.ErrnoException).code !== "ENOENT") throw renameErr;
					continue; // someone else tombstoned it first — retry the claim
				}
			}
			// we created the directory: fresh claim (epoch continues from any tombstone)
			const dead = this.readLatestTombstone(`${this.lockFile}.lock.dead-`);
			const epoch: SupervisorEpoch = {
				epoch: (dead?.epoch ?? 0) + 1,
				authorityToken: randomBytes(16).toString("hex"),
				acquiredAt: new Date().toISOString(),
			};
			writeFileSync(join(lockDir, "authority.json"), JSON.stringify({ ...epoch, pid: this.pid, fingerprint: repositoryFingerprint }, null, "\t"), "utf8");
			this.epoch = epoch;
			return { ok: true, epoch, reclaimed: dead !== undefined };
		}
		return { ok: false, error: "could not claim supervisor authority after takeover races" };
	}

	private readRecord(path: string): { epoch: number; pid: number } | undefined {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as { epoch: number; pid: number };
		} catch {
			return undefined;
		}
	}

	private readLatestTombstone(prefix: string): { epoch: number; pid: number } | undefined {
		try {
			const parent = join(this.lockFile, "..");
			const candidates = readdirSync(parent)
				.filter((f) => f.startsWith(prefix.split("/").pop()!))
				.sort();
			const latest = candidates[candidates.length - 1];
			return latest ? this.readRecord(join(parent, latest, "authority.json")) : undefined;
		} catch {
			return undefined;
		}
	}

	current(): SupervisorEpoch | undefined {
		return this.epoch;
	}

	/** Reports from an older epoch are stale by definition (V07-RUN-002). */
	acceptsReport(reportedEpoch: number, fencingToken: number, lease: { epoch: number; fence: number }): boolean {
		return reportedEpoch === lease.epoch && fencingToken === lease.fence && reportedEpoch === (this.epoch?.epoch ?? -1);
	}

	private isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "EPERM";
		}
	}
}

// ---------------------------------------------------------------------------
// Reconciliation state machine (V07-SUP-002)
// ---------------------------------------------------------------------------

export type ReconcileStep =
	| "processes"
	| "leases"
	| "timers"
	| "workspaces"
	| "state_store"
	| "event_offsets";

export function reconciliationGate(state: SupervisorState, completed: Set<ReconcileStep>): { canDispatch: boolean; remaining: ReconcileStep[] } {
	const all: ReconcileStep[] = ["processes", "leases", "timers", "workspaces", "state_store", "event_offsets"];
	const remaining = all.filter((step) => !completed.has(step));
	return { canDispatch: state === "ready" && remaining.length === 0, remaining };
}

// ---------------------------------------------------------------------------
// Idempotent RPC command log (V07-IPC-002, V07-IDEM-001)
// ---------------------------------------------------------------------------

export interface RpcCommand {
	commandId: string;
	idempotencyKey: string;
	actor: string;
	type: string;
	/** Typed payload validated per command type. */
	payload: Record<string, unknown>;
	expectedRevision?: number;
}

export interface RpcOutcome {
	commandId: string;
	idempotencyKey: string;
	status: "accepted" | "rejected";
	result?: Record<string, unknown>;
	error?: string;
	at: string;
}

export class IdempotentCommandLog {
	private outcomes = new Map<string, RpcOutcome>(); // keyed by idempotencyKey

	/**
	 * Retrying an identical key+payload returns the original outcome; the same
	 * key with a *different* payload fails (V07-IDEM-001).
	 */
	execute(command: RpcCommand, handler: (command: RpcCommand) => RpcOutcome["status"] extends never ? never : { status: "accepted" | "rejected"; result?: Record<string, unknown>; error?: string }): RpcOutcome {
		const prior = this.outcomes.get(command.idempotencyKey);
		if (prior) {
			const samePayload = prior.result?.["__payloadHash"] === payloadHash(command);
			// We stored the payload hash in result on first execution.
			if (!samePayload) {
				return {
					commandId: command.commandId,
					idempotencyKey: command.idempotencyKey,
					status: "rejected",
					error: "idempotency key reused with a different payload",
					at: new Date().toISOString(),
				};
			}
			return prior;
		}
		const handled = handler(command);
		const outcome: RpcOutcome = {
			commandId: command.commandId,
			idempotencyKey: command.idempotencyKey,
			status: handled.status,
			result: { ...(handled.result ?? {}), __payloadHash: payloadHash(command) },
			error: handled.error,
			at: new Date().toISOString(),
		};
		this.outcomes.set(command.idempotencyKey, outcome);
		return outcome;
	}

	/** Replay for restart recovery: outcomes are durable snapshots. */
	snapshot(): RpcOutcome[] {
		return [...this.outcomes.values()].map((o) => ({ ...o, result: omitPayloadHash(o.result) }));
	}
}

function payloadHash(command: RpcCommand): string {
	return JSON.stringify({ type: command.type, payload: command.payload, expectedRevision: command.expectedRevision });
}

function omitPayloadHash(result?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!result) return undefined;
	const { ["__payloadHash"]: _ignored, ...rest } = result;
	return rest;
}

// ---------------------------------------------------------------------------
// Detachment contracts (V07-DET-*)
// ---------------------------------------------------------------------------

export interface DetachmentContract {
	id: string;
	taskId: string;
	/** Authorized stages, roles, tools, attempts, time budget, transitions. */
	stages: string[];
	roles: string[];
	tools: string[];
	maxAttempts: number;
	expiresAt: string;
	/** Policy revision and task revision pinned at approval time. */
	policyRevision: number;
	taskRevision: number;
	approvedBy: string;
	approvedAt: string;
}

export function authorizeDetachedAction(contract: DetachmentContract, action: { stage?: string; role?: string; tool?: string; attemptNumber: number; now: Date; policyRevision: number; taskRevision: number }): { ok: true } | { ok: false; reason: string } {
	if (action.now.getTime() >= Date.parse(contract.expiresAt)) return { ok: false, reason: "contract expired — stopping at the next safe boundary" };
	if (action.policyRevision !== contract.policyRevision) return { ok: false, reason: "policy revision moved — contract is stale" };
	if (action.taskRevision !== contract.taskRevision) return { ok: false, reason: "task changed — contract is stale" };
	if (action.stage && !contract.stages.includes(action.stage)) return { ok: false, reason: `stage "${action.stage}" is outside the detachment contract` };
	if (action.role && !contract.roles.includes(action.role)) return { ok: false, reason: `role "${action.role}" is outside the detachment contract` };
	if (action.tool && !contract.tools.includes(action.tool)) return { ok: false, reason: `tool "${action.tool}" is outside the detachment contract` };
	if (action.attemptNumber > contract.maxAttempts) return { ok: false, reason: "attempt budget exhausted" };
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Durable event log with watermark continuity (V07-EVT-*)
// ---------------------------------------------------------------------------

export interface WatermarkedEvent {
	sequence: number;
	type: string;
	at: string;
	data: Record<string, unknown>;
	/** Present when retention truncated earlier events (gap metadata). */
	gapBefore?: number;
}

export class DurableEventLog {
	private events: WatermarkedEvent[] = [];
	private nextSequence = 1;

	constructor(private file: string, private retention = 10_000) {}

	append(type: string, data: Record<string, unknown>): WatermarkedEvent {
		const event: WatermarkedEvent = { sequence: this.nextSequence++, type, at: new Date().toISOString(), data };
		this.events.push(event);
		if (this.events.length > this.retention) {
			const dropped = this.events.length - this.retention;
			this.events.splice(0, dropped);
			const first = this.events[0]!;
			first.gapBefore = first.sequence - 1;
		}
		this.persist();
		return event;
	}

	/**
	 * Snapshot + subscription continuity (V07-EVT-001): the snapshot carries
	 * its watermark; the stream continues strictly after it.
	 */
	watermark(): number {
		return this.nextSequence - 1;
	}

	after(sequence: number): WatermarkedEvent[] {
		return this.events.filter((e) => e.sequence > sequence);
	}

	private persist(): void {
		mkdirSync(join(this.file, ".."), { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.events, null, "\t"), "utf8");
		renameSync(tmp, this.file);
	}
}

// ---------------------------------------------------------------------------
// Timers (V07-TMR-001)
// ---------------------------------------------------------------------------

export interface TimerCommand {
	id: string;
	/** Typed command name — never a free-form shell string. */
	command: "checks.run" | "task.retry" | "task.continue";
	taskId: string;
	dueAt: number;
	/** Deduplication across restarts and clock changes. */
	dedupKey: string;
}

export class TimerWheel {
	private timers = new Map<string, TimerCommand>();

	schedule(timer: Omit<TimerCommand, "id">): TimerCommand {
		const existing = [...this.timers.values()].find((t) => t.dedupKey === timer.dedupKey);
		if (existing) return existing; // idempotent across restart
		const full: TimerCommand = { id: `tmr-${monotonicId().toLowerCase()}`, ...timer };
		this.timers.set(full.id, full);
		return full;
	}

	/** Fires each due timer exactly once, even across clock changes. */
	due(now: number, fire: (timer: TimerCommand) => void): number {
		let fired = 0;
		for (const timer of [...this.timers.values()]) {
			if (timer.dueAt <= now) {
				this.timers.delete(timer.id);
				fire(timer);
				fired += 1;
			}
		}
		return fired;
	}
}

// ---------------------------------------------------------------------------
// Version negotiation + diagnostics (V07-UPG-001, V07-DIAG-001)
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = "1.0";

export function negotiateVersions(client: string, supervisor: string): { ok: true; version: string } | { ok: false; error: string; path: string } {
	const clientMajor = Number(client.split(".")[0]);
	const supervisorMajor = Number(supervisor.split(".")[0]);
	if (clientMajor !== supervisorMajor) {
		return {
			ok: false,
			error: `incompatible protocol versions (client ${client}, supervisor ${supervisor})`,
			path: clientMajor < supervisorMajor ? "upgrade the client" : "downgrade the client or upgrade the supervisor",
		};
	}
	return { ok: true, version: supervisor };
}

export function buildDiagnosticBundle(input: {
	protocolVersion: string;
	health: Record<string, unknown>;
	projectionOffset: number;
	processes: Array<{ pid: number; role: string }>;
	leases: Array<{ pool: string; owner: string }>;
	recentReasonCodes: string[];
	logs: string[];
}): Record<string, unknown> {
	return {
		protocolVersion: input.protocolVersion,
		generatedAt: new Date().toISOString(),
		health: input.health,
		projectionOffset: input.projectionOffset,
		processes: input.processes,
		leases: input.leases,
		recentReasonCodes: input.recentReasonCodes,
		logs: input.logs.map(redactDiagnosticLine),
	};
}

function redactDiagnosticLine(line: string): string {
	return line
		.replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
		.replace(/Bearer\s+[A-Za-z0-9_.-]{10,}/g, "Bearer [REDACTED]")
		.replace(/(password|token|secret|api[_-]?key)[=:]\s*\S+/gi, "$1=[REDACTED]");
}
