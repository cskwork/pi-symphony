import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SymphonyCore } from "../src/core.ts";
import { loadConfigFromText } from "../src/config.ts";
import { redactSecrets } from "../src/redact.ts";
import { assertReadOnlyGit } from "../src/gitinfo.ts";
import { redirectTargets, classifyWrite } from "../src/extension/guard.ts";
import { isValidTaskId } from "../src/ids.ts";
import { runCheck } from "../src/checks.ts";
import { disposeRepo, makeRepo, realGitExec, silentUi } from "./helpers.ts";

/**
 * Security regression tests from the v0.1 adversarial review (E1–E3, R7,
 * O1–O2, S1–S5, plus config integrity rules).
 */
let dir: string;
let core: SymphonyCore;

beforeEach(async () => {
	dir = makeRepo();
	core = new SymphonyCore({
		repoRoot: dir,
		ui: silentUi,
		gitExec: realGitExec(dir),
		env: { PATH: process.env.PATH ?? "" },
		sessionId: "sec-test",
	});
	await core.initialize({ taskPrefix: "DEV", targetBranch: "main", checks: [{ name: "unit", argv: ["true"] }] });
});

afterEach(() => disposeRepo(dir));

function createTask(overrides: { risks?: string[] } = {}): string {
	const created = core.createTask({ title: "sec", kind: "feature", acceptance: ["a"], risks: overrides.risks ?? [] });
	if (!created.ok) throw new Error(created.error);
	return created.value.id;
}

describe("R7: task id traversal", () => {
	it("rejects path-shaped task ids at core entry points", () => {
		for (const bad of ["../outside", "DEV-1/../../x", "", ".hidden", "dev-001"]) {
			expect(isValidTaskId(bad)).toBe(false);
		}
		expect(isValidTaskId("DEV-014")).toBe(true);
		const report = core.submitReport({ taskId: "../outside", section: "plan", summary: "x", details: {} });
		expect(report.ok).toBe(false);
	});
});

describe("E2: evidence tampering", () => {
	it("a tampered artifact is downgraded to broken on rehydrate", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.submitReport({ taskId, section: "implementation", summary: "s", details: {} });
		core.submitReport({ taskId, section: "review", summary: "A", details: { verdict: "approved" }, origin: "fresh-reviewer" });
		core.transition(taskId, "verify");
		// make the check FAIL so a pass would be a forgery
		const failing = new SymphonyCore({
			repoRoot: dir,
			ui: silentUi,
			gitExec: realGitExec(dir),
			checkExecutor: async () => ({ code: 1, stdout: "1 failing", stderr: "", timedOut: false }),
			env: { PATH: process.env.PATH ?? "" },
		});
		const failed = await failing.runCheckSet(taskId, "verify");
		expect(failed.ok).toBe(true);
		if (failed.ok) expect(failed.value.unit?.status).toBe("failed");

		// attacker flips the recorded outcome inside the artifact
		const checksDir = join(dir, ".symphony", "evidence", taskId, "checks");
		const artifact = readdirSync(checksDir).find((f) => f.endsWith(".json"))!;
		const parsed = JSON.parse(readFileSync(join(checksDir, artifact), "utf8"));
		parsed.status = "passed";
		parsed.exitCode = 0;
		writeFileSync(join(checksDir, artifact), JSON.stringify(parsed, null, "\t") + "\n", "utf8");

		// a restarted core detects the digest mismatch → broken → gate blocked
		const reborn = new SymphonyCore({ repoRoot: dir, ui: silentUi, gitExec: realGitExec(dir), env: { PATH: process.env.PATH ?? "" } });
		const runs = reborn.checkRunsFor(taskId);
		const unit = runs.get("unit");
		expect(unit?.status).toBe("broken");
	});
});

describe("E1: file-vs-ledger reconciliation", () => {
	it("a hand-edited task file forging Done is clamped to the ledger view", () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		// attacker edits the file directly to claim done
		const taskPath = join(dir, ".symphony", "tasks", `${taskId}.md`);
		writeFileSync(taskPath, readFileSync(taskPath, "utf8").replace("stage: plan", "stage: done"), "utf8");

		const reborn = new SymphonyCore({ repoRoot: dir, ui: silentUi, gitExec: realGitExec(dir), env: { PATH: process.env.PATH ?? "" } });
		expect(reborn.integrityReport().some((i) => i.includes("edited outside Symphony"))).toBe(true);
	});
});

describe("config integrity (R2b)", () => {
	it("rejects empty check sets — no evidence-free completion", () => {
		const text = readFileSync(join(dir, ".symphony", "config.yaml"), "utf8");
		const emptied = text
			.replace("verify: [unit]", "verify: []")
			.replace("post_integration: [unit]", "post_integration: []");
		const { issues } = loadConfigFromText(emptied);
		expect(issues.filter((i) => /must not be empty/.test(i.message)).length).toBe(2);
	});

	it("rejects check sets with no required command", () => {
		const text = readFileSync(join(dir, ".symphony", "config.yaml"), "utf8");
		const optional = text.replace("required: true", "required: false");
		const { issues } = loadConfigFromText(optional);
		expect(issues.some((i) => /at least one check.*required/.test(i.message))).toBe(true);
	});

	it("config drift during a task blocks Ready", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.submitReport({ taskId, section: "implementation", summary: "s", details: {} });
		core.submitReport({ taskId, section: "review", summary: "A", details: { verdict: "approved" }, origin: "fresh-reviewer" });
		core.transition(taskId, "verify");
		core.setRunState(taskId, "running"); // pins the current config hash
		// change the config on disk and reload
		const cfgPath = join(dir, ".symphony", "config.yaml");
		writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace("max_stage_retries: 1", "max_stage_retries: 2"), "utf8");
		const reborn = new SymphonyCore({ repoRoot: dir, ui: silentUi, gitExec: realGitExec(dir), env: { PATH: process.env.PATH ?? "" } });
		const ready = await reborn.advanceToReady(taskId);
		expect(ready.ok).toBe(false);
		if (!ready.ok) expect(ready.error).toMatch(/configuration changed during this task/);
	});
});

describe("E3: check-gated transitions refuse synchronous staleness", () => {
	it("transition(verify→ready) demands the async path with a live revision", () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.submitReport({ taskId, section: "implementation", summary: "s", details: {} });
		core.submitReport({ taskId, section: "review", summary: "A", details: { verdict: "approved" }, origin: "fresh-reviewer" });
		core.transition(taskId, "verify");
		const moved = core.transition(taskId, "ready");
		expect(moved.ok).toBe(false);
		if (!moved.ok) expect(moved.error).toMatch(/advanceToReady/);
	});
});

describe("O1: symbolic integration revisions", () => {
	it("HEAD is resolved to a concrete sha before recording", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "s", details: {} });
		core.submitReport({ taskId, section: "implementation", summary: "s", details: {} });
		core.submitReport({ taskId, section: "review", summary: "A", details: { verdict: "approved" }, origin: "fresh-reviewer" });
		core.transition(taskId, "verify");
		const ready = await core.advanceToReady(taskId);
		expect(ready.ok).toBe(true);
		const recorded = await core.recordIntegration({ taskId, revision: "HEAD", actor: "t" });
		expect(recorded.ok).toBe(true);
		const task = core.getTask(taskId);
		if (task.ok) expect(task.value.frontmatter.integration!.revision).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("E5: approval invalidation", () => {
	it("a new plan submission voids a prior approval", () => {
		const taskId = createTask({ risks: ["migration"] });
		core.transition(taskId, "plan");
		core.submitReport({ taskId, section: "plan", summary: "p1", details: {} });
		const approved = core.resolveApproval({ taskId, scope: "plan", actor: "u", approved: true });
		expect(approved.ok).toBe(true); // → build
		// review-finding loop: back to plan, re-plan, and the stale approval no longer counts
		core.transition(taskId, "plan");
		const rePlan = core.submitReport({ taskId, section: "plan", summary: "p2", details: {} });
		expect(rePlan.ok).toBe(true);
		if (rePlan.ok) expect(rePlan.value.stageAfter).toBe("plan"); // awaiting fresh approval
		const build = core.transition(taskId, "build");
		expect(build.ok).toBe(false); // stale approval cannot carry the gate
	});
});

describe("S1/S2: guard surface", () => {
	const policy = { protectedPaths: ["**/.env", ".symphony/**"], policy: "confirm" as const };

	it("nested and case-variant env files are protected", () => {
		expect(classifyWrite("backend/.env", policy)).toBe("block");
		expect(classifyWrite(".ENV", policy)).toBe("block");
		expect(classifyWrite("infra/prod/.env.local", policy)).toBe("block");
		expect(classifyWrite(".envrc", policy)).toBe("block");
	});

	it("redirect targets are extracted from shell commands", () => {
		expect(redirectTargets("echo x > .env")).toContain(".env");
		expect(redirectTargets("echo x >> .symphony/config.yaml")).toContain(".symphony/config.yaml");
		expect(redirectTargets("cat k | tee secrets/.env")).toContain("secrets/.env");
		expect(redirectTargets("echo x > /dev/null")).toEqual([]);
		expect(redirectTargets("ls -la")).toEqual([]);
	});
});

describe("S3: git allowlist hardening", () => {
	it.each([
		["log", "--exec=push"],
		["config", "--add", "user.name", "x"],
		["config", "--unset", "user.name"],
		["diff", "--output=/tmp/x"],
		["show", "--output=x"],
		["log", "--format=x", "--exec=rm"],
	])("rejects git %s (option allowlist)", (...argv) => {
		expect(() => assertReadOnlyGit(argv as string[])).toThrow();
	});

	it.each([
		["log", "-5"],
		["log", "--oneline", "--max-count=3"],
		["config", "--get", "user.name"],
		["diff", "HEAD"],
	])("still allows git %s", (...argv) => {
		expect(() => assertReadOnlyGit(argv as string[])).not.toThrow();
	});
});

describe("S4: redaction", () => {
	it("matches ENV-style secret names and bearer JWTs", () => {
		const out = redactSecrets("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI ST7/bXdRulz\nAuthorization: Bearer eyJhbGciOi.eyJzdWIi.SflKxwRJ");
		expect(out).not.toContain("wJalrXUtnFEMI");
		expect(out).not.toContain("eyJhbGciOi");
		expect(out).toMatch(/AWS_SECRET_ACCESS_KEY=\[REDACTED\]/);
	});
});

describe("S5: process-tree timeout", () => {
	it("kills grandchildren that hold the pipe open", async () => {
		// `sh -c 'sleep 5 & wait'` style trees must die at the deadline
		const outcome = await runCheck(
			"tree",
			{ argv: ["sh", "-c", "sleep 10 & sleep 10 & wait"], timeoutMs: 300 },
			{ cwd: dir, revision: null, env: { PATH: process.env.PATH ?? "" } },
		);
		expect(outcome.status).toBe("timeout");
		expect(outcome.evidence.durationMs).toBeLessThan(2500);
	}, 10_000);
});

describe("O2: config serialization round-trip", () => {
	it("boolean-looking argv strings survive write → read", () => {
		const text = readFileSync(join(dir, ".symphony", "config.yaml"), "utf8");
		expect(text).toContain('argv: ["true"]');
		const { issues, config } = loadConfigFromText(text);
		expect(issues).toEqual([]);
		expect(config!.commands.unit!.argv).toEqual(["true"]);
	});
});

describe("D1: CRLF tolerance", () => {
	it("task files with CRLF line endings parse and round-trip", async () => {
		const taskId = createTask();
		const taskPath = join(dir, ".symphony", "tasks", `${taskId}.md`);
		const crlf = readFileSync(taskPath, "utf8").replace(/\n/g, "\r\n");
		writeFileSync(taskPath, crlf, "utf8");
		const reborn = new SymphonyCore({ repoRoot: dir, ui: silentUi, gitExec: realGitExec(dir), env: { PATH: process.env.PATH ?? "" } });
		const task = reborn.getTask(taskId);
		expect(task.ok).toBe(true);
	});
});
