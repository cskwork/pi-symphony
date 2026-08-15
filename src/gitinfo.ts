/**
 * Read-only Git inspection. v0.1 never mutates repository state: only the
 * allowlisted inspection subcommands below may execute (V01-GIT-001).
 */
const ALLOWED_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"rev-parse",
	"log",
	"branch",
	"show",
	"merge-base",
	"ls-files",
	"config",
]);

/**
 * Per-subcommand option allowlist (S3): deny-by-default for options, so
 * `git log --exec=push`, `git config --add`, or `--output=` variants are
 * rejected structurally rather than by verb denylist luck.
 */
const ALLOWED_OPTIONS: Record<string, RegExp[]> = {
	status: [/^--porcelain$/, /^--short$/, /^-b$/, /^--branch$/],
	diff: [/^--numstat$/, /^--stat$/, /^--name-only$/, /^--name-status$/, /^-U\d+$/, /^--abbrev(=[a-z0-9]+)?$/],
	"rev-parse": [/^--abbrev-ref$/, /^--is-inside-work-tree$/, /^--show-toplevel$/, /^--short(=[a-z0-9]+)?$/, /^--verify$/],
	log: [/^--oneline$/, /^-n$/, /^-\d+$/, /^--max-count=\d+$/, /^--format=/, /^--pretty=/],
	branch: [/^--contains$/, /^--list$/, /^-a$/, /^--all$/, /^-v$/, /^--verbose$/],
	show: [/^--stat$/, /^--name-only$/, /^--format=/, /^--pretty=/, /^-s$/],
	"merge-base": [],
	"ls-files": [/^--others$/, /^--modified$/, /^--stage$/, /^--error-unmatch$/],
	config: [/^--get$/, /^--get-regexp$/],
};

/** Options that carry a value as a separate argv element (value consumed, not validated). */
const OPTIONS_WITH_VALUE = new Set(["-n", "--max-count", "-U", "--abbrev"]);

/** Destructive git verbs that must never appear in an inspection argv. */
const FORBIDDEN_VERBS = new Set([
	"push",
	"merge",
	"rebase",
	"reset",
	"clean",
	"checkout",
	"cherry-pick",
	"revert",
	"rm",
	"mv",
	"commit",
	"stash",
	"fetch",
	"pull",
	"clone",
	"init",
	"add",
	"worktree",
]);

export class GitCommandError extends Error {
	constructor(public argv: string[]) {
		super(`git inspection allows only read-only subcommands: git ${argv.join(" ")}`);
		this.name = "GitCommandError";
	}
}

/** Validate an inspection argv against the read-only allowlist. */
export function assertReadOnlyGit(argv: string[]): void {
	if (argv.length === 0) throw new GitCommandError(argv);
	const sub = argv[0]!;
	if (!ALLOWED_SUBCOMMANDS.has(sub)) throw new GitCommandError(argv);
	const optionAllowlist = ALLOWED_OPTIONS[sub] ?? [];
	const args = argv.slice(1);
	let expectingValue = false;
	for (const arg of args) {
		if (expectingValue) {
			expectingValue = false; // consume the value of the previous option
			continue;
		}
		if (arg.startsWith("-")) {
			const base = arg.split("=")[0]!;
			const allowed = optionAllowlist.some((re) => re.test(arg)) || optionAllowlist.some((re) => re.test(base));
			if (!allowed) throw new GitCommandError(argv);
			if (OPTIONS_WITH_VALUE.has(base) && !arg.includes("=")) expectingValue = true;
			continue;
		}
		// positional: read-only references and paths only
		if (FORBIDDEN_VERBS.has(arg)) throw new GitCommandError(argv);
	}
}

export type GitExec = (argv: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<{
	code: number;
	stdout: string;
	stderr: string;
}>;

export interface GitSnapshot {
	isRepo: boolean;
	revision: string | null;
	branch: string | null;
	dirty: boolean;
	changedFiles: number;
	/** Untracked+modified paths (bounded). */
	changedPaths: string[];
}

export async function gitSnapshot(exec: GitExec, cwd: string): Promise<GitSnapshot> {
	const empty: GitSnapshot = {
		isRepo: false,
		revision: null,
		branch: null,
		dirty: false,
		changedFiles: 0,
		changedPaths: [],
	};
	let status: string;
	try {
		const result = await exec(["rev-parse", "--is-inside-work-tree"], { cwd });
		if (result.code !== 0 || result.stdout.trim() !== "true") return empty;
		status = (await exec(["status", "--porcelain"], { cwd })).stdout;
	} catch {
		return empty;
	}
	const revision = (await exec(["rev-parse", "HEAD"], { cwd })).stdout.trim() || null;
	const branch = (await exec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim() || null;
	const changedPaths = status
		.split("\n")
		.map((l) => l.slice(3).trim())
		.filter(Boolean);
	return {
		isRepo: true,
		revision,
		branch,
		dirty: changedPaths.length > 0,
		changedFiles: changedPaths.length,
		changedPaths: changedPaths.slice(0, 200),
	};
}

export interface DiffSummary {
	filesChanged: number;
	insertions: number;
	deletions: number;
	paths: Array<{ path: string; added: number; removed: number }>;
}

export async function diffSummary(exec: GitExec, cwd: string, base?: string): Promise<DiffSummary> {
	const argv = base ? ["diff", "--numstat", base] : ["diff", "--numstat", "HEAD"];
	const { stdout } = await exec(argv, { cwd });
	const summary: DiffSummary = { filesChanged: 0, insertions: 0, deletions: 0, paths: [] };
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const [added, removed, path] = line.split("\t");
		if (!path) continue;
		const a = added === "-" ? 0 : Number(added);
		const r = removed === "-" ? 0 : Number(removed);
		summary.filesChanged += 1;
		summary.insertions += a;
		summary.deletions += r;
		summary.paths.push({ path, added: a, removed: r });
	}
	return summary;
}

/** Full diff text bounded by a byte cap with deterministic omission note. */
export async function boundedDiff(exec: GitExec, cwd: string, maxBytes: number): Promise<{ text: string; omitted: boolean }> {
	const { stdout } = await exec(["diff", "HEAD"], { cwd });
	if (stdout.length <= maxBytes) return { text: stdout, omitted: false };
	const head = stdout.slice(0, maxBytes);
	// cut at a hunk boundary for determinism
	const cut = head.lastIndexOf("\n@@");
	const text = cut > 0 ? head.slice(0, cut) : head;
	return {
		text: `${text}\n... [diff truncated: ${stdout.length - text.length} of ${stdout.length} bytes omitted — scope not fully proven]`,
		omitted: true,
	};
}

/** Integration preflight: does the declared revision exist on the target branch? */
export async function revisionOnBranch(
	exec: GitExec,
	cwd: string,
	revision: string,
	targetBranch: string,
): Promise<{ present: boolean; error?: string }> {
	const contains = await exec(["branch", "--contains", revision, "--list", targetBranch], { cwd });
	if (contains.code !== 0) return { present: false, error: contains.stderr.trim() || "branch --contains failed" };
	return { present: contains.stdout.trim().length > 0 };
}
