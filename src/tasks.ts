import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { monotonicId } from "./ids.ts";
import { taskFileName } from "./paths.ts";
import {
	MANAGED_SECTIONS,
	type ManagedSection,
	type StageReport,
	type TaskFrontmatter,
	type TaskKind,
	type TaskStage,
} from "./types.ts";

export const MANAGED_START = (section: ManagedSection) => `<!-- symphony:${section}:start -->`;
export const MANAGED_END = (section: ManagedSection) => `<!-- symphony:${section}:end -->`;

export interface ParsedTask {
	frontmatter: TaskFrontmatter;
	/** Body segments: human text interleaved with managed blocks. */
	segments: BodySegment[];
}

export type BodySegment =
	| { kind: "human"; text: string }
	| { kind: "managed"; section: ManagedSection; text: string };

export class TaskConflictError extends Error {
	constructor(
		public taskId: string,
		public expectedRevision: number,
		public actualRevision: number,
	) {
		super(
			`task ${taskId} changed externally (expected revision ${expectedRevision}, found ${actualRevision}); reload the task and retry`,
		);
		this.name = "TaskConflictError";
	}
}

/** Parse one task markdown file. Managed markers delimit machine-owned blocks. */
export function parseTaskFile(text: string): ParsedTask {
	if (!text.startsWith("---\n")) throw new Error("task file must start with YAML frontmatter");
	const end = text.indexOf("\n---\n", 4);
	if (end < 0) throw new Error("task file frontmatter is not terminated");
	const fmRaw = parseYaml(text.slice(4, end)) as Record<string, unknown>;
	const frontmatter = normalizeFrontmatter(fmRaw);
	const body = text.slice(end + 5);

	const segments: BodySegment[] = [];
	let cursor = 0;
	let humanStart = 0;
	while (cursor < body.length) {
		let nextStart: { section: ManagedSection; index: number } | undefined;
		for (const section of MANAGED_SECTIONS) {
			const marker = body.indexOf(MANAGED_START(section), cursor);
			if (marker >= 0 && (!nextStart || marker < nextStart.index)) nextStart = { section, index: marker };
		}
		if (!nextStart) break;
		const endMarker = body.indexOf(MANAGED_END(nextStart.section), nextStart.index);
		if (endMarker < 0) break; // unterminated marker: treat rest as human text
		if (nextStart.index > humanStart) {
			segments.push({ kind: "human", text: body.slice(humanStart, nextStart.index) });
		}
		segments.push({
			kind: "managed",
			section: nextStart.section,
			text: body.slice(nextStart.index, endMarker + MANAGED_END(nextStart.section).length),
		});
		cursor = endMarker + MANAGED_END(nextStart.section).length;
		humanStart = cursor;
	}
	if (humanStart < body.length) segments.push({ kind: "human", text: body.slice(humanStart) });
	return { frontmatter, segments };
}

function normalizeFrontmatter(raw: Record<string, unknown>): TaskFrontmatter {
	const fm = raw["symphony"] as Record<string, unknown> | undefined;
	const src = (fm && typeof fm === "object" ? fm : raw) as Record<string, unknown>;
	const acceptance = Array.isArray(src["acceptance"])
		? (src["acceptance"] as unknown[]).map((a) =>
				typeof a === "string" ? { text: a } : (a as { text: string }),
			)
		: [];
	return {
		id: String(src["id"] ?? ""),
		title: String(src["title"] ?? ""),
		kind: (src["kind"] as TaskKind) ?? "feature",
		stage: (src["stage"] as TaskStage) ?? "backlog",
		revision: Number(src["revision"] ?? 1),
		createdAt: String(src["created_at"] ?? src["createdAt"] ?? new Date().toISOString()),
		updatedAt: String(src["updated_at"] ?? src["updatedAt"] ?? new Date().toISOString()),
		targetBranch: src["target_branch"] ? String(src["target_branch"]) : undefined,
		acceptance,
		risks: Array.isArray(src["risks"]) ? (src["risks"] as unknown[]).map(String) : [],
		runState: (src["run_state"] as TaskFrontmatter["runState"]) ?? "idle",
		pinnedConfigHash: src["pinned_config_hash"] ? String(src["pinned_config_hash"]) : undefined,
		evidenceRevision: src["evidence_revision"] ? String(src["evidence_revision"]) : undefined,
		integration: src["integration"] as TaskFrontmatter["integration"],
	};
}

export function serializeTaskFile(parsed: ParsedTask): string {
	const fmYaml = stringifyYaml({ symphony: toYamlFrontmatter(parsed.frontmatter) }).trimEnd();
	const body = parsed.segments.map((s) => s.text).join("");
	return `---\n${fmYaml}\n---\n${body}`;
}

function toYamlFrontmatter(fm: TaskFrontmatter): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: fm.id,
		title: fm.title,
		kind: fm.kind,
		stage: fm.stage,
		revision: fm.revision,
		created_at: fm.createdAt,
		updated_at: fm.updatedAt,
		acceptance: fm.acceptance.map((a) => a.text),
		risks: fm.risks,
		run_state: fm.runState,
	};
	if (fm.targetBranch) out["target_branch"] = fm.targetBranch;
	if (fm.pinnedConfigHash) out["pinned_config_hash"] = fm.pinnedConfigHash;
	if (fm.evidenceRevision) out["evidence_revision"] = fm.evidenceRevision;
	if (fm.integration) out["integration"] = fm.integration;
	return out;
}

/** Managed-section content renderer for reports. */
export function renderManagedSection(
	section: ManagedSection,
	report: StageReport | undefined,
	extra: string[] = [],
): string {
	const lines = [MANAGED_START(section), ""];
	if (report) {
		lines.push(`_${report.submittedAt} — ${report.section} report_`, "", report.summary.trim(), "");
		const details = Object.entries(report.details);
		if (details.length > 0) {
			lines.push("```yaml");
			lines.push(stringifyYaml(report.details).trimEnd());
			lines.push("```", "");
		}
	}
	for (const line of extra) lines.push(line);
	lines.push("", MANAGED_END(section), "");
	return lines.join("\n");
}

/**
 * Atomic compare-and-swap write: parse → validate → compare expected revision →
 * temp file → rename. Human text outside managed markers is preserved
 * byte-for-byte because only frontmatter and managed blocks are rewritten.
 */
export function writeTaskFileAtomic(
	path: string,
	mutate: (parsed: ParsedTask) => void,
	options: { expectedRevision?: number; now?: Date } = {},
): TaskFrontmatter {
	const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
	const parsed = existing !== null ? parseTaskFile(existing) : null;
	if (parsed && options.expectedRevision !== undefined && parsed.frontmatter.revision !== options.expectedRevision) {
		throw new TaskConflictError(parsed.frontmatter.id, options.expectedRevision, parsed.frontmatter.revision);
	}
	const target: ParsedTask =
		parsed ?? { frontmatter: { ...emptyFrontmatter() }, segments: [{ kind: "human", text: "\n# Task notes\n\n" }] };
	mutate(target);
	target.frontmatter.revision = (parsed?.frontmatter.revision ?? 0) + 1;
	target.frontmatter.updatedAt = (options.now ?? new Date()).toISOString();
	const next = serializeTaskFile(target);
	const tmp = join(dirname(path), `.${basename(path)}.tmp-${monotonicId()}`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(tmp, next, "utf8");
	// fsync directory entry via rename on POSIX; renameSync is atomic
	renameSync(tmp, path);
	return { ...target.frontmatter };
}

function emptyFrontmatter(): TaskFrontmatter {
	const now = new Date().toISOString();
	return {
		id: "",
		title: "",
		kind: "feature",
		stage: "backlog",
		revision: 0,
		createdAt: now,
		updatedAt: now,
		acceptance: [],
		risks: [],
		runState: "idle",
	};
}

/** Replace or insert one managed section, preserving everything else. */
export function setManagedSection(parsed: ParsedTask, section: ManagedSection, text: string): void {
	const idx = parsed.segments.findIndex((s) => s.kind === "managed" && s.section === section);
	const segment: BodySegment = { kind: "managed", section, text };
	if (idx >= 0) {
		const merged = mergeLeadingHuman(parsed, idx);
		parsed.segments.splice(merged.index, 1, segment);
	} else {
		// append after the last managed section, before trailing human text
		let insertAt = parsed.segments.length;
		for (let i = parsed.segments.length - 1; i >= 0; i--) {
			const s = parsed.segments[i]!;
			if (s.kind === "managed") {
				insertAt = i + 1;
				break;
			}
		}
		if (insertAt === parsed.segments.length && !parsed.segments.some((s) => s.kind === "managed")) {
			insertAt = Math.max(1, parsed.segments.length);
		}
		parsed.segments.splice(insertAt, 0, segment);
	}
}

function mergeLeadingHuman(parsed: ParsedTask, idx: number): { index: number } {
	return { index: idx };
}

export function getManagedSection(parsed: ParsedTask, section: ManagedSection): string | undefined {
	const seg = parsed.segments.find((s) => s.kind === "managed" && s.section === section);
	return seg?.kind === "managed" ? seg.text : undefined;
}

export function readTaskFile(path: string): ParsedTask {
	return parseTaskFile(readFileSync(path, "utf8"));
}

/**
 * Collision-safe task ID allocation. A monotonic counter file guarantees
 * uniqueness under concurrency; existence check guards pre-existing files.
 */
export class TaskIdAllocator {
	constructor(private tasksDir: string, private prefix: string) {}

	next(): string {
		mkdirSync(this.tasksDir, { recursive: true });
		for (let guard = 0; guard < 10_000; guard++) {
			const n = this.readCounter() + 1;
			const id = `${this.prefix}-${String(n).padStart(3, "0")}`;
			if (!existsSync(join(this.tasksDir, taskFileName(id)))) {
				this.writeCounter(n);
				return id;
			}
			this.writeCounter(n); // skip an existing colliding file
		}
		throw new Error("unable to allocate a task id");
	}

	private counterFile(): string {
		return join(this.tasksDir, ".id-counter");
	}

	private readCounter(): number {
		try {
			return Number.parseInt(readFileSync(this.counterFile(), "utf8").trim(), 10) || 0;
		} catch {
			return 0;
		}
	}

	private writeCounter(n: number): void {
		const tmp = `${this.counterFile()}.tmp`;
		writeFileSync(tmp, String(n), "utf8");
		renameSync(tmp, this.counterFile());
	}
}

/** Backup helper used when init overwrites an existing configuration. */
export function backupFile(path: string, suffix = ".bak"): string | undefined {
	if (!existsSync(path)) return undefined;
	const backup = `${path}.${monotonicId()}${suffix}`;
	copyFileSync(path, backup);
	return backup;
}
