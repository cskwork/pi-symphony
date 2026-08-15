import { describe, expect, it } from "vitest";
import { compileWorkflow, defaultCompiledGraph, evaluateGate } from "../src/workflow.ts";
import { defaultWorkflow } from "../src/workflow-def.ts";
import { defaultConfig } from "../src/config.ts";

describe("graph-driven runtime (V03 compilation)", () => {
	it("the compiled default graph matches the static v0.1 engine", () => {
		const compiled = compileWorkflow(defaultWorkflow());
		const staticGraph = defaultCompiledGraph();
		for (const stage of ["plan", "build", "review", "verify", "ready", "postverify"]) {
			const progression = (list: readonly string[]) => list.filter((t) => t !== "blocked" && t !== "cancelled");
			expect(progression(compiled.transitions[stage]!).sort()).toEqual(progression(staticGraph.transitions[stage]!).sort());
		}
		expect(compiled.entryStage).toBe("plan");
		expect(compiled.reviewGated.has("review")).toBe(true);
	});

	it("compiled contracts enforce the same invariants on the happy path", () => {
		const compiled = compileWorkflow(defaultWorkflow());
		const config = defaultConfig("t");
		const evidence = {
			hasReport: () => true,
			reviewProvenance: "model" as const,
			planApproved: true,
			checks: new Map(),
			checksRevision: null,
			currentRevision: "r1",
			risks: [],
		};
		// review→verify via the compiled contract: provenance still required
		const contract = compiled.contractFor("review", "verify");
		expect(contract.requiresReviewProvenance).toBe(true);
		const gate = evaluateGate("review", "verify", { ...evidence, reviewProvenance: "model" }, config);
		expect(gate.ok).toBe(false);
		const approved = evaluateGate("review", "verify", { ...evidence, reviewProvenance: "fresh-reviewer" }, config);
		expect(approved.ok).toBe(true);
	});

	it("custom stages compile with their own contracts and blocked-inheritance", () => {
		const custom = {
			...defaultWorkflow(),
			stages: [
				{ id: "plan", actor: "planner", inputs: [], outputs: ["plan_report"], onSuccess: "build", requiresApproval: "plan" },
				{ id: "build", actor: "implementer", inputs: [], outputs: ["implementation_report"], onSuccess: "security_review" },
				{
					id: "security_review",
					actor: "security_reviewer",
					inputs: ["diff"],
					outputs: ["review_report"],
					onSuccess: "verify",
					onBlockingFindings: "build",
				},
				{ id: "verify", actor: "checks", inputs: [], outputs: ["check_evidence"], onSuccess: "ready", requiresChecks: "verify" as const },
				{ id: "ready", actor: "human", inputs: [], outputs: [], onSuccess: "postverify" },
				{ id: "postverify", actor: "checks", inputs: [], outputs: [], onSuccess: "done", requiresChecks: "postIntegration" as const },
				{ id: "done", actor: "none", inputs: [], outputs: [], terminal: true },
			],
		};
		const compiled = compileWorkflow(custom);
		expect(compiled.transitions["security_review"]).toEqual(["verify", "build"]);
		expect(compiled.reviewGated.has("security_review")).toBe(true);
		// blocked→security_review inherits the entry contract (implementation report)
		const blockedContract = compiled.contractFor("blocked", "security_review");
		expect(blockedContract.requiresReports).toContain("implementation");
		// and exiting the review stage demands provenance
		expect(compiled.contractFor("security_review", "verify").requiresReviewProvenance).toBe(true);
	});
});
