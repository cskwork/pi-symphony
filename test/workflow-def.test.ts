import { describe, expect, it } from "vitest";
import {
	type StageDefinition as StageDefinition2,
	parseCondition,
	evaluateCondition,
	explainCondition,
	validateGraph,
	simulate,
	defaultWorkflow,
	ConditionError,
} from "../src/workflow-def.ts";

describe("condition parser (V03-WF-004: typed, data-only AST)", () => {
	it("parses the documented condition forms", () => {
		expect(parseCondition({ task_kind: "feature" })).toEqual({ kind: "task_kind", equals: "feature" });
		expect(parseCondition({ task_field: { field: "risks", equals: 2 } })).toEqual({ kind: "task_field", field: "risks", equals: 2 });
		expect(() => parseCondition({ changed_paths: { matches: "auth/**" } })).toThrow(/glob string/);
		expect(parseCondition(true)).toEqual({ kind: "always" });
		expect(parseCondition({ any: [{ task_kind: "bug" }, { task_kind: "security" }] })).toMatchObject({ kind: "any" });
	});

	it("rejects code, scripts, and unknown operators", () => {
		expect(() => parseCondition({ exec: "rm -rf /" })).toThrow(ConditionError);
		expect(() => parseCondition({ $eval: "process.env" })).toThrow(ConditionError);
		expect(() => parseCondition({ task_kind: "x", changed_paths: "y" })).toThrow(/exactly one operator/);
		expect(() => parseCondition({ task_field: { field: "x", equals: "1", sneaky: true } })).toThrow(/unknown task_field fields/);
		expect(() => parseCondition({ task_field: { field: "x", eval: "1" } })).toThrow();
		expect(() => parseCondition({ all: [] })).toThrow(/non-empty/);
	});

	it("evaluation consults only the bounded facts", () => {
		const facts = { taskKind: "bug", taskFields: { security: true }, changedPaths: ["src/auth/login.ts"] };
		expect(evaluateCondition(parseCondition({ task_kind: "bug" }), facts)).toBe(true);
		expect(evaluateCondition(parseCondition({ task_field: { field: "security", equals: true } }), facts)).toBe(true);
		expect(evaluateCondition(parseCondition({ changed_paths: "auth/**" }), facts)).toBe(true);
		expect(evaluateCondition(parseCondition({ not: { task_kind: "bug" } }), facts)).toBe(false);
		expect(evaluateCondition(parseCondition({ all: [{ task_kind: "bug" }, { changed_paths: "docs/**" }] }), facts)).toBe(false);
	});

	it("explainCondition produces a full trace (V03-WF-005)", () => {
		const entries = explainCondition(
			parseCondition({ any: [{ task_kind: "bug" }, { all: [{ changed_paths: "auth/**" }] }] }),
			{ taskKind: "feature", taskFields: {}, changedPaths: ["auth/x.ts"] },
		);
		expect(entries.length).toBeGreaterThanOrEqual(4);
		expect(entries[entries.length - 1]!.result).toBe(true);
		expect(entries[0]!.note).toBeDefined();
	});
});

describe("graph validation (V03-WF-002/003)", () => {
	it("accepts the default graph", () => {
		expect(validateGraph(defaultWorkflow())).toEqual([]);
	});

	it("rejects multiple entries, no terminal, unknown targets, unreachable stages", () => {
		const orphan = { id: "orphan", actor: "x", inputs: [], outputs: [] };
		const base = defaultWorkflow();
		expect(validateGraph({ ...base, stages: [...base.stages, orphan] }).some((i) => /unreachable/.test(i.message))).toBe(true);

		const cycleOnly = { stages: [{ id: "a", actor: "x", inputs: [], outputs: [], onSuccess: "b" }, { id: "b", actor: "x", inputs: [], outputs: [], onSuccess: "a" }], invariants: { requireDeterministicVerify: true, requireCompletionEvidence: true } };
		expect(validateGraph(cycleOnly).some((i) => /no entry stage/.test(i.message))).toBe(true);

		const noTerminal = { stages: [{ id: "a", actor: "x", inputs: [], outputs: [], onSuccess: "b" }, { id: "b", actor: "x", inputs: [], outputs: [], onSuccess: "b" }], invariants: { requireDeterministicVerify: true, requireCompletionEvidence: true } };
		expect(validateGraph(noTerminal).some((i) => /no terminal/.test(i.message))).toBe(true);

		const badTarget = { ...base, stages: base.stages.map((s) => (s.id === "plan" ? { ...s, onSuccess: "nonexistent" } : s)) };
		expect(validateGraph(badTarget).some((i) => /unknown stage/.test(i.message))).toBe(true);
	});

	it("V03-WF-003: blocks graph paths to done that bypass deterministic verification", () => {
		const bypass = defaultWorkflow();
		const postverify = bypass.stages.find((s) => s.id === "postverify")!;
		delete (postverify as Partial<typeof postverify>).requiresChecks;
		const issues = validateGraph(bypass);
		expect(issues.some((i) => /invariant violation.*postverify → done requires/.test(i.message))).toBe(true);
	});
});

describe("simulation (V03-WF-005)", () => {
	it("explains selection, skipping, and terminal outcome", () => {
		const graph = defaultWorkflow();
		const result = simulate(graph, { taskKind: "feature", taskFields: {}, changedPaths: [] });
		expect(result.complete).toBe(true);
		expect(result.outcome).toBe("terminal at done");
		expect(result.steps.map((s) => s.stage)).toEqual(["plan", "build", "review", "verify", "ready", "postverify", "done"]);
		expect(result.steps.every((s) => s.selected)).toBe(true);
	});

	it("conditional stages are skipped with an explanation", () => {
		const graph = {
			...defaultWorkflow(),
			stages: [
				{
					id: "security_review",
					actor: "security_reviewer",
					when: parseCondition({ any: [{ task_field: { field: "security", equals: true } }, { changed_paths: "auth/**" }] }),
					inputs: ["diff"],
					outputs: ["review_report"],
					onSuccess: "verify",
				},
				{ id: "plan", actor: "planner", inputs: [], outputs: [], onSuccess: "build" },
				{ id: "build", actor: "implementer", inputs: [], outputs: [], onSuccess: "security_review" },
				{ id: "verify", actor: "checks", inputs: [], outputs: [], onSuccess: "done", requiresChecks: "verify" as const },
				{ id: "done", actor: "none", inputs: ["check_evidence"], outputs: [], terminal: true },
			],
		};
		const skipped = simulate(graph, { taskKind: "feature", taskFields: {}, changedPaths: ["src/ui.ts"] });
		const sec = skipped.steps.find((s) => s.stage === "security_review")!;
		expect(sec.selected).toBe(false);
		expect(sec.entries!.length).toBeGreaterThan(0);
		expect(skipped.steps.map((s) => s.stage)).toContain("verify");

		const selected = simulate(graph, { taskKind: "feature", taskFields: { security: true }, changedPaths: [] });
		expect(selected.steps.find((s) => s.stage === "security_review")!.selected).toBe(true);
	});

	it("stops on cycles and expansion limits", () => {
		const cyclic = {
			stages: [{ id: "a", actor: "x", when: parseCondition(true), inputs: [], outputs: [], onSuccess: "b" }, { id: "b", actor: "x", inputs: [], outputs: [], onSuccess: "a" }],
			invariants: { requireDeterministicVerify: true, requireCompletionEvidence: true },
		};
		const result = simulate(cyclic, { taskKind: "f", taskFields: {}, changedPaths: [] }, 10);
		expect(result.complete).toBe(false);
	});
});
