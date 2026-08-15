import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { GitExec } from "../src/gitinfo.ts";

/** Create a throwaway git repo fixture with one commit. */
export function makeRepo(withCommit = true): string {
	const dir = mkdtempSync(join(tmpdir(), "sym-test-"));
	if (withCommit) initRepoWithCommit(dir);
	return dir;
}

export function initRepoWithCommit(dir: string): void {
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "# fixture\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--no-gpg-sign", "--no-verify"], { cwd: dir });
}

export function disposeRepo(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

export function commitAll(dir: string, message: string): string {
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", message, "--no-gpg-sign", "--no-verify", "--allow-empty"], { cwd: dir });
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

/** Real git executor with the read-only assertion applied (matches production). */
export function realGitExec(cwd: string): GitExec {
	return async (argv, options) => {
		const { assertReadOnlyGit } = await import("../src/gitinfo.ts");
		assertReadOnlyGit(argv);
		try {
			const out = execFileSync("git", argv, { cwd: options?.cwd ?? cwd, encoding: "utf8", timeout: options?.timeoutMs ?? 10_000 });
			return { code: 0, stdout: out, stderr: "" };
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string, status?: number };
			return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
		}
	};
}


export const silentUi = {
	notify: () => {},
	select: async () => undefined,
	confirm: async () => true,
};
