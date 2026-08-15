/**
 * Symphony for Pi — extension entry point.
 *
 * The TUI is a pure adapter: every mutation goes through SymphonyCore, every
 * projection is rebuilt from typed events + task files (V01-CORE-001). The
 * same seam will serve the v0.2 HTML client.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SymphonyCore } from "../core.ts";
import { proposeInit } from "../init.ts";
import { SdkReviewerRunner } from "../reviewer.ts";
import { getManagedSection } from "../tasks.ts";
import { taskFileName } from "../paths.ts";
import { join } from "node:path";
import type { Stage } from "../types.ts";
import { registerSymphonyTools } from "./tools.ts";
import { SymphonyOverlay, type OverlayAction, type OverlayModel } from "./overlay.ts";
import { buildBrief, configIssuesText, doctorLines, nextStepLine, planBrief, taskDetailPanes } from "./presentation.ts";
import { classifyWrite, escapesCwd, findDestructiveCommand, pathRelativeTo, realpathOrSelf, redirectTargets, resolveToolPath } from "./guard.ts";
import { WebControlPlane } from "../web/server.ts";

const SUBCOMMANDS = [
	"init",
	"new",
	"continue",
	"status",
	"doctor",
	"recover",
	"complete",
	"checks",
	"pause",
	"resume",
	"retry",
	"cancel",
	"web",
] as const;

export default function symphonyExtension(pi: ExtensionAPI): void {
	let core: SymphonyCore | undefined;
	let coreCwd: string | undefined;
	let sessionId = "unknown";
	let webPlane: WebControlPlane | undefined;

	function gitExecFactory(ctx: ExtensionContext) {
		return async (argv: string[], options?: { cwd?: string; timeoutMs?: number }) => {
			const { assertReadOnlyGit } = await import("../gitinfo.ts");
			assertReadOnlyGit(argv);
			const result = await pi.exec(argv[0]!, argv.slice(1), {
				cwd: options?.cwd ?? ctx.cwd,
				timeout: options?.timeoutMs ?? 15_000,
			});
			return { code: result.code, stdout: result.stdout, stderr: result.stderr };
		};
	}

	function ensureCore(ctx: ExtensionContext): SymphonyCore {
		if (!core || coreCwd !== ctx.cwd) {
			core = new SymphonyCore({
				repoRoot: ctx.cwd,
				ui: {
					notify: (message, level) => ctx.ui.notify(message, level ?? "info"),
					select: async (title, options) => ctx.ui.select(title, options),
					confirm: async (title, message) => ctx.ui.confirm(title, message),
				},
				gitExec: gitExecFactory(ctx),
				sessionId,
			});
			coreCwd = ctx.cwd;
		}
		return core;
	}

	function refreshWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !core) return;
		if (!core.initialized) {
			ctx.ui.setWidget("symphony", undefined);
			return;
		}
		ctx.ui.setWidget("symphony", core.widgetLines());
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown";
		const c = ensureCore(ctx);
		if (c.initialized) {
			const recovery = c.recover();
			const interrupted = recovery.ok ? recovery.value.interrupted : [];
			if (interrupted.length > 0) {
				ctx.ui.notify(
					`Symphony: recovered ${interrupted.length} interrupted attempt(s): ${interrupted.join(", ")}. Run /sym continue to resume, retry, inspect, or cancel.`,
					"warning",
				);
			}
		}
		refreshWidget(ctx);
	});

	pi.on("session_shutdown", async () => {
		await webPlane?.stop();
		webPlane = undefined;
		core?.shutdown();
		core = undefined;
		coreCwd = undefined;
	});

	// -----------------------------------------------------------------------
	// Safety guard (V01-SAFE-001)
	// -----------------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		if (!core?.initialized) return;
		const policy = {
			protectedPaths: core.config.security.protectedPaths,
			policy: core.config.security.protectedPathPolicy ?? "confirm",
		};
		const decidePath = async (rawPath: string, tool: string) => {
			// Resolve through symlinks and re-derive the relative path so
			// aliases and ../ traversals land on the same classification.
			const absolute = resolveToolPath(ctx.cwd, rawPath);
			const real = realpathOrSelf(absolute);
			const rel = pathRelativeTo(ctx.cwd, real);
			const escaped = escapesCwd(ctx.cwd, real);
			const decision = classifyWrite(rel, policy);
			if (decision === "block" || (escaped && classifyWrite(absolute, policy) !== "allow")) {
				return { block: true, reason: `Symphony: "${rel}" is protected workflow state (tasks/evidence/config/git); model writes are not allowed` };
			}
			if (decision === "confirm") {
				const ok = await ctx.ui.confirm(
					"Symphony protected path",
					`Allow ${tool} to modify protected path "${rel}" in ${ctx.cwd}?`,
				);
				if (!ok) return { block: true, reason: `User declined protected-path write to ${rel}` };
			}
			return undefined;
		};
		if (event.toolName === "write" || event.toolName === "edit") {
			const input = event.input as { path?: string };
			if (typeof input.path === "string") {
				const decision = await decidePath(input.path, event.toolName);
				if (decision) return decision;
			}
			return;
		}
		if (event.toolName === "bash") {
			const input = event.input as { command?: string };
			if (typeof input.command === "string") {
				const command = input.command;
				const label = findDestructiveCommand(command);
				if (label) {
					const ok = await ctx.ui.confirm(
						"Symphony: destructive command",
						`Allow "${label}" in ${ctx.cwd}? This extension is not a sandbox; it runs with your permissions.`,
					);
					if (!ok) return { block: true, reason: `User declined ${label}` };
				}
				// Redirect/tee/dd targets aimed at protected state are blocked.
				for (const target of redirectTargets(command)) {
					const decision = await decidePath(target, "bash redirect");
					if (decision) return decision;
				}
			}
		}
	});

	// -----------------------------------------------------------------------
	// /sym command router
	// -----------------------------------------------------------------------

	pi.registerCommand("sym", {
		description: "Symphony workflow: /sym [init|new|continue|status|doctor|complete|checks|pause|resume|retry|cancel|recover]",
		getArgumentCompletions: (prefix: string) => {
			const items = [...SUBCOMMANDS, ""].map((s) => ({ value: s, label: s || "(overlay)" }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const c = ensureCore(ctx);
			try {
				switch (sub) {
					case undefined:
					case "":
						return await openOverlay(pi, ctx, c);
					case "init":
						return await cmdInit(ctx, c);
					case "new":
						return await cmdNew(ctx, c);
					case "continue":
						return await cmdContinue(ctx, c);
					case "status":
						return cmdStatus(ctx, c);
					case "doctor":
						return cmdDoctor(ctx, c);
					case "recover":
						return cmdRecover(ctx, c);
					case "complete":
						return await cmdComplete(ctx, c, rest[0]);
					case "checks":
						return await cmdChecks(ctx, c, rest[0] === "post" ? "postIntegration" : "verify");
					case "pause":
						return cmdPause(ctx, c);
					case "resume":
					case "retry":
						return await cmdResume(ctx, c, sub);
					case "cancel":
						return await cmdCancel(ctx, c);
					case "web":
						return await cmdWeb(ctx, c, rest[0]);
					default:
						ctx.ui.notify(`Symphony: unknown subcommand "${sub}". Try /sym for the overlay.`, "warning");
				}
			} finally {
				refreshWidget(ctx);
			}
		},
	});

	registerSymphonyTools(pi, (ctx) => ensureCore(ctx));

	// -----------------------------------------------------------------------
	// Command implementations
	// -----------------------------------------------------------------------

	async function cmdInit(ctx: ExtensionContext, c: SymphonyCore): Promise<void> {
		if (c.configIssues.length > 0 && c.initialized) {
			ctx.ui.notify(`Symphony config is invalid:\n${configIssuesText(c.configIssues)}\n/sym doctor shows repair guidance. Read-only inspection stays available.`, "warning");
		}
		const proposal = await proposeInit(ctx.cwd, c.deps.gitExec);
		const lines = [
			`Project: ${proposal.projectName}`,
			`Git repository: ${proposal.isGitRepo ? "yes" : "no — git evidence will show unavailable"}`,
			`Target branch: ${proposal.targetBranch}`,
			`Task prefix: ${proposal.taskPrefix}`,
			"Proposed checks (executable + arguments, mandatory timeouts):",
			...proposal.suggestedChecks.map((ch) => `  - ${ch.name}: ${ch.argv.join(" ")} (${ch.note})`),
			...(proposal.warnings.length > 0 ? ["Warnings:", ...proposal.warnings.map((w) => `  ! ${w}`)] : []),
			"",
			"No project scripts are executed during init. Only .symphony/ files are created.",
		];
		ctx.ui.notify(`Symphony init proposal:\n${lines.join("\n")}`, "info");
		const proceed = await ctx.ui.confirm("Initialize Symphony?", `Create .symphony/ in ${ctx.cwd} with the proposed configuration?`);
		if (!proceed) return;
		const prefix = await ctx.ui.input("Task id prefix:", "DEV");
		const branch = await ctx.ui.input("Target branch:", proposal.targetBranch);
		const result = await c.initialize({
			taskPrefix: prefix || "DEV",
			targetBranch: branch || proposal.targetBranch,
			checks: proposal.suggestedChecks,
		});
		ctx.ui.notify(
			result.ok
				? `Symphony initialized${result.value.backedUp ? ` (previous config backed up: ${result.value.backedUp})` : ""}. ${result.next ?? ""}`
				: `Init failed: ${result.error}`,
			result.ok ? "info" : "error",
		);
	}

	async function cmdNew(ctx: ExtensionContext, c: SymphonyCore): Promise<void> {
		if (c.configIssues.length > 0) {
			ctx.ui.notify(`Symphony config is invalid — /sym doctor. Creation blocked.`, "error");
			return;
		}
		if (!c.initialized) {
			ctx.ui.notify("Symphony is not initialized. Run /sym init first.", "warning");
			return;
		}
		const title = await ctx.ui.input("Task title:", "short imperative summary");
		if (!title) return;
		const kindChoice = await ctx.ui.select("Task kind:", ["feature", "bug", "refactor", "review"]);
		if (!kindChoice) return;
		const acceptanceRaw = await ctx.ui.editor("Acceptance criteria (one per line):", "");
		if (acceptanceRaw === undefined) return;
		const acceptance = acceptanceRaw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
		const risksRaw = await ctx.ui.editor("Declared risks (one per line, empty if none):", "");
		const risks = (risksRaw ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
		const result = c.createTask({ title, kind: kindChoice as "feature", acceptance, risks });
		ctx.ui.notify(result.ok ? `Task ${result.value.id} created (backlog). ${result.next ?? ""}` : `Failed: ${result.error}`, result.ok ? "info" : "error");
	}

	async function cmdContinue(ctx: ExtensionContext, c: SymphonyCore): Promise<void> {
		if (!c.initialized) {
			ctx.ui.notify("Symphony is not initialized. Run /sym init.", "warning");
			return;
		}
		if (c.configIssues.length > 0) {
			ctx.ui.notify(`Config invalid — read-only mode. Run /sym doctor.\n${configIssuesText(c.configIssues)}`, "error");
			return;
		}
		const tasks = c.listTasks();
		let task = tasks.find((t) => !["done", "cancelled"].includes(t.stage));
		if (!task) {
			ctx.ui.notify("No active task. /sym new creates one.", "info");
			return;
		}
		if (tasks.filter((t) => !["done", "cancelled"].includes(t.stage)).length > 1 && ctx.hasUI) {
			const choice = await ctx.ui.select("Active task:", tasks.filter((t) => !["done", "cancelled"].includes(t.stage)).map((t) => `${t.id} — ${t.title} (${t.stage})`));
			if (!choice) return;
			task = tasks.find((t) => choice.startsWith(t.id)) ?? task;
		}

		// Interrupted recovery path (V01-REC-001): explicit choice, no auto-resume.
		if (task.runState === "interrupted") {
			const choice = await ctx.ui.select(`Task ${task.id} was interrupted during ${task.stage}.`, ["Resume stage (continue same attempt)", "Retry stage (new attempt)", "Inspect task", "Cancel task"]);
			if (!choice) return;
			if (choice === "Inspect task") return cmdStatus(ctx, c, task.id);
			if (choice === "Cancel task") return cmdCancel(ctx, c, task.id);
			if (choice.startsWith("Resume stage")) {
				// Resume continues the interrupted attempt — no retry budget spent.
				const latest = latestAttempt(c, task.id);
				if (latest) {
					const resumed = c.resumeAttempt(task.id, latest);
					if (resumed.ok) {
						ctx.ui.notify(`Attempt ${latest} resumed for ${task.id}.`, "info");
						return; // stage dispatch happens on the next continue
					}
					return ctx.ui.notify(`Resume failed: ${resumed.error}`, "warning");
				}
				c.setRunState(task.id, "idle");
			} else {
				c.setRunState(task.id, "idle");
				// Retry falls through to stage dispatch with a fresh attempt
			}
		}

		switch (task.stage) {
			case "backlog": {
				const started = c.transition(task.id, "plan");
				if (!started.ok) return ctx.ui.notify(`Cannot start planning: ${started.error}`, "error");
				const attempt = c.startAttempt(task.id, "plan");
				if (!attempt.ok) return ctx.ui.notify(attempt.error, "error");
				const fresh = c.getTask(task.id);
				if (fresh.ok) pi.sendUserMessage(planBrief(fresh.value.frontmatter));
				ctx.ui.notify(`Symphony: planning ${task.id} in this session. The plan arrives via sym_plan_submit.`, "info");
				return;
			}
			case "plan": {
				const detail = c.getTask(task.id);
				const hasPlan = c.hasReport(task.id, "plan");
				if (!hasPlan) {
					if (c.startAttempt(task.id, "plan") && !c.getTask(task.id).ok) {
						return ctx.ui.notify("Plan attempt limit reached — /sym retry or /sym cancel", "warning");
					}
					const detailNow = c.getTask(task.id);
					pi.sendUserMessage(planBrief(detailNow.ok ? detailNow.value.frontmatter : task));
					return ctx.ui.notify(`Symphony: submit the plan with sym_plan_submit (task ${task.id}).`, "info");
				}
				// plan present: approval or build
				const needsApproval = task.risks.length > 0 && c.config.workflow.planApproval === "risks_only" || c.config.workflow.planApproval === "always";
				if (needsApproval) {
					const choice = await ctx.ui.select(`Approve plan for ${task.id}?`, ["Approve — start build", "Reject — keep planning"]);
					if (choice?.startsWith("Approve")) {
						const approved = c.resolveApproval({ taskId: task.id, scope: "plan", actor: "user", approved: true });
						if (approved.ok) {
							const fresh = c.getTask(task.id);
							if (fresh.ok) {
								const attempt = c.startAttempt(task.id, "build");
								if (attempt.ok) pi.sendUserMessage(buildBrief(fresh.value.frontmatter));
							}
							return ctx.ui.notify(approved.next ?? "", "info");
						}
						return ctx.ui.notify(`Approval failed: ${approved.error}`, "error");
					}
					return ctx.ui.notify("Plan stays pending approval.", "info");
				}
				const moved = c.transition(task.id, "build");
				if (moved.ok) {
					const fresh = c.getTask(task.id);
					if (fresh.ok) {
						c.startAttempt(task.id, "build");
						pi.sendUserMessage(buildBrief(fresh.value.frontmatter));
					}
				}
				return;
			}
			case "build": {
				const attempt = c.startAttempt(task.id, "build");
				if (!attempt.ok) return ctx.ui.notify(attempt.error, "warning");
				pi.sendUserMessage(buildBrief(task));
				return ctx.ui.notify(`Symphony: building ${task.id}. Report via sym_build_report when done.`, "info");
			}
			case "review": {
				return await runFreshReview(ctx, c, task.id);
			}
			case "verify": {
				ctx.ui.notify(`Symphony: running required checks for ${task.id}…`, "info");
				const advanced = await c.advanceToReady(task.id);
				if (advanced.ok) return ctx.ui.notify(`Task ${task.id} is Ready. Integrate manually, then record the integration from the overlay or /sym status.`, "info");
				return ctx.ui.notify(`Cannot reach Ready: ${advanced.error}`, "error");
			}
			case "ready": {
				const snapshot = await import("../gitinfo.ts").then((m) => m.gitSnapshot(c.deps.gitExec, ctx.cwd));
				ctx.ui.notify(
					[
						`Symphony: ${task.id} is Ready. Manual integration checklist:`,
						`1. Merge/apply the change into "${task.targetBranch ?? c.config.project.targetBranch}" yourself.`,
						"2. Return to the overlay (or /sym complete <revision>) and record the integrated commit.",
						"3. Symphony verifies the revision is on the target branch and reruns post-integration checks.",
						`Current checkout: ${snapshot.branch ?? "no branch"} @ ${snapshot.revision?.slice(0, 10) ?? "none"}${snapshot.dirty ? " (dirty)" : ""}`,
					].join("\n"),
					"info",
				);
				return;
			}
			case "postverify": {
				const completed = await c.completeTask({ taskId: task.id });
				if (completed.ok) return ctx.ui.notify(`Task ${task.id} is Done. Evidence trail closed.`, "info");
				return ctx.ui.notify(`Cannot complete: ${completed.error}`, "error");
			}
			default:
				ctx.ui.notify(`Task ${task.id} is ${task.stage}.`, "info");
		}
	}

	async function runFreshReview(ctx: ExtensionContext, c: SymphonyCore, taskId: string): Promise<void> {
		const manifestResult = await c.buildReviewManifest(taskId);
		if (!manifestResult.ok) return ctx.ui.notify(`Review manifest failed: ${manifestResult.error}`, "error");
		const attempt = c.startAttempt(taskId, "review" as Stage);
		if (!attempt.ok) return ctx.ui.notify(attempt.error, "warning");
		ctx.ui.notify(`Symphony: starting fresh reviewer session for ${taskId} (no implementer transcript)…`, "info");
		const reviewerRole = c.config.roles.reviewer;
		const runner = new SdkReviewerRunner({
			model: reviewerRole.model,
			thinking: reviewerRole.thinking,
			maxTurns: reviewerRole.maxTurns,
			tools: reviewerRole.tools?.length ? reviewerRole.tools : ["read", "grep", "find", "ls"],
			repoRoot: ctx.cwd,
		});
		try {
			const report = await runner.run(manifestResult.ok ? manifestResult.value.manifest : "", { taskId });
			const persist = persistReviewReport(c, taskId, report);
			if (!persist.ok) return ctx.ui.notify(persist.error ?? "persist failed", "error");
			const blocking = report.findings.filter((f) => f.severity === "blocker" || f.severity === "major");
			if (report.verdict === "approved" && blocking.length === 0) {
				const moved = c.transition(taskId, "verify");
				if (attempt.ok) c.completeAttempt(taskId, attempt.value.attemptId, "passed");
				ctx.ui.notify(`Review approved: task ${taskId} → verify. Findings recorded (${report.findings.length}).`, "info");
			} else {
				if (attempt.ok) c.completeAttempt(taskId, attempt.value.attemptId, "failed");
				ctx.ui.notify(
					`Review requested changes (${blocking.length} blocking). Task stays in review. Address findings, submit a new sym_build_report.`,
					"warning",
				);
			}
		} catch (err) {
			if (attempt.ok) c.interruptAttempt(taskId, attempt.value.attemptId);
			ctx.ui.notify(`Reviewer failed: ${(err as Error).message}. Attempt marked interrupted — /sym continue offers retry.`, "error");
		}
	}

	function latestAttempt(c: SymphonyCore, taskId: string): string | undefined {
		const events = c.ledger.read(taskId);
		const started = events.filter((e) => e.type === "attempt.started" && e.attemptId);
		return started[started.length - 1]?.attemptId;
	}

	function cmdStatus(ctx: ExtensionContext, c: SymphonyCore, taskId?: string): void {
		if (!c.initialized) return void ctx.ui.notify("Symphony not initialized — /sym init", "info");
		const tasks = c.listTasks();
		if (tasks.length === 0) return void ctx.ui.notify("No tasks. /sym new creates one.", "info");
		const target = taskId ?? tasks.find((t) => !["done", "cancelled"].includes(t.stage))?.id ?? tasks[0]!.id;
		const detail = c.getTask(target);
		if (!detail.ok) return void ctx.ui.notify(detail.error, "error");
		const checks = c.checkRunsFor(target);
		const sections: Record<string, string | undefined> = {};
		for (const seg of detail.value.parsed.segments) if (seg.kind === "managed") sections[seg.section] = seg.text;
		const panes = taskDetailPanes(detail.value.frontmatter, sections, checks);
		ctx.ui.notify(
			[`Symphony ${target} — ${detail.value.frontmatter.stage} (${detail.value.frontmatter.runState})`, ...panes.overview, ...panes.checks].join("\n"),
			"info",
		);
	}

	function cmdDoctor(ctx: ExtensionContext, c: SymphonyCore): void {
		const report = c.doctor();
		ctx.ui.notify(["Symphony doctor:", ...doctorLines(report)].join("\n"), report.every((r) => r.ok) ? "info" : "warning");
	}

	function cmdRecover(ctx: ExtensionContext, c: SymphonyCore): void {
		const result = c.recover();
		const value = result.ok ? result.value : { interrupted: [] as string[], reclaimedLease: false };
		ctx.ui.notify(
			`Recovery: ${value.interrupted.length} interrupted attempt(s), lease reclaimed: ${value.reclaimedLease}.`,
			"info",
		);
	}

	async function cmdComplete(ctx: ExtensionContext, c: SymphonyCore, revisionArg?: string): Promise<void> {
		const tasks = c.listTasks().filter((t) => !["done", "cancelled"].includes(t.stage));
		if (tasks.length === 0) return void ctx.ui.notify("No active task.", "info");
		const task = tasks[0]!;
		if (task.stage === "ready") {
			const revision = revisionArg ?? (await ctx.ui.input("Integrated revision (commit on target branch):", "HEAD"));
			if (!revision) return;
			const recorded = await c.recordIntegration({ taskId: task.id, revision, actor: "user" });
			if (!recorded.ok) return void ctx.ui.notify(`Integration rejected: ${recorded.error}`, "error");
			ctx.ui.notify(`Integration recorded. Running post-integration verification…`, "info");
		}
		const completed = await c.completeTask({ taskId: task.id });
		ctx.ui.notify(completed.ok ? `Task ${task.id} done.` : `Cannot complete: ${completed.error}`, completed.ok ? "info" : "error");
	}

	async function cmdChecks(ctx: ExtensionContext, c: SymphonyCore, set: "verify" | "postIntegration"): Promise<void> {
		const task = c.listTasks().find((t) => !["done", "cancelled"].includes(t.stage));
		if (!task) return void ctx.ui.notify("No active task.", "info");
		ctx.ui.notify(`Running ${set} checks for ${task.id}…`, "info");
		const result = await c.runCheckSet(task.id, set);
		if (!result.ok) return void ctx.ui.notify(result.error, "error");
		const lines = Object.values(result.value).map((r) => `${r.check}: ${r.status} (${r.durationMs}ms, exit ${r.exitCode ?? "n/a"})`);
		const allPassed = Object.values(result.value).every((r) => r.status === "passed");
		ctx.ui.notify([`Checks for ${task.id}:`, ...lines].join("\n"), allPassed ? "info" : "warning");
	}

	function cmdPause(ctx: ExtensionContext, c: SymphonyCore, taskId?: string): void {
		const task = taskId ?? c.listTasks().find((t) => !["done", "cancelled"].includes(t.stage))?.id;
		if (!task) return void ctx.ui.notify("No active task.", "info");
		const result = c.setRunState(task, "waiting");
		ctx.ui.notify(result.ok ? `Task ${task} paused (Waiting).` : result.error!, result.ok ? "info" : "error");
	}

	async function cmdResume(ctx: ExtensionContext, c: SymphonyCore, mode: "resume" | "retry"): Promise<void> {
		const task = c.listTasks().find((t) => !["done", "cancelled"].includes(t.stage));
		if (!task) return void ctx.ui.notify("No active task.", "info");
		c.setRunState(task.id, "idle");
		if (mode === "retry") {
			// clear interrupted attempt bookkeeping; next continue starts fresh
			ctx.ui.notify(`Retry ${task.id} (${task.stage}) — run /sym continue.`, "info");
			return;
		}
		await cmdContinue(ctx, c);
	}

	async function cmdWeb(ctx: ExtensionContext, c: SymphonyCore, action?: string): Promise<void> {
		if (action === "stop") {
			if (webPlane) {
				await webPlane.stop();
				webPlane = undefined;
				ctx.ui.notify("Symphony web UI stopped.", "info");
			} else {
				ctx.ui.notify("Symphony web UI is not running.", "info");
			}
			return;
		}
		if (action === "status") {
			return void ctx.ui.notify(
				webPlane ? "Symphony web UI: running (loopback)" : "Symphony web UI: stopped",
				"info",
			);
		}
		if (webPlane) {
			if (action === "open") {
				const url = (webPlane as unknown as { lastUrl?: string }).lastUrl;
				if (url) {
					try {
						const { exec } = await import("node:child_process");
						const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
						exec(`${open} "${url}"`);
						return void ctx.ui.notify("Symphony web UI opened in your browser.", "info");
					} catch {
						return void ctx.ui.notify(`Open manually: ${url}`, "info");
					}
				}
			}
			ctx.ui.notify(`Symphony web UI already running — /sym web status`, "info");
			return;
		}
		try {
			webPlane = new WebControlPlane(() => ensureCore(ctx));
			const started = await webPlane.start();
			(webPlane as unknown as { lastUrl?: string }).lastUrl = started.url;
			ctx.ui.notify(
				[
					"Symphony UI",
					started.url,
					`Repository: ${ctx.cwd}`,
					"Remote access: disabled (loopback only; not a sandbox boundary)",
				].join("\n"),
				"info",
			);
		} catch (err) {
			webPlane = undefined;
			ctx.ui.notify(`Failed to start web UI: ${(err as Error).message}`, "error");
		}
	}

	function cmdCancel(ctx: ExtensionContext, c: SymphonyCore, taskId?: string): void {
		const id = taskId ?? c.listTasks().find((t) => !["done", "cancelled"].includes(t.stage))?.id;
		if (!id) return void ctx.ui.notify("No active task.", "info");
		const result = c.transition(id, "cancelled");
		ctx.ui.notify(result.ok ? `Task ${id} cancelled.` : `Cancel failed: ${result.error}`, result.ok ? "info" : "error");
	}

	// -----------------------------------------------------------------------
	// Overlay
	// -----------------------------------------------------------------------

	function buildModel(c: SymphonyCore, selectedId?: string): OverlayModel {
		const tasks = c.listTasks();
		const checkRunsAll = { get: (id: string) => c.checkRunsFor(id) } as const;
		const overlayTasks = tasks.map((t) => {
			const checks = checkRunsAll.get(t.id);
			const summary =
				checks && checks.size > 0
					? [...checks.values()].every((r) => r.status === "passed")
						? "checks green"
						: "checks not green"
					: "checks not run";
			return {
				id: t.id,
				title: t.title,
				stage: t.stage,
				runState: t.runState,
				updatedAt: t.updatedAt,
				acceptanceTotal: t.acceptance.length,
				checksSummary: summary,
			};
		});
		const target = selectedId ?? tasks.find((t) => !["done", "cancelled"].includes(t.stage))?.id ?? tasks[0]?.id;
		const detail: OverlayModel["detail"] = { overview: [], contract: [], changes: [], review: [], checks: [], history: [] };
		if (target) {
			const t = c.getTask(target);
			if (t.ok) {
				const sections: Record<string, string | undefined> = {};
				for (const seg of t.value.parsed.segments) if (seg.kind === "managed") sections[seg.section] = seg.text;
				const panes = taskDetailPanes(t.value.frontmatter, sections, checkRunsAll.get(target) ?? new Map());
				for (const key of Object.keys(detail) as Array<keyof OverlayModel["detail"]>) {
					detail[key].push(...(panes[key] ?? []));
				}
			}
		}
		const actions = overlayActions(c, target);
		return { tasks: overlayTasks, detail, actions, status: c.widgetLines()[0] };
	}

	function overlayActions(c: SymphonyCore, taskId?: string): OverlayAction[] {
		if (!taskId) return [{ id: "new", label: "New task" }];
		const task = c.getTask(taskId);
		if (!task.ok) return [];
		const stage = task.value.frontmatter.stage;
		const base: OverlayAction[] = [{ id: "continue", label: "Continue ▸ next step" }];
		switch (stage) {
			case "ready":
				base.push({ id: "record-integration", label: "Record integration…" });
				break;
			case "postverify":
				base.push({ id: "complete", label: "Complete task (post-integration verify)" });
				break;
			case "verify":
				base.push({ id: "checks", label: "Run checks & advance to Ready" });
				break;
			default:
				break;
		}
		if (!["done", "cancelled"].includes(stage)) {
			base.push({ id: "cancel", label: "Cancel task" });
		}
		return base;
	}

	async function openOverlay(pi: ExtensionAPI, ctx: ExtensionContext, c: SymphonyCore): Promise<void> {
		let selectedId: string | undefined;
		const model = buildModel(c);
		if (ctx.mode !== "tui") {
			const lines = model.tasks.map((t) => `${t.id} ${t.stage} ${t.runState} — ${t.title}`);
			ctx.ui.notify(["Symphony tasks:", ...(lines.length ? lines : ["(none — /sym new)"])].join("\n"), "info");
			return;
		}
		const overlay = new SymphonyOverlay(model, () => {});
		const choice = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => ({
			render: (width: number) => overlay.render(width),
			handleInput: (data: string) => {
				overlay.handleInput(data);
				selectedId = overlay.selectedTaskId;
				tui.requestRender();
				if (overlay.isClosed) done(overlay.closeResult);
			},
			invalidate: () => overlay.invalidate(),
		}), { overlay: true });
		if (choice) await runOverlayAction(choice, ctx, c, selectedId);
	}

	async function runOverlayAction(actionId: string, ctx: ExtensionContext, c: SymphonyCore, selectedId?: string): Promise<void> {
		const all = c.listTasks();
		const task = (selectedId ? all.find((t) => t.id === selectedId) : undefined)
			?? all.find((t) => !["done", "cancelled"].includes(t.stage));
		switch (actionId) {
			case "new":
				return cmdNew(ctx, c);
			case "continue":
				return cmdContinue(ctx, c);
			case "checks":
				if (!task) return;
				return cmdChecks(ctx, c, "verify");
			case "record-integration": {
				if (!task) return;
				const revision = await ctx.ui.input(`Integrated revision for ${task.id} (commit on ${task.targetBranch ?? "target"}):`, "HEAD");
				if (!revision) return;
				const confirm = await ctx.ui.confirm(
					"Record integration",
					`Record ${revision} as integrated into ${task.targetBranch ?? c.config.project.targetBranch} for ${task.id}?`,
				);
				if (!confirm) return;
				const result = await c.recordIntegration({ taskId: task.id, revision, actor: "user" });
				ctx.ui.notify(result.ok ? `Recorded. ${result.next ?? ""}` : `Rejected: ${result.error}`, result.ok ? "info" : "error");
				return;
			}
			case "complete":
				if (!task) return;
				return cmdComplete(ctx, c);
			case "cancel":
				if (!task) return;
				return cmdCancel(ctx, c, task.id);
			default:
				ctx.ui.notify(`Unknown overlay action ${actionId}`, "warning");
		}
	}
}

function persistReviewReport(c: SymphonyCore, taskId: string, report: import("../reviewer.ts").ReviewReport): { ok: boolean; error?: string } {
	const result = c.submitReport({
		taskId,
		section: "review",
		summary: `${report.verdict.toUpperCase()} — ${report.summary}`,
		details: { verdict: report.verdict, findings: report.findings, sessionId: report.sessionId },
		origin: "fresh-reviewer",
	});
	return result.ok ? { ok: true } : { ok: false, error: result.error };
}
