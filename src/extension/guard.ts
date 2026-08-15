import { lstatSync, realpathSync } from "node:fs";
import { dirname, relative, isAbsolute, resolve } from "node:path";
import { minimatch } from "./minimatch.ts";

/**
 * V01-SAFE-001: protected-path writes and destructive commands are blocked or
 * confirmed according to repository policy. Color is never the only signal —
 * every interception names the exact path and operation.
 */

export interface GuardPolicy {
	protectedPaths: string[];
	policy: "block" | "confirm";
}

const DESTRUCTIVE_COMMAND_PATTERNS: Array<{ re: RegExp; label: string }> = [
	{ re: /\bgit(?:\s+-[A-Za-z]\s*[^\s]*)?\s+push\b/, label: "git push" },
	{ re: /\bgit\s+reset\s+--hard\b/, label: "git reset --hard" },
	{ re: /\bgit\s+clean\b/, label: "git clean" },
	{ re: /\bgit\s+merge\b/, label: "git merge" },
	{ re: /\bgit\s+rebase\b/, label: "git rebase" },
	{ re: /\bgit\s+checkout\s+--\s/, label: "git checkout -- (discard)" },
	{ re: /\bgit\s+checkout\s+\.(\s|$)/, label: "git checkout . (discard)" },
	{ re: /\bgit\s+restore\b/, label: "git restore" },
	{ re: /\bgit\s+branch\s+-D\b/, label: "git branch -D" },
	{ re: /\bgit\s+(add|rm|mv)\s+-f\b/, label: "git force add/rm/mv" },
	{ re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive|--force)/, label: "rm recursive/force" },
	{ re: /\bsudo\b/, label: "sudo" },
	{ re: /\bchmod\s+-R\b/, label: "chmod -R" },
	{ re: /\bchown\s+-R\b/, label: "chown -R" },
	{ re: /\bkill(all)?\b/, label: "kill" },
];

/**
 * Redirect/tee targets that write files: `> path`, `>> path`, `tee path`.
 * Used to catch bash writes aimed at protected locations.
 */
const REDIRECT_TARGET_RE = /(?:>{1,2}|\btee(?:\s+-a)?\s+|\bdd\s+[^|]*of=)(?:\s*)([\w./@-]+|"[^"]+"|'[^']+')/g;

/** Extract candidate write targets from a shell command line. */
export function redirectTargets(command: string): string[] {
	const targets: string[] = [];
	for (const match of command.matchAll(REDIRECT_TARGET_RE)) {
		const raw = match[1]!.replace(/^["']|["']$/g, "");
		if (raw && !raw.startsWith("&") && raw !== "/dev/null") targets.push(raw);
	}
	return targets;
}

export function isProtectedPath(path: string, policy: GuardPolicy): boolean {
	const normalized = normalizePath(path);
	for (const pattern of policy.protectedPaths) {
		if (minimatch(normalized, pattern)) return true;
		if (minimatch(normalized.toLowerCase(), pattern.toLowerCase())) return true;
	}
	return false;
}

/** Normalize separators; case-fold is handled at match time (APFS is case-insensitive). */
function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}

/**
 * Resolve through symlinks so aliases of protected locations are caught.
 * Falls back to the literal path when resolution fails (broken link).
 */
export function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		try {
			// resolve parent symlinks even if the leaf doesn't exist yet
			return resolve(dirname(realpathSync(dirname(path))), path.split("/").pop()!);
		} catch {
			return path;
		}
	}
}

/** True when the path is outside the working directory (absolute escapes). */
export function escapesCwd(cwd: string, path: string): boolean {
	const rel = relative(cwd, path);
	return rel.startsWith("..") || isAbsolute(rel);
}

/** Locations whose corruption forges workflow/evidence truth: always block. */
const ALWAYS_BLOCK_PATTERNS = [".symphony/tasks/**", ".symphony/evidence/**", ".symphony/runtime/**", "**/.git/**", "**/.env", "**/.env.*", "**/.envrc"];

export function classifyWrite(path: string, policy: GuardPolicy): "allow" | "confirm" | "block" {
	const normalized = normalizePath(path);
	for (const pattern of ALWAYS_BLOCK_PATTERNS) {
		if (minimatch(normalized, pattern) || minimatch(normalized.toLowerCase(), pattern.toLowerCase())) return "block";
	}
	if (!isProtectedPath(normalized, policy)) return "allow";
	return policy.policy === "block" ? "block" : "confirm";
}

export function findDestructiveCommand(command: string): string | undefined {
	for (const { re, label } of DESTRUCTIVE_COMMAND_PATTERNS) {
		if (re.test(command)) return label;
	}
	return undefined;
}

/** Resolve a tool target path against cwd, tolerating a leading @. */
export function resolveToolPath(cwd: string, rawPath: string): string {
	const trimmed = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	const absolute = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	return absolute;
}

export function pathRelativeTo(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	return rel.startsWith("..") ? path : rel.replace(/\\/g, "/");
}
