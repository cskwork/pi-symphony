import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import symphonyExtension from "../src/extension/index.ts";
import { commitAll, disposeRepo, makeRepo, realGitExec, silentUi } from "./helpers.ts";

/** v0.5-v0.8 capability wiring: worktrees, queue, supervisor are user-reachable. */

function makeFakePi() {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const execCalls: string[][] = [];
	return {
		pi: {
			registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, def),
			registerTool: () => {},
			on: () => {},
			exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
				execCalls.push([command, ...args]);
				const { execFileSync } = await import("node:child_process");
				try {
					const stdout = execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8", timeout: options?.timeout ?? 30_000 });
					return { code: 0, stdout, stderr: "" };
				} catch (err) {
					const e = err as { stdout?: string; stderr?: string; status?: number };
					return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
				}
			},
			sendUserMessage: () => {},
		},
		commands,
		execCalls,
	};
}

function makeCtx(dir: string, answers: { confirm?: Record<string, boolean> } = {}) {
	const notifications: string[] = [];
	return {
		ctx: {
			cwd: dir,
			mode: "print",
			hasUI: false,
			ui: {
				notify: (m: string) => notifications.push(m),
				select: async () => undefined,
				confirm: async (title: string) => answers.confirm?.[title] ?? false,
				input: async () => "",
				editor: async () => "",
				setWidget: () => {},
				setStatus: () => {},
			},
			sessionManager: { getSessionId: () => "wiring", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
		},
		notifications,
	};
}

let dir: string;
beforeEach(() => {
	dir = makeRepo();
});
afterEach(() => disposeRepo(dir));

describe("capability wiring (v0.5-v0.7 commands)", () => {
	it("/sym worktree allocate creates a real managed worktree via the typed command", async () => {
		const { pi, commands } = makeFakePi();
		symphonyExtension(pi as never);
		const { ctx, notifications } = makeCtx(dir, { confirm: { "Initialize Symphony?": true, "Allocate managed worktree?": true } });
		await commands.get("sym")!.handler("init", ctx);
		// create a task so allocation has a target
		const { SymphonyCore } = await import("../src/core.ts");
		const core = new SymphonyCore({ repoRoot: dir, ui: silentUi, gitExec: realGitExec(dir), env: { PATH: process.env.PATH ?? "" } });
		core.createTask({ title: "wt", kind: "feature", acceptance: ["a"], risks: [] });
		await commands.get("sym")!.handler("worktree allocate build", ctx);
		const note = notifications.join("\\n");
		expect(note).toMatch(/Worktree .* allocated/);
		// the worktree really exists on disk with its own branch
		const { execFileSync } = await import("node:child_process");
		const branch = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: dir, encoding: "utf8" });
		expect(branch).toMatch(/sym-dev-001-build/);
	});

	it("/sym worktree list and remove round-trip safely", async () => {
		const { pi, commands } = makeFakePi();
		symphonyExtension(pi as never);
		const { ctx, notifications } = makeCtx(dir, { confirm: { "Initialize Symphony?": true, "Allocate managed worktree?": true } });
		await commands.get("sym")!.handler("init", ctx);
		const { SymphonyCore } = await import("../src/core.ts");
		const core = new SymphonyCore({ repoRoot: dir, ui: silentUi, gitExec: realGitExec(dir), env: { PATH: process.env.PATH ?? "" } });
		core.createTask({ title: "wt", kind: "feature", acceptance: ["a"], risks: [] });
		await commands.get("sym")!.handler("worktree allocate build", ctx);
		await commands.get("sym")!.handler("worktree list", ctx);
		expect(notifications.some((n) => n.includes("Managed worktrees"))).toBe(true);
		// remove without changes → allowed
		const second = makeCtx(dir);
		await commands.get("sym")!.handler("worktree remove DEV-001", second.ctx);
		expect(second.notifications.some((n) => n.includes("removed"))).toBe(true);
	});

	it("/sym queue shows dispatchable and blocked tasks with reason codes", async () => {
		const { pi, commands } = makeFakePi();
		symphonyExtension(pi as never);
		const { ctx, notifications } = makeCtx(dir, { confirm: { "Initialize Symphony?": true } });
		await commands.get("sym")!.handler("init", ctx);
		const { SymphonyCore } = await import("../src/core.ts");
		const core = new SymphonyCore({ repoRoot: dir, ui: silentUi, gitExec: realGitExec(dir), env: { PATH: process.env.PATH ?? "" } });
		core.createTask({ title: "a", kind: "feature", acceptance: ["x"], risks: [] });
		core.createTask({ title: "risky", kind: "feature", acceptance: ["x"], risks: ["migration"] });
		core.transition("DEV-002", "plan");
		await commands.get("sym")!.handler("queue", ctx);
		const note = notifications.find((n) => n.includes("Queue"));
		expect(note).toBeDefined();
		expect(note).toMatch(/DEV-001 backlog .* dispatchable/);
		expect(note).toMatch(/DEV-002 plan .* (dispatchable|approval_pending)/);
	});

	it("/sym supervisor reports authority and reconciliation posture", async () => {
		const { pi, commands } = makeFakePi();
		symphonyExtension(pi as never);
		const { ctx, notifications } = makeCtx(dir, { confirm: { "Initialize Symphony?": true } });
		await commands.get("sym")!.handler("init", ctx);
		await commands.get("sym")!.handler("supervisor", ctx);
		const note = notifications.find((n) => n.includes("Authority:"));
		expect(note).toMatch(/epoch \d+/);
		expect(note).toMatch(/Reconciliation:/);
	});
});
