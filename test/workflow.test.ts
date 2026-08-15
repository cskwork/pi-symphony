import { describe, expect, it } from "vitest";
import { assertTransition, evaluateGate, nextAction, needsPlanApproval } from "../src/workflow.ts";
import type { TaskStage } from "../src/types.ts";
import { defaultConfig } from "../src/config.ts";
import type { EvidenceBundle } from "../src/workflow.ts";

const config = defaultConfig("test");

function evidence(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
	return {
		hasReport: () => false,
		planApproved: false,
		checks: new Map(),
		checksRevision: null,
		currentRevision: "rev-1",
		risks: [],
		...overrides,
	};
}

describe("workflow engine (V01-WF-001 property tests)", () => {
	const valid: Array<[TaskStage, TaskStage]> = [
		["backlog", "plan"],
		["plan", "build"],
		["build", "review"],
		["review", "verify"],
		["verify", "ready"],
		["ready", "postverify"],
		["postverify", "done"],
		["plan", "cancelled"],
		["verify", "blocked"],
		["blocked", "plan"],
	];
	const invalid: Array<[TaskStage, TaskStage]> = [
		["backlog", "build"],
		["backlog", "done"],
		["plan", "verify"],
		["build", "ready"],
		["review", "done"],
		["ready", "review"],
		["done", "backlog"],
		["done", "plan"],
		["cancelled", "plan"],
		["verify", "done"],
	];

	it.each(valid)("allows %s → %s", (from, to) => {
		expect(() => assertTransition(from, to)).not.toThrow();
	});
	it.each(invalid)("rejects %s → %s", (from, to) => {
		expect(() => assertTransition(from, to)).toThrow(/invalid transition/);
	});

	it("requires plan and implementation reports before review", () => {
		const gate = evaluateGate("build", "review", evidence(), config);
		expect(gate.ok).toBe(false);
		expect(gate.ok === false && gate.reason).toMatch(/plan report/);
		const ok = evaluateGate("build", "review", evidence({ hasReport: () => true }), config);
		expect(ok.ok).toBe(true);
	});

	it("requires plan approval when risks are declared (risks_only policy)", () => {
		const risky = evidence({ hasReport: () => true, risks: ["data migration"] });
		expect(evaluateGate("plan", "build", risky, config).ok).toBe(false);
		const approved = evidence({ hasReport: () => true, risks: ["data migration"], planApproved: true });
		expect(evaluateGate("plan", "build", approved, config).ok).toBe(true);
		expect(needsPlanApproval(config, { risks: [] })).toBe(false);
		expect(needsPlanApproval(config, { risks: ["x"] })).toBe(true);
	});

	it("V01-QA-002: failed, missing, timed-out, unavailable and stale checks block Ready", () => {
		const fail = evidence({ hasReport: () => true, checks: new Map([["unit", fakeCheck("failed")]]) });
		expect(evaluateGate("verify", "ready", fail, config)).toMatchObject({ ok: false });
		const timeout = evidence({ hasReport: () => true, checks: new Map([["unit", fakeCheck("timeout")]]) });
		expect(evaluateGate("verify", "ready", timeout, config)).toMatchObject({ ok: false });
		const unavailable = evidence({ hasReport: () => true, checks: new Map([["unit", fakeCheck("unavailable")]]) });
		expect(evaluateGate("verify", "ready", unavailable, config)).toMatchObject({ ok: false });
		const missing = evidence({ hasReport: () => true });
		expect(evaluateGate("verify", "ready", missing, config)).toMatchObject({ ok: false });
		const stale = evidence({
			hasReport: () => true,
			checks: new Map([["unit", fakeCheck("passed", "old-rev")]]),
			currentRevision: "new-rev",
		});
		expect(evaluateGate("verify", "ready", stale, config)).toMatchObject({ ok: false });
		const fresh = evidence({ hasReport: () => true, checks: new Map([["unit", fakeCheck("passed", "rev-1")]]) });
		expect(evaluateGate("verify", "ready", fresh, config)).toMatchObject({ ok: true });
	});

	it("post-integration gate requires fresh passing checks too", () => {
		const failing = evidence({ checks: new Map([["unit", fakeCheck("failed")]]) });
		expect(evaluateGate("postverify", "done", failing, config).ok).toBe(false);
	});

	it("nextAction suggests the right /sym continue step", () => {
		expect(nextAction("backlog", evidence(), config).action).toBe("advance:plan");
		expect(nextAction("plan", evidence(), config).action).toBe("satisfy:build");
		expect(nextAction("verify", evidence(), config).action).toBe("satisfy:ready");
		expect(nextAction("ready", evidence(), config).action).toBe("integrate");
		expect(nextAction("done", evidence(), config).action).toBe("none");
	});
});

function fakeCheck(status: "passed" | "failed" | "timeout" | "unavailable", revision = "rev-1") {
	return {
		check: "unit",
		runId: "run",
		status,
		exitCode: status === "passed" ? 0 : 1,
		durationMs: 10,
		startedAt: "now",
		finishedAt: "now",
		output: "",
		truncated: false,
		revision,
		command: ["true"],
	};
}
