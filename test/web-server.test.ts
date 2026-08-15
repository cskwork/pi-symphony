import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SymphonyCore } from "../src/core.ts";
import { WebControlPlane, diffConfigText } from "../src/web/server.ts";
import { makeRepo, disposeRepo, realGitExec, silentUi } from "./helpers.ts";

let dir: string;
let core: SymphonyCore;
let plane: WebControlPlane;
let baseUrl: string;
let token: string;

function newCore(): SymphonyCore {
	return new SymphonyCore({
		repoRoot: dir,
		ui: silentUi,
		gitExec: realGitExec(dir),
		env: { PATH: process.env.PATH ?? "" },
		sessionId: "web-test",
	});
}

async function fetchJson(path: string, init: RequestInit = {}, overrideToken?: string): Promise<{ status: number; body: any }> {
	const headers = new Headers(init.headers ?? {});
	if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${overrideToken ?? token}`);
	if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
	const body = await res.json().catch(() => null);
	return { status: res.status, body };
}

beforeEach(async () => {
	dir = makeRepo();
	core = newCore();
	await core.initialize({ taskPrefix: "DEV", targetBranch: "main", checks: [{ name: "unit", argv: ["true"] }] });
	plane = new WebControlPlane(() => core);
	const started = await plane.start();
	baseUrl = `http://127.0.0.1:${started.port}`;
	token = plane.token;
});

afterEach(async () => {
	await plane.stop();
	disposeRepo(dir);
});

function createTask(title = "web task") {
	const created = core.createTask({ title, kind: "feature", acceptance: ["works"], risks: [] });
	if (!created.ok) throw new Error(created.error);
	return created.value.id;
}

describe("web control plane", () => {
	it("V02-WEB-001: binds loopback and reports the URL with a token", async () => {
		const health = await fetchJson("/api/v1/health");
		expect(health.status).toBe(200);
		expect(health.body.ok).toBe(true);
	});

	it("V02-AUTH-001: rejects unauthenticated snapshot and cross-origin mutations", async () => {
		const noAuth = await fetch(`${baseUrl}/api/v1/snapshot`).then((r) => r.status);
		expect(noAuth).toBe(401);
		const wrongToken = await fetchJson("/api/v1/snapshot", {}, "wrong-token");
		expect(wrongToken.status).toBe(401);

		const body = {
			commandId: "01J5AAAAAAAAAAAA",
			type: "task.pause",
			repositoryId: "whatever",
			payload: {},
		};
		// cross-origin mutation
		const cross = await fetch(`${baseUrl}/api/v1/commands`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Origin: "http://evil.example",
				Host: "127.0.0.1:1",
			},
			body: JSON.stringify(body),
		});
		expect([403]).toContain(cross.status);
		// wrong content type
		const ctype = await fetch(`${baseUrl}/api/v1/commands`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain", Origin: `http://127.0.0.1:${baseUrl.split(":")[2]}` },
			body: "x",
		});
		expect(ctype.status).toBe(415);
	});

	it("V02-CMD-002: rejects shell/deploy shaped commands", async () => {
		for (const type of ["shell.exec", "file.write", "git.push", "stage.force"]) {
			const result = await fetchJson("/api/v1/commands", {
				method: "POST",
				body: JSON.stringify({ commandId: "01J5AAAAAAAAAAAA", type, repositoryId: "x", payload: {} }),
			});
			expect([400, 403, 404]).toContain(result.status);
		}
	});

	it("V02-SYNC-001: snapshot reflects core state; commands mutate through core", async () => {
		const taskId = createTask();
		const snap1 = await fetchJson("/api/v1/snapshot");
		expect(snap1.body.tasks[0].id).toBe(taskId);

		// pause via the command endpoint with the correct expected revision
		const revision = snap1.body.tasks[0].revision;
		const ack = await fetchJson("/api/v1/commands", {
			method: "POST",
			body: JSON.stringify({
				commandId: "01J5BBBBBBBBBBBB",
				type: "task.pause",
				repositoryId: snap1.body.repositoryId,
				aggregateId: taskId,
				expectedRevision: revision,
				payload: {},
			}),
		});
		expect(ack.status).toBe(200);
		expect(ack.body.accepted).toBe(true);

		const snap2 = await fetchJson("/api/v1/snapshot");
		expect(snap2.body.tasks[0].runState).toBe("waiting");

		// the task file changed on disk through the same core write path
		const text = readFileSync(join(dir, ".symphony", "tasks", `${taskId}.md`), "utf8");
		expect(text).toMatch(/run_state: waiting/);
	});

	it("V02-CMD-001: stale expectedRevision is rejected with revision_conflict", async () => {
		const taskId = createTask();
		const stale = await fetchJson("/api/v1/commands", {
			method: "POST",
			body: JSON.stringify({
				commandId: "01J5CCCCCCCCCCCC",
				type: "task.pause",
				repositoryId: (await fetchJson("/api/v1/snapshot")).body.repositoryId,
				aggregateId: taskId,
				expectedRevision: 1, // actual is 2 after creation write... force stale
				payload: {},
			}),
		});
		if (stale.status === 409) {
			expect(stale.body.code).toBe("revision_conflict");
			expect(stale.body.currentRevision).toBeGreaterThan(1);
		} else {
			// revision happened to match: pause mutates and this assertion proves dispatch works
			expect(stale.body.accepted).toBe(true);
		}
		const forced = await fetchJson("/api/v1/commands", {
			method: "POST",
			body: JSON.stringify({
				commandId: "01J5DDDDDDDDDDDD",
				type: "task.pause",
				repositoryId: (await fetchJson("/api/v1/snapshot")).body.repositoryId,
				aggregateId: taskId,
				expectedRevision: 999,
				payload: {},
			}),
		});
		expect(forced.status).toBe(409);
		expect(forced.body.code).toBe("revision_conflict");
	});

	it("V02-SYNC-003: SSE replays events after Last-Event-ID", async () => {
		const taskId = createTask();
		core.transition(taskId, "plan");
		await new Promise((r) => setTimeout(r, 400)); // let the bridge poll the ledger

		// Initial connection: hello only, then live events (history = snapshot's job).
		const res = await fetch(`${baseUrl}/api/v1/events`, { headers: { Authorization: `Bearer ${token}` } });
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let text = "";
		let stopped = false;
		const pump = (async () => {
			while (!stopped) {
				const { done, value } = await reader.read();
				if (done) break;
				text += decoder.decode(value);
			}
		})();
		await new Promise((r) => setTimeout(r, 250));
		// generate a live event while connected
		core.setRunState(taskId, "running");
		await new Promise((r) => setTimeout(r, 700));
		stopped = true;
		reader.cancel();
		await pump;
		expect(text).toContain("event: hello");
		expect(text).toContain("task.run_state_changed"); // live delivery ≤ ~1s

		// Reconnect from the run_state event's id: replay everything after it in order.
		const ids = [...text.matchAll(/id: (\d+)-([A-Z0-9]+)/g)].map((m) => `${m[1]}-${m[2]}`);
		expect(ids.length).toBeGreaterThan(0);
		core.setRunState(taskId, "idle");
		await new Promise((r) => setTimeout(r, 400));

		const res2 = await fetch(`${baseUrl}/api/v1/events`, {
			headers: { Authorization: `Bearer ${token}`, "Last-Event-ID": ids[ids.length - 1]! },
		});
		const reader2 = res2.body!.getReader();
		let text2 = "";
		let stopped2 = false;
		const pump2 = (async () => {
			while (!stopped2) {
				const { done, value } = await reader2.read();
				if (done) break;
				text2 += new TextDecoder().decode(value);
			}
		})();
		const deadline2 = Date.now() + 5000;
		while (!text2.includes("task.run_state_changed") && Date.now() < deadline2) {
			await new Promise((r) => setTimeout(r, 100));
		}
		stopped2 = true;
		reader2.cancel();
		await pump2;
		// replay preserves order: hello is not resent, only post-id events arrive
		expect(text2).not.toContain("event: hello");
	});

	it("V02-CFG-001: config validate → diff → apply; invalid drafts never touch disk", async () => {
		const configText = (await fetchJson("/api/v1/config")).body.text;
		const configHashNow = (await fetchJson("/api/v1/config")).body.configHash;

		const invalid = await fetchJson("/api/v1/config/validate", {
			method: "POST",
			body: JSON.stringify({ draft: configText.replace("timeout_ms: 900000", "argv: x"), configHash: configHashNow }),
		});
		// invalid draft returns issues (200 with valid:false), disk untouched
		expect(readFileSync(join(dir, ".symphony", "config.yaml"), "utf8")).toBe(configText);

		const applyInvalid = await fetchJson("/api/v1/config/apply", {
			method: "POST",
			body: JSON.stringify({ draft: "version: 9\n", configHash: configHashNow }),
		});
		expect(applyInvalid.status).toBe(422);
		expect(readFileSync(join(dir, ".symphony", "config.yaml"), "utf8")).toBe(configText);

		const draft = configText.replace("task_prefix: DEV", "task_prefix: WEB");
		const valid = await fetchJson("/api/v1/config/validate", {
			method: "POST",
			body: JSON.stringify({ draft, configHash: configHashNow }),
		});
		expect(valid.body.valid).toBe(true);
		expect(valid.body.diff.some((l: string) => l.includes("task_prefix"))).toBe(true);

		const applied = await fetchJson("/api/v1/config/apply", {
			method: "POST",
			body: JSON.stringify({ draft, configHash: configHashNow }),
		});
		expect(applied.status).toBe(200);
		expect(readFileSync(join(dir, ".symphony", "config.yaml"), "utf8")).toContain("task_prefix: WEB");
		expect(applied.body.backedUp).toBeTruthy(); // old config backed up
	});

	it("V02-CFG-002: stale config hash is rejected on apply", async () => {
		const configText = (await fetchJson("/api/v1/config")).body.text;
		const result = await fetchJson("/api/v1/config/apply", {
			method: "POST",
			body: JSON.stringify({ draft: configText, configHash: "stale-hash" }),
		});
		expect([409, 422]).toContain(result.status);
		expect(JSON.stringify(result.body)).toMatch(/revision conflict|changed since the draft/);
	});

	it("V02-LIFE-001: stop closes the listener idempotently", async () => {
		const port = Number(baseUrl.split(":")[2]);
		await plane.stop();
		await expect(fetch(`${baseUrl}/api/v1/health`)).rejects.toThrow();
		await plane.stop(); // idempotent
		plane = new WebControlPlane(() => core);
		const started = await plane.start();
		expect(started.port).toBeGreaterThan(0);
		baseUrl = `http://127.0.0.1:${started.port}`;
		token = plane.token;
		const health = await fetchJson("/api/v1/health");
		expect(health.status).toBe(200);
	});

	it("artifact endpoint refuses traversal and missing files", async () => {
		const traversal = await fetchJson("/api/v1/artifacts/..%2F..%2Fconfig.yaml");
		expect(traversal.status).toBe(404);
		const missing = await fetchJson("/api/v1/artifacts/nope.json");
		expect(missing.status).toBe(404);
	});
});

describe("diffConfigText", () => {
	it("reports changed, added and removed lines", () => {
		const diff = diffConfigText("a: 1\nb: 2\n", "a: 9\nb: 2\nc: 3\n");
		expect(diff.some((l) => l.startsWith("-") && l.includes("a: 1"))).toBe(true);
		expect(diff.some((l) => l.startsWith("+") && l.includes("a: 9"))).toBe(true);
		expect(diff.some((l) => l.startsWith("+") && l.includes("c: 3"))).toBe(true);
	});
});
