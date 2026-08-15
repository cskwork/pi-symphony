/**
 * Symphony for Pi — shared domain types (v0.1).
 *
 * These types are UI-independent. All mutations flow through SymphonyCore
 * (src/core.ts); the Pi extension layer is an adapter over this domain.
 */

/** Workflow stages in canonical order. */
export const STAGES = [
	"backlog",
	"plan",
	"build",
	"review",
	"verify",
	"ready",
	"postverify",
	"done",
] as const;
export type Stage = (typeof STAGES)[number];

/** Parked / terminal states that live outside the happy path. */
export const PARKED_STAGES = ["blocked", "cancelled"] as const;
export type ParkedStage = (typeof PARKED_STAGES)[number];

export type TaskStage = Stage | ParkedStage;

export type TaskKind = "feature" | "bug" | "refactor" | "review";

/** Run state is always displayed separately from task stage. */
export const RUN_STATES = ["idle", "running", "waiting", "interrupted"] as const;
export type RunState = (typeof RUN_STATES)[number];

export type AttemptStatus =
	| "pending"
	| "running"
	| "passed"
	| "failed"
	| "interrupted"
	| "cancelled";

export type CheckStatus = "passed" | "failed" | "timeout" | "unavailable" | "stale" | "broken";

export interface AcceptanceCriterion {
	text: string;
}

export interface TaskFrontmatter {
	id: string;
	title: string;
	kind: TaskKind;
	stage: TaskStage;
	/** Optimistic concurrency revision; incremented on every machine write. */
	revision: number;
	createdAt: string;
	updatedAt: string;
	targetBranch?: string;
	/** IDs of acceptance criteria used for AC progress reporting. */
	acceptance: AcceptanceCriterion[];
	risks: string[];
	/** Stage-level run state, distinct from the stage itself. */
	runState: RunState;
	/** Config hash pinned when the current attempt started. */
	pinnedConfigHash?: string;
	/** Revision (git) evidence was last captured against, if any. */
	evidenceRevision?: string;
	/** Human-approved integration record. */
	integration?: IntegrationRecord;
}

export interface IntegrationRecord {
	/** Commit that was integrated into the target branch. */
	revision: string;
	targetBranch: string;
	integratedAt: string;
	actor: string;
	note?: string;
}

/** Machine-managed section identifiers inside a task file. */
export const MANAGED_SECTIONS = [
	"plan",
	"implementation",
	"review",
	"verification",
	"integration",
	"closeout",
] as const;
export type ManagedSection = (typeof MANAGED_SECTIONS)[number];

export interface StageReport {
	/** Which managed section this report belongs to. */
	section: ManagedSection;
	/** Free-form summary written by the role. */
	summary: string;
	/** Structured details (validated per section). */
	details: Record<string, unknown>;
	submittedAt: string;
	/**
	 * Who produced the report. The workflow engine refuses review→verify
	 * unless the review report is `fresh-reviewer` or `manual`.
	 */
	origin: "fresh-reviewer" | "model" | "manual";
}

export interface ApprovalRecord {
	id: string;
	scope: string;
	taskId: string;
	actor: string;
	inputRevision: number;
	/** Aggregate revision of the plan this approval reviewed. */
	planRevision?: number;
	configHash: string;
	approvedAt: string;
}

/** Deterministic gate command definition (executable + argument vector). */
export interface CommandDefinition {
	argv: string[];
	/** Mandatory timeout in milliseconds. */
	timeoutMs: number;
	required?: boolean;
	cwd?: string;
	/** Allowlisted extra environment variables to pass through. */
	envAllowlist?: string[];
	/** Output cap in bytes for persisted/displayed evidence. */
	maxOutputBytes?: number;
}

export interface CheckRunEvidence {
	check: string;
	runId: string;
	status: CheckStatus;
	exitCode: number | null;
	durationMs: number;
	startedAt: string;
	finishedAt: string;
	/** Redacted and truncated output excerpt. */
	output: string;
	truncated: boolean;
	/** Git revision the check ran against. */
	revision: string | null;
	command: string[];
}

/** Typed domain event persisted to the append-only ledger. */
export interface SymphonyEvent {
	eventId: string;
	sequence: number;
	type: string;
	aggregateId: string;
	aggregateRevision: number;
	attemptId?: string;
	emittedAt: string;
	data: Record<string, unknown>;
}

export const EVENT_TYPES = [
	"task.created",
	"task.stage_changed",
	"task.run_state_changed",
	"task.updated",
	"report.submitted",
	"approval.resolved",
	"approval.requested",
	"attempt.started",
	"attempt.completed",
	"attempt.interrupted",
	"check.completed",
	"lease.acquired",
	"lease.released",
	"lease.reclaimed",
	"integration.recorded",
	"recovery.completed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface AttemptRecord {
	id: string;
	taskId: string;
	stage: Stage;
	status: AttemptStatus;
	startedAt: string;
	endedAt?: string;
	/** Retry counter within the stage. */
	tryNumber: number;
	pinnedConfigHash: string;
}

export interface UiPort {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
}

/** Result type for core commands (discriminated on ok). */
export type CommandResult<T = unknown> =
	| { ok: true; value: T; next?: string }
	| { ok: false; error: string; next?: string };
