/**
 * Multi-task scheduler: dependency DAG, deterministic selection, admission,
 * capacity pools, retry taxonomy, and rebuildable state (PRD v0.6).
 */

import { monotonicId } from "./ids.ts";

// ---------------------------------------------------------------------------
// Dependency DAG (V06-DAG-*)
// ---------------------------------------------------------------------------

export type DependencyCondition =
	| { kind: "task_done"; taskId: string }
	| { kind: "stage_reached"; taskId: string; stage: string }
	| { kind: "check_passed"; taskId: string; check: string };

export interface DependencyEdge {
	/** The dependent task waits for this condition. */
	condition: DependencyCondition;
	/** Hard dependencies gate dispatch; soft ones only inform priority. */
	hard: boolean;
}

export interface DagIssue {
	message: string;
}

export class DependencyGraph {
	private edges = new Map<string, DependencyEdge[]>();

	addEdge(taskId: string, edge: DependencyCondition, options: { hard?: boolean } = {}): { ok: true } | { ok: false; issues: DagIssue[] } {
		const issues: DagIssue[] = [];
		if (edge.kind === "task_done" && edge.taskId === taskId) {
			issues.push({ message: "self-dependency rejected" });
		}
		if (!isValidDependencyCondition(edge)) {
			issues.push({ message: "invalid dependency condition" });
		}
		// cycle check: would this edge create a cycle?
		if (edge.kind === "task_done" && this.reachable(edge.taskId, new Set()).has(taskId)) {
			issues.push({ message: `cycle: ${taskId} → … → ${edge.taskId} → ${taskId}` });
		}
		if (issues.length > 0) return { ok: false, issues };
		const list = this.edges.get(taskId) ?? [];
		list.push({ condition: edge, hard: options.hard ?? true });
		this.edges.set(taskId, list);
		return { ok: true };
	}

	edgesOf(taskId: string): DependencyEdge[] {
		return this.edges.get(taskId) ?? [];
	}

	private reachable(from: string, seen: Set<string>): Set<string> {
		if (seen.has(from)) return seen;
		seen.add(from);
		for (const edge of this.edges.get(from) ?? []) {
			if (edge.condition.kind === "task_done") this.reachable(edge.condition.taskId, seen);
		}
		return seen;
	}

	/**
	 * Evaluate hard dependencies against durable state (V06-DAG-002): the
	 * caller supplies only committed facts, never a transient projection.
	 */
	hardDependenciesMet(taskId: string, facts: DependencyFacts): boolean {
		return (this.edges.get(taskId) ?? [])
			.filter((e) => e.hard)
			.every((e) => conditionMet(e.condition, facts));
	}
}

export interface DependencyFacts {
	taskStages: Record<string, string>;
	checksPassed: Record<string, string[]>;
}

function isValidDependencyCondition(condition: DependencyCondition): boolean {
	return condition.kind === "task_done"
		? Boolean(condition.taskId)
		: condition.kind === "stage_reached"
			? Boolean(condition.taskId && condition.stage)
			: condition.kind === "check_passed"
				? Boolean(condition.taskId && condition.check)
				: false;
}

function conditionMet(condition: DependencyCondition, facts: DependencyFacts): boolean {
	switch (condition.kind) {
		case "task_done": return facts.taskStages[condition.taskId] === "done";
		case "stage_reached": return stageOrder(facts.taskStages[condition.taskId] ?? "") >= stageOrder(condition.stage);
		case "check_passed": return (facts.checksPassed[condition.taskId] ?? []).includes(condition.check);
	}
}

function stageOrder(stage: string): number {
	const order = ["backlog", "plan", "build", "review", "verify", "ready", "postverify", "done"];
	const idx = order.indexOf(stage);
	return idx >= 0 ? idx : -1;
}

// ---------------------------------------------------------------------------
// Deterministic scheduler (V06-SCH-*, V06-ADM-*, V06-DSP-*)
// ---------------------------------------------------------------------------

export interface SchedulerTask {
	taskId: string;
	priority: 0 | 1 | 2 | 3; // 0 = highest
	/** Readiness inputs; all must be true to be a candidate. */
	hardDependenciesMet: boolean;
	approvalGranted: boolean;
	createdAt: number;
}

export type NonRunnableReason =
	| { code: "dependency_unmet" }
	| { code: "approval_pending" }
	| { code: "admission_paused" }
	| { code: "capacity_exhausted"; pool: string }
	| { code: "resource_unavailable"; resource: string }
	| { code: "circuit_open"; breaker: string }
	| { code: "not_active" };

/**
 * Candidate selection is a pure function of the snapshot (V06-SCH-001):
 * priority + aging (waiting time), deterministic tie-break by createdAt then
 * taskId. Starvation bound: an eligible task older than the limit wins over
 * newer higher-priority work (V06-SCH-002).
 */
export function selectCandidates(tasks: SchedulerTask[], options: { capacity: number; now: number; starvationMs: number; paused: boolean }): Array<{ taskId: string }> | { error: NonRunnableReason } {
	if (options.paused) return { error: { code: "admission_paused" } };
	const eligible = tasks.filter((t) => t.hardDependenciesMet && t.approvalGranted);
	// reason codes for every non-candidate (V06-UI-001)
	const scored = eligible.map((t) => {
		const waited = options.now - t.createdAt;
		const aged = waited >= options.starvationMs;
		return { task: t, score: t.priority - (aged ? 100 : 0), waited, aged };
	});
	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		if (a.task.createdAt !== b.task.createdAt) return a.task.createdAt - b.task.createdAt;
		return a.task.taskId < b.task.taskId ? -1 : 1;
	});
	return scored.slice(0, options.capacity).map((s) => ({ taskId: s.task.taskId }));
}

export function nonRunnableReasons(tasks: SchedulerTask[], options: { paused: boolean }): Map<string, NonRunnableReason> {
	const reasons = new Map<string, NonRunnableReason>();
	for (const task of tasks) {
		if (!task.hardDependenciesMet) reasons.set(task.taskId, { code: "dependency_unmet" });
		else if (!task.approvalGranted) reasons.set(task.taskId, { code: "approval_pending" });
		else if (options.paused) reasons.set(task.taskId, { code: "admission_paused" });
	}
	return reasons;
}

// ---------------------------------------------------------------------------
// Dispatch idempotency + reconciliation (V06-DSP-*)
// ---------------------------------------------------------------------------

export type DispatchState = "intent" | "acknowledged" | "reconciling" | "resolved";

export interface DispatchRecord {
	dispatchId: string;
	taskId: string;
	issuedAt: string;
	state: DispatchState;
}

export class DispatchLog {
	private dispatches = new Map<string, DispatchRecord>();

	issue(taskId: string): { ok: true; dispatch: DispatchRecord; duplicate: boolean } | { ok: false; error: string } {
		const dispatchId = `dsp-${monotonicId().toLowerCase()}`;
		const dispatch: DispatchRecord = { dispatchId, taskId, issuedAt: new Date().toISOString(), state: "intent" };
		this.dispatches.set(dispatchId, dispatch);
		return { ok: true, dispatch, duplicate: false };
	}

	/** Idempotent by dispatch ID: duplicate acks are no-ops (V06-DSP-001). */
	acknowledge(dispatchId: string): boolean {
		const dispatch = this.dispatches.get(dispatchId);
		if (!dispatch || dispatch.state === "acknowledged") return dispatch?.state === "acknowledged";
		if (dispatch.state === "resolved") return false;
		dispatch.state = "acknowledged";
		return true;
	}

	/** Unacknowledged intents enter reconciliation, never immediate re-dispatch (V06-DSP-002). */
	reconcile(dispatchId: string): boolean {
		const dispatch = this.dispatches.get(dispatchId);
		if (!dispatch || dispatch.state !== "intent") return false;
		dispatch.state = "reconciling";
		return true;
	}

	resolve(dispatchId: string): boolean {
		const dispatch = this.dispatches.get(dispatchId);
		if (!dispatch) return false;
		dispatch.state = "resolved";
		return true;
	}

	byTask(taskId: string): DispatchRecord[] {
		return [...this.dispatches.values()].filter((d) => d.taskId === taskId);
	}
}

// ---------------------------------------------------------------------------
// Capacity pools + exclusive resources (V06-CAP-*, V06-RES-001)
// ---------------------------------------------------------------------------

export interface LeaseClaim {
	pool: string;
	/** Exclusive resource value, e.g. "port:5432". */
	exclusive?: string;
}

export class CapacityStore {
	private poolCounts = new Map<string, number>();
	private exclusiveOwners = new Map<string, string>();
	private log: Array<{ claims: LeaseClaim[]; released: string[] }> = [];

	constructor(private limits: Record<string, number>) {}

	/**
	 * All-or-nothing admission (V06-ADM-001): claims every lease or none.
	 * The claim log makes partial-failure recovery replayable.
	 */
	claimAll(owner: string, claims: LeaseClaim[]): { ok: true } | { ok: false; error: string; partial: string[] } {
		const taken: string[] = [];
		for (const claim of claims) {
			if (claim.exclusive) {
				const holder = this.exclusiveOwners.get(claim.exclusive);
				if (holder !== undefined && holder !== owner) {
					this.releaseAll(taken);
					return { ok: false, error: `resource ${claim.exclusive} held by ${holder}`, partial: [] };
				}
			}
			const current = this.poolCounts.get(claim.pool) ?? 0;
			const limit = this.limits[claim.pool] ?? 0;
			if (current >= limit) {
				this.releaseAll(taken);
				return { ok: false, error: `pool ${claim.pool} exhausted (${current}/${limit})`, partial: [] };
			}
			this.poolCounts.set(claim.pool, current + 1);
			if (claim.exclusive) this.exclusiveOwners.set(claim.exclusive, owner);
			taken.push(claim.pool);
		}
		this.log.push({ claims, released: [] });
		return { ok: true };
	}

	release(owner: string, claims: LeaseClaim[]): void {
		for (const claim of claims) {
			const current = this.poolCounts.get(claim.pool) ?? 0;
			if (current > 0) this.poolCounts.set(claim.pool, current - 1);
			if (claim.exclusive && this.exclusiveOwners.get(claim.exclusive) === owner) {
				this.exclusiveOwners.delete(claim.exclusive);
			}
		}
		this.log.push({ claims: [], released: claims.map((c) => c.exclusive ?? c.pool) });
	}

	occupancy(pool: string): number {
		return this.poolCounts.get(pool) ?? 0;
	}

	exclusiveOwner(value: string): string | undefined {
		return this.exclusiveOwners.get(value);
	}

	private releaseAll(taken: string[]): void {
		for (const pool of taken) {
			this.poolCounts.set(pool, Math.max(0, (this.poolCounts.get(pool) ?? 1) - 1));
		}
	}
}

// ---------------------------------------------------------------------------
// Retry taxonomy + circuit breakers (V06-RET-*)
// ---------------------------------------------------------------------------

export type FailureClass = "transient" | "deterministic" | "policy" | "user" | "unknown";

export interface RetryPolicy {
	maxRetries: number;
	backoffMs: number;
}

export const RETRY_RULES: Record<FailureClass, { retryable: boolean; policy: RetryPolicy; action: string }> = {
	transient: { retryable: true, policy: { maxRetries: 3, backoffMs: 5_000 }, action: "retry with backoff" },
	deterministic: { retryable: false, policy: { maxRetries: 0, backoffMs: 0 }, action: "fail fast — fix the cause" },
	policy: { retryable: false, policy: { maxRetries: 0, backoffMs: 0 }, action: "fail — resolve the policy violation" },
	user: { retryable: false, policy: { maxRetries: 0, backoffMs: 0 }, action: "pause — await user decision" },
	unknown: { retryable: true, policy: { maxRetries: 1, backoffMs: 30_000 }, action: "retry once, then escalate" },
};

export function classifyFailure(input: { exitCode?: number | null; timedOut?: boolean; errorMessage?: string; policyViolation?: boolean; userCancelled?: boolean }): FailureClass {
	if (input.userCancelled) return "user";
	if (input.policyViolation) return "policy";
	if (input.timedOut) return "transient";
	if (input.errorMessage && /ENOENT|not found|does not exist/i.test(input.errorMessage)) return "deterministic";
	if (input.errorMessage && /rate.?limit|ECONNRESET|ETIMEDOUT|503/i.test(input.errorMessage)) return "transient";
	if (input.exitCode !== undefined && input.exitCode !== null && input.exitCode !== 0) return "deterministic";
	return "unknown";
}

export class CircuitBreaker {
	private failures = new Map<string, number>();
	private open = new Map<string, string>();

	constructor(private threshold = 3) {}

	recordFailure(breakerId: string, reason: string): boolean {
		const count = (this.failures.get(breakerId) ?? 0) + 1;
		this.failures.set(breakerId, count);
		if (count >= this.threshold) {
			this.open.set(breakerId, reason);
			return true;
		}
		return false;
	}

	recordSuccess(breakerId: string): void {
		this.failures.delete(breakerId);
		this.open.delete(breakerId);
	}

	isOpen(breakerId: string): string | undefined {
		return this.open.get(breakerId);
	}

	reset(breakerId: string): void {
		this.failures.delete(breakerId);
		this.open.delete(breakerId);
	}
}
