import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SkillCatalog,
	activeCapabilities,
	lintSkill,
	parseSkillManifest,
	pinMismatches,
	runFixture,
} from "../src/skills.ts";

let dir: string;
beforeEach(() => {
	dir = join(tmpdir(), `sym-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeSkill(name: string, manifest: Record<string, unknown>, body: string, files: Record<string, string> = {}): void {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "skill.yaml"), yaml({ ...manifest, name }), "utf8");
	writeFileSync(join(skillDir, String(manifest["entry"] ?? "SKILL.md")), body, "utf8");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(skillDir, path, ".."), { recursive: true });
		writeFileSync(join(skillDir, path), content, "utf8");
	}
}

function yaml(obj: Record<string, unknown>): string {
	return Object.entries(obj)
		.map(([k, v]) => {
			if (Array.isArray(v)) return `${k}:\n${v.map((i) => `  - ${JSON.stringify(i)}`).join("\n")}`;
			return `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`;
		})
		.join("\n");
}

const validManifest = {
	name: "risk-challenge",
	version: "1.0.0",
	description: "Challenge plans that touch risky areas",
	invocation: "stage_or_explicit",
	stages: ["plan"],
	capabilities: ["read_task", "read_repository"],
	inputs: ["task_contract", "proposed_plan"],
	outputs: ["challenge_report"],
	side_effects: "none",
	entry: "SKILL.md",
};

describe("skill manifest schema (V03-SKILL-002)", () => {
	it("accepts a complete manifest", () => {
		const result = parseSkillManifest(validManifest, "repository", "hash");
		expect(result.issues).toEqual([]);
		expect(result.manifest!.name).toBe("risk-challenge");
	});

	it("rejects incomplete manifests with exact fields", () => {
		const result = parseSkillManifest({ ...validManifest, version: undefined, capabilities: ["execute_shell"] }, "repository", "h");
		expect(result.issues.some((i) => i.field === "version")).toBe(true);
		expect(result.issues.some((i) => /unknown capabilities.*execute_shell/.test(i.message))).toBe(true);
	});

	it("rejects undeclared side-effect channels", () => {
		const result = parseSkillManifest({ ...validManifest, side_effects: "arbitrary_writes" }, "repository", "h");
		expect(result.issues.some((i) => /side_effects/.test(i.message ?? ""))).toBe(true);
	});
});

describe("catalog + progressive disclosure (V03-SKILL-001)", () => {
	it("catalog entries omit the body; loadBody is the only body accessor", () => {
		writeSkill("risk-challenge", validManifest, "# Risk challenge\nFull instructions only after selection.");
		const catalog = new SkillCatalog([{ dir, source: "repository" }]);
		const entries = catalog.catalog();
		expect(entries).toHaveLength(1);
		expect(JSON.stringify(entries)).not.toContain("Full instructions");
		expect(catalog.loadBody("risk-challenge")).toContain("Full instructions");
	});

	it("manifest issues surface for broken skills", () => {
		const skillDir = join(dir, "broken");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "skill.yaml"), "name: broken\n", "utf8");
		const catalog = new SkillCatalog([{ dir, source: "repository" }]);
		expect(catalog.catalog()).toHaveLength(0);
		expect(catalog.manifestIssues().length).toBeGreaterThan(0);
	});
});

describe("pinning (V03-SKILL-004)", () => {
	it("content changes after pinning require re-approval", () => {
		writeSkill("risk-challenge", validManifest, "body");
		const catalog = new SkillCatalog([{ dir, source: "repository" }]);
		const skill = catalog.get("risk-challenge")!;
		expect(pinMismatches([skill], [{ name: "risk-challenge", version: "1.0.0", hash: skill.contentHash, source: "repository", pinnedAt: "now" }])).toEqual([]);
		const mismatches = pinMismatches([skill], [{ name: "risk-challenge", version: "1.0.0", hash: "different", source: "repository", pinnedAt: "now" }]);
		expect(mismatches.some((m) => /content changed since pin/.test(m.reason))).toBe(true);
		expect(pinMismatches([skill], []).some((m) => /not pinned/.test(m.reason))).toBe(true);
	});
});

describe("capability intersection (V03-SKILL-003)", () => {
	it("active tools are the intersection of role, repository, and skill", () => {
		const skill = { ...validManifest, dir: "", entryPath: "", source: "repository" as const, contentHash: "" };
		// role allows read+write_notes; repository allows read only
		expect(activeCapabilities(["read_task", "write_task_notes"], ["read_task"], [skill as never])).toEqual(["read_task"]);
		// skill cannot grant a capability repository policy forbids
		const greedy = { ...skill, capabilities: ["read_task", "propose_report"] } as never;
		expect(activeCapabilities(["read_task", "propose_report"], ["read_task"], [greedy])).toEqual(["read_task"]);
	});
});

describe("lint (V03-SKILL-005)", () => {
	it("flags one case per rule", () => {
		writeSkill("linty", validManifest, [
			"# Linty",
			"See the documentation for details.", // ambiguous pointer
			"Do the work.", // missing completion criteria
			"Edit the file directly when needed.", // undeclared side effect
			"Alpha beta gamma delta epsilon zeta eta theta. Alpha beta gamma delta epsilon zeta eta theta.", // duplicated 8-word run
			"[Guide](./missing-guide.md)", // unavailable reference
		].join("\n"));
		const catalog = new SkillCatalog([{ dir, source: "repository" }]);
		const skill = catalog.get("linty")!;
		const findings = lintSkill(skill, catalog.loadBody("linty")!);
		const rules = new Set(findings.map((f) => f.rule));
		expect(rules.has("ambiguous-pointer")).toBe(true);
		expect(rules.has("missing-completion")).toBe(true);
		expect(rules.has("undeclared-side-effect")).toBe(true);
		expect(rules.has("duplicated-text")).toBe(true);
		expect(rules.has("unavailable-reference")).toBe(true);
	});

	it("clean skill passes lint", () => {
		writeSkill(
			"clean",
			validManifest,
			"# Clean skill\nUse [the guide](./guide.md).\nThis skill is complete when the challenge report is filed.",
			{ "guide.md": "# Guide" },
		);
		const catalog = new SkillCatalog([{ dir, source: "repository" }]);
		expect(lintSkill(catalog.get("clean")!, catalog.loadBody("clean")!)).toEqual([]);
	});
});

describe("behavioral fixtures (V03-EVAL-001)", () => {
	it("deterministic fixtures verify checkpoints and forbidden outputs", () => {
		const result = runFixture(
			{
				name: "challenge-issued",
				stubReplies: [{ when: "# Risk challenge", reply: "CHALLENGE: migration risk unaddressed" }],
				expectCheckpoints: ["CHALLENGE:"],
				forbiddenOutputs: ["APPROVED without review"],
			},
			"# Risk challenge\nReview the plan and reply with CHALLENGE: ...",
		);
		expect(result.passed).toBe(true);

		const failing = runFixture(
			{ name: "must-not-self-approve", stubReplies: [{ when: "*", reply: "APPROVED without review" }], expectCheckpoints: ["CHALLENGE:"], forbiddenOutputs: ["APPROVED without review"] },
			"# Risk challenge",
		);
		expect(failing.passed).toBe(false);
		expect(failing.forbiddenHits).toContain("APPROVED without review");
	});
});
