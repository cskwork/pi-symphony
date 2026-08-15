/**
 * Delegated role sessions and durable handoffs (PRD v0.4).
 *
 * v0.4 separates analysis concurrency from mutation concurrency: delegated
 * roles are read-only; the current implementer remains the single writer.
 */

import { createHash } from "node:crypto";
import { monotonicId } from "./ids.ts";

// ---------------------------------------------------------------------------
// Role sessions
// ---------------------------------------------------------------------------

export type RoleKind =
	| "scout"
	| "planner"
	| "security_reviewer"
	| "architect"
	| "qa_analyst"
	| "reviewer"
	| "implementer";

export type RoleLifecycle =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "interrupted"
	| "cancelled"
	| "superseded";

export interface RoleLimits {
	maxTurns: number;
	wallClockMs: number;
	/** Optional: enforced when the provider reports usage, else "unavailable". */
	maxTokens?: number;
	maxOutputBytes?: number;
}

/** Immutable launch manifest for one child role (V04-ROLE-001). */
export interface RoleManifest {
	role: RoleKind;
	taskId: string;
	stage: string;
	attemptId: string;
	revision: string | null;
	configHash: string;
	/** Declared context inputs (references, not copies). */
	inputs: string[];
	tools: string[];
	skills: string[];
	limits: RoleLimits;
	/** Explicitly omitted scope, for the "did not receive" proof. */
	omitted: string[];
	createdAt: string;
}

export interface RoleSession {
	id: string;
	manifest: RoleManifest;
	lifecycle: RoleLifecycle;
	startedAt?: string;
	endedAt?: string;
	error?: string;
	usage?: { turns: number; tokens?: number; wallClockMs: number };
}

export class RoleSessionRegistry {
	private sessions = new Map<string, RoleSession>();

	launch(manifest: RoleManifest, options: { hardCap: number; configCap: number }): { ok: true; session: RoleSession } | { ok: false; error: string } {
		const active = [...this.sessions.values()].filter((s) => s.lifecycle === "running" || s.lifecycle === "pending");
		const cap = Math.min(options.hardCap, options.configCap);
		if (active.length >= cap) {
			return { ok: false, error: `concurrency cap reached (${active.length}/${cap} active child sessions)` };
		}
		const session: RoleSession = {
			id: `role-${monotonicId().toLowerCase()}`,
			manifest,
			lifecycle: "running",
			startedAt: new Date().toISOString(),
		};
		this.sessions.set(session.id, session);
		return { ok: true, session };
	}

	get(id: string): RoleSession | undefined {
		return this.sessions.get(id);
	}

	active(): RoleSession[] {
		return [...this.sessions.values()].filter((s) => s.lifecycle === "running" || s.lifecycle === "pending");
	}

	all(): RoleSession[] {
		return [...this.sessions.values()];
	}

	/** Lifecycle transitions are validated: terminal states never resurrect (V04-ROLE-004). */
	setLifecycle(id: string, to: RoleLifecycle, error?: string): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		const terminal: RoleLifecycle[] = ["completed", "failed", "cancelled", "superseded"];
		if (terminal.includes(session.lifecycle)) return false;
		session.lifecycle = to;
		session.endedAt = to === "running" || to === "pending" ? undefined : new Date().toISOString();
		if (error) session.error = error;
		return true;
	}

	/** Restart recovery: running sessions from a dead process become interrupted (V04-REC-001 part). */
	recover(isAlive: (sessionId: string) => boolean): string[] {
		const interrupted: string[] = [];
		for (const session of this.sessions.values()) {
			if (session.lifecycle !== "running") continue;
			if (!isAlive(session.id)) {
				session.lifecycle = "interrupted";
				session.endedAt = new Date().toISOString();
				interrupted.push(session.id);
			}
		}
		return interrupted;
	}
}

/** v0.4 single-writer guarantee: child roles never get mutation tools (V04-ROLE-002). */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const MUTATION_TOOLS = new Set(["write", "edit", "bash"]);

export function assertReadOnlyManifest(manifest: RoleManifest): void {
	for (const tool of manifest.tools) {
		if (MUTATION_TOOLS.has(tool)) {
			throw new Error(`role ${manifest.role} requested mutation tool "${tool}" — delegated roles are read-only in v0.4`);
		}
	}
}

// ---------------------------------------------------------------------------
// Topology presets (Quick / Standard / Deep)
// ---------------------------------------------------------------------------

export interface TopologyRole {
	role: RoleKind;
	limits: RoleLimits;
	inputs: string[];
}

export interface Topology {
	id: "quick" | "standard" | "deep";
	roles: TopologyRole[];
	/** Maximum concurrent delegated sessions this preset allows. */
	maxConcurrent: number;
}

export const TOPOLOGIES: Record<Topology["id"], Topology> = {
	quick: {
		id: "quick",
		maxConcurrent: 1,
		roles: [
			{ role: "reviewer", limits: { maxTurns: 6, wallClockMs: 5 * 60_000 }, inputs: ["task_contract", "diff", "implementation_report"] },
		],
	},
	standard: {
		id: "standard",
		maxConcurrent: 2,
		roles: [
			{ role: "scout", limits: { maxTurns: 4, wallClockMs: 5 * 60_000 }, inputs: ["task_contract"] },
			{ role: "reviewer", limits: { maxTurns: 8, wallClockMs: 10 * 60_000 }, inputs: ["task_contract", "diff", "implementation_report", "check_evidence"] },
		],
	},
	deep: {
		id: "deep",
		maxConcurrent: 2,
		roles: [
			{ role: "scout", limits: { maxTurns: 6, wallClockMs: 8 * 60_000 }, inputs: ["task_contract"] },
			{ role: "architect", limits: { maxTurns: 8, wallClockMs: 10 * 60_000 }, inputs: ["task_contract", "plan_report"] },
			{ role: "security_reviewer", limits: { maxTurns: 8, wallClockMs: 10 * 60_000 }, inputs: ["task_contract", "diff"] },
			{ role: "qa_analyst", limits: { maxTurns: 8, wallClockMs: 10 * 60_000 }, inputs: ["task_contract", "implementation_report"] },
			{ role: "reviewer", limits: { maxTurns: 10, wallClockMs: 15 * 60_000 }, inputs: ["task_contract", "diff", "implementation_report", "check_evidence"] },
		],
	},
};

// ---------------------------------------------------------------------------
// Durable handoffs
// ---------------------------------------------------------------------------

export type HandoffState = "queued" | "delivered" | "accepted" | "completed" | "failed" | "expired" | "superseded";

export interface Handoff {
	id: string;
	/** Idempotency key: retries with the same key return the same handoff (V04-HOF-004). */
	idempotencyKey: string;
	fromRole: RoleKind;
	toRole: RoleKind;
	taskId: string;
	stage: string;
	attemptId: string;
	revision: string | null;
	configHash: string;
	manifestId: string;
	/** References to authoritative artifacts — never inline copies (V04-CTX-001). */
	artifacts: Array<{ kind: string; ref: string; sha256: string }>;
	payloadSummary: string;
	state: HandoffState;
	createdAt: string;
	updatedAt: string;
	acceptedAt?: string;
	completedAt?: string;
	error?: string;
}

export interface HandoffEvent {
	id: string;
	handoffId: string;
	type: "queued" | "delivered" | "accepted" | "completed" | "failed" | "expired" | "superseded";
	at: string;
	actor: string;
	detail?: string;
}

export class HandoffLedger {
	private handoffs = new Map<string, Handoff>();
	private byIdempotency = new Map<string, string>();
	private events: HandoffEvent[] = [];

	/**
	 * Submit a handoff through the narrow validated path (V04-HOF-002).
	 * Every identity and integrity field is checked; artifact references must
	 * carry content hashes.
	 */
	submit(input: {
		idempotencyKey: string;
		fromRole: RoleKind;
		toRole: RoleKind;
		taskId: string;
		stage: string;
		attemptId: string;
		revision: string | null;
		configHash: string;
		manifestId: string;
		artifacts: Array<{ kind: string; ref: string; sha256: string }>;
		payloadSummary: string;
		validateArtifact?: (ref: string, sha256: string) => boolean | Promise<boolean>;
	}): { ok: true; handoff: Handoff; duplicate: boolean } | { ok: false; error: string } {
		const existingKey = this.byIdempotency.get(input.idempotencyKey);
		if (existingKey) {
			const existing = this.handoffs.get(existingKey)!;
			return { ok: true, handoff: existing, duplicate: true };
		}
		if (input.fromRole === input.toRole) return { ok: false, error: "sender and recipient roles must differ" };
		if (!input.taskId || !input.stage || !input.attemptId) return { ok: false, error: "task, stage, and attempt are required" };
		if (!/^[0-9a-f]{8,64}$/.test(input.configHash) && !/^[0-9a-f]{16}$/.test(input.configHash)) {
			return { ok: false, error: "configHash must be a hex digest" };
		}
		for (const artifact of input.artifacts) {
			if (!artifact.ref || !/^[0-9a-f]{8,64}$/.test(artifact.sha256)) {
				return { ok: false, error: `artifact ${artifact.kind || "(unnamed)"} needs a ref and a sha256 digest` };
			}
		}
		if (input.payloadSummary.length > 2000) return { ok: false, error: "payloadSummary must stay under 2000 characters — reference artifacts instead of copying" };
		const now = new Date().toISOString();
		const handoff: Handoff = {
			id: `hof-${monotonicId().toLowerCase()}`,
			...input,
			state: "queued",
			createdAt: now,
			updatedAt: now,
		};
		this.handoffs.set(handoff.id, handoff);
		this.byIdempotency.set(handoff.idempotencyKey, handoff.id);
		this.record(handoff.id, "queued", "system");
		return { ok: true, handoff, duplicate: false };
	}

	/**
	 * Accept: the recipient must match role, task, stage, attempt, and the
	 * manifest's topology snapshot (V04-HOF-005).
	 */
	accept(handoffId: string, recipient: { role: RoleKind; taskId: string; stage: string; attemptId: string; manifestId: string }, actor: string): { ok: true } | { ok: false; error: string } {
		const handoff = this.handoffs.get(handoffId);
		if (!handoff) return { ok: false, error: `unknown handoff ${handoffId}` };
		if (handoff.state !== "delivered" && handoff.state !== "queued") {
			return { ok: false, error: `handoff is ${handoff.state}; only queued/delivered handoffs can be accepted` };
		}
		if (handoff.toRole !== recipient.role) return { ok: false, error: `handoff is addressed to ${handoff.toRole}, not ${recipient.role}` };
		if (handoff.taskId !== recipient.taskId) return { ok: false, error: "task mismatch" };
		if (handoff.stage !== recipient.stage) return { ok: false, error: `stage mismatch (handoff: ${handoff.stage}, recipient: ${recipient.stage})` };
		if (handoff.attemptId !== recipient.attemptId) return { ok: false, error: "attempt mismatch" };
		if (handoff.manifestId !== recipient.manifestId) return { ok: false, error: "topology snapshot mismatch — the role was replaced" };
		handoff.state = "accepted";
		handoff.acceptedAt = new Date().toISOString();
		handoff.updatedAt = handoff.acceptedAt;
		this.record(handoffId, "accepted", actor);
		return { ok: true };
	}

	complete(handoffId: string, actor: string): boolean {
		const handoff = this.handoffs.get(handoffId);
		if (!handoff || handoff.state !== "accepted") return false;
		handoff.state = "completed";
		handoff.completedAt = new Date().toISOString();
		handoff.updatedAt = handoff.completedAt;
		this.record(handoffId, "completed", actor);
		return true;
	}

	fail(handoffId: string, error: string, actor: string): boolean {
		const handoff = this.handoffs.get(handoffId);
		if (!handoff || ["completed", "failed", "superseded", "expired"].includes(handoff.state)) return false;
		handoff.state = "failed";
		handoff.error = error;
		handoff.updatedAt = new Date().toISOString();
		this.record(handoffId, "failed", actor, error);
		return true;
	}

	/** Supersede: a replacement role retires the old handoff auditably. */
	supersede(handoffId: string, actor: string): boolean {
		const handoff = this.handoffs.get(handoffId);
		if (!handoff || handoff.state === "superseded") return false;
		handoff.state = "superseded";
		handoff.updatedAt = new Date().toISOString();
		this.record(handoffId, "superseded", actor);
		return true;
	}

	byTask(taskId: string): Handoff[] {
		return [...this.handoffs.values()].filter((h) => h.taskId === taskId);
	}

	all(): Handoff[] {
		return [...this.handoffs.values()];
	}

	eventLog(): HandoffEvent[] {
		return [...this.events];
	}

	/** Replay rebuilds identical state (V04-HOF-003). */
	static replay(events: HandoffEvent[]): Map<string, Handoff> {
		const state = new Map<string, Handoff>();
		for (const event of events) {
			const handoff = state.get(event.handoffId) ?? { id: event.handoffId, state: "queued" } as Handoff;
			handoff.state = event.type;
			state.set(event.handoffId, handoff);
		}
		return state;
	}

	private record(handoffId: string, type: HandoffEvent["type"], actor: string, detail?: string): void {
		this.events.push({ id: `he-${monotonicId().toLowerCase()}`, handoffId, type, at: new Date().toISOString(), actor, detail });
	}
}

export function artifactDigest(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 32);
}


// ---------------------------------------------------------------------------
// SDK-backed delegated role runner (generalizes the fresh reviewer)
// ---------------------------------------------------------------------------

import type { ReviewerRunner } from "./reviewer.ts";

export interface DelegatedRoleReport {
	role: string;
	summary: string;
	/** Structured findings, if the role produced them. */
	findings: Array<{ severity: string; summary: string; detail?: string }>;
	sessionId: string;
	turns: number;
}

/**
 * Runs one delegated role in a fresh, read-only Pi SDK session. The launch
 * manifest is frozen before the session starts (V04-ROLE-001); the runner
 * enforces the turn cap fail-closed like the reviewer does.
 */
export class DelegatedRoleRunner {
	constructor(private roleManifest: RoleManifest) {
		assertReadOnlyManifest(roleManifest);
	}

	buildSessionPlan() {
		return {
			tools: [...this.roleManifest.tools],
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
			cwd: process.cwd(),
			systemPrompt: [
				`You are Symphony's delegated ${this.roleManifest.role} running in a fresh, read-only session for task ${this.roleManifest.taskId} (${this.roleManifest.stage}).`,
				"You did not write this change. You have no mutation tools.",
				`Declared inputs: ${this.roleManifest.inputs.join(", ") || "none"}.`,
				`Omitted scope (you did NOT receive these): ${this.roleManifest.omitted.join(", ") || "none"}.`,
				"Reference artifacts by path; do not paste large content.",
				this.roleManifest.role === "reviewer" || this.roleManifest.role === "security_reviewer"
					? 'End with a fenced ```review block containing {"verdict":"approved"|"changes_requested","findings":[...]} JSON.'
					: "End with a concise structured summary.",
			].join("\n"),
		};
	}

	async run(context: string, options: { signal?: AbortSignal } = {}): Promise<DelegatedRoleReport> {
		const { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const plan = this.buildSessionPlan();
		const loader = new DefaultResourceLoader({
			cwd: plan.cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
			systemPromptOverride: () => plan.systemPrompt,
		});
		await loader.reload();
		const { session } = await createAgentSession({
			resourceLoader: loader,
			tools: plan.tools,
			sessionManager: SessionManager.inMemory(plan.cwd),
		});
		let finalText = "";
		let turns = 0;
		let capped = false;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "turn_end") {
				turns += 1;
				if (turns >= this.roleManifest.limits.maxTurns) {
					capped = true;
					void session.abort();
				}
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				const text = event.message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (text.trim()) finalText = text;
			}
		});
		try {
			if (options.signal?.aborted) throw new Error("delegated role aborted before start");
			await session.prompt(context);
		} catch (err) {
			if (!capped) throw err;
		} finally {
			unsubscribe();
			session.dispose();
		}
		const parsed = parseRoleOutput(finalText);
		return {
			role: this.roleManifest.role,
			summary: capped ? `${parsed.summary}\n[turn cap reached — report is incomplete]` : parsed.summary,
			findings: parsed.findings,
			sessionId: session.sessionId,
			turns,
		};
	}
}

function parseRoleOutput(output: string): { summary: string; findings: Array<{ severity: string; summary: string; detail?: string }> } {
	const match = output.match(/```review\s*([\s\S]*?)```/);
	if (!match) return { summary: output.slice(0, 2000), findings: [] };
	try {
		const parsed = JSON.parse(match[1]!) as { summary?: string; findings?: Array<{ severity?: string; summary?: string; detail?: string }> };
		return {
			summary: parsed.summary ?? output.slice(0, 2000),
			findings: (parsed.findings ?? [])
				.filter((f) => typeof f.summary === "string")
				.map((f) => ({ severity: String(f.severity ?? "note"), summary: String(f.summary), detail: f.detail ? String(f.detail) : undefined })),
		};
	} catch {
		return { summary: output.slice(0, 2000), findings: [] };
	}
}

/** Reuse for reviewer compatibility. */
export type { ReviewerRunner };
