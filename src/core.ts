import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { monotonicId } from "./ids.ts";
import { configHash, loadConfigFile, type SymphonyConfig } from "./config.ts";
import { EventLedger } from "./events.ts";
import { LeaseManager } from "./lease.ts";
import { symphonyPaths, taskFileName } from "./paths.ts";
import {
	backupFile,
	getManagedSection,
	parseTaskFile,
	readTaskFile,
	renderManagedSection,
	setManagedSection,
	TaskConflictError,
	TaskIdAllocator,
	writeTaskFileAtomic,
	type ParsedTask,
} from "./tasks.ts";
import {
	assertTransition,
	evaluateGate,
	nextAction,
	needsPlanApproval,
	type EvidenceBundle,
} from "./workflow.ts";
import { buildCheckEnv, persistCheckEvidence, runCheck, type CommandExecutor } from "./checks.ts";
import {
	assertReadOnlyGit,
	boundedDiff,
	diffSummary,
	gitSnapshot,
	revisionOnBranch,
	type GitExec,
	type GitSnapshot,
} from "./gitinfo.ts";
import {
	type ApprovalRecord,
	type AttemptRecord,
	type CheckRunEvidence,
	type CommandResult,
	type IntegrationRecord,
	type ManagedSection,
	type RunState,
	type Stage,
	type StageReport,
	type SymphonyEvent,
	type TaskFrontmatter,
	type TaskKind,
	type TaskStage,
	type UiPort,
} from "./types.ts";

/** Detected project metadata — collected without executing project scripts. */
export interface ProjectDetection {
	projectName: string;
	language?: "node" | "python" | "java" | "unknown";
	packageManager?: string;
	isGitRepo: boolean;
	defaultBranch: string;
	suggestedChecks: Array<{ name: string; argv: string[]; note: string }>;
	/** Files inspected during detection, for the init review screen. */
	inspected: string[];
}

export interface CoreDeps {
	repoRoot: string;
	ui: UiPort;
	gitExec: GitExec;
	checkExecutor?: CommandExecutor;
	/** Process id used for lease ownership. */
	pid?: number;
	sessionId?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * SymphonyCore is the only component that mutates task state. Every mutation
 * validates against the workflow engine, appends a typed event, and writes
 * task files atomically. UI adapters (TUI now, HTML in v0.2) call commands.
 */
export class SymphonyCore {
	readonly paths: ReturnType<typeof symphonyPaths>;
	readonly ledger: EventLedger;
	private readonly lease: LeaseManager;
	config: SymphonyConfig;
	configIssues: ReturnType<typeof loadConfigFile>["issues"];
	private attempts = new Map<string, AttemptRecord>();
	private approvals = new Map<string, ApprovalRecord>();
	private reports = new Map<string, Set<ManagedSection>>(); // taskId → submitted sections
	private checkRuns = new Map<string, Map<string, CheckRunEvidence>>(); // taskId → check → latest
	/** Bounded context manifest builder for the fresh reviewer. */

	constructor(readonly deps: CoreDeps) {
		this.paths = symphonyPaths(deps.repoRoot);
		const loaded = loadConfigFile(this.paths.config);
		this.config = loaded.config;
		this.configIssues = loaded.issues;
		this.ledger = new EventLedger(this.paths.eventsFile);
		this.lease = new LeaseManager(this.paths.leaseFile);
		this.replay();
	}

	get initialized(): boolean {
		return existsSync(this.paths.config);
	}

	// ---------------------------------------------------------------------------
	// Init & doctor
	// ---------------------------------------------------------------------------

	/** V01-PROJ-001: detect repository metadata without executing project code. */
	async detectProject(): Promise<ProjectDetection> {
		const inspected: string[] = [];
		const detection: ProjectDetection = {
			projectName: this.deps.repoRoot.split("/").filter(Boolean).pop() ?? "project",
			isGitRepo: false,
			defaultBranch: "main",
			suggestedChecks: [],
			inspected,
		};
		const snapshot = await gitSnapshot(this.deps.gitExec, this.deps.repoRoot);
		detection.isGitRepo = snapshot.isRepo;
		if (snapshot.branch && snapshot.branch !== "HEAD") detection.defaultBranch = snapshot.branch;

		const pkgPath = join(this.deps.repoRoot, "package.json");
		if (existsSync(pkgPath)) {
			inspected.push("package.json");
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
				if (typeof pkg["name"] === "string") detection.projectName = pkg["name"];
				const scripts = (pkg["scripts"] ?? {}) as Record<string, string>;
				if (scripts["test"] !== undefined) {
					const pm = existsSync(join(this.deps.repoRoot, "pnpm-lock.yaml"))
						? "pnpm"
						: existsSync(join(this.deps.repoRoot, "yarn.lock"))
							? "yarn"
							: "npm";
					detection.packageManager = pm;
					detection.suggestedChecks.push({ name: "unit", argv: [pm, "test", "--", "--run"], note: "package.json scripts.test" });
					detection.language = "node";
				}
				if (scripts["typecheck"] !== undefined) {
					detection.suggestedChecks.push({ name: "typecheck", argv: ["npm", "run", "typecheck"], note: "package.json scripts.typecheck" });
				}
			} catch {
				// malformed metadata: keep defaults, doctor will note it
			}
		}
		const pyproject = join(this.deps.repoRoot, "pyproject.toml");
		const setupPy = join(this.deps.repoRoot, "setup.py");
		if (existsSync(pyproject) || existsSync(setupPy)) {
			inspected.push(existsSync(pyproject) ? "pyproject.toml" : "setup.py");
			detection.language = "python";
			detection.suggestedChecks.push({ name: "unit", argv: ["python3", "-m", "pytest"], note: "python project" });
		}
		const pom = join(this.deps.repoRoot, "pom.xml");
		if (existsSync(pom)) {
			inspected.push("pom.xml");
			detection.language = "java";
			detection.suggestedChecks.push({ name: "unit", argv: ["mvn", "-q", "test"], note: "maven project" });
		}
		if (detection.suggestedChecks.length === 0) {
			detection.suggestedChecks.push({
				name: "smoke",
				argv: ["node", "--version"],
				note: "no project test command detected — placeholder, edit .symphony/config.yaml",
			});
		}
		return detection;
	}

	/** V01-PROJ-002: create only Symphony-owned paths; backup existing config. */
	async initialize(answers: {
		taskPrefix: string;
		targetBranch: string;
		checks: Array<{ name: string; argv: string[] }>;
		confirmOverwrite?: boolean;
	}): Promise<CommandResult<{ backedUp?: string }>> {
		if (!this.initialized || answers.confirmOverwrite !== false) {
			// continue
		}
		const backup = this.initialized ? backupFile(this.paths.config) : undefined;
		const detection = await this.detectProject();
		const cfg = structuredClone(this.config);
		cfg.project.taskPrefix = answers.taskPrefix.toUpperCase();
		cfg.project.targetBranch = answers.targetBranch;
		cfg.project.name = detection.projectName;
		cfg.commands = {};
		for (const check of answers.checks) {
			cfg.commands[check.name] = {
				argv: check.argv,
				timeoutMs: 900_000,
				required: true,
			};
		}
		if (cfg.commands["unit"] === undefined && answers.checks[0]) {
			cfg.commands["unit"] = { ...cfg.commands[answers.checks[0]!.name]! };
		}
		cfg.checks.verify = Object.keys(cfg.commands).slice(0, 2);
		cfg.checks.postIntegration = cfg.checks.verify;
		this.config = cfg;

		mkdirSync(this.paths.root, { recursive: true });
		mkdirSync(this.paths.tasksDir, { recursive: true });
		mkdirSync(this.paths.promptsDir, { recursive: true });
		mkdirSync(this.paths.runtimeDir, { recursive: true });
		mkdirSync(this.paths.cacheDir, { recursive: true });
		mkdirSync(this.paths.logsDir, { recursive: true });
		writeFileSync(this.paths.config, serializeConfigYaml(cfg), "utf8");
		const gitignore = join(this.paths.root, ".gitignore");
		if (!existsSync(gitignore)) {
			writeFileSync(gitignore, "runtime/\nconfig.local.yaml\n", "utf8");
		}
		this.configIssues = [];
		return { ok: true, value: { backedUp: backup }, next: "create a task with /sym new" };
	}

	doctor(): Array<{ area: string; ok: boolean; detail: string }> {
		const report: Array<{ area: string; ok: boolean; detail: string }> = [];
		report.push({
			area: "config",
			ok: this.configIssues.length === 0,
			detail: this.configIssues.length === 0 ? `schema v1 valid (hash ${configHash(this.config)})` : this.configIssues.map((i) => `${i.path}: ${i.message}`).join("; "),
		});
		const leaseStatus = this.lease.status();
		report.push({
			area: "lease",
			ok: !leaseStatus.stale,
			detail: leaseStatus.record
				? leaseStatus.stale
					? `stale lease held by dead pid ${leaseStatus.record.pid} — /sym recover reclaims it`
					: `active lease: ${leaseStatus.record.taskId} (${leaseStatus.record.stage})`
				: "no lease held",
		});
		const tasks = this.listTasks();
		const interrupted = tasks.filter((t) => t.runState === "interrupted");
		report.push({
			area: "recovery",
			ok: interrupted.length === 0,
			detail: interrupted.length === 0 ? `${tasks.length} task(s) indexed` : `interrupted tasks: ${interrupted.map((t) => t.id).join(", ")}`,
		});
		for (const [name, def] of Object.entries(this.config.commands)) {
			report.push({
				area: `check:${name}`,
				ok: true,
				detail: `${def.argv.join(" ")} (timeout ${def.timeoutMs}ms${def.required ? ", required" : ""})`,
			});
		}
		return report;
	}

	// ---------------------------------------------------------------------------
	// Task commands
	// ---------------------------------------------------------------------------

	createTask(input: {
		title: string;
		kind: TaskKind;
		acceptance: string[];
		risks: string[];
	}): CommandResult<{ id: string }> {
		if (this.configIssues.length > 0) {
			return { ok: false, error: "configuration is invalid — run /sym doctor; read-only inspection stays available" };
		}
		const allocator = new TaskIdAllocator(this.paths.tasksDir, this.config.project.taskPrefix);
		const id = allocator.next();
		const now = new Date();
		writeTaskFileAtomic(
			join(this.paths.tasksDir, taskFileName(id)),
			(parsed) => {
				parsed.frontmatter = {
					id,
					title: input.title,
					kind: input.kind,
					stage: "backlog",
					revision: 0,
					createdAt: now.toISOString(),
					updatedAt: now.toISOString(),
					targetBranch: this.config.project.targetBranch,
					acceptance: input.acceptance.map((text) => ({ text })),
					risks: input.risks,
					runState: "idle",
				};
				for (const section of ["plan", "implementation", "review", "verification", "integration", "closeout"] as ManagedSection[]) {
					setManagedSection(parsed, section, renderManagedSection(section, undefined));
				}
			},
			{ now },
		);
		this.ledger.append(id, "task.created", {
			title: input.title,
			kind: input.kind,
			stage: "backlog",
			acceptance: input.acceptance,
			risks: input.risks,
		}, { aggregateRevision: 1, now });
		this.rebuildIndex();
		return { ok: true, value: { id }, next: "run /sym continue to plan the task" };
	}

	listTasks(): TaskFrontmatter[] {
		if (!existsSync(this.paths.tasksDir)) return [];
		const tasks: TaskFrontmatter[] = [];
		for (const file of readdirSync(this.paths.tasksDir)) {
			if (!file.endsWith(".md")) continue;
			try {
				tasks.push(readTaskFile(join(this.paths.tasksDir, file)).frontmatter);
			} catch {
				// unparseable task: skip, doctor shows it
			}
		}
		return tasks.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
	}

	getTask(id: string): CommandResult<{ frontmatter: TaskFrontmatter; parsed: ParsedTask }> {
		const path = join(this.paths.tasksDir, taskFileName(id));
		if (!existsSync(path)) return { ok: false, error: `unknown task ${id}` };
		try {
			const parsed = readTaskFile(path);
			return { ok: true, value: { frontmatter: parsed.frontmatter, parsed } };
		} catch (err) {
			return { ok: false, error: `task ${id} is unreadable: ${(err as Error).message}` };
		}
	}

	/** Public read for adapters: which managed sections have submitted reports. */
	hasReport(taskId: string, section: ManagedSection): boolean {
		return this.reports.get(taskId)?.has(section) ?? false;
	}

	/** Public read for adapters: latest check evidence per check name. */
	checkRunsFor(taskId: string): Map<string, CheckRunEvidence> {
		return this.checkRuns.get(taskId) ?? new Map<string, CheckRunEvidence>();
	}

	private evidenceFor(id: string, risks: string[], revision: string | null): EvidenceBundle {
		const checks = this.checkRuns.get(id) ?? new Map<string, CheckRunEvidence>();
		return {
			hasReport: (section) => this.hasReport(id, section),
			planApproved: [...this.approvals.values()].some((a) => a.taskId === id && a.scope === "plan"),
			checks,
			checksRevision: null,
			currentRevision: revision,
			risks,
		};
	}

	/**
	 * Fresh revision read on every call — evidence freshness must never be
	 * served from a stale cache while work is in flight.
	 */
	private async currentRevision(): Promise<string | null> {
		return (await gitSnapshot(this.deps.gitExec, this.deps.repoRoot)).revision;
	}

	/** Structured report submission (V01-WF-002: models never force transitions). */
	submitReport(input: {
		taskId: string;
		section: ManagedSection;
		summary: string;
		details: Record<string, unknown>;
	}): CommandResult<{ stageAfter: TaskStage }> {
		const task = this.getTask(input.taskId);
		if (!task.ok) return { ok: false, error: task.error };
		const fm = task.value.frontmatter;
		const report: StageReport = {
			section: input.section,
			summary: input.summary,
			details: input.details,
			submittedAt: new Date().toISOString(),
		};
		const path = join(this.paths.tasksDir, taskFileName(input.taskId));
		try {
			writeTaskFileAtomic(
				path,
				(parsed) => {
					setManagedSection(parsed, input.section, renderManagedSection(input.section, report));
				},
				{ expectedRevision: fm.revision },
			);
		} catch (err) {
			return this.handleWriteError(err);
		}
		this.ledger.append(input.taskId, "report.submitted", {
			section: input.section,
			summaryLength: input.summary.length,
		}, { aggregateRevision: fm.revision + 1 });
		const sections = this.reports.get(input.taskId) ?? new Set<ManagedSection>();
		sections.add(input.section);
		this.reports.set(input.taskId, sections);
		this.rebuildIndex();

		// Auto-advance only when the deterministic gate is satisfied.
		let stageAfter: TaskStage = fm.stage;
		if (fm.stage === "plan" && input.section === "plan") {
			const gate = evaluateGate("plan", "build", this.evidenceFor(input.taskId, fm.risks, null), this.config);
			const approvalNeeded = needsPlanApproval(this.config, { risks: fm.risks });
			if (gate.ok && !approvalNeeded) {
				const moved = this.transition(input.taskId, "build");
				if (moved.ok) stageAfter = moved.value.stage;
			}
			else if (gate.ok && approvalNeeded)
				this.ledger.append(input.taskId, "approval.requested", { scope: "plan", reason: "risks declared" }, { aggregateRevision: fm.revision + 1 });
		}
		if (fm.stage === "build" && input.section === "implementation") {
			const gate = evaluateGate("build", "review", this.evidenceFor(input.taskId, fm.risks, null), this.config);
			if (gate.ok) {
				const moved = this.transition(input.taskId, "review");
				if (moved.ok) stageAfter = moved.value.stage;
			}
		}
		return { ok: true, value: { stageAfter }, next: stageAfter !== fm.stage ? `task advanced to ${stageAfter}` : undefined };
	}

	resolveApproval(input: { taskId: string; scope: string; actor: string; approved: boolean }): CommandResult<{}> {
		if (!input.approved) return { ok: true, value: {}, next: "approval rejected — task stays in plan" };
		const task = this.getTask(input.taskId);
		if (!task.ok) return { ok: false, error: task.error };
		const approval: ApprovalRecord = {
			id: monotonicId(),
			scope: input.scope,
			taskId: input.taskId,
			actor: input.actor,
			inputRevision: task.value.frontmatter.revision,
			configHash: configHash(this.config),
			approvedAt: new Date().toISOString(),
		};
		this.approvals.set(`${input.taskId}:${input.scope}`, approval);
		this.ledger.append(input.taskId, "approval.resolved", {
			scope: input.scope,
			actor: input.actor,
			approved: true,
			configHash: approval.configHash,
		}, { aggregateRevision: task.value.frontmatter.revision });
		if (task.value.frontmatter.stage === "plan" && input.scope === "plan") {
			const gate = evaluateGate("plan", "build", this.evidenceFor(input.taskId, task.value.frontmatter.risks, null), this.config);
			if (gate.ok) this.transition(input.taskId, "build");
			else return { ok: false, error: gate.reason };
		}
		return { ok: true, value: {}, next: "plan approved — build can start" };
	}

	/** Validated stage transition (V01-WF-001). */
	transition(taskId: string, to: TaskStage, options: { force?: boolean } = {}): CommandResult<{ stage: TaskStage }> {
		const task = this.getTask(taskId);
		if (!task.ok) return { ok: false, error: task.error };
		const from = task.value.frontmatter.stage;
		if (from === to) return { ok: true, value: { stage: to } };
		try {
			assertTransition(from, to);
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
		// Contract enforcement: every transition must satisfy its output contract.
		const contractGate = evaluateGate(from, to, this.evidenceFor(taskId, task.value.frontmatter.risks, null), this.config);
		if (!contractGate.ok) {
			return { ok: false, error: `${from} → ${to} blocked: ${contractGate.reason}` };
		}
		const path = join(this.paths.tasksDir, taskFileName(taskId));
		try {
			writeTaskFileAtomic(
				path,
				(parsed) => {
					parsed.frontmatter.stage = to;
					if (to === "done" || to === "cancelled") parsed.frontmatter.runState = "idle";
				},
				{ expectedRevision: task.value.frontmatter.revision },
			);
		} catch (err) {
			return this.handleWriteError(err);
		}
		this.ledger.append(taskId, "task.stage_changed", { from, to }, { aggregateRevision: task.value.frontmatter.revision + 1 });
		this.rebuildIndex();
		return { ok: true, value: { stage: to }, next: `task ${taskId}: ${from} → ${to}` };
	}

	setRunState(taskId: string, to: RunState): CommandResult<{}> {
		const task = this.getTask(taskId);
		if (!task.ok) return { ok: false, error: task.error };
		try {
			writeTaskFileAtomic(
				join(this.paths.tasksDir, taskFileName(taskId)),
				(parsed) => {
					parsed.frontmatter.runState = to;
				},
				{ expectedRevision: task.value.frontmatter.revision },
			);
		} catch (err) {
			return this.handleWriteError(err);
		}
		this.ledger.append(taskId, "task.run_state_changed", { from: task.value.frontmatter.runState, to }, { aggregateRevision: task.value.frontmatter.revision + 1 });
		this.rebuildIndex();
		return { ok: true, value: {} };
	}

	// ---------------------------------------------------------------------------
	// Attempts, leases, recovery
	// ---------------------------------------------------------------------------

	startAttempt(taskId: string, stage: Stage): CommandResult<{ attemptId: string }> {
		const task = this.getTask(taskId);
		if (!task.ok) return { ok: false, error: task.error };
		if (task.value.frontmatter.stage !== stage) {
			return { ok: false, error: `task ${taskId} is in ${task.value.frontmatter.stage}, not ${stage}` };
		}
		const priorTries = [...this.attempts.values()].filter((a) => a.taskId === taskId && a.stage === stage).length;
		if (priorTries > this.config.limits.maxStageRetries) {
			return { ok: false, error: `stage ${stage} exceeded max retries (${this.config.limits.maxStageRetries})` };
		}
		const attempt: AttemptRecord = {
			id: `${stage}-${priorTries + 1}`,
			taskId,
			stage,
			status: "running",
			startedAt: new Date().toISOString(),
			tryNumber: priorTries + 1,
			pinnedConfigHash: configHash(this.config),
		};
		this.attempts.set(attempt.id, attempt);
		this.lease.acquire({
			taskId,
			stage,
			pid: this.deps.pid ?? process.pid,
			sessionId: this.deps.sessionId ?? "unknown",
			acquiredAt: new Date().toISOString(),
			heartbeatAt: new Date().toISOString(),
		});
		this.ledger.append(taskId, "attempt.started", { stage, tryNumber: attempt.tryNumber }, { aggregateRevision: task.value.frontmatter.revision, attemptId: attempt.id });
		this.ledger.append(taskId, "lease.acquired", { stage, pid: this.deps.pid ?? process.pid }, { aggregateRevision: task.value.frontmatter.revision, attemptId: attempt.id });
		this.setRunState(taskId, "running");
		return { ok: true, value: { attemptId: attempt.id } };
	}

	completeAttempt(taskId: string, attemptId: string, status: "passed" | "failed" | "cancelled"): CommandResult<{}> {
		const attempt = this.attempts.get(attemptId);
		if (!attempt || attempt.taskId !== taskId) return { ok: false, error: `unknown attempt ${attemptId}` };
		attempt.status = status;
		attempt.endedAt = new Date().toISOString();
		const current = this.getTask(taskId);
		this.ledger.append(taskId, "attempt.completed", { stage: attempt.stage, status }, { aggregateRevision: current.ok ? current.value.frontmatter.revision : 0, attemptId });
		this.lease.release();
		this.ledger.append(taskId, "lease.released", {}, { aggregateRevision: 0, attemptId });
		this.setRunState(taskId, "idle");
		return { ok: true, value: {} };
	}

	interruptAttempt(taskId: string, attemptId: string): CommandResult<{}> {
		const attempt = this.attempts.get(attemptId);
		if (!attempt || attempt.taskId !== taskId) return { ok: false, error: `unknown attempt ${attemptId}` };
		attempt.status = "interrupted";
		attempt.endedAt = new Date().toISOString();
		this.ledger.append(taskId, "attempt.interrupted", { stage: attempt.stage, status: "interrupted" }, { aggregateRevision: 0, attemptId });
		this.setRunState(taskId, "interrupted");
		return { ok: true, value: {} };
	}

	/**
	 * V01-REC-001: on load, any running attempt from a dead process becomes
	 * Interrupted. Never resumed automatically; no duplicate attempts.
	 */
	recover(): CommandResult<{ interrupted: string[]; reclaimedLease: boolean }> {
		const interrupted: string[] = [];
		for (const [id, attempt] of this.attempts) {
			if (attempt.status !== "running") continue;
			attempt.status = "interrupted";
			attempt.endedAt = new Date().toISOString();
			this.ledger.append(attempt.taskId, "attempt.interrupted", { stage: attempt.stage, status: "interrupted" }, { aggregateRevision: 0, attemptId: id });
			interrupted.push(id);
		}
		const leaseStatus = this.lease.status();
		let reclaimedLease = false;
		if (leaseStatus.stale) {
			this.lease.release();
			reclaimedLease = true;
		}
		for (const task of this.listTasks()) {
			if (task.runState === "running" || task.runState === "waiting") {
				if (interrupted.length > 0 || leaseStatus.stale) {
					this.setRunState(task.id, "interrupted");
				}
			}
		}
		if (interrupted.length > 0 || reclaimedLease) {
			this.ledger.append("runtime", "recovery.completed", { interrupted, reclaimedLease }, { aggregateRevision: 0 });
		}
		return { ok: true, value: { interrupted, reclaimedLease } };
	}

	shutdown(): void {
		this.lease.release();
	}

	// ---------------------------------------------------------------------------
	// Checks (verify / post-integration)
	// ---------------------------------------------------------------------------

	async runCheckSet(taskId: string, set: "verify" | "postIntegration"): Promise<CommandResult<Record<string, CheckRunEvidence>>> {
		const task = this.getTask(taskId);
		if (!task.ok) return { ok: false, error: task.error };
		if (this.configIssues.length > 0) {
			return { ok: false, error: "configuration is invalid; checks are blocked (read-only inspection available)" };
		}
		const revision = await this.currentRevision();
		const names = set === "verify" ? this.config.checks.verify : this.config.checks.postIntegration;
		const runs = this.checkRuns.get(taskId) ?? new Map<string, CheckRunEvidence>();
		const results: Record<string, CheckRunEvidence> = {};
		for (const name of names) {
			const def = this.config.commands[name];
			if (!def) {
				results[name] = {
					check: name,
					runId: "unavailable",
					status: "unavailable",
					exitCode: null,
					durationMs: 0,
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					output: `check "${name}" is not defined in commands`,
					truncated: false,
					revision,
					command: [],
				};
				continue;
			}
			const outcome = await runCheck(name, def, {
				cwd: this.deps.repoRoot,
				revision,
				env: buildCheckEnv(def, this.deps.env ?? process.env),
				executor: this.deps.checkExecutor,
			});
			persistCheckEvidence(this.paths.checksDir(taskId), outcome.evidence);
			runs.set(name, outcome.evidence);
			results[name] = outcome.evidence;
			this.ledger.append(taskId, "check.completed", {
				check: name,
				status: outcome.status,
				revision,
				runId: outcome.evidence.runId,
			}, { aggregateRevision: task.value.frontmatter.revision });
		}
		this.checkRuns.set(taskId, runs);
		this.refreshEvidenceRevision(taskId, revision);
		return { ok: true, value: results };
	}

	private refreshEvidenceRevision(taskId: string, revision: string | null): void {
		const task = this.getTask(taskId);
		if (!task.ok) return;
		try {
			writeTaskFileAtomic(
				join(this.paths.tasksDir, taskFileName(taskId)),
				(parsed) => {
					parsed.frontmatter.evidenceRevision = revision ?? undefined;
					setManagedSection(
						parsed,
						"verification",
						renderManagedSection("verification", undefined, [
							`Latest verification run: ${new Date().toISOString()} against ${revision ?? "no git revision"}`,
							...[...(this.checkRuns.get(taskId)?.values() ?? [])].map(
								(run) => `- ${run.check}: ${run.status} (exit ${run.exitCode ?? "n/a"}, ${run.durationMs}ms, rev ${run.revision ?? "none"})`,
							),
						]),
					);
				},
				{ expectedRevision: task.value.frontmatter.revision },
			);
		} catch {
			// evidence refresh is best-effort; gate still enforces
		}
		this.rebuildIndex();
	}

	/** V01-QA-002: gate Ready/Done on fresh required-check evidence. */
	async advanceToReady(taskId: string): Promise<CommandResult<{ stage: TaskStage }>> {
		const task = this.getTask(taskId);
		if (!task.ok) return { ok: false, error: task.error };
		if (task.value.frontmatter.stage !== "verify") {
			return { ok: false, error: `task is in ${task.value.frontmatter.stage}; verify runs from verify` };
		}
		await this.runCheckSet(taskId, "verify");
		const revision = await this.currentRevision();
		const gate = evaluateGate(
			"verify",
			"ready",
			this.evidenceFor(taskId, task.value.frontmatter.risks, revision),
			this.config,
		);
		if (!gate.ok) return { ok: false, error: `cannot reach Ready: ${gate.reason}` };
		return this.transition(taskId, "ready");
	}

	// ---------------------------------------------------------------------------
	// Manual integration + post-integration verification (V01-COMP-001)
	// ---------------------------------------------------------------------------

	async recordIntegration(input: {
		taskId: string;
		revision: string;
		actor: string;
		note?: string;
	}): Promise<CommandResult<{}>> {
		const task = this.getTask(input.taskId);
		if (!task.ok) return { ok: false, error: task.error };
		if (task.value.frontmatter.stage !== "ready") {
			return { ok: false, error: "integration is recorded from Ready only" };
		}
		const target = task.value.frontmatter.targetBranch ?? this.config.project.targetBranch;
		const verify = await revisionOnBranch(this.deps.gitExec, this.deps.repoRoot, input.revision, target);
		if (!verify.present) {
			const cause = verify.error?.includes("no such commit")
				? "revision does not exist in this repository"
				: verify.error
					? `cannot verify revision: ${verify.error}`
					: null;
			return {
				ok: false,
				error: cause
					? `${cause} — integration requires a commit present on "${target}"`
					: `revision ${input.revision.slice(0, 10)} is not on target branch "${target}"`,
			};
		}
		const record: IntegrationRecord = {
			revision: input.revision,
			targetBranch: target,
			integratedAt: new Date().toISOString(),
			actor: input.actor,
			note: input.note,
		};
		try {
			writeTaskFileAtomic(
				join(this.paths.tasksDir, taskFileName(input.taskId)),
				(parsed) => {
					parsed.frontmatter.integration = record;
					parsed.frontmatter.stage = "postverify";
					setManagedSection(parsed, "integration", renderManagedSection("integration", undefined, [
						`Integrated by ${record.actor} at ${record.integratedAt}`,
						`Revision: ${record.revision}`,
						`Target branch: ${record.targetBranch}`,
						record.note ? `Note: ${record.note}` : "",
					].filter(Boolean)));
				},
				{ expectedRevision: task.value.frontmatter.revision },
			);
		} catch (err) {
			return this.handleWriteError(err);
		}
		this.ledger.append(input.taskId, "integration.recorded", { ...record }, { aggregateRevision: task.value.frontmatter.revision + 1 });
		this.rebuildIndex();
		return { ok: true, value: {}, next: "run /sym complete to verify against the integrated revision" };
	}

	/** V01-COMP-001: verify the declared revision and rerun post-integration checks. */
	async completeTask(input: { taskId: string; integratedRevision?: string }): Promise<CommandResult<{ stage: TaskStage }>> {
		const task = this.getTask(input.taskId);
		if (!task.ok) return { ok: false, error: task.error };
		if (task.value.frontmatter.stage !== "postverify") {
			return { ok: false, error: "completion runs from post-integration verify" };
		}
		const integration = task.value.frontmatter.integration;
		if (!integration) return { ok: false, error: "no integration record — record integration first" };
		const onBranch = await revisionOnBranch(this.deps.gitExec, this.deps.repoRoot, integration.revision, integration.targetBranch);
		if (!onBranch.present) {
			return { ok: false, error: `integrated revision ${integration.revision.slice(0, 10)} is no longer present on ${integration.targetBranch}` };
		}
		const revision = await this.currentRevision();
		if (revision && revision !== integration.revision) {
			// checkout must be at the integrated revision for post-integration checks
			return {
				ok: false,
				error: `current checkout is ${revision.slice(0, 10)} but integration declares ${integration.revision.slice(0, 10)}; check out the integrated revision and retry`,
			};
		}
		const checks = await this.runCheckSet(input.taskId, "postIntegration");
		if (!checks.ok) return { ok: false, error: checks.error };
		const gate = evaluateGate(
			"postverify",
			"done",
			this.evidenceFor(input.taskId, task.value.frontmatter.risks, revision),
			this.config,
		);
		if (!gate.ok) return { ok: false, error: `cannot complete: ${gate.reason}` };
		const closeoutExtras: string[] = [
			`Completed at ${new Date().toISOString()}`,
			`Integrated revision: ${integration.revision} on ${integration.targetBranch}`,
			...Object.values(checks.value!).map((run) => `- ${run.check}: ${run.status}`),
		];
		const beforeClose = this.getTask(input.taskId);
		const closeRevision = beforeClose.ok ? beforeClose.value.frontmatter.revision : task.value.frontmatter.revision;
		try {
			writeTaskFileAtomic(
				join(this.paths.tasksDir, taskFileName(input.taskId)),
				(parsed) => {
					parsed.frontmatter.stage = "done";
					setManagedSection(parsed, "closeout", renderManagedSection("closeout", undefined, closeoutExtras));
				},
				{ expectedRevision: closeRevision },
			);
		} catch (err) {
			return this.handleWriteError(err);
		}
		this.ledger.append(input.taskId, "task.stage_changed", { from: "postverify", to: "done" }, { aggregateRevision: closeRevision + 1 });
		this.rebuildIndex();
		return { ok: true, value: { stage: "done" }, next: "task closed with full evidence trail" };
	}

	// ---------------------------------------------------------------------------
	// Projections (TUI + future HTML)
	// ---------------------------------------------------------------------------

	widgetLines(): string[] {
		if (!this.initialized) return ["SYMPHONY  not initialized — /sym init"];
		const tasks = this.listTasks();
		const active = tasks.find((t) => !["done", "cancelled"].includes(t.stage));
		if (!active) {
			return [`SYMPHONY  ${tasks.length} task(s) · no active task · /sym new`];
		}
		const acDone = active.acceptance.length; // AC progress detailed in overlay
		const checks = this.checkRuns.get(active.id);
		const checkState = checks && checks.size > 0
			? [...checks.values()].every((r) => r.status === "passed")
				? "checks green"
				: "checks not green"
			: "checks not run";
		const runIcon = active.runState === "running" ? "●" : active.runState === "interrupted" ? "⚠" : active.runState === "waiting" ? "…" : " ";
		return [
			`SYMPHONY  ${active.id} · ${active.stage.toUpperCase()} · ${runIcon} ${active.runState}`,
			`${active.title.slice(0, 60)} · AC ${acDone}/${active.acceptance.length} · ${checkState}`,
		];
	}

	async nextStep(taskId?: string): Promise<{ action: string; detail: string } | undefined> {
		const tasks = this.listTasks();
		const target = taskId ? tasks.find((t) => t.id === taskId) : tasks.find((t) => !["done", "cancelled"].includes(t.stage));
		if (!target) return undefined;
		const revision = await this.currentRevision();
		const evidence = this.evidenceFor(target.id, target.risks, revision);
		return nextAction(target.stage, evidence, this.config);
	}

	/** Bounded context manifest for the fresh reviewer (G04). */
	async buildReviewManifest(taskId: string): Promise<CommandResult<{ manifest: string }>> {
		const task = this.getTask(taskId);
		if (!task.ok) return { ok: false, error: task.error };
		const parsed = task.value.parsed;
		const diff = await boundedDiff(this.deps.gitExec, this.deps.repoRoot, 50_000);
		const summary = await diffSummary(this.deps.gitExec, this.deps.repoRoot);
		const revision = await this.currentRevision();
		const manifest = [
			"# Symphony review manifest",
			"",
			`## Task contract — ${task.value.frontmatter.id}: ${task.value.frontmatter.title}`,
			`Kind: ${task.value.frontmatter.kind} · Stage: ${task.value.frontmatter.stage}`,
			"",
			"### Acceptance criteria",
			...task.value.frontmatter.acceptance.map((a, i) => `${i + 1}. ${a.text}`),
			task.value.frontmatter.risks.length > 0 ? "\n### Declared risks\n" + task.value.frontmatter.risks.map((r) => `- ${r}`).join("\n") : "",
			"",
			"### Plan",
			stripManagedMarkers(getManagedSection(parsed, "plan") ?? ""),
			"",
			"### Implementation report",
			stripManagedMarkers(getManagedSection(parsed, "implementation") ?? ""),
			"",
			"### Change summary",
			`${summary.filesChanged} files, +${summary.insertions}/-${summary.deletions} (revision ${revision ?? "none"})`,
			...summary.paths.slice(0, 50).map((p) => `- ${p.path} +${p.added}/-${p.removed}`),
			"",
			"### Diff",
			diff.text || "(no uncommitted changes)",
			"",
			"### Existing evidence",
			...[...(this.checkRuns.get(taskId)?.values() ?? [])].map((r) => `- ${r.check}: ${r.status} at ${r.revision ?? "none"}`),
		].join("\n");
		return { ok: true, value: { manifest } };
	}

	// ---------------------------------------------------------------------------
	// Internals
	// ---------------------------------------------------------------------------

	private replay(): void {
		if (!existsSync(this.paths.tasksDir)) return;
		for (const file of readdirSync(this.paths.tasksDir)) {
			if (!file.endsWith(".md")) continue;
			try {
				const fm = parseTaskFile(readFileSync(join(this.paths.tasksDir, file), "utf8")).frontmatter;
				const events = this.ledger.read(fm.id);
				this.restoreFromEvents(fm.id, events);
			} catch {
				// skip unreadable
			}
		}
	}

	private restoreFromEvents(taskId: string, events: SymphonyEvent[]): void {
		let attempt: AttemptRecord | undefined;
		for (const event of events) {
			switch (event.type) {
				case "approval.resolved":
					if (event.data["approved"]) {
						this.approvals.set(`${taskId}:${String(event.data["scope"])}`, {
							id: event.eventId,
							scope: String(event.data["scope"]),
							taskId,
							actor: String(event.data["actor"] ?? "unknown"),
							inputRevision: event.aggregateRevision,
							configHash: String(event.data["configHash"] ?? ""),
							approvedAt: event.emittedAt,
						});
					}
					break;
				case "attempt.started":
					attempt = {
						id: event.attemptId ?? "unknown",
						taskId,
						stage: String(event.data["stage"]) as Stage,
						status: "running",
						startedAt: event.emittedAt,
						tryNumber: Number(event.data["tryNumber"] ?? 1),
						pinnedConfigHash: "",
					};
					this.attempts.set(attempt.id, attempt);
					break;
				case "attempt.completed":
				case "attempt.interrupted": {
					const id = event.attemptId;
					const record = id ? this.attempts.get(id) : attempt;
					if (record) {
						record.status = String(event.data["status"]) as AttemptRecord["status"];
						record.endedAt = event.emittedAt;
					}
					break;
				}
				case "report.submitted":
					{
						const sections = this.reports.get(taskId) ?? new Set<ManagedSection>();
						sections.add(String(event.data["section"]) as ManagedSection);
						this.reports.set(taskId, sections);
					}
					break;
				case "check.completed":
					this.recordCheckEvidenceFromEvent(taskId, event);
					break;
				default:
					break;
			}
		}
	}

	private recordCheckEvidenceFromEvent(taskId: string, event: SymphonyEvent): void {
		// Full evidence lives on disk; ledger keeps status for gate freshness.
		const runs = this.checkRuns.get(taskId) ?? new Map<string, CheckRunEvidence>();
		const name = String(event.data["check"] ?? "");
		const existing = runs.get(name);
		runs.set(name, {
			check: name,
			runId: String(event.data["runId"] ?? ""),
			status: String(event.data["status"]) as CheckRunEvidence["status"],
			exitCode: null,
			durationMs: 0,
			startedAt: event.emittedAt,
			finishedAt: event.emittedAt,
			output: existing?.output ?? "",
			truncated: false,
			revision: (event.data["revision"] as string | null) ?? null,
			command: [],
		});
		this.checkRuns.set(taskId, runs);
		// Rehydrate full artifacts from disk when available.
		const dir = this.paths.checksDir(taskId);
		if (existsSync(dir)) {
			for (const file of readdirSync(dir)) {
				if (!file.startsWith(`${name}-`) || !file.endsWith(".json")) continue;
				try {
					const evidence = JSON.parse(readFileSync(join(dir, file), "utf8")) as CheckRunEvidence;
					const current = runs.get(name);
					if (!current || (evidence.finishedAt ?? "") >= (current.finishedAt ?? "")) runs.set(name, evidence);
				} catch {
					// ignore corrupt artifacts; marked broken at projection time
				}
			}
		}
	}

	private handleWriteError(err: unknown): CommandResult<never> {
		if (err instanceof TaskConflictError) {
			return { ok: false, error: err.message, next: "reload the task (external change detected); both versions preserved" };
		}
		return { ok: false, error: (err as Error).message };
	}

	private rebuildIndex(): void {
		const tasks = this.listTasks();
		const index = tasks.map((t) => ({
			id: t.id,
			title: t.title,
			stage: t.stage,
			runState: t.runState,
			updatedAt: t.updatedAt,
		}));
		mkdirSync(this.paths.cacheDir, { recursive: true });
		const tmp = `${this.paths.taskIndex}.tmp`;
		writeFileSync(tmp, JSON.stringify(index, null, "\t"), "utf8");
		renameSync(tmp, this.paths.taskIndex);
	}
}

function stripManagedMarkers(text: string): string {
	return text
		.replace(/^<!-- symphony:[a-z]+:start -->\n?/m, "")
		.replace(/\n?<!-- symphony:[a-z]+:end -->$/m, "")
		.trim();
}

function serializeConfigYaml(config: SymphonyConfig): string {
	// Render with snake_case keys matching the documented schema.
	const lines: string[] = ["# Symphony configuration (schema v1)", `version: 1`, ""];
	lines.push("project:");
	lines.push(`  name: ${yamlScalar(config.project.name)}`);
	lines.push(`  task_prefix: ${config.project.taskPrefix}`);
	lines.push(`  target_branch: ${config.project.targetBranch}`);
	lines.push("ui:");
	lines.push(`  widget: ${config.ui.widget}`);
	lines.push(`  density: ${config.ui.density}`);
	lines.push("workspace:");
	lines.push(`  mode: ${config.workspace.mode}`);
	lines.push(`  max_active_tasks: ${config.workspace.maxActiveTasks}`);
	lines.push("workflow:");
	lines.push(`  preset: ${config.workflow.preset}`);
	lines.push(`  plan_approval: ${config.workflow.planApproval}`);
	lines.push(`  review_medium_policy: ${config.workflow.reviewMediumPolicy}`);
	lines.push(`  completion: ${config.workflow.completion}`);
	lines.push("roles:");
	for (const [role, cfg] of Object.entries(config.roles)) {
		lines.push(`  ${role}:`);
		lines.push(`    session: ${cfg.session}`);
		lines.push(`    model: ${cfg.model}`);
		lines.push(`    thinking: ${cfg.thinking}`);
		lines.push(`    max_turns: ${cfg.maxTurns}`);
		if ("tools" in cfg && cfg.tools) lines.push(`    tools: [${cfg.tools.map((t) => yamlScalar(t)).join(", ")}]`);
	}
	lines.push("commands:");
	for (const [name, def] of Object.entries(config.commands)) {
		lines.push(`  ${name}:`);
		lines.push(`    argv: [${def.argv.map((a) => yamlScalar(a)).join(", ")}]`);
		lines.push(`    timeout_ms: ${def.timeoutMs}`);
		if (def.required) lines.push(`    required: true`);
	}
	lines.push("checks:");
	lines.push(`  verify: [${config.checks.verify.map((c) => yamlScalar(c)).join(", ")}]`);
	lines.push(`  post_integration: [${config.checks.postIntegration.map((c) => yamlScalar(c)).join(", ")}]`);
	lines.push("security:");
	lines.push(`  protected_paths: [${config.security.protectedPaths.map((p) => yamlScalar(p)).join(", ")}]`);
	if (config.security.protectedPathPolicy) lines.push(`  protected_path_policy: ${config.security.protectedPathPolicy}`);
	lines.push("limits:");
	lines.push(`  max_child_sessions: ${config.limits.maxChildSessions}`);
	lines.push(`  max_stage_retries: ${config.limits.maxStageRetries}`);
	return lines.join("\n") + "\n";
}

function yamlScalar(value: string): string {
	return /^[A-Za-z0-9_./@-]+$/.test(value) ? value : JSON.stringify(value);
}
