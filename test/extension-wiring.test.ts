import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import symphonyExtension from "../src/extension/index.ts";
import { commitAll, disposeRepo, makeRepo, realGitExec, silentUi } from "./helpers.ts";

/**
 * Wiring test: drives the real extension factory with a stubbed Pi host.
 * Verifies command routing, tool registration, brief injection, guard
 * interception, and widget refresh without a live TUI.
 */

interface RegisteredTool {
	name: string;
	definition: {
		parameters: unknown;
		execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
	};
}

function makeFakePi() {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sentMessages: string[] = [];
	const execCalls: Array<{ command: string; args: string[]; options?: { cwd?: string; timeout?: number } }> = [];
	const pi = {
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, def),
		registerTool: (definition: RegisteredTool["definition"] & { name: string }) => {
			// toolbox registers as full definition object
			tools.set((definition as { name: string }).name, { name: (definition as { name: string }).name, definition: definition as RegisteredTool["definition"] });
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
			execCalls.push({ command, args, options });
			try {
				const stdout = execFileSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf8",
					timeout: options?.timeout ?? 10_000,
				});
				return { code: 0, stdout, stderr: "" };
			} catch (err) {
				const e = err as { stdout?: string; stderr?: string; status?: number };
				return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
			}
		},
		sendUserMessage: (text: string) => {
			sentMessages.push(text);
		},
	};
	return { pi, commands, tools, handlers, sentMessages, execCalls };
}

function makeFakeCtx(dir: string, answers: { input?: Record<string, string>; select?: Record<string, string>; confirm?: Record<string, boolean>; editor?: Record<string, string> } = {}) {
	const notifications: string[] = [];
	const widgets = new Map<string, string[] | undefined>();
	const ctx = {
		cwd: dir,
		mode: "print",
		hasUI: false,
		ui: {
			notify: (message: string) => notifications.push(message),
			select: async (title: string) => answers.select?.[title],
			confirm: async (title: string) => answers.confirm?.[title] ?? false,
			input: async (title: string) => answers.input?.[title],
			editor: async (title: string) => answers.editor?.[title],
			setWidget: (key: string, lines: string[] | undefined) => widgets.set(key, lines),
			setStatus: () => {},
		},
		sessionManager: {
			getSessionId: () => "wiring-test-session",
			getSessionFile: () => undefined,
			getEntries: () => [],
			getBranch: () => [],
		},
	};
	return { ctx, notifications, widgets };
}

let dir: string;

beforeEach(() => {
	dir = makeRepo();
});
afterEach(() => disposeRepo(dir));

describe("extension wiring", () => {
	it("registers the /sym command and sym_* tools", () => {
		const { pi, commands, tools } = makeFakePi();
		symphonyExtension(pi as never);
		expect(commands.has("sym")).toBe(true);
		for (const tool of ["sym_task_read", "sym_diff_read", "sym_plan_submit", "sym_build_report", "sym_review_submit"]) {
			expect(tools.has(tool)).toBe(true);
		}
	});

	it("runs init → new → continue(plan) → plan tool → continue(build) → build tool → review stage", async () => {
		const { pi, commands, tools, sentMessages, execCalls } = makeFakePi();
		symphonyExtension(pi as never);
		const handler = commands.get("sym")!.handler;
		const { ctx } = makeFakeCtx(dir, {
			confirm: { "Initialize Symphony?": true },
			input: { "Task id prefix:": "DEV", "Target branch:": "main", "Task title:": "Wire feature Y" },
			select: { "Task kind:": "feature" },
			editor: {
				"Acceptance criteria (one per line):": "works end to end",
				"Declared risks (one per line, empty if none):": "",
			},
		});

		await handler("init", ctx);
		expect(readFileSync(join(dir, ".symphony", "config.yaml"), "utf8")).toMatch(/task_prefix: DEV/);
		expect(execCalls[0]).toMatchObject({
			command: "git",
			args: ["-C", dir, "rev-parse", "--is-inside-work-tree"],
		});
		expect(execCalls[0]?.options?.cwd).toBeUndefined();

		await handler("new", ctx);
		expect(readFileSync(join(dir, ".symphony", "tasks", "DEV-001.md"), "utf8")).toMatch(/Wire feature Y/);

		// continue from backlog → plan brief injected into current session
		await handler("continue", ctx);
		expect(sentMessages.some((m) => m.includes("Symphony task DEV-001") && m.includes("sym_plan_submit"))).toBe(true);

		// model submits a plan through the tool (fresh ctx object per call in real pi)
		const planTool = tools.get("sym_plan_submit")!;
		const planResult = (await planTool.definition.execute(
			"call-1",
			{ summary: "do the thing", steps: ["step one"], files: ["src/x.ts"], risks: [] },
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ text: string }>; details: { stage: string } };
		expect(planResult.details.stage).toBe("build");

		// continue at build: build brief injected
		await handler("continue", ctx);
		expect(sentMessages.some((m) => m.includes("build phase"))).toBe(true);

		const buildTool = tools.get("sym_build_report")!;
		const buildResult = (await buildTool.definition.execute(
			"call-2",
			{ summary: "implemented", filesChanged: ["src/x.ts"], acceptanceStatus: [{ criterion: 1, status: "met" }] },
			undefined,
			undefined,
			ctx,
		)) as { details: { stage: string } };
		expect(buildResult.details.stage).toBe("review");

		const status = readFileSync(join(dir, ".symphony", "tasks", "DEV-001.md"), "utf8");
		expect(status).toMatch(/stage: review/);
	});

	it("guard blocks protected-path writes and confirms destructive commands", async () => {
		const { pi, commands, handlers } = makeFakePi();
		symphonyExtension(pi as never);
		const { ctx } = makeFakeCtx(dir, {
			confirm: { "Initialize Symphony?": true },
			input: { "Task id prefix:": "DEV", "Target branch:": "main" },
		});
		// initialize first so the guard has a policy to enforce
		await commands.get("sym")!.handler("init", ctx);
		for (const h of handlers.get("session_start") ?? []) await h({}, ctx);

		const guard = handlers.get("tool_call")![0]!;
		// .env write is protected → confirm prompt; ctx.hasUI false → blocked by default answer
		const blockedEnv = (await guard(
			{ toolName: "write", input: { path: ".env", content: "X=1" }, toolCallId: "t1" },
			ctx,
		)) as { block: boolean; reason: string } | undefined;
		expect(blockedEnv?.block).toBe(true);
		expect(blockedEnv?.reason).toMatch(/protected/);

		// destructive command: with hasUI=false the confirm resolves false → blocked
		const blockedPush = (await guard(
			{ toolName: "bash", input: { command: "git push origin main" }, toolCallId: "t2" },
			ctx,
		)) as { block: boolean; reason: string } | undefined;
		expect(blockedPush?.block).toBe(true);
		expect(blockedPush?.reason).toMatch(/declined git push/);
		// benign commands are untouched
		const allowedCommand = (await guard(
			{ toolName: "bash", input: { command: "git status --porcelain" }, toolCallId: "t5" },
			ctx,
		)) as { block: boolean } | undefined;
		expect(allowedCommand).toBeUndefined();

		// normal write is untouched
		const allowed = (await guard(
			{ toolName: "write", input: { path: "src/new-file.ts", content: "x" }, toolCallId: "t4" },
			ctx,
		)) as { block: boolean } | undefined;
		expect(allowed).toBeUndefined();
	});

	it("session lifecycle refreshes the widget and shutdown releases resources", async () => {
		const { pi, handlers } = makeFakePi();
		symphonyExtension(pi as never);
		const { ctx, widgets } = makeFakeCtx(dir, {});
		for (const h of handlers.get("session_start") ?? []) await h({}, ctx);
		// not initialized → widget cleared
		expect(widgets.get("symphony")).toBeUndefined();
		for (const h of handlers.get("session_shutdown") ?? []) await h({}, ctx);
	});
});
