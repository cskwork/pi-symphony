import type { ConfigIssue } from "../config.ts";
import type { TaskFrontmatter, CheckRunEvidence } from "../types.ts";

/** Pure formatting helpers shared by the widget, overlay, and print output. */

export function configIssuesText(issues: ConfigIssue[]): string {
	return issues.map((i) => `${i.path}: ${i.message}`).join("\n");
}

export interface DetailPanes {
	overview: string[];
	contract: string[];
	changes: string[];
	review: string[];
	checks: string[];
	history: string[];
}

export function taskDetailPanes(
	task: TaskFrontmatter,
	sections: Record<string, string | undefined>,
	checks: Map<string, CheckRunEvidence>,
): DetailPanes {
	const overview: string[] = [
		`ID:       ${task.id}`,
		`Title:    ${task.title}`,
		`Kind:     ${task.kind}`,
		`Stage:    ${task.stage}`,
		`Run:      ${task.runState}`,
		`Revision: ${task.revision} · updated ${task.updatedAt}`,
		`Target:   ${task.targetBranch ?? "-"}`,
	];
	if (task.integration) {
		overview.push(`Integrated: ${task.integration.revision.slice(0, 10)} on ${task.integration.targetBranch}`);
	}
	const contract: string[] = [
		"Acceptance criteria:",
		...task.acceptance.map((a, i) => `  ${i + 1}. ${a.text}`),
		task.risks.length > 0 ? "Risks:" : "Risks: (none declared)",
		...task.risks.map((r) => `  - ${r}`),
	];
	const changes: string[] = [
		`Evidence revision: ${task.evidenceRevision ?? "none"}`,
		task.integration ? `Integrated revision: ${task.integration.revision}` : "Not integrated",
	];
	const review: string[] = textLines(sections["review"] ?? "(no review yet)");
	const checksLines: string[] = [];
	if (checks.size === 0) checksLines.push("checks not run");
	for (const run of checks.values()) {
		checksLines.push(`${run.check}: ${run.status} (exit ${run.exitCode ?? "n/a"}, ${run.durationMs}ms, rev ${run.revision ?? "none"})`);
		if (run.output) checksLines.push(`  ${firstLine(run.output).slice(0, 100)}`);
	}
	const history: string[] = [
		`Created ${task.createdAt}`,
		`Updated ${task.updatedAt}`,
		`Stage ${task.stage} · run ${task.runState}`,
	];
	return { overview, contract, changes, review, checks: checksLines, history };
}

function textLines(text: string): string[] {
	return text.split("\n").filter((l) => l.trim().length > 0).slice(0, 24);
}

function firstLine(text: string): string {
	return text.split("\n").find((l) => l.trim().length > 0) ?? "";
}

export function doctorLines(report: Array<{ area: string; ok: boolean; detail: string }>): string[] {
	return report.map((r) => `${r.ok ? "✓" : "✗"} ${r.area.padEnd(16)} ${r.detail}`);
}

export function planBrief(task: TaskFrontmatter): string {
	return [
		`Symphony task ${task.id}: ${task.title}`,
		"",
		"Acceptance criteria:",
		...task.acceptance.map((a, i) => `${i + 1}. ${a.text}`),
		task.risks.length > 0 ? "\nDeclared risks:\n" + task.risks.map((r) => `- ${r}`).join("\n") : "",
		"",
		"Plan the implementation. Explore the repository, then submit a structured plan",
		`with the sym_plan_submit tool (task ${task.id}). Include steps, files you expect`,
		"to touch, risks, and how each acceptance criterion will be verified.",
	]
		.filter(Boolean)
		.join("\n");
}

export function buildBrief(task: TaskFrontmatter): string {
	return [
		`Symphony task ${task.id}: ${task.title} — build phase`,
		"",
		"Implement the approved plan. Work in the current checkout.",
		"When done, submit a structured implementation report with the",
		`sym_build_report tool (task ${task.id}): what changed, why, files touched,`,
		"deviations from the plan, and how acceptance criteria are addressed.",
	]
		.join("\n");
}

export function nextStepLine(step: { action: string; detail: string } | undefined): string {
	return step ? `${step.action} — ${step.detail}` : "no active task";
}
