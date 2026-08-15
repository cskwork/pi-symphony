import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SymphonyCore } from "../src/core.ts";
import { evaluateGate, type EvidenceBundle } from "../src/workflow.ts";
import { commitAll, disposeRepo, makeRepo, realGitExec, silentUi } from "./helpers.ts";

/**
 * Regression tests for the two v0.1 review blockers:
 *  1. blocked → ready without evidence
 *  2. self-submitted review satisfying review → verify
 * plus the major fixes folded in from the adversarial review.
 */

let dir: string;
let core: SymphonyCore;

function newCore(pid = process.pid): SymphonyCore {
	return new SymphonyCore({
		repoRoot: dir,
		ui: silentUi,
		gitExec: realGitExec(dir),
		pid,
		sessionId: "sess-blocker",
		env: { PATH: process.env.PATH ?? "" },
	});
}

beforeEach(async () => {
	dir = makeRepo();
	core = newCore();
	await core.initialize({ taskPrefix: "DEV", targetBranch: "main", checks: [{ name: "unit", argv: ["true"] }] });
});

afterEach(() => disposeRepo(dir));

function createTask(overrides: { risks?: string[] } = {}): string {
	const created = core.createTask({
		title: "blocker task",
		kind: "feature",
		acceptance: ["criterion"],
		risks: overrides.risks ?? [],
	});
	if (!created.ok) throw new Error(created.error);
	return created.value.id;
}

describe("blocker 1: blocked → X carries the target stage's contract", () => {
	it("blocked → ready is rejected without reports and fresh checks", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.transition(taskId, "blocked");
		const moved = core.transition(taskId, "ready");
		expect(moved.ok).toBe(false);
		if (!moved.ok) expect(moved.error).toMatch(/implementation report|check/i);
	});

	it("blocked → build still requires plan + approval; blocked → verify requires proven review", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.transition(taskId, "blocked");
		expect(core.transition(taskId, "build").ok).toBe(false);
		// satisfy plan, then blocked→build works
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.transition(taskId, "blocked");
		expect(core.transition(taskId, "build").ok).toBe(true);
		// review provenance still enforced through the blocked edge
		core.submitReport({ taskId, section: "implementation", summary: "s", details: {} });
		core.transition(taskId, "review");
		core.submitReport({ taskId, section: "review", summary: "APPROVED", details: {}, origin: "model" });
		core.transition(taskId, "blocked");
		const toVerify = core.transition(taskId, "verify");
		expect(toVerify.ok).toBe(false);
		if (!toVerify.ok) expect(toVerify.error).toMatch(/independent|implementer/);
	});

	it("blocked → ready blocked by failed checks even with all reports", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.submitReport({ taskId, section: "implementation", summary: "s", details: {} });
		core.submitReport({ taskId, section: "review", summary: "A", details: {}, origin: "fresh-reviewer" });
		core.transition(taskId, "verify");
		core.transition(taskId, "blocked");
		const moved = core.transition(taskId, "ready");
		expect(moved.ok).toBe(false);
		if (!moved.ok) expect(moved.error).toMatch(/check/i);
	});
});

describe("blocker 2: review provenance is an engine invariant", () => {
	it("a model-submitted review cannot satisfy review → verify", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.submitReport({ taskId, section: "implementation", summary: "s", details: {} });
		core.submitReport({ taskId, section: "review", summary: "APPROVED — all good", details: { verdict: "approved" }, origin: "model" });
		const moved = core.transition(taskId, "verify");
		expect(moved.ok).toBe(false);
		if (!moved.ok) expect(moved.error).toMatch(/implementer session|independent review/);
	});

	it("a fresh-reviewer review satisfies it; a manual one does too", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.submitReport({ taskId, section: "implementation", summary: "s", details: {} });
		core.submitReport({ taskId, section: "review", summary: "APPROVED", details: {}, origin: "fresh-reviewer" });
		expect(core.transition(taskId, "verify").ok).toBe(true);

		const taskId2 = createTask();
		core.transition(taskId2, "plan");
		core.submitReport({ taskId: taskId2, section: "plan", summary: "s", details: {} });
		core.submitReport({ taskId: taskId2, section: "implementation", summary: "s", details: {} });
		core.submitReport({ taskId: taskId2, section: "review", summary: "human accepted", details: {}, origin: "manual" });
		expect(core.transition(taskId2, "verify").ok).toBe(true);
	});

	it("provenance survives restart via event replay", () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.submitReport({ taskId, section: "implementation", summary: "s", details: {} });
		core.submitReport({ taskId, section: "review", summary: "APPROVED", details: {}, origin: "model" });
		const reborn = newCore();
		const moved = reborn.transition(taskId, "verify");
		expect(moved.ok).toBe(false);
	});
});

describe("major fixes from the adversarial review", () => {
	it("plan-discovered risks trigger approval (policy not evadable)", () => {
		const taskId = createTask({ risks: [] });
		core.transition(taskId, "plan");
		const result = core.submitReport({
			taskId,
			section: "plan",
			summary: "plan",
			details: { risks: ["data migration"] },
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.stageAfter).toBe("plan"); // stays for approval
		if (result.ok) expect(result.next).toMatch(/approval required|require approval/);
		// risks merged into the task contract
		const task = core.getTask(taskId);
		if (task.ok) expect(task.value.frontmatter.risks).toContain("data migration");
		// approval then unlocks build
		const approved = core.resolveApproval({ taskId, scope: "plan", actor: "user", approved: true });
		expect(approved.ok).toBe(true);
	});

	it("missing evidence artifact downgrades a recorded pass to broken", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.submitReport({ taskId, section: "implementation", summary: "s", details: {} });
		core.submitReport({ taskId, section: "review", summary: "A", details: {}, origin: "fresh-reviewer" });
		core.transition(taskId, "verify");
		const ready = await core.advanceToReady(taskId);
		expect(ready.ok).toBe(true);

		// Simulate the artifact vanishing while the recorded run stays in memory:
		// the evidence map still holds a "passed" run, but its artifact is gone.
		rmSync(join(dir, ".symphony", "evidence", taskId, "checks"), { recursive: true, force: true });
		const coreAny = core as unknown as { evidenceFor: (id: string, r: string[], rev: string | null) => EvidenceBundle };
		const bundle = coreAny.evidenceFor(taskId, [], null);
		const unit = bundle.checks.get("unit");
		expect(unit).toBeDefined();
		expect(unit!.status).toBe("broken"); // downgraded before the gate sees it
		const gate = evaluateGate("verify", "ready", bundle, core.config);
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.reason).toMatch(/broken/);
	});

	it("broken evidence blocks gates (direct engine check)", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.submitReport({ taskId, section: "implementation", summary: "s", details: {} });
		core.submitReport({ taskId, section: "review", summary: "A", details: {}, origin: "fresh-reviewer" });
		core.transition(taskId, "verify");
		await core.runCheckSet(taskId, "verify");
		// delete artifact, then attempt Ready without rerunning checks
		rmSync(join(dir, ".symphony", "evidence", taskId, "checks"), { recursive: true, force: true });
		const coreAny = core as unknown as { evidenceFor: (id: string, r: string[], rev: string | null) => EvidenceBundle };
		const gate = evaluateGate("verify", "ready", coreAny.evidenceFor(taskId, [], null), core.config);
		// evidence bundle built through validateEvidenceArtifacts: broken run ≠ passed → blocked
		expect(gate.ok).toBe(false);
	});

	it("lease mutual exclusion: acquire refuses a live foreign lease", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		const attempt = core.startAttempt(taskId, "plan");
		expect(attempt.ok).toBe(true);
		// a second core (different pid+session) cannot start work
		const foreign = newCore(999_999);
		const foreignAttempt = foreign.startAttempt(taskId, "plan");
		if (foreignAttempt.ok) {
			// pid 999999 may actually exist on busy systems; only assert when truly alive
			const { isProcessAlive } = await import("../src/lease.ts");
			expect(isProcessAlive(999_999)).toBe(true);
		} else {
			expect(foreignAttempt.error).toMatch(/lease/);
		}
	});

	it("resume continues the same attempt without spending the retry budget", () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		const first = core.startAttempt(taskId, "plan");
		if (!first.ok) throw new Error(first.error);
		core.interruptAttempt(taskId, first.value.attemptId);
		const resumed = core.resumeAttempt(taskId, first.value.attemptId);
		expect(resumed.ok).toBe(true);
		if (resumed.ok) expect(resumed.value.attemptId).toBe(first.value.attemptId);
		// resume twice without a new interruption is rejected
		const again = core.resumeAttempt(taskId, first.value.attemptId);
		expect(again.ok).toBe(false);
	});

	it("non-Git checkouts complete the lifecycle with evidence marked unavailable", async () => {
		const { makeRepo: mk, disposeRepo: dp, realGitExec: git } = await import("./helpers.ts");
		const plain = mk(false); // no git repo at all
		try {
			const plainCore = new SymphonyCore({
				repoRoot: plain,
				ui: silentUi,
				gitExec: git(plain),
				env: { PATH: process.env.PATH ?? "" },
			});
			await plainCore.initialize({ taskPrefix: "DEV", targetBranch: "main", checks: [{ name: "unit", argv: ["true"] }] });
			const created = plainCore.createTask({ title: "non-git task", kind: "feature", acceptance: ["a"], risks: [] });
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const id = created.value.id;
			plainCore.transition(id, "plan");
			plainCore.submitReport({ taskId: id, section: "plan", summary: "s", details: {} });
			plainCore.submitReport({ taskId: id, section: "implementation", summary: "s", details: {} });
			plainCore.submitReport({ taskId: id, section: "review", summary: "A", details: {}, origin: "fresh-reviewer" });
			plainCore.transition(id, "verify");
			const ready = await plainCore.advanceToReady(id);
			expect(ready.ok).toBe(true);
			const integrated = await plainCore.recordIntegration({ taskId: id, revision: "worktree", actor: "t" });
			expect(integrated.ok).toBe(true);
			const done = await plainCore.completeTask({ taskId: id });
			expect(done.ok).toBe(true);
		} finally {
			dp(plain);
		}
	});

	it("widget AC progress reflects implementation report statuses", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.submitReport({
			taskId,
			section: "implementation",
			summary: "partial",
			details: { acceptance_status: [{ criterion: 1, status: "partial" }] },
		});
		const lines = core.widgetLines();
		expect(lines[1]).toMatch(/AC 0\/1/);
	});
});
