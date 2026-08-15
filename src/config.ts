import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { CommandDefinition } from "./types.ts";

/** Configuration schema v1 (see PRD v0.1 "Configuration schema v1"). */
export interface SymphonyConfig {
	version: 1;
	project: {
		name: string;
		taskPrefix: string;
		targetBranch: string;
	};
	ui: {
		widget: boolean;
		density: "compact" | "comfortable";
	};
	workspace: {
		mode: "current_checkout";
		maxActiveTasks: number;
	};
	workflow: {
		preset: "software-dev";
		planApproval: "risks_only" | "always" | "never";
		reviewMediumPolicy: "ask" | "fresh" | "current";
		completion: "manual_merge";
	};
	roles: {
		planner: RoleConfig;
		implementer: RoleConfig;
		reviewer: RoleConfig & { session: "fresh"; tools: string[] };
	};
	commands: Record<string, CommandDefinition>;
	checks: {
		verify: string[];
		postIntegration: string[];
	};
	security: {
		protectedPaths: string[];
		protectedPathPolicy?: "block" | "confirm";
	};
	limits: {
		maxChildSessions: number;
		maxStageRetries: number;
	};
	/** Unknown fields preserved verbatim so forward-compatible edits survive. */
	_unknown?: Record<string, unknown>;
}

export interface RoleConfig {
	session: "current" | "fresh";
	model: string;
	thinking: string;
	maxTurns: number;
	tools?: string[];
}

export interface ConfigIssue {
	path: string;
	message: string;
}

const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export function defaultConfig(projectName: string): SymphonyConfig {
	return {
		version: 1,
		project: { name: projectName, taskPrefix: "DEV", targetBranch: "main" },
		ui: { widget: true, density: "compact" },
		workspace: { mode: "current_checkout", maxActiveTasks: 1 },
		workflow: {
			preset: "software-dev",
			planApproval: "risks_only",
			reviewMediumPolicy: "ask",
			completion: "manual_merge",
		},
		roles: {
			planner: { session: "current", model: "inherit", thinking: "high", maxTurns: 4 },
			implementer: { session: "current", model: "inherit", thinking: "high", maxTurns: 12 },
			reviewer: {
				session: "fresh",
				model: "inherit",
				thinking: "high",
				maxTurns: 6,
				tools: ["sym_task_read", "sym_diff_read", "read"],
			},
		},
		commands: {
			unit: { argv: ["npm", "test"], timeoutMs: 900_000, required: true },
		},
		checks: { verify: ["unit"], postIntegration: ["unit"] },
		security: {
			protectedPaths: [".env", ".env.*", ".git/**", ".symphony/runtime/**"],
			protectedPathPolicy: "confirm",
		},
		limits: { maxChildSessions: 1, maxStageRetries: 1 },
	};
}

/**
 * Validate a parsed configuration document. Returns every issue found so the
 * doctor can show path-specific repair guidance.
 */
export function validateConfig(raw: unknown): { issues: ConfigIssue[]; config?: SymphonyConfig } {
	const issues: ConfigIssue[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { issues: [{ path: "$", message: "configuration must be a YAML mapping" }] };
	}
	const doc = raw as Record<string, unknown>;

	const version = doc["version"];
	if (version !== 1) {
		issues.push({
			path: "version",
			message: `unsupported schema version ${JSON.stringify(version)}; run /sym init to migrate (v0.1 supports version 1 only)`,
		});
		return { issues };
	}

	const projectRaw = (doc["project"] ?? {}) as Record<string, unknown>;
	const cfg: SymphonyConfig = defaultConfig(String(projectRaw["name"] ?? "project"));
	const unknown: Record<string, unknown> = {};
	for (const key of Object.keys(doc)) {
		if (!["version", "project", "ui", "workspace", "workflow", "roles", "commands", "checks", "security", "limits"].includes(key)) {
			unknown[key] = doc[key];
		}
	}
	cfg._unknown = Object.keys(unknown).length > 0 ? unknown : undefined;

	// project
	const project = expectObject(doc["project"], "project", issues) ?? {};
	cfg.project.name = requireString(project, "name", "project.name", issues, cfg.project.name);
	cfg.project.taskPrefix = requireString(project, "task_prefix", "project.task_prefix", issues, cfg.project.taskPrefix).toUpperCase();
	cfg.project.targetBranch = requireString(project, "target_branch", "project.target_branch", issues, cfg.project.targetBranch);
	if (!/^[A-Z][A-Z0-9_-]*$/.test(cfg.project.taskPrefix)) {
		issues.push({ path: "project.task_prefix", message: "task prefix must be uppercase letters/digits (e.g. DEV)" });
	}

	// ui
	const ui = expectObject(doc["ui"], "ui", issues) ?? {};
	if (ui["widget"] !== undefined) cfg.ui.widget = Boolean(ui["widget"]);
	if (ui["density"] !== undefined && ui["density"] !== "compact" && ui["density"] !== "comfortable") {
		issues.push({ path: "ui.density", message: 'density must be "compact" or "comfortable"' });
	}

	// workspace
	const workspace = expectObject(doc["workspace"], "workspace", issues) ?? {};
	if (workspace["mode"] !== undefined && workspace["mode"] !== "current_checkout") {
		issues.push({ path: "workspace.mode", message: 'v0.1 supports only "current_checkout"' });
	}
	if (workspace["max_active_tasks"] !== undefined) {
		const n = workspace["max_active_tasks"];
		if (n !== 1) issues.push({ path: "workspace.max_active_tasks", message: "v0.1 allows exactly 1 active task" });
	}

	// workflow
	const workflow = expectObject(doc["workflow"], "workflow", issues) ?? {};
	if (workflow["plan_approval"] !== undefined && !["risks_only", "always", "never"].includes(String(workflow["plan_approval"]))) {
		issues.push({ path: "workflow.plan_approval", message: 'plan_approval must be one of risks_only|always|never' });
	} else if (workflow["plan_approval"] !== undefined) cfg.workflow.planApproval = workflow["plan_approval"] as SymphonyConfig["workflow"]["planApproval"];
	if (workflow["review_medium_policy"] !== undefined && !["ask", "fresh", "current"].includes(String(workflow["review_medium_policy"]))) {
		issues.push({ path: "workflow.review_medium_policy", message: 'review_medium_policy must be one of ask|fresh|current' });
	} else if (workflow["review_medium_policy"] !== undefined) cfg.workflow.reviewMediumPolicy = workflow["review_medium_policy"] as SymphonyConfig["workflow"]["reviewMediumPolicy"];

	// roles
	const roles = expectObject(doc["roles"], "roles", issues) ?? {};
	for (const roleName of ["planner", "implementer", "reviewer"] as const) {
		const role = expectObject(roles[roleName], `roles.${roleName}`, issues);
		if (!role) continue;
		const target = cfg.roles[roleName] as unknown as Record<string, unknown>;
		if (role["session"] !== undefined) target["session"] = requireString(role, "session", `roles.${roleName}.session`, issues, "current");
		if (role["model"] !== undefined) target["model"] = role["model"];
		if (role["thinking"] !== undefined) target["thinking"] = role["thinking"];
		if (role["max_turns"] !== undefined) {
			const n = role["max_turns"];
			if (typeof n !== "number" || n < 1 || n > 64 || !Number.isInteger(n)) {
				issues.push({ path: `roles.${roleName}.max_turns`, message: "max_turns must be an integer between 1 and 64" });
			} else target["maxTurns"] = n;
		}
		if (role["tools"] !== undefined) {
			if (!Array.isArray(role["tools"]) || role["tools"].some((t) => typeof t !== "string")) {
				issues.push({ path: `roles.${roleName}.tools`, message: "tools must be a list of tool names" });
			}
		}
	}
	if (cfg.roles.reviewer.session !== "fresh") {
		issues.push({ path: "roles.reviewer.session", message: 'reviewer session must be "fresh" for independent review' });
	}

	// commands — fixed argv, mandatory timeout, bounded limits (V01-QA-001)
	const commands = expectObject(doc["commands"], "commands", issues) ?? {};
	cfg.commands = {};
	for (const [name, def] of Object.entries(commands)) {
		const cmd = validateCommandDefinition(name, def, issues);
		if (cmd) cfg.commands[name] = cmd;
	}
	const checkGroups = expectObject(doc["checks"], "checks", issues) ?? {};
	cfg.checks.verify = stringArray(checkGroups["verify"], "checks.verify", issues) ?? cfg.checks.verify;
	cfg.checks.postIntegration = stringArray(checkGroups["post_integration"], "checks.post_integration", issues) ?? cfg.checks.postIntegration;
	for (const [group, names] of [["verify", cfg.checks.verify], ["post_integration", cfg.checks.postIntegration]] as const) {
		for (const name of names) {
			if (!cfg.commands[name]) {
				issues.push({ path: `checks.${group}`, message: `unknown check "${name}" — define it under commands:` });
			}
		}
	}

	// security
	const security = expectObject(doc["security"], "security", issues) ?? {};
	cfg.security.protectedPaths = stringArray(security["protected_paths"], "security.protected_paths", issues) ?? cfg.security.protectedPaths;
	if (security["protected_path_policy"] !== undefined && !["block", "confirm"].includes(String(security["protected_path_policy"]))) {
		issues.push({ path: "security.protected_path_policy", message: 'protected_path_policy must be "block" or "confirm"' });
	} else if (security["protected_path_policy"] !== undefined) {
		cfg.security.protectedPathPolicy = security["protected_path_policy"] as "block" | "confirm";
	}

	// limits
	const limits = expectObject(doc["limits"], "limits", issues) ?? {};
	if (limits["max_child_sessions"] !== undefined) {
		const n = limits["max_child_sessions"];
		if (typeof n !== "number" || n < 0 || n > 8) issues.push({ path: "limits.max_child_sessions", message: "max_child_sessions must be 0-8" });
		else cfg.limits.maxChildSessions = n;
	}
	if (limits["max_stage_retries"] !== undefined) {
		const n = limits["max_stage_retries"];
		if (typeof n !== "number" || n < 0 || n > 5) issues.push({ path: "limits.max_stage_retries", message: "max_stage_retries must be 0-5" });
		else cfg.limits.maxStageRetries = n;
	}

	if (issues.length > 0) return { issues };
	return { issues: [], config: cfg };
}

/** V01-QA-001: reject shell strings, missing timeouts, oversized limits. */
export function validateCommandDefinition(
	name: string,
	def: unknown,
	issues: ConfigIssue[],
): CommandDefinition | undefined {
	const path = `commands.${name}`;
	if (typeof def === "string" || typeof def === "number") {
		issues.push({
			path,
			message: "command must be a mapping with argv (executable + argument array); shell strings are rejected",
		});
		return undefined;
	}
	if (typeof def !== "object" || def === null || Array.isArray(def)) {
		issues.push({ path, message: "command must be a mapping" });
		return undefined;
	}
	const doc = def as Record<string, unknown>;
	const argv = doc["argv"];
	if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string" || a.length === 0)) {
		issues.push({ path: `${path}.argv`, message: "argv must be a non-empty array of strings (executable first, no shell)" });
		return undefined;
	}
	const timeoutMs = doc["timeout_ms"];
	if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		issues.push({ path: `${path}.timeout_ms`, message: "timeout_ms is mandatory and must be a positive integer" });
		return undefined;
	}
	if (timeoutMs > MAX_TIMEOUT_MS) {
		issues.push({ path: `${path}.timeout_ms`, message: `timeout_ms exceeds the maximum of ${MAX_TIMEOUT_MS}` });
		return undefined;
	}
	const cmd: CommandDefinition = {
		argv: argv as string[],
		timeoutMs,
		required: doc["required"] === undefined ? false : Boolean(doc["required"]),
	};
	if (doc["cwd"] !== undefined) {
		if (typeof doc["cwd"] !== "string") issues.push({ path: `${path}.cwd`, message: "cwd must be a string" });
		else cmd.cwd = doc["cwd"];
	}
	if (doc["env_allowlist"] !== undefined) {
		const env = stringArray(doc["env_allowlist"], `${path}.env_allowlist`, issues);
		if (env) cmd.envAllowlist = env;
	}
	if (doc["max_output_bytes"] !== undefined) {
		const n = doc["max_output_bytes"];
		if (typeof n !== "number" || n <= 0 || n > MAX_OUTPUT_BYTES) {
			issues.push({ path: `${path}.max_output_bytes`, message: `max_output_bytes must be 1..${MAX_OUTPUT_BYTES}` });
		} else cmd.maxOutputBytes = n;
	}
	return cmd;
}

function expectObject(value: unknown, path: string, issues: ConfigIssue[]): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		issues.push({ path, message: "expected a mapping" });
		return undefined;
	}
	return value as Record<string, unknown>;
}

function requireString(
	obj: Record<string, unknown>,
	key: string,
	path: string,
	issues: ConfigIssue[],
	fallback: string,
): string {
	const v = obj[key];
	if (v === undefined) return fallback;
	if (typeof v !== "string" || v.length === 0) {
		issues.push({ path, message: "must be a non-empty string" });
		return fallback;
	}
	return v;
}

function stringArray(value: unknown, path: string, issues: ConfigIssue[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		issues.push({ path, message: "must be a list of strings" });
		return undefined;
	}
	return value as string[];
}

export interface LoadedConfig {
	config: SymphonyConfig;
	/** Presentation-only overrides from gitignored config.local.yaml. */
	local: Partial<SymphonyConfig["ui"]>;
	/** Invalid-configuration marker: read-only inspection stays available. */
	issues: ConfigIssue[];
}

export function loadConfigFromText(text: string): { issues: ConfigIssue[]; config?: SymphonyConfig } {
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch (err) {
		return { issues: [{ path: "$", message: `YAML parse error: ${(err as Error).message}` }] };
	}
	return validateConfig(parsed);
}

export function loadConfigFile(path: string): LoadedConfig {
	try {
		const text = readFileSync(path, "utf8");
		const result = loadConfigFromText(text);
		if (!result.config) return { config: defaultConfig("unknown"), local: {}, issues: result.issues };
		let local: Partial<SymphonyConfig["ui"]> = {};
		try {
			const localRaw = parseYaml(readFileSync(path.replace(/config\.yaml$/, "config.local.yaml"), "utf8"));
			if (localRaw && typeof localRaw === "object") {
				const ui = (localRaw as Record<string, unknown>)["ui"];
				if (ui && typeof ui === "object") local = ui as Partial<SymphonyConfig["ui"]>;
			}
		} catch {
			// optional file
		}
		return { config: result.config, local, issues: [] };
	} catch (err) {
		return {
			config: defaultConfig("unknown"),
			local: {},
			issues: [{ path: "$", message: `cannot read configuration: ${(err as Error).message}` }],
		};
	}
}

/** Stable hash of effective configuration, used to pin attempts. */
export function configHash(config: SymphonyConfig): string {
	const canonical = JSON.stringify(config, (key, value) => (key === "_unknown" ? undefined : value));
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
