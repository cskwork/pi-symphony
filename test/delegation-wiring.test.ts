import { describe, expect, it, beforeEach, afterEach } from "vitest";
import symphonyExtension from "../src/extension/index.ts";
import { disposeRepo, makeRepo, realGitExec, silentUi } from "./helpers.ts";

function makeFakePi() {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	return {
		pi: {
			registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, def),
			registerTool: () => {},
			on: () => {},
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			sendUserMessage: () => {},
		},
		commands,
	};
}

function makeCtx(dir: string) {
	const notifications: string[] = [];
	return {
		ctx: {
			cwd: dir,
			mode: "print",
			hasUI: false,
			ui: { notify: (m: string) => notifications.push(m), select: async () => undefined, confirm: async () => true, input: async () => "", editor: async () => "", setWidget: () => {}, setStatus: () => {} },
			sessionManager: { getSessionId: () => "del", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
		},
		notifications,
	};
}

let dir: string;
beforeEach(() => {
	dir = makeRepo();
});
afterEach(() => disposeRepo(dir));

describe("delegation commands", () => {
	it("unknown roles are rejected with the topology listing", async () => {
		const { pi, commands } = makeFakePi();
		symphonyExtension(pi as never);
		const { ctx, notifications } = makeCtx(dir);
		await commands.get("sym")!.handler("delegate nope", ctx);
		expect(notifications.some((n) => n.includes("Unknown role") && n.includes("reviewer"))).toBe(true);
	});

	it("delegation without an active task is refused", async () => {
		const { pi, commands } = makeFakePi();
		symphonyExtension(pi as never);
		const { ctx, notifications } = makeCtx(dir);
		await commands.get("sym")!.handler("delegate scout", ctx);
		expect(notifications.some((n) => n.includes("No active task"))).toBe(true);
	});

	it("/sym roles shows topology, sessions, and the single-writer rule", async () => {
		const { pi, commands } = makeFakePi();
		symphonyExtension(pi as never);
		const { ctx, notifications } = makeCtx(dir);
		await commands.get("sym")!.handler("roles", ctx);
		const note = notifications.find((n) => n.includes("Topology: standard"));
		expect(note).toBeDefined();
		expect(note).toContain("scout");
		expect(note).toContain("Single writer: delegated roles are read-only");
		expect(note).toContain("(none — /sym delegate <role> launches one)");
	});

	it("/sym handoffs reports the empty queue honestly", async () => {
		const { pi, commands } = makeFakePi();
		symphonyExtension(pi as never);
		const { ctx, notifications } = makeCtx(dir);
		await commands.get("sym")!.handler("handoffs", ctx);
		expect(notifications.some((n) => n.includes("No handoffs"))).toBe(true);
	});
});
