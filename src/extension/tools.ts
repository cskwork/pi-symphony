import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { SymphonyCore } from "../core.ts";
import type { ManagedSection } from "../types.ts";

/**
 * Model-facing tools. V01-WF-002: the model can submit structured reports and
 * read state, but it can never force a transition — SymphonyCore validates
 * every report against the workflow contract before advancing.
 */

export function registerSymphonyTools(
	pi: ExtensionAPI,
	coreFor: (ctx: ExtensionContext) => SymphonyCore,
): void {
	pi.registerTool({
		name: "sym_task_read",
		label: "Symphony task",
		description:
			"Read the Symphony task record (contract, acceptance criteria, plan, reports, checks). Use for the active or a named task.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Task id like DEV-014; defaults to the active task" })),
		}),
		promptSnippet: "Read Symphony task contracts and reports",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const core = coreFor(ctx);
			const active = core.listTasks().find((t) => !["done", "cancelled"].includes(t.stage));
			const id = params.taskId ?? active?.id;
			if (!id) return { content: [{ type: "text", text: "No Symphony task exists yet. Ask the user to run /sym new." }], details: {} };
			const task = core.getTask(id);
			if (!task.ok) return { content: [{ type: "text", text: task.error! }], details: {} };
			const fm = task.value.frontmatter;
			const body = [
				`# ${fm.id}: ${fm.title}`,
				`kind: ${fm.kind} · stage: ${fm.stage} · run: ${fm.runState} · revision: ${fm.revision}`,
				"",
				"## Acceptance criteria",
				...fm.acceptance.map((a, i) => `${i + 1}. ${a.text}`),
				fm.risks.length > 0 ? "## Risks\n" + fm.risks.map((r) => `- ${r}`).join("\n") : "",
				"",
				task.value.parsed.segments
					.filter((s) => s.kind === "managed")
					.map((s) => s.text)
					.join("\n"),
			].join("\n");
			return {
				content: [{ type: "text", text: body.slice(0, 50_000) }],
				details: { taskId: fm.id, stage: fm.stage },
			};
		},
	});

	pi.registerTool({
		name: "sym_diff_read",
		label: "Symphony diff",
		description: "Read the working-tree diff summary and bounded diff text for evidence gathering.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const core = coreFor(ctx);
			const task = core.listTasks().find((t) => !["done", "cancelled"].includes(t.stage));
			if (!task) return { content: [{ type: "text", text: "No active task." }], details: {} };
			const manifest = await core.buildReviewManifest(task.id);
			if (!manifest.ok) return { content: [{ type: "text", text: manifest.error! }], details: {} };
			return {
				content: [{ type: "text", text: manifest.value.manifest.slice(0, 50_000) }],
				details: { taskId: task.id },
			};
		},
	});

	pi.registerTool({
		name: "sym_plan_submit",
		label: "Submit plan",
		description: "Submit a structured plan for the current Symphony task. The workflow engine validates and advances to build only when the contract (and approval policy) is satisfied.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String()),
			summary: Type.String({ description: "Plan narrative: approach, steps, verification strategy" }),
			steps: Type.Array(Type.String(), { description: "Ordered implementation steps" }),
			files: Type.Array(Type.String(), { description: "Files expected to change" }),
			risks: Type.Array(Type.String(), { description: "Newly identified risks (empty if none)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const core = coreFor(ctx);
			const id = params.taskId ?? activeTaskId(core);
			if (!id) return err("No active task.");
			const result = core.submitReport({
				taskId: id,
				section: "plan" as ManagedSection,
				summary: params.summary,
				details: { steps: params.steps, files: params.files, risks: params.risks },
			});
			return result.ok
				? {
						content: [{ type: "text", text: `Plan recorded. Task ${id} is now ${result.value.stageAfter}.${result.next ? " " + result.next : ""}` }],
						details: { taskId: id, stage: result.value.stageAfter },
					}
				: err(result.error!);
		},
	});

	pi.registerTool({
		name: "sym_build_report",
		label: "Submit build report",
		description: "Submit the structured implementation report. Required before the task can move to review.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String()),
			summary: Type.String({ description: "What changed and why" }),
			filesChanged: Type.Array(Type.String()),
			acceptanceStatus: Type.Array(
				Type.Object({
					criterion: Type.Integer({ description: "Acceptance criterion number (1-based)" }),
					status: StringEnum(["met", "not_met", "partial"]),
					note: Type.Optional(Type.String()),
				}),
			),
			deviations: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const core = coreFor(ctx);
			const id = params.taskId ?? activeTaskId(core);
			if (!id) return err("No active task.");
			const result = core.submitReport({
				taskId: id,
				section: "implementation" as ManagedSection,
				summary: params.summary,
				details: {
					files_changed: params.filesChanged,
					acceptance_status: params.acceptanceStatus,
					deviations: params.deviations ?? [],
				},
			});
			return result.ok
				? {
						content: [{ type: "text", text: `Build report recorded. Task ${id} is now ${result.value.stageAfter}. Next: /sym continue starts the independent review.` }],
						details: { taskId: id, stage: result.value.stageAfter },
					}
				: err(result.error!);
		},
	});

	pi.registerTool({
		name: "sym_review_submit",
		label: "Record review notes",
		description:
			"Record review notes from this (implementer) session. IMPORTANT: notes submitted here are marked with implementer provenance and can NEVER satisfy the review→verify gate — Symphony runs an independent fresh-session review for that. Use this only to attach observations.",
		parameters: Type.Object({
			taskId: Type.String(),
			verdict: StringEnum(["approved", "changes_requested"]),
			summary: Type.String(),
			findings: Type.Array(
				Type.Object({
					severity: StringEnum(["blocker", "major", "minor", "note"]),
					file: Type.Optional(Type.String()),
					summary: Type.String(),
					detail: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const core = coreFor(ctx);
			const result = core.submitReport({
				taskId: params.taskId,
				section: "review" as ManagedSection,
				summary: `${params.verdict.toUpperCase()} — ${params.summary}`,
				details: { verdict: params.verdict, findings: params.findings },
				origin: "model",
			});
			return result.ok
				? {
						content: [{ type: "text", text: `Notes recorded with implementer provenance. Task stays ${result.value.stageAfter}: an independent fresh-session review (run /sym continue in review) is required to advance to verify.` }],
						details: { taskId: params.taskId, provenance: "model" },
					}
				: err(result.error);
		},
	});
}

function activeTaskId(core: SymphonyCore): string | undefined {
	return core.listTasks().find((t) => !["done", "cancelled"].includes(t.stage))?.id;
}

function err(message: string) {
	return { content: [{ type: "text" as const, text: `Symphony: ${message}` }], details: { error: message } };
}
