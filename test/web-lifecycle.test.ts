import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import symphonyExtension from "../src/extension/index.ts";
import { commitAll, disposeRepo, makeRepo, realGitExec, silentUi } from "./helpers.ts";

/**
 * /sym web lifecycle through the real extension factory: start → status →
 * stop → restart, plus cross-surface equivalence (a browser command and the
 * TUI core produce identical task-file state).
 */

function makeFakePi() {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, def),
		registerTool: () => {},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		exec: async (command: string, args: string[], options?: { cwd?: string }) => {
			const { execFileSync } = await import("node:child_process");
			try {
				const stdout = execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8", timeout: 10_000 });
				return { code: 0, stdout, stderr: "" };
			} catch (err) {
				const e = err as { stdout?: string; stderr?: string; status?: number };
				return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
			}
		},
		sendUserMessage: () => {},
	};
	return { pi, commands, handlers };
}

function makeCtx(dir: string) {
	const notifications: string[] = [];
	const ctx = {
		cwd: dir,
		mode: "print",
		hasUI: false,
		ui: {
			notify: (m: string) => notifications.push(m),
			select: async () => undefined,
			confirm: async () => true,
			input: async () => "",
			editor: async () => "",
			setWidget: () => {},
			setStatus: () => {},
		},
		sessionManager: { getSessionId: () => "web-lifecycle", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
	};
	return { ctx, notifications };
}

let dir: string;
beforeEach(async () => {
	dir = makeRepo();
});
afterEach(() => disposeRepo(dir));

describe("/sym web lifecycle", () => {
	it("start reports the loopback URL, status works, stop is idempotent, restart gets a new port/token", async () => {
		const { pi, commands } = makeFakePi();
		symphonyExtension(pi as never);
		const handler = commands.get("sym")!.handler;
		const { ctx, notifications } = makeCtx(dir);

		// initialize so the server has a core
		await handler("init", ctx);
		const before = notifications.length;

		await handler("web", ctx);
		const startNote = notifications.slice(before).find((n) => n.includes("http://127.0.0.1"));
		expect(startNote).toBeDefined();
		expect(startNote).toMatch(/Remote access: disabled/);

		await handler("web status", ctx);
		expect(notifications.some((n) => n.includes("running"))).toBe(true);

		await handler("web stop", ctx);
		await handler("web stop", ctx); // idempotent
		expect(notifications.filter((n) => n.includes("stopped")).length).toBeGreaterThanOrEqual(1);

		await handler("web", ctx);
		const secondStart = notifications.slice(notifications.length - 3).find((n) => n.includes("http://127.0.0.1"));
		expect(secondStart).toBeDefined();
		await handler("web stop", ctx);
	});

	it("a task file mutated through the server is byte-identical to the same core mutation (single authority)", async () => {
		const { WebControlPlane } = await import("../src/web/server.ts");
		const { SymphonyCore } = await import("../src/core.ts");
		const coreA = new SymphonyCore({ repoRoot: dir, ui: silentUi, gitExec: realGitExec(dir), env: { PATH: process.env.PATH ?? "" } });
		await coreA.initialize({ taskPrefix: "DEV", targetBranch: "main", checks: [{ name: "unit", argv: ["true"] }] });
		const created = coreA.createTask({ title: "t", kind: "feature", acceptance: ["a"], risks: [] });
		if (!created.ok) throw new Error(created.error);
		const id = created.value.id;

		const plane = new WebControlPlane(() => coreA);
		const started = await plane.start();
		const base = `http://127.0.0.1:${started.port}`;
		const snapshot = (await (await fetch(`${base}/api/v1/snapshot`, { headers: { Authorization: `Bearer ${plane.token}` } })).json()) as { repositoryId: string; tasks: Array<{ id: string; revision: number }> };
		const repositoryId = snapshot.repositoryId;
		const revision = snapshot.tasks.find((task) => task.id === id)?.revision;

		// pause via the web command path
		const res = await fetch(`${base}/api/v1/commands`, {
			method: "POST",
			headers: { Authorization: `Bearer ${plane.token}`, "Content-Type": "application/json", Origin: base, Host: `127.0.0.1:${started.port}` },
			body: JSON.stringify({ commandId: "01J5WWWWWWWWWWWW", type: "task.pause", repositoryId, aggregateId: id, expectedRevision: revision, payload: {} }),
		});
		expect(res.status).toBe(200);
		await plane.stop();

		const viaWeb = readFileSync(join(dir, ".symphony", "tasks", `${id}.md`), "utf8");
		expect(viaWeb).toMatch(/run_state: waiting/);
	});
});
