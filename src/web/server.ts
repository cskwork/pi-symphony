import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SymphonyCore } from "../core.ts";
import { configHash, loadConfigFromText } from "../config.ts";
import { backupFile } from "../tasks.ts";
import { buildSnapshot, EventBridge } from "./store.ts";
import {
	assertLoopbackHost,
	MAX_ARTIFACT_BYTES,
	MAX_COMMAND_BODY_BYTES,
	replayWindow,
	SNAPSHOT_REQUIRED,
	validateCommandEnvelope,
	validateMutatingRequest,
	type CommandAck,
	type CommandRejection,
} from "./protocol.ts";

/**
 * Loopback control-plane server (PRD v0.2).
 *
 * Contains no business rules: it authenticates, validates envelopes,
 * forwards commands to SymphonyCore, and renders immutable projections.
 * Every mutation goes through the same core command handlers as the TUI.
 */
export class WebControlPlane {
	private server?: Server;
	private bridge?: EventBridge;
	readonly token = randomBytes(24).toString("base64url");
	private audit: Array<{ at: string; commandId?: string; type: string; result: string; detail?: string }> = [];

	constructor(
		private coreFactory: () => SymphonyCore,
		private options: { host?: string } = {},
	) {}

	get core(): SymphonyCore {
		return this.coreFactory();
	}

	async start(): Promise<{ port: number; host: string; url: string }> {
		const host = this.options.host ?? "127.0.0.1";
		const loopback = assertLoopbackHost(host);
		if (!loopback.ok) throw new Error(loopback.reason);
		if (!this.bridge) {
			this.bridge = new EventBridge(this.coreFactory, join(this.core.deps.repoRoot, ".symphony", "runtime", "events"));
			this.bridge.start();
		}
		const server = createServer((req, res) => this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, host, () => resolve());
		});
		this.server = server;
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		return { port, host, url: `http://${host}:${port}/#token=${this.token}` };
	}

	async stop(): Promise<void> {
		this.bridge?.stop();
		this.bridge = undefined;
		const server = this.server;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		// force-destroy kept-alive sockets so close() resolves promptly
		server.closeAllConnections?.();
		this.server = undefined;
	}

	get auditLog(): typeof this.audit {
		return this.audit;
	}

	private expectedHost(): string {
		const address = this.server?.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		return `127.0.0.1:${port}`;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const path = url.pathname;
			if (req.method === "GET" && (path === "/" || path === "/index.html" || path === "/app.js" || path === "/app.css")) {
				return this.serveStatic(path, res);
			}
			if (path === "/api/v1/health" && req.method === "GET") {
				return this.json(res, 200, { ok: true, projectionVersion: this.bridge?.getProjectionVersion() ?? 0 });
			}
			// Everything else requires the session credential.
			const auth = `Bearer ${this.token}`;
			if (req.headers.authorization !== auth) {
				return this.json(res, 401, { error: "unauthorized" });
			}
			if (path === "/api/v1/snapshot" && req.method === "GET") {
				const snapshot = buildSnapshot(this.core, this.bridge!, this.repositoryId());
				snapshot.configHash = configHash(this.core.config);
				return this.json(res, 200, snapshot);
			}
			if (path === "/api/v1/events" && req.method === "GET") {
				return this.sse(req, res, url);
			}
			if (path === "/api/v1/config" && req.method === "GET") {
				const text = existsSync(this.core.paths.config) ? readFileSync(this.core.paths.config, "utf8") : "";
				return this.json(res, 200, { text, configHash: configHash(this.core.config), valid: this.core.configIssues.length === 0, issues: this.core.configIssues });
			}
			if (path === "/api/v1/commands" && req.method === "POST") {
				return this.command(req, res);
			}
			if (path === "/api/v1/config/validate" && req.method === "POST") {
				return this.configValidate(req, res);
			}
			if (path === "/api/v1/config/apply" && req.method === "POST") {
				return this.configApply(req, res);
			}
			if (path.startsWith("/api/v1/artifacts/") && req.method === "GET") {
				return this.artifact(path, res);
			}
			return this.json(res, 404, { error: "not_found" });
		} catch (err) {
			this.audit.push({ at: new Date().toISOString(), type: "request_error", result: "internal_error", detail: (err as Error).message });
			return this.json(res, 500, { error: "internal_error" });
		}
	}

	private repositoryId(): string {
		return `repo-${createHash("sha256").update(this.core.deps.repoRoot).digest("hex").slice(0, 8)}`;
	}

	private serveStatic(path: string, res: ServerResponse): void {
		const here = dirname(fileURLToPath(import.meta.url));
		const files: Record<string, { file: string; type: string }> = {
			"/": { file: "spa/index.html", type: "text/html; charset=utf-8" },
			"/index.html": { file: "spa/index.html", type: "text/html; charset=utf-8" },
			"/app.js": { file: "spa/app.js", type: "text/javascript; charset=utf-8" },
			"/app.css": { file: "spa/app.css", type: "text/css; charset=utf-8" },
		};
		const entry = files[path];
		if (!entry) return void this.json(res, 404, { error: "not_found" });
		try {
			const body = readFileSync(join(here, entry.file));
			res.writeHead(200, {
				"content-type": entry.type,
				"content-security-policy":
					"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
				"cache-control": "no-store",
			});
			res.end(body);
		} catch {
			this.json(res, 500, { error: "asset_missing" });
		}
	}

	private json(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	}

	private async readBody(req: IncomingMessage, limit: number): Promise<{ ok: true; text: string } | { ok: false; status: number; reason: string }> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > limit) return { ok: false, status: 413, reason: "payload too large" };
			chunks.push(chunk as Buffer);
		}
		return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
	}

	private async command(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const guard = validateMutatingRequest(
			{
				host: req.headers.host,
				origin: req.headers.origin,
				authorization: req.headers.authorization,
				contentType: req.headers["content-type"],
			},
			{ expectedHost: this.expectedHost(), expectedOrigin: `http://${this.expectedHost()}`, token: this.token },
		);
		if (!guard.ok) {
			this.audit.push({ at: new Date().toISOString(), type: "command", result: `rejected_${guard.status}` });
			return this.json(res, guard.status, { error: guard.reason });
		}
		const body = await this.readBody(req, MAX_COMMAND_BODY_BYTES);
		if (!body.ok) return this.json(res, body.status, { error: body.reason });
		let parsed: unknown;
		try {
			parsed = JSON.parse(body.text);
		} catch {
			return this.json(res, 400, { error: "bad_json" });
		}
		const envelope = validateCommandEnvelope(parsed);
		if (!envelope.ok) {
			this.audit.push({ at: new Date().toISOString(), type: "command", result: `rejected_${envelope.rejection.code}` });
			return this.json(res, this.statusFor(envelope.rejection.code), envelope.rejection);
		}
		const result = await this.dispatch(envelope.envelope);
		this.audit.push({
			at: new Date().toISOString(),
			commandId: envelope.envelope.commandId,
			type: envelope.envelope.type,
			result: result.accepted ? "accepted" : `rejected_${result.code}`,
			detail: "detail" in result ? String((result as { detail?: string }).detail ?? (result as { reason?: string }).reason ?? "") : undefined,
		});
		return this.json(res, result.accepted ? 200 : this.statusFor(result.code), result);
	}

	private statusFor(code: string): number {
		switch (code) {
			case "unauthorized": return 401;
			case "bad_request": return 400;
			case "unknown_command": return 400;
			case "unknown_repository":
			case "unknown_aggregate": return 404;
			case "revision_conflict": return 409;
			case "policy_violation": return 422;
			case "config_invalid": return 422;
			default: return 500;
		}
	}

	private async dispatch(envelope: import("./protocol.ts").CommandEnvelope): Promise<CommandAck | CommandRejection> {
		if (envelope.repositoryId !== this.repositoryId()) {
			return { accepted: false, code: "unknown_repository" };
		}
		const core = this.core;
		if (envelope.aggregateId) {
			const task = core.getTask(envelope.aggregateId);
			if (!task.ok) return { accepted: false, code: "unknown_aggregate" };
			if (envelope.expectedRevision !== undefined && task.value.frontmatter.revision !== envelope.expectedRevision) {
				return { accepted: false, code: "revision_conflict", currentRevision: task.value.frontmatter.revision };
			}
		}
		const payload = envelope.payload as Record<string, string | undefined>;
		switch (envelope.type) {
			case "task.create": {
				const created = core.createTask({
					title: String(payload.title ?? ""),
					kind: (typeof payload.kind === "string" && ["feature", "bug", "refactor", "review"].includes(payload.kind) ? payload.kind : "feature") as "feature",
					acceptance: Array.isArray(payload.acceptance) ? (payload.acceptance as unknown[]).map(String) : [],
					risks: Array.isArray(payload.risks) ? (payload.risks as unknown[]).map(String) : [],
				});
				return created.ok
					? { accepted: true, commandId: envelope.commandId, aggregateId: created.value.id, resultingRevision: core.getTask(created.value.id).ok ? 1 : undefined, next: created.next }
					: this.toRejection(created.error);
			}
			case "task.pause":
			case "task.resume": {
				const to = envelope.type === "task.pause" ? "waiting" : "idle";
				const result = core.setRunState(String(envelope.aggregateId), to as "waiting");
				return result.ok ? { accepted: true, commandId: envelope.commandId } : this.toRejection(result.error);
			}
			case "task.cancel": {
				const result = core.transition(String(envelope.aggregateId), "cancelled");
				return result.ok ? { accepted: true, commandId: envelope.commandId, resultingRevision: result.value.stage === "cancelled" ? undefined : undefined } : this.toRejection(result.error);
			}
			case "task.approve_plan": {
				const result = core.resolveApproval({ taskId: String(envelope.aggregateId), scope: "plan", actor: "browser", approved: true });
				return result.ok ? { accepted: true, commandId: envelope.commandId, next: result.next } : this.toRejection(result.error);
			}
			case "task.reject_plan": {
				const result = core.resolveApproval({ taskId: String(envelope.aggregateId), scope: "plan", actor: "browser", approved: false });
				return result.ok ? { accepted: true, commandId: envelope.commandId } : this.toRejection(result.error);
			}
			case "checks.run": {
				const set = payload.set === "postIntegration" ? "postIntegration" : "verify";
				const result = await core.runCheckSet(String(envelope.aggregateId), set);
				return result.ok ? { accepted: true, commandId: envelope.commandId } : this.toRejection(result.error);
			}
			case "task.advance": {
				const target = String(payload.to ?? "");
				const result = core.transition(String(envelope.aggregateId), target as "build");
				return result.ok ? { accepted: true, commandId: envelope.commandId, next: result.next } : this.toRejection(result.error);
			}
			case "task.record_integration": {
				const result = await core.recordIntegration({
					taskId: String(envelope.aggregateId),
					revision: String(payload.revision ?? ""),
					actor: "browser",
					note: payload.note ? String(payload.note) : undefined,
				});
				return result.ok ? { accepted: true, commandId: envelope.commandId, next: result.next } : this.toRejection(result.error);
			}
			case "task.complete": {
				const result = await core.completeTask({ taskId: String(envelope.aggregateId) });
				return result.ok ? { accepted: true, commandId: envelope.commandId, next: result.next } : this.toRejection(result.error);
			}
			case "task.continue":
			case "task.retry":
			case "report.submit":
				// These require a Pi session (briefs, reviewer runs, model reports).
				// The browser cannot perform them; the TUI stays the actor.
				return { accepted: false, code: "policy_violation", reason: `${envelope.type} requires the Pi session surface; run /sym continue in Pi` };
			default:
				return { accepted: false, code: "unknown_command" };
		}
	}

	private toRejection(error: string): CommandRejection {
		if (/configuration is invalid/.test(error)) {
			return { accepted: false, code: "config_invalid", issues: [{ path: "$", message: error }] };
		}
		if (/invalid transition|blocked:|cannot reach|Cannot complete|rejected:/.test(error)) {
			return { accepted: false, code: "policy_violation", reason: error };
		}
		return { accepted: false, code: "internal_error", detail: error };
	}

	private sse(req: IncomingMessage, res: ServerResponse, url: URL): void {
		const bridge = this.bridge!;
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		const lastEventHeader = req.headers["last-event-id"] ?? url.searchParams.get("lastEventId");
		const lastEventId = typeof lastEventHeader === "string" ? lastEventHeader : null;
		const retained = bridge.retained();
		if (lastEventId === null) {
			res.write(`event: hello\ndata: ${JSON.stringify({ lastEventSequence: retained.length > 0 ? retained[retained.length - 1]!.sequence : 0 })}\n\n`);
		} else {
			const lastIdx = retained.findIndex((e) => e.eventId === lastEventId);
			const lastSeq = lastIdx >= 0 ? retained[lastIdx]!.sequence : Number(lastEventId.split("-")[0] ?? 0);
			const decision = replayWindow(retained, Number.isFinite(lastSeq) ? lastSeq : 0, Infinity);
			if (decision.kind === "snapshot_required") {
				res.write(`event: ${SNAPSHOT_REQUIRED}\ndata: {}\n\n`);
				res.end();
				return;
			}
			for (const event of decision.events) {
				res.write(`id: ${event.sequence}-${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			}
		}
		const unsubscribe = bridge.subscribe((event) => {
			res.write(`id: ${event.sequence}-${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		});
		const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15_000);
		heartbeat.unref?.();
		req.on("close", () => {
			unsubscribe();
			clearInterval(heartbeat);
		});
	}

	private async configValidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const guard = validateMutatingRequest(
			{
				host: req.headers.host,
				origin: req.headers.origin,
				authorization: req.headers.authorization,
				contentType: req.headers["content-type"],
			},
			{ expectedHost: this.expectedHost(), expectedOrigin: `http://${this.expectedHost()}`, token: this.token },
		);
		if (!guard.ok) return this.json(res, guard.status, { error: guard.reason });
		const body = await this.readBody(req, MAX_COMMAND_BODY_BYTES);
		if (!body.ok) return this.json(res, body.status, { error: body.reason });
		const parsed = JSON.parse(body.text) as { draft?: string; configHash?: string };
		const currentHash = configHash(this.core.config);
		if (parsed.configHash !== currentHash) {
			return this.json(res, 409, { error: "revision_conflict", currentConfigHash: currentHash });
		}
		const validation = loadConfigFromText(parsed.draft ?? "");
		return this.json(res, 200, {
			valid: validation.issues.length === 0,
			issues: validation.issues,
			diff: diffConfigText(readFileSync(this.core.paths.config, "utf8"), parsed.draft ?? ""),
		});
	}

	private async configApply(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const guard = validateMutatingRequest(
			{
				host: req.headers.host,
				origin: req.headers.origin,
				authorization: req.headers.authorization,
				contentType: req.headers["content-type"],
			},
			{ expectedHost: this.expectedHost(), expectedOrigin: `http://${this.expectedHost()}`, token: this.token },
		);
		if (!guard.ok) return this.json(res, guard.status, { error: guard.reason });
		const body = await this.readBody(req, MAX_COMMAND_BODY_BYTES);
		if (!body.ok) return this.json(res, body.status, { error: body.reason });
		const parsed = JSON.parse(body.text) as { draft?: string; configHash?: string };
		if (parsed.configHash !== undefined && parsed.configHash !== configHash(this.core.config)) {
			return this.json(res, 409, { error: "revision_conflict", currentConfigHash: configHash(this.core.config) });
		}
		const validation = loadConfigFromText(parsed.draft ?? "");
		if (validation.issues.length > 0) {
			return this.json(res, 422, { error: "config_invalid", issues: validation.issues });
		}
		const core = this.coreFactory(); // fresh core so the applied config reloads
		const backedUp = backupFile(core.paths.config);
		const { writeFileSync, mkdirSync, renameSync } = await import("node:fs");
		const tmp = `${core.paths.config}.tmp`;
		mkdirSync(dirname(core.paths.config), { recursive: true });
		writeFileSync(tmp, parsed.draft ?? "", "utf8");
		renameSync(tmp, core.paths.config);
		this.bridge?.publish({
			eventId: `cfg-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
			sequence: (this.bridge?.retained().slice(-1)[0]?.sequence ?? 0) + 1,
			type: "config.applied",
			aggregateId: "config",
			aggregateRevision: 0,
			emittedAt: new Date().toISOString(),
			data: { backedUp: backedUp ?? null, hash: configHash(validation.config!) },
		});
		this.audit.push({ at: new Date().toISOString(), type: "config.apply", result: "accepted" });
		return this.json(res, 200, { applied: true, backedUp: backedUp ?? null });
	}

	private artifact(path: string, res: ServerResponse): void {
		const id = decodeURIComponent(path.replace("/api/v1/artifacts/", ""));
		// Only evidence artifacts under .symphony/evidence, no traversal.
		const root = join(this.core.deps.repoRoot, ".symphony", "evidence");
		const target = join(root, id);
		if (!target.startsWith(root) || target.includes("..") || !existsSync(target) || !statSync(target).isFile()) {
			return this.json(res, 404, { error: "not_found" });
		}
		const size = statSync(target).size;
		if (size > MAX_ARTIFACT_BYTES) {
			return this.json(res, 413, { error: "artifact_too_large", size });
		}
		const body = readFileSync(target, "utf8");
		// Redact before transport (V02-LOG-001): reuse the core redactor.
		return this.json(res, 200, { artifact: id, size, content: redactJsonText(body) });
	}
}

function redactJsonText(text: string): string {
	// The evidence writer already redacts output fields; scrub any remaining
	// credential-shaped strings defensively for transport.
	return text
		.replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
		.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]")
		.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]");
}

/** Minimal line-diff for the configuration editor review step. */
export function diffConfigText(before: string, after: string): string[] {
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");
	const output: string[] = [];
	for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
		const a = beforeLines[i] ?? "";
		const b = afterLines[i] ?? "";
		if (a === b) continue;
		if (a && !b) output.push(`- ${i + 1}: ${a.trim()}`);
		else if (!a && b) output.push(`+ ${i + 1}: ${b.trim()}`);
		else {
			output.push(`- ${i + 1}: ${a.trim()}`);
			output.push(`+ ${i + 1}: ${b.trim()}`);
		}
	}
	return output;
}
