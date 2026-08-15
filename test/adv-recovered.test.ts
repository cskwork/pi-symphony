import { describe, expect, it } from "vitest";
import { parseCondition, evaluateCondition } from "../src/workflow-def.ts";
import { loadConfigFromText } from "../src/config.ts";
import { SdkReviewerRunner, sanitizeReviewerTools } from "../src/reviewer.ts";

/**
 * Findings recovered from the (report-less) v1.0 adversarial review session:
 *  1. pathological changed_paths globs must not hang evaluation
 *  2. reviewer tools: config mutation tools rejected; runner sanitizes anyway
 */

describe("glob condition robustness", () => {
	it("pathological **-chains stay fast (no catastrophic backtracking)", () => {
		const pathological = [
			"**/".repeat(24),
			"**/".repeat(24) + "x",
			"*".repeat(64),
			"**/**/**/**/**/**/*.deeply/nested/no/match",
		];
		for (const pattern of pathological) {
			const condition = parseCondition({ changed_paths: pattern });
			const started = Date.now();
			evaluateCondition(condition, { taskKind: "f", taskFields: {}, changedPaths: ["short/path.ts", "a/b/c/d/e/f/g/no-match.ts"] });
			const elapsed = Date.now() - started;
			expect(elapsed, `pattern ${pattern.slice(0, 20)}… took ${elapsed}ms`).toBeLessThan(1000);
		}
	});
});

describe("reviewer tool enforcement", () => {
	it("config rejects mutation tools for the reviewer role", () => {
		const yaml = `
version: 1
project: { name: x, task_prefix: DEV, target_branch: main }
roles:
  reviewer:
    session: fresh
    model: inherit
    thinking: high
    max_turns: 6
    tools: [bash, write]
commands:
  unit: { argv: ["true"], timeout_ms: 5000, required: true }
checks: { verify: [unit], post_integration: [unit] }
`;
		const { issues } = loadConfigFromText(yaml);
		expect(issues.some((i) => i.path === "roles.reviewer.tools" && /read-only/.test(i.message))).toBe(true);
	});

	it("legitimate read-only reviewer tools are copied through, not silently dropped", () => {
		const yaml = `
version: 1
project: { name: x, task_prefix: DEV, target_branch: main }
roles:
  reviewer:
    session: fresh
    model: inherit
    thinking: high
    max_turns: 6
    tools: [read, grep, sym_diff_read]
commands:
  unit: { argv: ["true"], timeout_ms: 5000, required: true }
checks: { verify: [unit], post_integration: [unit] }
`;
		const { issues, config } = loadConfigFromText(yaml);
		expect(issues).toEqual([]);
		expect(config!.roles.reviewer.tools).toEqual(["read", "grep", "sym_diff_read"]);
	});

	it("the runner sanitizes tool lists regardless of origin (defense in depth)", () => {
		expect(sanitizeReviewerTools(["bash", "write", "edit"])).toEqual(["read", "grep", "find", "ls"]);
		expect(sanitizeReviewerTools(["read", "bash"])).toEqual(["read"]);
		const runner = new SdkReviewerRunner({ model: "inherit", thinking: "high", maxTurns: 3, tools: ["bash"], repoRoot: "/tmp" });
		expect(runner.buildSessionPlan().tools).not.toContain("bash");
	});
});
