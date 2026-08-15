/**
 * Repository integrations, CI evidence, and observability (PRD v0.8).
 */

// ---------------------------------------------------------------------------
// Adapter contracts (V08-ADP-*)
// ---------------------------------------------------------------------------

export interface AdapterCapabilities {
	provider: string;
	/** Fully declared surface; unsupported calls are rejected, not faked. */
	read: Array<"issue" | "issue_comments" | "pull_request" | "statuses" | "repository">;
	write: Array<"create_issue" | "comment" | "push" | "open_pull_request" | "close_issue">;
	authSource: "env" | "credential_store" | "oauth";
	rateLimit: { requestsPerWindow: number; windowMs: number; cooldownSignal: string };
	errorTaxonomy: Array<"auth_failed" | "not_found" | "rate_limited" | "conflict" | "network" | "server_error">;
}

export function validateAdapterCapabilities(raw: unknown): { ok: true; capabilities: AdapterCapabilities } | { ok: false; issues: string[] } {
	const issues: string[] = [];
	if (typeof raw !== "object" || raw === null) return { ok: false, issues: ["capability descriptor must be an object"] };
	const doc = raw as Record<string, unknown>;
	if (typeof doc["provider"] !== "string" || doc["provider"].length === 0) issues.push("provider is required");
	if (!Array.isArray(doc["read"]) || (doc["read"] as unknown[]).length === 0) issues.push("read capabilities must be a non-empty list");
	if (!Array.isArray(doc["write"])) issues.push("write capabilities must be a list");
	if (!["env", "credential_store", "oauth"].includes(String(doc["authSource"]))) issues.push("authSource must be env|credential_store|oauth");
	const rl = doc["rateLimit"];
	if (typeof rl !== "object" || rl === null || typeof (rl as Record<string, unknown>)["requestsPerWindow"] !== "number") {
		issues.push("rateLimit.requestsPerWindow is required");
	}
	if (issues.length > 0) return { ok: false, issues };
	return { ok: true, capabilities: raw as AdapterCapabilities };
}

/** Adapters return normalized snapshots; they never mutate task state (V08-ADP-002). */
export interface RemoteIssueSnapshot {
	provider: string;
	repository: string;
	issueId: string;
	/** Provenance required for imports (V08-SRC-001). */
	sourceRevision: string | null;
	retrievedAt: string;
	title: string;
	state: "open" | "closed";
	labels: string[];
	/** Field ownership: who wins on concurrent edits. */
	fieldOwnership: Record<string, "local" | "remote">;
}

// ---------------------------------------------------------------------------
// Sync conflict rules (V08-SYNC-*)
// ---------------------------------------------------------------------------

export interface FieldConflict {
	field: string;
	localValue: string;
	remoteValue: string;
	resolution: "manual" | "local_wins" | "remote_wins";
}

/**
 * A remote change to a local-owned or concurrently changed field creates a
 * conflict — it never overwrites local task content (V08-SYNC-001).
 */
export function reconcileFields(local: Record<string, string>, remote: Record<string, string>, ownership: Record<string, "local" | "remote">): { applied: Record<string, string>; conflicts: FieldConflict[] } {
	const applied: Record<string, string> = {};
	const conflicts: FieldConflict[] = [];
	for (const [field, remoteValue] of Object.entries(remote)) {
		const localValue = local[field];
		const owner = ownership[field] ?? "remote";
		if (localValue === undefined) {
			applied[field] = remoteValue;
			continue;
		}
		if (localValue === remoteValue) {
			applied[field] = localValue;
			continue;
		}
		if (owner === "remote" && !changedLocallySinceImport(local, field)) {
			applied[field] = remoteValue;
			continue;
		}
		conflicts.push({ field, localValue, remoteValue, resolution: "manual" });
	}
	for (const [field, value] of Object.entries(local)) {
		if (!(field in applied)) applied[field] = value;
	}
	return { applied, conflicts };
}

function changedLocallySinceImport(local: Record<string, string>, _field: string): boolean {
	// Conservative default: any local value present means it may have been
	// edited locally since import — conflicts are safer than silent loss.
	return true;
}

/**
 * Remote lifecycle changes map to *validated commands*, never direct stage
 * assignment (V08-SYNC-002).
 */
export function mapRemoteLifecycle(label: string): { command: "task.advance" | "task.cancel" | "none"; target?: string } {
	switch (label.toLowerCase()) {
		case "in progress": return { command: "task.advance", target: "build" };
		case "in review": return { command: "task.advance", target: "review" };
		case "blocked": return { command: "none" };
		case "wontfix": return { command: "task.cancel" };
		default: return { command: "none" }; // unknown labels can never jump stages
	}
}

// ---------------------------------------------------------------------------
// Outbound operations (V08-OUT-*, V08-PR-001)
// ---------------------------------------------------------------------------

export interface OutboundOperation {
	kind: "push" | "open_pull_request" | "comment" | "close_issue";
	/** Idempotency: the same key must produce one remote effect (V08-OUT-001). */
	idempotencyKey: string;
	actor: string;
	approvalId: string;
	payload: Record<string, unknown>;
}

export class OutboundQueue {
	private executed = new Map<string, { receipt: Record<string, unknown>; at: string }>();
	/** In-flight executions, reserved synchronously so concurrent callers with
	 * the same key share one transport call (exactly one remote effect). */
	private inflight = new Map<string, Promise<{ ok: true; receipt: Record<string, unknown>; replayed: boolean } | { ok: false; error: string }>>();

	/** Executes each key exactly once; lost-response retries replay the receipt. */
	execute(operation: OutboundOperation, transport: (op: OutboundOperation) => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<{ ok: true; receipt: Record<string, unknown>; replayed: boolean } | { ok: false; error: string }> {
		const prior = this.executed.get(operation.idempotencyKey);
		if (prior) return Promise.resolve({ ok: true, receipt: prior.receipt, replayed: true });
		const pending = this.inflight.get(operation.idempotencyKey);
		if (pending) return pending;
		const execution = (async () => {
			try {
				const receipt = await transport(operation);
				this.executed.set(operation.idempotencyKey, { receipt, at: new Date().toISOString() });
				return { ok: true as const, receipt, replayed: false };
			} finally {
				this.inflight.delete(operation.idempotencyKey);
			}
		})();
		this.inflight.set(operation.idempotencyKey, execution);
		return execution;
	}

	receipts(): Array<{ key: string; receipt: Record<string, unknown>; at: string }> {
		return [...this.executed.entries()].map(([key, value]) => ({ key, ...value }));
	}
}

/**
 * Push preflight (V08-OUT-002): verify remote identity, branch policy, local
 * head, and non-force mode immediately before execution.
 */
export function pushPreflight(input: { remote: string; expectedRemote: string; branch: string; allowedBranches: string[]; localHead: string; remoteHead: string; force: boolean }): { ok: true } | { ok: false; error: string } {
	if (input.remote !== input.expectedRemote) return { ok: false, error: `remote mismatch: ${input.remote} ≠ ${input.expectedRemote}` };
	if (!input.allowedBranches.includes(input.branch)) return { ok: false, error: `branch "${input.branch}" is not push-allowed` };
	if (input.force) return { ok: false, error: "force push is never authorized by Symphony" };
	if (input.remoteHead !== input.localHead && !isAncestorLike(input.remoteHead)) {
		return { ok: false, error: `remote diverged (remote ${input.remoteHead.slice(0, 8)}) — fetch/merge first; refusing to overwrite` };
	}
	return { ok: true };
}

function isAncestorLike(_sha: string): boolean {
	// The caller supplies real ancestry data in production; here any remote
	// head equal to local is a fast-forward, divergence aborts.
	return false;
}

/**
 * PR linkage (V08-PR-001): the PR's head SHA defines evidence currency.
 */
export function linkPullRequest(input: { prNumber: number; base: string; headBranch: string; headSha: string }): { prNumber: number; base: string; headBranch: string; headSha: string; linkedAt: string } {
	return { ...input, linkedAt: new Date().toISOString() };
}

export function pullRequestEvidenceFresh(linked: { headSha: string }, evidence: { subjectSha: string }): boolean {
	return linked.headSha === evidence.subjectSha;
}

// ---------------------------------------------------------------------------
// CI evidence gating (V08-CI-*)
// ---------------------------------------------------------------------------

export interface CiEvidence {
	provider: string;
	context: string;
	subjectSha: string;
	state: "success" | "failure" | "pending";
	completedAt: string;
	/** Local deterministic checks vs remote CI stay distinct categories. */
	category: "local" | "remote";
}

/**
 * CI acceptance (V08-CI-001): subject SHA must match the expected head and
 * every required context must be unambiguously present.
 */
export function acceptCiEvidence(evidence: CiEvidence[], expectedHeadSha: string, requiredContexts: string[]): { ok: true } | { ok: false; reasons: string[] } {
	const reasons: string[] = [];
	for (const context of requiredContexts) {
		const matching = evidence.filter((e) => e.context === context);
		if (matching.length === 0) {
			reasons.push(`required CI context "${context}" is missing`);
			continue;
		}
		if (matching.length > 1) reasons.push(`ambiguous context "${context}": ${matching.length} providers report it`);
		for (const item of matching) {
			if (item.subjectSha !== expectedHeadSha) reasons.push(`context "${context}" ran against ${item.subjectSha.slice(0, 8)}, expected ${expectedHeadSha.slice(0, 8)}`);
			if (item.state !== "success") reasons.push(`context "${context}" is ${item.state}`);
		}
	}
	return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Polling with rate-limit awareness (V08-POLL-001)
// ---------------------------------------------------------------------------

export class PollBudget {
	private used = 0;
	private cooldownUntil = 0;

	constructor(private limit: number, private windowMs: number, private jitter = 0.2) {}

	/** Returns delay before the next poll, or null when on cooldown. */
	nextRequestAt(now: number): number | null {
		if (now < this.cooldownUntil) return this.cooldownUntil - now;
		if (this.used >= this.limit) return null; // window exhausted
		this.used += 1;
		const jitterFactor = 1 + (Math.random() * 2 - 1) * this.jitter;
		return Math.max(0, (this.windowMs / this.limit) * jitterFactor);
	}

	/** Provider signaled a cooldown (rate-limit header/retry-after). */
	cooldown(now: number, ms: number): void {
		this.cooldownUntil = Math.max(this.cooldownUntil, now + ms);
	}

	reset(): void {
		this.used = 0;
	}
}

// ---------------------------------------------------------------------------
// Observability (V08-OBS-*)
// ---------------------------------------------------------------------------

export type UsageProvenance = "provider_reported" | "estimated" | "unavailable";

export interface UsageMetric {
	provenance: UsageProvenance;
	/** Undefined when unavailable — never zero (V08-OBS-002). */
	tokens?: number;
}

export interface ExportPolicy {
	/** Default: operational metadata only (V08-OBS-001). */
	includeTaskBodies: boolean;
	includeDiffs: boolean;
	includeCommandOutput: boolean;
	includePrompts: boolean;
}

export const DEFAULT_EXPORT_POLICY: ExportPolicy = {
	includeTaskBodies: false,
	includeDiffs: false,
	includeCommandOutput: false,
	includePrompts: false,
};

export function buildExportSnapshot(input: { policy?: ExportPolicy; tasks: Array<{ id: string; title: string; stage: string; body?: string }>; events: Array<{ type: string; data: Record<string, unknown> }>; usage: UsageMetric[] }): Record<string, unknown> {
	const policy = input.policy ?? DEFAULT_EXPORT_POLICY;
	return {
		generatedAt: new Date().toISOString(),
		tasks: input.tasks.map((t) => ({
			id: t.id,
			title: t.title,
			stage: t.stage,
			...(policy.includeTaskBodies ? { body: t.body } : {}),
		})),
		events: input.events.map((e) => ({
			type: e.type,
			...(policy.includeCommandOutput ? { data: e.data } : {}),
		})),
		usage: input.usage.map((u) => ({
			provenance: u.provenance,
			tokens: u.tokens ?? null, // null = unavailable, distinct from 0
		})),
		policy,
	};
}

/** Redaction applied to every credential-bearing surface (V08-AUTH-001). */
export function redactIntegrationSecrets(text: string): string {
	return text
		.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]")
		.replace(/glpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED:gitlab-token]")
		.replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]")
		.replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [REDACTED]")
		.replace(/\b[A-Za-z0-9_-]*(token|secret|password|api[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

// ---------------------------------------------------------------------------
// Audit correlation (V08-AUD-001)
// ---------------------------------------------------------------------------

export interface AuditRecord {
	at: string;
	actor: string;
	kind: "local_command" | "approval" | "remote_operation" | "provider_receipt" | "workflow_event";
	/** Correlates one delivery timeline end-to-end. */
	correlationId: string;
	detail: Record<string, unknown>;
}

export function correlateAudit(records: AuditRecord[]): Map<string, AuditRecord[]> {
	const byCorrelation = new Map<string, AuditRecord[]>();
	for (const record of records) {
		const list = byCorrelation.get(record.correlationId) ?? [];
		list.push(record);
		byCorrelation.set(record.correlationId, list);
	}
	for (const list of byCorrelation.values()) list.sort((a, b) => (a.at < b.at ? -1 : 1));
	return byCorrelation;
}
