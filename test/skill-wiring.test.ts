import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import symphonyExtension from "../src/extension/index.ts";
import { disposeRepo, makeRepo } from "./helpers.ts";

/** Skill progressive disclosure through the real extension factory. */

function makeFakePi() {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { name: string; definition: { execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown> } }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	return {
		pi: {
			registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, def),
			registerTool: (definition: { name: string }) => tools.set(definition.name, { name: definition.name, definition: definition as never }),
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			sendUserMessage: () => {},
		},
		commands,
		tools,
		handlers,
	};
}

function makeCtx(dir: string) {
	return {
		cwd: dir,
		mode: "print",
		hasUI: false,
		ui: { notify: () => {}, select: async () => undefined, confirm: async () => true, input: async () => "", editor: async () => "", setWidget: () => {}, setStatus: () => {} },
		sessionManager: { getSessionId: () => "skills-wiring", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
	};
}

let dir: string;
beforeEach(() => {
	dir = makeRepo();
	const skillsDir = join(dir, ".symphony", "skills", "risk-challenge");
	mkdirSync(skillsDir, { recursive: true });
	writeFileSync(
		join(skillsDir, "skill.yaml"),
		[
			'name: "risk-challenge"',
			'version: "1.0.0"',
			'description: "Challenge risky plans"',
			'invocation: "stage_or_explicit"',
			"stages:",
			'  - "plan"',
			"capabilities:",
			'  - "read_task"',
			'  - "read_repository"',
			"inputs:",
			'  - "task_contract"',
			"outputs:",
			'  - "challenge_report"',
			'side_effects: "none"',
			'entry: "SKILL.md"',
		].join("\n"),
		"utf8",
	);
	writeFileSync(join(skillsDir, "SKILL.md"), "# Risk challenge\nSECRET_BODY_INSTRUCTIONS only after selection", "utf8");
});
afterEach(() => disposeRepo(dir));

describe("skill tools wiring (V03-SKILL-001/003)", () => {
	it("sym_skills shows catalog entries without bodies; sym_skill_select loads the body with provenance", async () => {
		const { pi, tools } = makeFakePi();
		symphonyExtension(pi as never);
		const ctx = makeCtx(dir);

		const list = (await tools.get("sym_skills")!.definition.execute("t1", { stage: "plan" }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(list.content[0]!.text).toContain("risk-challenge");
		expect(list.content[0]!.text).not.toContain("SECRET_BODY_INSTRUCTIONS");

		const selected = (await tools.get("sym_skill_select")!.definition.execute("t2", { name: "risk-challenge" }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
			details: { capabilities: string[] };
		};
		expect(selected.content[0]!.text).toContain("SECRET_BODY_INSTRUCTIONS");
		expect(selected.content[0]!.text).toContain("repository");
		expect(selected.details.capabilities).toContain("read_task");

		const unknown = (await tools.get("sym_skill_select")!.definition.execute("t3", { name: "nope" }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(unknown.content[0]!.text).toMatch(/unknown skill/);
	});

	it("stage filtering hides unbound skills", async () => {
		const { pi, tools } = makeFakePi();
		symphonyExtension(pi as never);
		const ctx = makeCtx(dir);
		const list = (await tools.get("sym_skills")!.definition.execute("t1", { stage: "verify" }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(list.content[0]!.text).toMatch(/No skills bound/);
	});
});
