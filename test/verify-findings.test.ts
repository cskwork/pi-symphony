import { describe, expect, it } from "vitest";
import { defaultWorkflow, validateGraph } from "../src/workflow-def.ts";
import { sanitizeBranch } from "../src/worktrees.ts";
import { validateCustomWorkflow, type WorkflowStageConfig } from "../src/config.ts";
import { applyMigration, previewMigration } from "../src/migration.ts";

/** Findings from the verification reviewer's session (re-verified here). */

describe("ready-edge invariant (stale-evidence hole via custom graph)", () => {
	it("a custom graph reaching ready without verify checks is rejected", () => {
		const hostile = {
			...defaultWorkflow(),
			stages: defaultWorkflow().stages.map((s) =>
				s.id === "verify" ? { ...s, requiresChecks: undefined } : s,
			),
		};
		const issues = validateGraph(hostile);
		expect(issues.some((i) => /→ ready requires requires_checks: verify/.test(i.message))).toBe(true);
	});

	it("a custom graph with requires_checks: none into ready is also rejected", () => {
		const hostile = {
			...defaultWorkflow(),
			stages: defaultWorkflow().stages.map((s) =>
				s.id === "verify" ? { ...s, requiresChecks: "none" as const } : s,
			),
		};
		const issues = validateGraph(hostile);
		expect(issues.some((i) => /→ ready requires/.test(i.message))).toBe(true);
	});

	it("the default graph still validates", () => {
		expect(validateGraph(defaultWorkflow())).toEqual([]);
	});

	it("validateCustomWorkflow surfaces the same violation", async () => {
		const stages: WorkflowStageConfig[] = [
			{ id: "plan", actor: "planner", inputs: [], outputs: ["plan_report"], onSuccess: "build" },
			{ id: "build", actor: "implementer", inputs: [], outputs: ["implementation_report"], onSuccess: "review" },
			{ id: "review", actor: "reviewer", inputs: [], outputs: ["review_report"], onSuccess: "verify" },
			// hole: verify → ready without requiresChecks
			{ id: "verify", actor: "checks", inputs: [], outputs: [], onSuccess: "ready" },
			{ id: "ready", actor: "human", inputs: [], outputs: [], onSuccess: "postverify" },
			{ id: "postverify", actor: "checks", inputs: [], outputs: [], onSuccess: "done", requiresChecks: "postIntegration" },
			{ id: "done", actor: "none", inputs: ["post_check_evidence"], outputs: [], terminal: true },
		];
		const result = await validateCustomWorkflow(stages, { requireDeterministicVerify: true, requireCompletionEvidence: true });
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => /→ ready requires/.test(i.message))).toBe(true);
	});
});

describe("sanitizeBranch idempotency (registry/git mismatch)", () => {
	it("re-sanitizing an already-sanitized branch returns it unchanged", () => {
		const first = sanitizeBranch("DEV-001", "build");
		const second = sanitizeBranch("DEV-001", first);
		expect(second).toBe(first);
		expect(first).toMatch(/^sym\/dev-001\/build-[a-z0-9]+$/);
	});
});

describe("defensive guards on public helpers", () => {
	it("validateCustomWorkflow tolerates undefined stages/invariants", async () => {
		const result = await validateCustomWorkflow(undefined, undefined);
		expect(result.ok).toBe(true);
		expect(result.issues).toEqual([]);
	});

	it("applyMigration rejects previews without a next document", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "guard-"));
		try {
			const cfg = join(dir, "config.yaml");
			writeFileSync(cfg, "version: 1\n", "utf8");
			expect((applyMigration(cfg, undefined)).ok).toBe(false);
			expect((applyMigration(cfg, {})).ok).toBe(false);
			// a real preview still works
			const preview = previewMigration("version: 1\n");
			expect(applyMigration(cfg, preview).ok).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
