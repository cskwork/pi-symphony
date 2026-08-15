import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { relative, isAbsolute, resolve } from "node:path";
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
	{ re: /\bgit\s+push\b/, label: "git push" },
	{ re: /\bgit\s+reset\s+--hard\b/, label: "git reset --hard" },
	{ re: /\bgit\s+clean\b/, label: "git clean" },
	{ re: /\bgit\s+merge\b/, label: "git merge" },
	{ re: /\bgit\s+rebase\b/, label: "git rebase" },
	{ re: /\bgit\s+checkout\s+--\s/, label: "git checkout -- (discard)" },
	{ re: /\bgit\s+branch\s+-D\b/, label: "git branch -D" },
	{ re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive|--force)/, label: "rm recursive/force" },
	{ re: /\bsudo\b/, label: "sudo" },
];

export function isProtectedPath(path: string, policy: GuardPolicy): boolean {
	const normalized = path.replace(/\\/g, "/");
	for (const pattern of policy.protectedPaths) {
		if (minimatch(normalized, pattern)) return true;
	}
	return false;
}

export function classifyWrite(path: string, policy: GuardPolicy): "allow" | "confirm" | "block" {
	if (!isProtectedPath(path, policy)) return "allow";
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
