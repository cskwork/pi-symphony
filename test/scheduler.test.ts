import { describe, expect, it } from "vitest";
import {
	CapacityStore,
	CircuitBreaker,
	DependencyGraph,
	DispatchLog,
	classifyFailure,
	RETRY_RULES,
	selectCandidates,
	nonRunnableReasons,
	type SchedulerTask,
} from "../src/scheduler.ts";

function task(overrides: Partial<SchedulerTask> & { taskId: string }): SchedulerTask {
	return { priority: 2, hardDependenciesMet: true, approvalGranted: true, createdAt: 1_000, ...overrides };
}

describe("dependency DAG (V06-DAG-*)", () => {
	it("rejects self-references, invalid conditions, and cycles", () => {
		const graph = new DependencyGraph();
		expect(graph.addEdge("DEV-001", { kind: "task_done", taskId: "DEV-001" }).ok).toBe(false);
		expect(graph.addEdge("DEV-001", { kind: "stage_reached", taskId: "", stage: "build" }).ok).toBe(false);
		graph.addEdge("DEV-002", { kind: "task_done", taskId: "DEV-001" });
		graph.addEdge("DEV-001", { kind: "task_done", taskId: "DEV-003" });
		const cycle = graph.addEdge("DEV-003", { kind: "task_done", taskId: "DEV-002" });
		expect(cycle.ok).toBe(false);
		if (!cycle.ok) expect(cycle.issues[0]!.message).toMatch(/cycle/);
	});

	it("hard dependencies evaluate against durable state only (V06-DAG-002)", () => {
		const graph = new DependencyGraph();
		graph.addEdge("DEV-002", { kind: "task_done", taskId: "DEV-001" });
		expect(graph.hardDependenciesMet("DEV-002", { taskStages: { "DEV-001": "verify" }, checksPassed: {} })).toBe(false);
		expect(graph.hardDependenciesMet("DEV-002", { taskStages: { "DEV-001": "done" }, checksPassed: {} })).toBe(true);
		// stage and check conditions
		const g2 = new DependencyGraph();
		g2.addEdge("DEV-003", { kind: "stage_reached", taskId: "DEV-001", stage: "verify" });
		g2.addEdge("DEV-004", { kind: "check_passed", taskId: "DEV-001", check: "unit" });
		expect(g2.hardDependenciesMet("DEV-003", { taskStages: { "DEV-001": "ready" }, checksPassed: {} })).toBe(true);
		expect(g2.hardDependenciesMet("DEV-004", { taskStages: { "DEV-001": "ready" }, checksPassed: { "DEV-001": ["unit"] } })).toBe(true);
		expect(g2.hardDependenciesMet("DEV-004", { taskStages: { "DEV-001": "ready" }, checksPassed: {} })).toBe(false);
	});
});

describe("deterministic selection (V06-SCH-*)", () => {
	const snapshot: SchedulerTask[] = [
		task({ taskId: "DEV-A", priority: 1, createdAt: 2000 }),
		task({ taskId: "DEV-B", priority: 0, createdAt: 3000 }),
		task({ taskId: "DEV-C", priority: 1, createdAt: 1000 }),
	];

	it("identical snapshots produce identical order across 1000 replays (V06-SCH-001)", () => {
		const first = selectCandidates(snapshot, { capacity: 3, now: 5000, starvationMs: 60_000, paused: false });
		expect("taskId" in (first as object) ? false : true).toBe(true);
		for (let i = 0; i < 1000; i++) {
			const again = selectCandidates(snapshot, { capacity: 3, now: 5000, starvationMs: 60_000, paused: false }) as Array<{ taskId: string }>;
			expect(again.map((t) => t.taskId)).toEqual((first as Array<{ taskId: string }>).map((t) => t.taskId));
		}
		const order = (first as Array<{ taskId: string }>).map((t) => t.taskId);
		expect(order).toEqual(["DEV-B", "DEV-C", "DEV-A"]); // priority, then createdAt
	});

	it("starvation bound: aged low-priority beats fresh high-priority (V06-SCH-002)", () => {
		const withStarved = [
			task({ taskId: "DEV-OLD", priority: 3, createdAt: 0 }),
			task({ taskId: "DEV-NEW", priority: 0, createdAt: 8000 }),
		];
		const selected = selectCandidates(withStarved, { capacity: 1, now: 10_000, starvationMs: 5_000, paused: false }) as Array<{ taskId: string }>;
		expect(selected[0]!.taskId).toBe("DEV-OLD");
	});

	it("no dispatch while paused; reasons cover every non-candidate (V06-SCH-003, V06-UI-001)", () => {
		const paused = selectCandidates(snapshot, { capacity: 3, now: 5000, starvationMs: 60_000, paused: true });
		expect("error" in paused && paused.error.code).toBe("admission_paused");
		const reasons = nonRunnableReasons(
			[task({ taskId: "DEV-X", hardDependenciesMet: false }), task({ taskId: "DEV-Y", approvalGranted: false })],
			{ paused: false },
		);
		expect(reasons.get("DEV-X")).toEqual({ code: "dependency_unmet" });
		expect(reasons.get("DEV-Y")).toEqual({ code: "approval_pending" });
	});
});

describe("dispatch idempotency (V06-DSP-*)", () => {
	it("duplicate acks are no-ops; unacked intents reconcile, never re-dispatch", () => {
		const log = new DispatchLog();
		const issued = log.issue("DEV-001");
		if (!issued.ok) throw new Error("issue failed");
		expect(log.acknowledge(issued.dispatch.dispatchId)).toBe(true);
		expect(log.acknowledge(issued.dispatch.dispatchId)).toBe(true); // idempotent
		const other = log.issue("DEV-001");
		if (!other.ok) throw new Error("issue failed");
		expect(log.reconcile(other.dispatch.dispatchId)).toBe(true);
		expect(log.reconcile(other.dispatch.dispatchId)).toBe(false); // already reconciling
	});
});

describe("capacity + resources (V06-CAP-*, V06-ADM-001, V06-RES-001)", () => {
	it("claims are all-or-nothing", () => {
		const store = new CapacityStore({ runner: 2, port: 1 });
		const first = store.claimAll("t1", [{ pool: "runner" }, { pool: "port", exclusive: "port:5432" }]);
		expect(first.ok).toBe(true);
		const second = store.claimAll("t2", [{ pool: "runner" }, { pool: "port", exclusive: "port:5432" }]);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error).toMatch(/port:5432 held by t1/);
		// the failed claim released its runner slot
		expect(store.occupancy("runner")).toBe(1);
	});

	it("occupancy never exceeds limits under concurrent-style pressure", () => {
		const store = new CapacityStore({ runner: 2 });
		const results = Array.from({ length: 10 }, (_, i) => store.claimAll(`t${i}`, [{ pool: "runner" }]));
		const winners = results.filter((r) => r.ok).length;
		expect(winners).toBe(2);
		expect(store.occupancy("runner")).toBe(2);
	});

	it("release frees exclusive owners", () => {
		const store = new CapacityStore({ db: 1 });
		store.claimAll("t1", [{ pool: "db", exclusive: "db:app" }]);
		store.release("t1", [{ pool: "db", exclusive: "db:app" }]);
		expect(store.claimAll("t2", [{ pool: "db", exclusive: "db:app" }]).ok).toBe(true);
	});
});

describe("retry taxonomy + breakers (V06-RET-*)", () => {
	it("failure classes map to distinct actions", () => {
		expect(classifyFailure({ timedOut: true })).toBe("transient");
		expect(classifyFailure({ errorMessage: "command not found" })).toBe("deterministic");
		expect(classifyFailure({ errorMessage: "rate limit exceeded" })).toBe("transient");
		expect(classifyFailure({ policyViolation: true })).toBe("policy");
		expect(classifyFailure({ userCancelled: true })).toBe("user");
		expect(classifyFailure({})).toBe("unknown");
		expect(RETRY_RULES.deterministic.retryable).toBe(false);
		expect(RETRY_RULES.transient.retryable).toBe(true);
		expect(RETRY_RULES.user.action).toMatch(/await user/);
	});

	it("circuit breaker opens after the threshold and halts dispatch", () => {
		const breaker = new CircuitBreaker(3);
		expect(breaker.recordFailure("provider", "503")).toBe(false);
		expect(breaker.recordFailure("provider", "503")).toBe(false);
		expect(breaker.recordFailure("provider", "503")).toBe(true);
		expect(breaker.isOpen("provider")).toBe("503");
		breaker.reset("provider");
		expect(breaker.isOpen("provider")).toBeUndefined();
	});
});
