import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfigFromText, validateCommandDefinition, configHash } from "../src/config.ts";
import type { ConfigIssue } from "../src/config.ts";

const validYaml = `
version: 1
project:
  name: my-app
  task_prefix: DEV
  target_branch: main
commands:
  unit:
    argv: ["npm", "test"]
    timeout_ms: 900000
    required: true
checks:
  verify: [unit]
  post_integration: [unit]
`;

describe("config schema v1", () => {
	it("accepts a valid document and fills defaults", () => {
		const { issues, config } = loadConfigFromText(validYaml);
		expect(issues).toEqual([]);
		expect(config!.project.name).toBe("my-app");
		expect(config!.workspace.maxActiveTasks).toBe(1);
		expect(config!.roles.reviewer.session).toBe("fresh");
	});

	it("rejects unsupported versions with migration guidance", () => {
		const { issues } = loadConfigFromText(validYaml.replace("version: 1", "version: 2"));
		expect(issues[0]!.message).toMatch(/unsupported schema version.*migrate/);
	});

	it("rejects malformed YAML", () => {
		const { issues } = loadConfigFromText("version: [unclosed");
		expect(issues[0]!.message).toMatch(/YAML parse error/);
	});

	it("V01-QA-001: rejects shell strings for commands", () => {
		const inline = loadConfigFromText(validYaml.replace('argv: ["npm", "test"]', 'argv: "npm test | tee log"'));
		expect(inline.issues.some((i) => i.path.startsWith("commands.unit") && /shell/.test(i.message))).toBe(true);
		const asCommand = loadConfigFromText(
			validYaml.replace('unit:\n    argv: ["npm", "test"]\n    timeout_ms: 900000\n    required: true', 'unit: "npm test"'),
		);
		expect(asCommand.issues.some((i) => i.path === "commands.unit" && /shell strings are rejected/.test(i.message))).toBe(true);
	});

	it("V01-QA-001: rejects missing timeouts", () => {
		const { issues } = loadConfigFromText(validYaml.replace("timeout_ms: 900000", ""));
		expect(issues.some((i) => i.path === "commands.unit.timeout_ms")).toBe(true);
	});

	it("V01-QA-001: rejects oversized limits", () => {
		const issues: ConfigIssue[] = [];
		validateCommandDefinition("big", { argv: ["x"], timeout_ms: 10 ** 9 }, issues);
		expect(issues.some((i) => /exceeds the maximum/.test(i.message))).toBe(true);
		validateCommandDefinition("neg", { argv: ["x"], timeout_ms: -1 }, issues);
		expect(issues.some((i) => i.path === "commands.neg.timeout_ms")).toBe(true);
	});

	it("flags check references to unknown commands", () => {
		const { issues } = loadConfigFromText(validYaml.replace("verify: [unit]", "verify: [nope]"));
		expect(issues.some((i) => /unknown check "nope"/.test(i.message))).toBe(true);
	});

	it("preserves unknown fields for forward compatibility", () => {
		const { config } = loadConfigFromText(validYaml + "\nfuture_field: {a: 1}\n");
		expect(config!._unknown).toEqual({ future_field: { a: 1 } });
	});

	it("config hash is stable and content-derived", () => {
		const a = loadConfigFromText(validYaml).config!;
		const b = loadConfigFromText(validYaml).config!;
		expect(configHash(a)).toBe(configHash(b));
		a.project.name = "other";
		expect(configHash(a)).not.toBe(configHash(b));
	});

	it("defaults are schema-valid", () => {
		const { issues } = loadConfigFromText(toYaml(defaultConfig("x")));
		expect(issues).toEqual([]);
	});
});

function toYaml(config: unknown): string {
	// serialize enough of the default config for round-trip validation
	const c = config as ReturnType<typeof defaultConfig>;
	return `
version: 1
project:
  name: ${c.project.name}
  task_prefix: ${c.project.taskPrefix}
  target_branch: ${c.project.targetBranch}
workflow:
  preset: ${c.workflow.preset}
  plan_approval: ${c.workflow.planApproval}
  review_medium_policy: ${c.workflow.reviewMediumPolicy}
  completion: ${c.workflow.completion}
roles:
  planner: {session: current, model: inherit, thinking: high, max_turns: 4}
  implementer: {session: current, model: inherit, thinking: high, max_turns: 12}
  reviewer: {session: fresh, model: inherit, thinking: high, max_turns: 6, tools: [sym_task_read, sym_diff_read, read]}
commands:
  unit:
    argv: [${c.commands.unit!.argv.map((a) => JSON.stringify(a)).join(", ")}]
    timeout_ms: ${c.commands.unit!.timeoutMs}
    required: true
checks:
  verify: [unit]
  post_integration: [unit]
security:
  protected_paths: [${c.security.protectedPaths.map((p) => JSON.stringify(p)).join(", ")}]
limits:
  max_child_sessions: ${c.limits.maxChildSessions}
  max_stage_retries: ${c.limits.maxStageRetries}
`;
}
