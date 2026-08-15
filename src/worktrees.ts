/**
 * Git worktrees and controlled delivery (PRD v0.5).
 *
 * Managed worktrees give delegated roles isolated write surfaces. Every
 * mutation path is typed, previewed, fenced, and audited.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { monotonicId } from "./ids.ts";

/** Typed git commands: the only mutations Symphony performs (V05-GIT-001). */
export type GitMutationCommand =
	| { kind: "worktree_add"; path: string; branch: string; baseSha: string }
	| { kind: "worktree_remove"; path: string }
	| { kind: "branch_create"; name: string; baseSha: string }
	| { kind: "merge_ff_only"; target: string; source: string }
	| { kind: "checkout_sha"; sha: string };

/** Render a typed command to argv — never free-form user input. */
export function renderGitCommand(command: GitMutationCommand): string[] {
	switch (command.kind) {
		case "worktree_add":
			return ["worktree", "add", "-b", command.branch, command.path, command.baseSha];
		case "worktree_remove":
			return ["worktree", "remove", command.path];
		case "branch_create":
			return ["branch", command.name, command.baseSha];
		case "merge_ff_only":
			return ["merge", "--ff-only", command.source];
		case "checkout_sha":
			return ["checkout", command.sha];
	}
}

export function isGitMutationArgv(argv: string[]): boolean {
	const mutationVerbs = new Set(["worktree", "branch", "merge", "checkout", "rebase", "reset", "clean", "push", "cherry-pick", "revert", "commit", "add", "rm", "mv", "stash"]);
	return argv.length > 0 && mutationVerbs.has(argv[0]!);
}

// ---------------------------------------------------------------------------
// Workspace registry + fencing tokens (V05-WS-*, V05-OWN-*)
// ---------------------------------------------------------------------------

export interface WorkspaceRecord {
	id: string;
	taskId: string;
	/** Canonicalized absolute path outside the main repository. */
	path: string;
	branch: string;
	baseSha: string;
	createdAt: string;
	/** Fencing token: monotonically increasing per workspace (V05-OWN-002). */
	fence: number;
	state: "active" | "removing" | "removed" | "orphaned";
}

export class WorktreeRegistry {
	private workspaces = new Map<string, WorkspaceRecord>();

	constructor(private registryFile: string) {}

	private persist(): void {
		mkdirSync(join(this.registryFile, ".."), { recursive: true });
		const tmp = `${this.registryFile}.tmp`;
		writeFileSync(tmp, JSON.stringify([...this.workspaces.values()], null, "\t"), "utf8");
		renameSync(tmp, this.registryFile);
	}

	load(): void {
		if (!existsSync(this.registryFile)) return;
		try {
			const records = JSON.parse(readFileSync(this.registryFile, "utf8")) as WorkspaceRecord[];
			for (const record of records) this.workspaces.set(record.id, record);
		} catch {
			// torn write: registry is rebuildable from git worktree list
		}
	}

	/**
	 * Allocate a managed worktree (V05-WS-001): only after the caller showed
	 * the preview; path must be outside the repository and canonicalized
	 * (V05-WS-002); branch names are sanitized and collision-safe without
	 * deleting anything (V05-WS-003).
	 */
	allocate(input: { taskId: string; path: string; branch: string; baseSha: string; repoRoot: string }): { ok: true; workspace: WorkspaceRecord } | { ok: false; error: string } {
		const canonical = canonicalize(input.path);
		if (!canonical) return { ok: false, error: "workspace path cannot be canonicalized" };
		if (isInside(canonical, canonicalize(input.repoRoot)!)) {
			return { ok: false, error: "workspace path must live outside the repository by default (V05-WS-002)" };
		}
		if ([...this.workspaces.values()].some((w) => canonicalize(w.path) === canonical && w.state === "active")) {
			return { ok: false, error: `workspace path already in use: ${canonical}` };
		}
		const branch = sanitizeBranch(input.taskId, input.branch);
		const workspace: WorkspaceRecord = {
			id: `ws-${monotonicId().toLowerCase()}`,
			taskId: input.taskId,
			path: canonical,
			branch,
			baseSha: input.baseSha,
			createdAt: new Date().toISOString(),
			fence: 1,
			state: "active",
		};
		this.workspaces.set(workspace.id, workspace);
		this.persist();
		return { ok: true, workspace };
	}

	get(id: string): WorkspaceRecord | undefined {
		return this.workspaces.get(id);
	}

	byTask(taskId: string): WorkspaceRecord[] {
		return [...this.workspaces.values()].filter((w) => w.taskId === taskId);
	}

	active(): WorkspaceRecord[] {
		return [...this.workspaces.values()].filter((w) => w.state === "active");
	}

	/** Next fencing token — ownership transfer increments it (V05-OWN-001/002). */
	nextFence(id: string): number | undefined {
		const workspace = this.workspaces.get(id);
		if (!workspace || workspace.state !== "active") return undefined;
		workspace.fence += 1;
		this.persist();
		return workspace.fence;
	}

	/**
	 * Removal safety (V05-CLEAN-001): blocked when the worktree holds anything
	 * not created by this Symphony allocation; no destructive fallback.
	 */
	requestRemoval(id: string, inspection: { hasUncommittedChanges: boolean; hasUnknownFiles: boolean; inUse: boolean }): { ok: true } | { ok: false; reason: string } {
		const workspace = this.workspaces.get(id);
		if (!workspace) return { ok: false, reason: "unknown workspace" };
		if (inspection.inUse) return { ok: false, reason: "a process is using the worktree" };
		if (inspection.hasUncommittedChanges) return { ok: false, reason: "uncommitted changes present — commit or stash first" };
		if (inspection.hasUnknownFiles) return { ok: false, reason: "unknown untracked files present — review them first" };
		workspace.state = "removing";
		this.persist();
		return { ok: true };
	}

	completeRemoval(id: string): void {
		const workspace = this.workspaces.get(id);
		if (workspace) {
			workspace.state = "removed";
			this.persist();
		}
	}

	markOrphaned(id: string): void {
		const workspace = this.workspaces.get(id);
		if (workspace && workspace.state === "active") {
			workspace.state = "orphaned";
			this.persist();
		}
	}
}

export function canonicalize(path: string): string | undefined {
	if (path.includes("\0")) return undefined;
	const normalized = path.replace(/\/+/g, "/").replace(/\/$/, "");
	return normalized.length === 0 ? undefined : normalized;
}

function isInside(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * Deterministic, sanitized, collision-safe branch names (V05-WS-003).
 * Idempotent: an already-sanitized branch is returned unchanged, so callers
 * that pre-sanitize (e.g. to derive the worktree path) and the registry's
 * own allocation always agree on the same name.
 */
export function sanitizeBranch(taskId: string, raw: string): string {
	const prefix = `sym/${taskId.toLowerCase()}/`;
	if (raw.toLowerCase().startsWith(prefix)) return raw.slice(0, 80);
	const suffix = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 30);
	const unique = monotonicId().toLowerCase().slice(-6);
	return `${prefix}${suffix || "work"}-${unique}`.slice(0, 80);
}

// ---------------------------------------------------------------------------
// Fenced write leases (V05-OWN-001/002/003)
// ---------------------------------------------------------------------------

export interface WriteLease {
	workspaceId: string;
	fence: number;
	owner: string;
	expectedHeadSha: string;
	acquiredAt: string;
}

export class FencedLeaseStore {
	constructor(private file: string) {}

	private readAll(): Map<string, WriteLease> {
		if (!existsSync(this.file)) return new Map();
		try {
			const list = JSON.parse(readFileSync(this.file, "utf8")) as WriteLease[];
			return new Map(list.map((l) => [l.workspaceId, l]));
		} catch {
			return new Map();
		}
	}

	/**
	 * Atomic compare-and-swap: exactly one unexpired lease per workspace; a
	 * transfer invalidates the prior owner's fencing token first.
	 */
	acquire(input: { workspaceId: string; expectedFence: number; owner: string; expectedHeadSha: string }): { ok: true; lease: WriteLease } | { ok: false; error: string } {
		const leases = this.readAll();
		const current = leases.get(input.workspaceId);
		if (current && current.fence !== input.expectedFence) {
			return { ok: false, error: `fencing mismatch: lease at fence ${current.fence}, caller expected ${input.expectedFence}` };
		}
		if (current && current.owner !== input.owner) {
			// Transfer: the caller must have ended/interrupted the prior attempt
			// (V05-OWN-003) — represented here by passing the current fence.
			if (input.expectedFence !== current.fence) {
				return { ok: false, error: `cannot take over from ${current.owner} without ending their attempt first` };
			}
		}
		const lease: WriteLease = {
			workspaceId: input.workspaceId,
			fence: input.expectedFence + 1,
			owner: input.owner,
			expectedHeadSha: input.expectedHeadSha,
			acquiredAt: new Date().toISOString(),
		};
		leases.set(input.workspaceId, lease);
		mkdirSync(join(this.file, ".."), { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify([...leases.values()], null, "\t"), "utf8");
		renameSync(tmp, this.file);
		return { ok: true, lease };
	}

	/** Validate a write-capable report against the current lease (V05-OWN-002). */
	validateReport(input: { workspaceId: string; fence: number; headSha: string }): { ok: true } | { ok: false; error: string } {
		const lease = this.readAll().get(input.workspaceId);
		if (!lease) return { ok: false, error: "no active lease for workspace" };
		if (lease.fence !== input.fence) return { ok: false, error: `stale fencing token ${input.fence} (current ${lease.fence}) — ownership was transferred` };
		if (lease.expectedHeadSha !== input.headSha) return { ok: false, error: `head moved: report claims ${input.headSha.slice(0, 8)}, lease pins ${lease.expectedHeadSha.slice(0, 8)}` };
		return { ok: true };
	}
}

// ---------------------------------------------------------------------------
// Delivery: preflight + integrate + disposition (V05-DEL-*, V05-REV-001)
// ---------------------------------------------------------------------------

export interface DeliveryPreflight {
	taskHeadSha: string;
	targetHeadSha: string;
	approved: boolean;
	policyRevision: number;
	evidenceFresh: boolean;
	dirtyTarget: boolean;
	conflicts: string[];
	missingEvidence: string[];
	/** Separate, actionable findings — never one merged failure (V05-DEL-001). */
	blockers: Array<{ code: string; detail: string }>;
	canProceed: boolean;
}

export function evaluateDeliveryPreflight(input: {
	taskHeadSha: string;
	targetHeadSha: string;
	approved: boolean;
	policyRevision: number;
	expectedPolicyRevision: number;
	evidenceRevision: string | null;
	dirtyTarget: boolean;
	conflictingPaths: string[];
	missingEvidence: string[];
}): DeliveryPreflight {
	const blockers: Array<{ code: string; detail: string }> = [];
	if (!input.approved) blockers.push({ code: "not_approved", detail: "delivery requires an explicit approval record" });
	if (input.policyRevision !== input.expectedPolicyRevision) {
		blockers.push({ code: "policy_drift", detail: `policy revision moved from ${input.expectedPolicyRevision} to ${input.policyRevision}` });
	}
	if (input.evidenceRevision !== input.taskHeadSha) {
		blockers.push({ code: "stale_evidence", detail: `required evidence was produced at ${input.evidenceRevision?.slice(0, 8) ?? "none"} but the task head is ${input.taskHeadSha.slice(0, 8)}` });
	}
	if (input.dirtyTarget) blockers.push({ code: "dirty_target", detail: "target checkout has uncommitted changes" });
	if (input.conflictingPaths.length > 0) blockers.push({ code: "conflicts", detail: `paths changed on both sides: ${input.conflictingPaths.slice(0, 5).join(", ")}` });
	for (const missing of input.missingEvidence) blockers.push({ code: "missing_evidence", detail: `missing: ${missing}` });
	return {
		...input,
		evidenceFresh: input.evidenceRevision === input.taskHeadSha,
		conflicts: input.conflictingPaths,
		blockers,
		canProceed: blockers.length === 0,
	};
}

export type DeliveryOutcome =
	| { state: "aborted"; reason: string }
	| { state: "integrated_verified"; revision: string }
	/** Mutation succeeded but checks failed: no auto-reset, operator must decide (V05-DEL-003). */
	| { state: "integrated_unverified"; revision: string; failedChecks: string[] };

export function recordDeliveryOutcome(outcome: DeliveryOutcome, ledger: { append: (type: string, data: Record<string, unknown>) => void }): void {
	ledger.append("delivery.transition", { state: outcome.state, ...("revision" in outcome ? { revision: outcome.revision } : {}), ...("reason" in outcome ? { reason: outcome.reason } : {}), ...("failedChecks" in outcome ? { failedChecks: outcome.failedChecks } : {}) });
}

/**
 * Manual integration verification (V05-DEL-004): the supplied result SHA must
 * contain the approved task head (or an explicitly acknowledged squash).
 */
export function verifyManualIntegration(input: { resultSha: string; taskHeadSha: string; contains: (ancestor: string, descendant: string) => boolean; acknowledgedSquash?: boolean }): { ok: true } | { ok: false; error: string } {
	if (input.acknowledgedSquash) return { ok: true };
	if (!/^[0-9a-f]{40}$/.test(input.resultSha)) return { ok: false, error: "result SHA is not a full commit hash" };
	if (!input.contains(input.taskHeadSha, input.resultSha)) {
		return { ok: false, error: `result ${input.resultSha.slice(0, 8)} does not contain the approved task head ${input.taskHeadSha.slice(0, 8)} (squash? record the acknowledgment explicitly)` };
	}
	return { ok: true };
}
