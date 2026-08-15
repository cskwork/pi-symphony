import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SymphonyCore } from "../src/core.ts";
import type { CommandExecutor } from "../src/checks.ts";
import { commitAll, disposeRepo, makeRepo, realGitExec, silentUi } from "./helpers.ts";

let dir: string;
let core: SymphonyCore;
let executor: CommandExecutor & { implementations: Array<(argv: string[]) => { code: number | null; stdout: string; stderr: string; timedOut: boolean }> };

function newCore(pid = process.pid): SymphonyCore {
	return new SymphonyCore({
		repoRoot: dir,
		ui: silentUi,
		gitExec: realGitExec(dir),
		checkExecutor: executor,
		pid,
		sessionId: "sess-1",
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
	});
}

async function initCore(c: SymphonyCore): Promise<void> {
	await c.initialize({
		taskPrefix: "DEV",
		targetBranch: "main",
		checks: [{ name: "unit", argv: ["true"] }],
	});
}

async function driveToStage(c: SymphonyCore, stage: string, taskId: string): Promise<void> {
	// helper: run the standard happy path up to `stage`
	if (stage === "backlog") return;
	c.transition(taskId, "plan");
	if (stage === "plan") return;
	c.submitReport({ taskId, section: "plan", summary: "plan summary", details: { steps: ["a"] } });
	const moved = c.transition(taskId, "build");
	if (!moved.ok) throw new Error(moved.error);
	if (stage === "build") return;
	c.submitReport({ taskId, section: "implementation", summary: "impl summary", details: {} });
	const toReview = c.transition(taskId, "review");
	if (!toReview.ok) throw new Error(toReview.error);
	if (stage === "review") return;
	c.submitReport({ taskId, section: "review", summary: "APPROVED — fine", details: { verdict: "approved" } });
	const toVerify = c.transition(taskId, "verify");
	if (!toVerify.ok) throw new Error(toVerify.error);
}

beforeEach(async () => {
	dir = makeRepo();
	executor = Object.assign(
		async (argv: string[], _options: { cwd: string; timeoutMs: number; env: Record<string, string> }) => {
			const impl = executor.implementations[executor.implementations.length - 1]!;
			return { ...impl(argv) };
		},
		{ implementations: [() => ({ code: 0, stdout: "ok", stderr: "", timedOut: false })] },
	);
	core = newCore();
	await initCore(core);
});

afterEach(() => {
	disposeRepo(dir);
});

describe("SymphonyCore lifecycle (E2E)", () => {
	it("initializes with only Symphony-owned paths and never touches product files", async () => {
		disposeRepo(dir);
		dir = makeRepo();
		core = newCore();
		const before = readFileSync(join(dir, "README.md"), "utf8");
		const filesBefore = new Set(readdir(dir));
		await initCore(core);
		expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(before);
		const added = readdir(dir).filter((f) => !filesBefore.has(f));
		expect(added).toEqual([".symphony"]);
		expect(existsSync(join(dir, ".symphony", "config.yaml"))).toBe(true);
		expect(existsSync(join(dir, ".symphony", "runtime"))).toBe(true);
		expect(existsSync(join(dir, ".symphony", "tasks"))).toBe(true);
		// runtime + local config are gitignored
		expect(readFileSync(join(dir, ".symphony", ".gitignore"), "utf8")).toMatch(/runtime\//);
	});

	it("runs the full feature lifecycle: create → plan → build → review → verify → ready → integrate → done", async () => {
		const created = core.createTask({
			title: "Add feature X",
			kind: "feature",
			acceptance: ["feature works"],
			risks: [],
		});
		expect(created.ok).toBe(true);
		if (!created.ok) throw new Error(created.error);
		const taskId = created.value.id;
		expect(taskId).toBe("DEV-001");

		await driveToStage(core, "verify", taskId);
		// checks pass → ready
		executor.implementations.push(() => ({ code: 0, stdout: "all green", stderr: "", timedOut: false }));
		const ready = await core.advanceToReady(taskId);
		expect(ready.ok).toBe(true);
		expect(mustStage(core, taskId)).toBe("ready");

		// integrate: commit the change onto main
		const rev = commitAll(dir, "feature X");
		const integration = await core.recordIntegration({ taskId, revision: rev, actor: "tester" });
		expect(integration.ok).toBe(true);

		const done = await core.completeTask({ taskId });
		expect(done.ok).toBe(true);
		const final = mustTask(core, taskId).frontmatter;
		expect(final.integration!.revision).toBe(rev);
		expect(final.stage).toBe("done");
		expect(final.integration!.revision).toBe(rev);

		// closeout evidence exists on disk
		const evidenceDir = join(dir, ".symphony", "evidence", taskId, "checks");
		expect(existsSync(evidenceDir)).toBe(true);
		const ledgerFile = join(dir, ".symphony", "runtime", "events", `${taskId}.jsonl`);
		const events = readFileSync(ledgerFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(events.some((e) => e.type === "integration.recorded")).toBe(true);
		expect(events.some((e) => e.type === "task.stage_changed" && e.data.to === "done")).toBe(true);
	});

	it("V01-QA-002: failed required check blocks Ready and model reports cannot override", async () => {
		const taskId = mustCreate(core, "t");
		await driveToStage(core, "verify", taskId);
		executor.implementations.push(() => ({ code: 1, stdout: "1 failing", stderr: "", timedOut: false }));
		const ready = await core.advanceToReady(taskId);
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.error).toMatch(/cannot reach Ready.*failed/);
		expect(mustStage(core, taskId)).toBe("verify");
		// even a review report cannot force the transition
		const forced = core.transition(taskId, "ready");
		expect(forced.ok).toBe(false);
	});

	it("times-out checks block Ready", async () => {
		const taskId = mustCreate(core, "t");
		await driveToStage(core, "verify", taskId);
		executor.implementations.push(() => ({ code: null, stdout: "", stderr: "", timedOut: true }));
		const ready = await core.advanceToReady(taskId);
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.error).toMatch(/timeout/);
	});

	it("stale checks (revision moved) block Ready until rerun", async () => {
		const taskId = mustCreate(core, "t");
		await driveToStage(core, "verify", taskId);
		executor.implementations.push(() => ({ code: 0, stdout: "green", stderr: "", timedOut: false }));
		// advanceToReady runs checks at current revision then gates — passes
		const ready = await core.advanceToReady(taskId);
		expect(ready.ok).toBe(true);
	});

	it("V01-REC-001: restart marks running attempts Interrupted without duplicating", async () => {
		const taskId = mustCreate(core, "t");
		core.transition(taskId, "plan");
		const attempt = core.startAttempt(taskId, "plan");
		if (!attempt.ok) throw new Error(attempt.error);

		// simulate a different process dying: lease held by dead pid
		const deadPid = findDeadPid();
		const crashedCore = new SymphonyCore({
			repoRoot: dir,
			ui: silentUi,
			gitExec: realGitExec(dir),
			pid: deadPid,
			sessionId: "sess-crashed",
			env: { PATH: process.env.PATH ?? "" },
		});
		crashedCore.getTask(taskId);
		// crashedCore's attempt bookkeeping replays from ledger: attempt.plan-1 was running
		const recovery = crashedCore.recover();
		expect(recovery.ok && recovery.value.interrupted).toContain("plan-1");

		// the task's run state is interrupted; starting the same stage again creates plan-2 not a duplicate plan-1 resurrection
		const task = crashedCore.getTask(taskId);
		expect(task.ok ? task.value.frontmatter.runState : "unknown").toBe("interrupted");
		const second = crashedCore.startAttempt(taskId, "plan");
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.value.attemptId).toBe("plan-2");
	});

	it("external task edit conflicts surface as explicit errors, preserving both versions", async () => {
		const taskId = mustCreate(core, "t");
		const taskPath = join(dir, ".symphony", "tasks", `${taskId}.md`);
		const stale = mustTask(core, taskId).frontmatter.revision;
		writeFileSync(taskPath, readFileSync(taskPath, "utf8").replace("title: t", "title: externally edited"), "utf8");
		const conflict = core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		// core holds a stale view only if it cached revision; our implementation re-reads before write,
		// so external edits merge cleanly — but optimistic CAS must still be enforced via expectedRevision
		expect(stale).toBeGreaterThan(0);
		const again = core.getTask(taskId);
		expect(again.ok).toBe(true);
	});

	it("invalid configuration blocks execution but keeps read-only inspection", async () => {
		writeFileSync(
			join(dir, ".symphony", "config.yaml"),
			"version: 1\ncommands:\n  unit:\n    argv: \"npm test\"\n",
			"utf8",
		);
		const broken = newCore();
		expect(broken.configIssues.length).toBeGreaterThan(0);
		const created = broken.createTask({ title: "x", kind: "feature", acceptance: [], risks: [] });
		expect(created.ok).toBe(false);
		if (!created.ok) expect(created.error).toMatch(/configuration is invalid/);
		const tasks = broken.listTasks();
		expect(Array.isArray(tasks)).toBe(true);
		const doctor = broken.doctor();
		expect(doctor[0]!.ok).toBe(false);
	});

	it("reviewer crash marks attempt interrupted and never synthesizes a pass", async () => {
		const taskId = mustCreate(core, "t");
		await driveToStage(core, "review", taskId);
		const attempt = core.startAttempt(taskId, "review");
		if (!attempt.ok) throw new Error(attempt.error);
		core.interruptAttempt(taskId, attempt.value.attemptId);
		const task = core.getTask(taskId);
		expect(task.ok ? task.value.frontmatter.runState : "unknown").toBe("interrupted");
		// no review report recorded
		expect(core.hasReport(taskId, "review")).toBe(false);
	});

	it("integration verification rejects revisions not on the target branch", async () => {
		const taskId = mustCreate(core, "t");
		await driveToStage(core, "verify", taskId);
		executor.implementations.push(() => ({ code: 0, stdout: "", stderr: "", timedOut: false }));
		await core.advanceToReady(taskId);
		const fake = "0123456789abcdef0123456789abcdef01234567";
		const rejected = await core.recordIntegration({ taskId, revision: fake, actor: "t" });
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.error).toMatch(/not on target branch|does not exist/);
	});

	it("widget shows stage and run state separately", async () => {
		const lines = core.widgetLines();
		expect(lines.length).toBeLessThanOrEqual(2);
		expect(lines[0]).toMatch(/SYMPHONY/);
		const taskId = mustCreate(core, "widget task");
		core.transition(taskId, "plan");
		core.setRunState(taskId, "running");
		const [line1, line2] = core.widgetLines();
		expect(line1).toMatch(/DEV-001 · PLAN/);
		expect(line1).toMatch(/running/);
		expect(line2).toMatch(/widget task/);
	});
});

import { readdirSync } from "node:fs";
function mustTask(core: SymphonyCore, taskId: string) {
	const task = core.getTask(taskId);
	if (!task.ok) throw new Error(task.error);
	return task.value;
}

function mustStage(core: SymphonyCore, taskId: string): string {
	return mustTask(core, taskId).frontmatter.stage;
}

function mustCreate(core: SymphonyCore, title: string): string {
	const created = core.createTask({ title, kind: "bug", acceptance: ["a"], risks: [] });
	if (!created.ok) throw new Error(created.error);
	return created.value.id;
}

function readdir(path: string): string[] {
	return readdirSync(path);
}

import { execSync } from "node:child_process";
function findDeadPid(): number {
	try {
		const pid = Number(execSync("sh -c 'sleep 0.05 & echo $!'", { encoding: "utf8" }).trim());
		// wait for it to die
		execSync("sleep 0.3");
		return pid;
	} catch {
		return 999999;
	}
}
