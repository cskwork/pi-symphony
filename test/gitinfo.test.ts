import { describe, expect, it, vi } from "vitest";
import { assertReadOnlyGit, GitCommandError } from "../src/gitinfo.ts";
import { makeRepo, disposeRepo, realGitExec, commitAll } from "./helpers.ts";

describe("git inspection allowlist (V01-GIT-001)", () => {
	const allowed = [
		["status", "--porcelain"],
		["diff", "--numstat", "HEAD"],
		["rev-parse", "HEAD"],
		["log", "--oneline", "-5"],
		["branch", "--contains", "abc", "--list", "main"],
		["show", "--stat", "HEAD"],
		["merge-base", "main", "feature"],
	];
	const forbidden = [
		["push", "origin", "main"],
		["merge", "feature"],
		["reset", "--hard", "HEAD~1"],
		["clean", "-fd"],
		["checkout", "--", "file"],
		["rebase", "main"],
		["commit", "-m", "x"],
		["stash", "pop"],
		["worktree", "add", "../wt"],
	];

	it.each(allowed)("allows git %s", (...argv) => {
		expect(() => assertReadOnlyGit(argv)).not.toThrow();
	});
	it.each(forbidden)("rejects git %s", (...argv) => {
		expect(() => assertReadOnlyGit(argv)).toThrow(GitCommandError);
	});

	it("command spy: a full snapshot session executes only allowlisted commands", async () => {
		const dir = makeRepo();
		try {
			const exec = realGitExec(dir);
			const spy = vi.fn(exec);
			// import after creating spy to keep it simple: call through wrapper
			const { gitSnapshot, diffSummary } = await import("../src/gitinfo.ts");
			const snap = await gitSnapshot(spy, dir);
			expect(snap.isRepo).toBe(true);
			expect(snap.revision).toMatch(/^[0-9a-f]{40}$/);
			const summary = await diffSummary(spy, dir);
			expect(summary.filesChanged).toBe(0);
			for (const call of spy.mock.calls) {
				expect(() => assertReadOnlyGit(call[0])).not.toThrow();
			}
		} finally {
			disposeRepo(dir);
		}
	});
});
