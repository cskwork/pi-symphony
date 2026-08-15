/**
 * Workflow definition layer (PRD v0.3): structured, validated, customizable
 * stage graphs with typed declarative conditions. No code execution, no
 * template expressions, no arbitrary runtime state (V03-WF-004).
 */

// ---------------------------------------------------------------------------
// Condition AST — data-only
// ---------------------------------------------------------------------------

export type Condition =
	| { kind: "always" }
	| { kind: "never" }
	| { kind: "task_kind"; equals: string }
	| { kind: "task_field"; field: string; equals: string | number | boolean }
	| { kind: "changed_paths"; matches: string }
	| { kind: "all"; of: Condition[] }
	| { kind: "any"; of: Condition[] }
	| { kind: "not"; of: Condition };

/** Parse the YAML-facing condition form into the typed AST. Rejects anything else. */
export function parseCondition(raw: unknown, path = "when"): Condition {
	if (raw === undefined || raw === null) return { kind: "always" };
	if (typeof raw === "boolean") return raw ? { kind: "always" } : { kind: "never" };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new ConditionError(path, "condition must be a mapping or boolean");
	}
	const doc = raw as Record<string, unknown>;
	const keys = Object.keys(doc);
	if (keys.length !== 1) {
		throw new ConditionError(path, `condition must have exactly one operator (got: ${keys.join(", ") || "none"})`);
	}
	const [op] = keys as [string];
	const arg = doc[op]!;
	switch (op) {
		case "task_kind":
			if (typeof arg !== "string") throw new ConditionError(path, "task_kind expects a string");
			return { kind: "task_kind", equals: arg };
		case "task_field": {
			if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
				throw new ConditionError(path, "task_field expects {field, equals}");
			}
			const inner = arg as Record<string, unknown>;
			if (typeof inner["field"] !== "string" || !["equals"].every((k) => k in inner)) {
				throw new ConditionError(path, "task_field expects {field, equals}");
			}
			const value = inner["equals"];
			if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
				throw new ConditionError(path, "task_field.equals must be a scalar");
			}
			const extra = Object.keys(inner).filter((k) => k !== "field" && k !== "equals");
			if (extra.length > 0) throw new ConditionError(path, `unknown task_field fields: ${extra.join(", ")}`);
			return { kind: "task_field", field: inner["field"] as string, equals: value };
		}
		case "changed_paths":
			if (typeof arg !== "string") throw new ConditionError(path, "changed_paths expects a glob string");
			return { kind: "changed_paths", matches: arg };
		case "all":
		case "any": {
			if (!Array.isArray(arg) || arg.length === 0) throw new ConditionError(path, `${op} expects a non-empty list`);
			const inner = arg.map((c, i) => parseCondition(c, `${path}.${op}[${i}]`));
			return op === "all" ? { kind: "all", of: inner } : { kind: "any", of: inner };
		}
		case "not": {
			const inner = parseCondition(arg, `${path}.not`);
			return { kind: "not", of: inner };
		}
		default:
			throw new ConditionError(path, `unknown condition operator "${op}" (allowed: task_kind, task_field, changed_paths, all, any, not)`);
	}
}

export class ConditionError extends Error {
	constructor(public path: string, reason: string) {
		super(`${path}: ${reason}`);
		this.name = "ConditionError";
	}
}

/** The bounded runtime facts a condition may consult — nothing else. */
export interface ConditionFacts {
	taskKind: string;
	taskFields: Record<string, string | number | boolean>;
	changedPaths: string[];
}

export interface ExplainEntry {
	condition: Condition;
	depth: number;
	result: boolean;
	note?: string;
}

export function evaluateCondition(condition: Condition, facts: ConditionFacts): boolean {
	return explainCondition(condition, facts).pop()!.result;
}

/** Evaluate with a full explanation trace (V03-WF-005). */
export function explainCondition(condition: Condition, facts: ConditionFacts, depth = 0): ExplainEntry[] {
	const entries: ExplainEntry[] = [];
	switch (condition.kind) {
		case "always":
			entries.push({ condition, depth, result: true });
			break;
		case "never":
			entries.push({ condition, depth, result: false });
			break;
		case "task_kind":
			entries.push({ condition, depth, result: facts.taskKind === condition.equals, note: `task.kind=${facts.taskKind}` });
			break;
		case "task_field": {
			const value = facts.taskFields[condition.field];
			entries.push({ condition, depth, result: value === condition.equals, note: `${condition.field}=${JSON.stringify(value ?? null)}` });
			break;
		}
		case "changed_paths": {
			const matched = facts.changedPaths.some((p) => globMatch(p, condition.matches));
			entries.push({ condition, depth, result: matched, note: `${facts.changedPaths.length} changed path(s)` });
			break;
		}
		case "all":
		case "any": {
			let result = condition.kind === "all";
			for (const child of condition.of) {
				const childEntries = explainCondition(child, facts, depth + 1);
				entries.push(...childEntries);
				const childResult = childEntries[childEntries.length - 1]!.result;
				result = condition.kind === "all" ? result && childResult : result || childResult;
			}
			entries.push({ condition, depth, result });
			break;
		}
		case "not": {
			const childEntries = explainCondition(condition.of, facts, depth + 1);
			entries.push(...childEntries);
			entries.push({ condition, depth, result: !childEntries[childEntries.length - 1]!.result });
			break;
		}
	}
	return entries;
}

function globMatch(path: string, pattern: string): boolean {
	// Match both the literal pattern and an implicitly-rooted variant so
	// "auth/**" hits both "auth/x.ts" and "src/auth/x.ts".
	return globToRegExp(pattern).test(path) || globToRegExp(`**/${pattern}`).test(path);
}

function globToRegExp(pattern: string): RegExp {
	return new RegExp(
		`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`,
	);
}

// ---------------------------------------------------------------------------
// Stage graph definition
// ---------------------------------------------------------------------------

export interface StageDefinition {
	id: string;
	actor: string;
	purpose?: string;
	/** Data-only condition selecting this stage. */
	when?: Condition;
	inputs: string[];
	outputs: string[];
	/** Named transition targets. */
	onSuccess?: string;
	onRejected?: string;
	onBlockingFindings?: string;
	/** This stage's exit requires deterministic checks (verify gate). */
	requiresChecks?: "verify" | "postIntegration" | "none";
	/** This stage's exit requires an approval record. */
	requiresApproval?: string;
	terminal?: boolean;
}

export interface WorkflowInvariants {
	requireDeterministicVerify: boolean;
	requireCompletionEvidence: boolean;
}

export interface WorkflowDefinition {
	stages: StageDefinition[];
	invariants: WorkflowInvariants;
}

export interface GraphIssue {
	stage?: string;
	message: string;
}

/**
 * Validate a workflow graph (V03-WF-002): exactly one entry, at least one
 * terminal success state, no unreachable stages, no unknown transition
 * targets, and no cycles that lack an exit.
 */
export function validateGraph(def: WorkflowDefinition): GraphIssue[] {
	const issues: GraphIssue[] = [];
	const ids = new Set(def.stages.map((s) => s.id));
	if (def.stages.length === 0) return [{ message: "workflow has no stages" }];

	// Entry = not the *success* target of any stage. Rejection/blocking back-edges
	// (onRejected/onBlockingFindings) are recovery paths, not entries.
	const entries = def.stages.filter((s) => !def.stages.some((other) => other.onSuccess === s.id));
	if (entries.length === 0) issues.push({ message: "no entry stage: every stage is targeted by another (cycle)" });
	if (entries.length > 1) issues.push({ message: `multiple entry stages: ${entries.map((s) => s.id).join(", ")}` });

	const terminals = def.stages.filter((s) => s.terminal || targetsOf(s).length === 0);
	if (terminals.length === 0) issues.push({ message: "no terminal stage: every stage has an outgoing transition" });

	const successTerminals = terminals.filter((s) => s.id === "done" || s.requiresChecks === "postIntegration");
	if (successTerminals.length === 0) issues.push({ message: "no terminal success state (expected a `done` stage or a postIntegration-gated terminal)" });

	for (const stage of def.stages) {
		for (const target of targetsOf(stage)) {
			if (!ids.has(target)) issues.push({ stage: stage.id, message: `transition to unknown stage "${target}"` });
		}
	}

	// Reachability from the canonical entry (first entry, plan preferred)
	if (entries.length >= 1) {
		const canonical = entries.find((s) => s.id === "plan") ?? entries[0]!;
		const reachable = new Set<string>();
		const queue = [canonical.id];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (reachable.has(current)) continue;
			reachable.add(current);
			const stage = def.stages.find((s) => s.id === current);
			if (!stage) continue;
			queue.push(...targetsOf(stage));
		}
		for (const stage of def.stages) {
			if (!reachable.has(stage.id)) issues.push({ stage: stage.id, message: "stage is unreachable from the entry stage" });
		}
	}

	// Invariant enforcement (V03-WF-003): every path into done/ready must pass
	// through a check-gated stage exit.
	if (def.invariants.requireDeterministicVerify) {
		const done = def.stages.find((s) => s.id === "done");
		if (done) {
			for (const stage of def.stages) {
				if (targetsOf(stage).includes("done") && stage.requiresChecks === undefined) {
					issues.push({
						stage: stage.id,
						message: `invariant violation: ${stage.id} → done without requiresChecks (deterministic verification would be bypassable)`,
					});
				}
			}
		}
	}
	if (def.invariants.requireCompletionEvidence) {
		const done = def.stages.find((s) => s.id === "done");
		if (done && done.inputs.length === 0 && !def.stages.some((s) => s.requiresChecks === "postIntegration")) {
			issues.push({ stage: "done", message: "invariant violation: completion without evidence inputs" });
		}
	}
	return issues;
}

function targetsOf(stage: StageDefinition): string[] {
	return [stage.onSuccess, stage.onRejected, stage.onBlockingFindings].filter((t): t is string => typeof t === "string");
}

// ---------------------------------------------------------------------------
// Simulation with explanations (V03-WF-005)
// ---------------------------------------------------------------------------

export interface SimulationStep {
	stage: string;
	selected: boolean;
	reason: string;
	entries?: ExplainEntry[];
}

export interface SimulationResult {
	steps: SimulationStep[];
	outcome: string;
	complete: boolean;
}

/**
 * Dry-run a workflow against a task's facts: which stages run, which are
 * skipped by condition, and what the terminal outcome is.
 */
export function simulate(def: WorkflowDefinition, facts: ConditionFacts, maxSteps = 32): SimulationResult {
	const steps: SimulationStep[] = [];
	const entry = def.stages.find((s) => !def.stages.some((other) => other.onSuccess === s.id));
	if (!entry) return { steps, outcome: "invalid graph: no entry stage", complete: false };
	let current: StageDefinition | undefined = entry;
	const stageById = (id: string): StageDefinition | undefined => def.stages.find((s) => s.id === id);
	const visited = new Set<string>();
	while (current && steps.length < maxSteps) {
		if (visited.has(current.id)) {
			steps.push({ stage: current.id, selected: false, reason: "cycle detected — stopping simulation" });
			return { steps, outcome: `cycle at ${current.id}`, complete: false };
		}
		visited.add(current.id);
		const explanation = current.when ? explainCondition(current.when, facts) : [{ condition: { kind: "always" }, depth: 0, result: true } as ExplainEntry];
		const selected = explanation[explanation.length - 1]!.result;
		steps.push({
			stage: current.id,
			selected,
			reason: selected ? "condition satisfied" : "condition not satisfied — stage skipped",
			entries: explanation,
		});
		const active: StageDefinition = current;
		if (!selected) {
			// A skipped conditional stage falls through to its success target.
			current = active.onSuccess ? stageById(active.onSuccess) : undefined;
			continue;
		}
		if (active.terminal || !active.onSuccess) {
			return { steps, outcome: `terminal at ${active.id}`, complete: true };
		}
		current = stageById(active.onSuccess);
	}
	return { steps, outcome: "simulation exceeded step limit — check conditional expansion", complete: false };
}

/** Default software-dev graph expressed as v2 stages (mirrors the v0.1 engine). */
export function defaultWorkflow(): WorkflowDefinition {
	return {
		stages: [
			{ id: "plan", actor: "planner", inputs: ["task_contract"], outputs: ["plan_report"], onSuccess: "build", requiresApproval: "plan" },
			{ id: "build", actor: "implementer", inputs: ["plan_report"], outputs: ["implementation_report"], onSuccess: "review", onRejected: "plan" },
			{ id: "review", actor: "reviewer", inputs: ["plan_report", "implementation_report", "diff"], outputs: ["review_report"], onSuccess: "verify", onBlockingFindings: "build" },
			{ id: "verify", actor: "checks", inputs: ["implementation_report"], outputs: ["check_evidence"], onSuccess: "ready", onRejected: "build", requiresChecks: "verify" },
			{ id: "ready", actor: "human", inputs: ["check_evidence"], outputs: ["integration_record"], onSuccess: "postverify" },
			{ id: "postverify", actor: "checks", inputs: ["integration_record"], outputs: ["post_check_evidence"], onSuccess: "done", onRejected: "ready", requiresChecks: "postIntegration" },
			{ id: "done", actor: "none", inputs: ["post_check_evidence"], outputs: [], terminal: true },
		],
		invariants: { requireDeterministicVerify: true, requireCompletionEvidence: true },
	};
}
