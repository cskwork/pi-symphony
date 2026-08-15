import type { SymphonyConfig } from "./config.ts";
import type { CheckRunEvidence, Stage, TaskStage } from "./types.ts";

/**
 * Default software-dev workflow graph (PRD v0.1):
 * backlog → plan → build → review → verify → ready
 *         → (manual integration) → postverify → done
 * blocked / cancelled are parked states reachable from any active stage.
 */
export const TRANSITIONS: Readonly<Record<TaskStage, readonly TaskStage[]>> = {
	backlog: ["plan", "cancelled"],
	plan: ["build", "blocked", "cancelled"],
	build: ["review", "plan", "blocked", "cancelled"],
	review: ["verify", "build", "blocked", "cancelled"],
	verify: ["ready", "build", "blocked", "cancelled"],
	ready: ["postverify", "blocked", "cancelled"],
	postverify: ["done", "ready", "blocked", "cancelled"],
	done: [],
	blocked: ["plan", "build", "review", "verify", "ready", "cancelled"],
	cancelled: [],
};

export interface TransitionCheck {
	/** Evidence required by the target stage gate. */
	requiresReports?: Array<"plan" | "implementation" | "review">;
	requiresApproval?: "plan";
	/** Required checks that must be freshly passed. */
	requiresChecks?: "verify" | "postIntegration";
}

export const TRANSITION_CONTRACTS: Readonly<Record<string, TransitionCheck>> = {
	"backlog→plan": {},
	"plan→build": { requiresReports: ["plan"], requiresApproval: "plan" },
	"build→review": { requiresReports: ["plan", "implementation"] },
	"review→verify": { requiresReports: ["plan", "implementation", "review"] },
	"verify→ready": { requiresReports: ["implementation"], requiresChecks: "verify" },
	"ready→postverify": {},
	"postverify→done": { requiresChecks: "postIntegration" },
};

export class WorkflowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowError";
	}
}

export function assertTransition(from: TaskStage, to: TaskStage): void {
	const allowed = TRANSITIONS[from];
	if (!allowed || !allowed.includes(to as Stage)) {
		throw new WorkflowError(`invalid transition ${from} → ${to}`);
	}
}

export interface EvidenceBundle {
	hasReport: (section: "plan" | "implementation" | "review") => boolean;
	planApproved: boolean;
	/** Latest run per required check name. */
	checks: Map<string, CheckRunEvidence>;
	/** Revision checks were last run against. */
	checksRevision: string | null;
	currentRevision: string | null;
	/** Declared risks, used by approval policy evaluation. */
	risks: string[];
}

/** Gate evaluation: deterministic evidence only; model reports cannot override. */
export function evaluateGate(
	from: TaskStage,
	to: TaskStage,
	evidence: EvidenceBundle,
	config: SymphonyConfig,
): { ok: true } | { ok: false; reason: string } {
	try {
		assertTransition(from, to);
	} catch (err) {
		return { ok: false, reason: (err as Error).message };
	}
	const contract = TRANSITION_CONTRACTS[`${from}→${to}`];
	if (!contract) return { ok: true };

	for (const section of contract.requiresReports ?? []) {
		if (!evidence.hasReport(section)) {
			return { ok: false, reason: `${to} requires a submitted ${section} report` };
		}
	}
	if (contract.requiresApproval === "plan" && needsPlanApproval(config, evidence)) {
		if (!evidence.planApproved) {
			return { ok: false, reason: "plan approval is required before build" };
		}
	}
	if (contract.requiresChecks) {
		const required = contract.requiresChecks === "verify" ? config.checks.verify : config.checks.postIntegration;
		for (const name of required) {
			const run = evidence.checks.get(name);
			if (!run) return { ok: false, reason: `required check "${name}" has not run` };
			if (run.status !== "passed") {
				return { ok: false, reason: `required check "${name}" is ${run.status}` };
			}
			if (evidence.currentRevision !== null && run.revision !== null && run.revision !== evidence.currentRevision) {
				return { ok: false, reason: `required check "${name}" is stale (ran against ${run.revision ?? "unknown"})` };
			}
		}
	}
	return { ok: true };
}

/** risks_only approval policy: approval required only when risks are declared. */
export function needsPlanApproval(config: SymphonyConfig, evidence: { risks: string[] }): boolean {
	if (config.workflow.planApproval === "always") return true;
	if (config.workflow.planApproval === "never") return false;
	return evidence.risks.length > 0;
}

/** Next suggested action for /sym continue. */
export function nextAction(
	stage: TaskStage,
	evidence: EvidenceBundle,
	config: SymphonyConfig,
): { action: string; detail: string } {
	const order: Array<[TaskStage, Stage]> = [
		["backlog", "plan"],
		["plan", "build"],
		["build", "review"],
		["review", "verify"],
		["verify", "ready"],
	];
	for (const [from, to] of order) {
		if (stage !== from) continue;
		const gate = evaluateGate(from, to, evidence, config);
		if (gate.ok) return { action: `advance:${to}`, detail: `advance to ${to}` };
		return { action: `satisfy:${to}`, detail: gate.reason };
	}
	if (stage === "ready") return { action: "integrate", detail: "record manual integration" };
	if (stage === "postverify") {
		const gate = evaluateGate("postverify", "done", evidence, config);
		return gate.ok
			? { action: "advance:done", detail: "complete the task" }
			: { action: "satisfy:done", detail: gate.reason };
	}
	return { action: "none", detail: `task is ${stage}` };
}
