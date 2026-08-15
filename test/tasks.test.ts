import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	parseTaskFile,
	renderManagedSection,
	serializeTaskFile,
	setManagedSection,
	writeTaskFileAtomic,
	TaskIdAllocator,
	TaskConflictError,
} from "../src/tasks.ts";
import { makeRepo, disposeRepo, initRepoWithCommit } from "./helpers.ts";

let dir: string;

beforeEach(() => {
	dir = makeRepo(false);
	initRepoWithCommit(dir);
});
afterEach(() => disposeRepo(dir));

function seedTask(): string {
	const path = join(dir, "DEV-001.md");
	writeTaskFileAtomic(path, (parsed) => {
		parsed.frontmatter = {
			id: "DEV-001",
			title: "Fix pagination race",
			kind: "bug",
			stage: "build",
			revision: 0,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			acceptance: [{ text: "no race" }],
			risks: ["migration"],
			runState: "idle",
		};
		setManagedSection(parsed, "plan", renderManagedSection("plan", { section: "plan", summary: "plan body", details: { steps: ["a"] }, submittedAt: "now", origin: "model" }));
	});
	return path;
}

describe("task repository", () => {
	it("V01-TASK-002: external human edits outside managed markers survive machine writes", () => {
		const path = seedTask();
		// human edits free text between frontmatter and managed block
		const before = readFileSync(path, "utf8");
		const humanNote = "\n> NOTE(human): remember the index migration\n";
		const withNote = before.replace("# Task notes", `# Task notes${humanNote}`);
		writeFileSync(path, withNote, "utf8");

		writeTaskFileAtomic(path, (parsed) => {
			setManagedSection(parsed, "review", renderManagedSection("review", { section: "review", summary: "looks good", details: {}, submittedAt: "later", origin: "fresh-reviewer" }));
		});

		const after = readFileSync(path, "utf8");
		expect(after).toContain("> NOTE(human): remember the index migration");
		// and the managed plan section content is preserved too
		expect(after).toContain("plan body");
		expect(after).toContain("looks good");
	});

	it("rejects stale expected revisions (optimistic concurrency)", () => {
		const path = seedTask();
		const parsed = parseTaskFile(readFileSync(path, "utf8"));
		const staleRevision = parsed.frontmatter.revision;
		// external write bumps the revision
		writeTaskFileAtomic(path, () => {});
		expect(() =>
			writeTaskFileAtomic(path, () => {}, { expectedRevision: staleRevision }),
		).toThrow(TaskConflictError);
	});

	it("managed sections round-trip through parse → serialize", () => {
		const path = seedTask();
		const text = readFileSync(path, "utf8");
		const parsed = parseTaskFile(text);
		expect(serializeTaskFile(parsed)).toBe(text);
	});

	it("V01-TASK-001: allocates collision-safe monotonic ids and skips existing files", () => {
		const allocator = new TaskIdAllocator(join(dir, "tasks"), "DEV");
		expect(allocator.next()).toBe("DEV-001");
		expect(allocator.next()).toBe("DEV-002");
		// simulate a pre-existing DEV-003 (crash between counter and file write)
		writeFileSync(join(dir, "tasks", "DEV-003.md"), "placeholder", "utf8");
		expect(allocator.next()).toBe("DEV-004");
	});

	it("atomic write leaves no temp files behind", () => {
		const path = seedTask();
		writeTaskFileAtomic(path, () => {});
		const files = readdirSync(dir).filter((f) => f.includes(".tmp"));
		expect(files).toEqual([]);
	});
});
