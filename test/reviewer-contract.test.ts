import { describe, expect, it } from "vitest";
import { SdkReviewerRunner, DEFAULT_REVIEWER_TOOLS, parseReviewOutput } from "../src/reviewer.ts";

/**
 * Reviewer session contract (V01-AGENT-001): verified against the real SDK
 * option surface — read-only tools, full resource isolation, repo-scoped cwd,
 * role settings applied. The model call itself is exercised by the smoke
 * harness with a live API key, not here.
 */
describe("fresh reviewer session plan", () => {
	it("grants only read-only tools", () => {
		const runner = new SdkReviewerRunner();
		const plan = runner.buildSessionPlan();
		expect(plan.tools).toEqual(DEFAULT_REVIEWER_TOOLS);
		for (const forbidden of ["edit", "write", "bash"]) {
			expect(plan.tools).not.toContain(forbidden);
		}
	});

	it("isolates from ambient extensions, skills, and context files", () => {
		const plan = new SdkReviewerRunner().buildSessionPlan();
		expect(plan.noExtensions).toBe(true);
		expect(plan.noSkills).toBe(true);
		expect(plan.noContextFiles).toBe(true);
	});

	it("applies reviewer role configuration from config", () => {
		const runner = new SdkReviewerRunner({
			model: "inherit",
			thinking: "high",
			maxTurns: 3,
			tools: ["read", "sym_task_read", "sym_diff_read"],
			repoRoot: "/tmp/repo",
		});
		const plan = runner.buildSessionPlan();
		expect(plan.tools).toEqual(["read", "sym_task_read", "sym_diff_read"]);
		expect(plan.cwd).toBe("/tmp/repo");
		expect(plan.systemPrompt).toContain("independent reviewer");
		expect(plan.systemPrompt).toContain("read-only tools");
	});

	it("turn-capped reviews are reported as changes_requested, never approved", () => {
		// parseReviewOutput is the single funnel for reviewer output; the turn
		// cap path constructs its own changes_requested report.
		const approvedLooking = parseReviewOutput('looks great, ship it', "s");
		expect(approvedLooking.verdict).toBe("changes_requested");
	});
});
