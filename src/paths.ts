import { join } from "node:path";
import { assertValidTaskId } from "./ids.ts";

/** Canonical `.symphony` directory layout for one repository checkout. */
export interface SymphonyPaths {
	root: string;
	config: string;
	configLocal: string;
	tasksDir: string;
	promptsDir: string;
	evidenceDir: (taskId: string) => string;
	checksDir: (taskId: string) => string;
	reviewDir: (taskId: string) => string;
	integrationDir: (taskId: string) => string;
	runtimeDir: string;
	eventsFile: (taskId: string) => string;
	leaseFile: string;
	cacheDir: string;
	taskIndex: string;
	logsDir: string;
}

export function symphonyPaths(repoRoot: string): SymphonyPaths {
	const base = join(repoRoot, ".symphony");
	const evidence = join(base, "evidence");
	const runtime = join(base, "runtime");
	return {
		root: base,
		config: join(base, "config.yaml"),
		configLocal: join(base, "config.local.yaml"),
		tasksDir: join(base, "tasks"),
		promptsDir: join(base, "prompts"),
		evidenceDir: (taskId: string) => contained(taskId, evidence),
		checksDir: (taskId: string) => containedDir(taskId, evidence, "checks"),
		reviewDir: (taskId: string) => containedDir(taskId, evidence, "review"),
		integrationDir: (taskId: string) => containedDir(taskId, evidence, "integration"),
		runtimeDir: runtime,
		eventsFile: (taskId: string) => contained(taskId, join(runtime, "events"), ".jsonl"),
		leaseFile: join(runtime, "leases", "active.json"),
		cacheDir: join(runtime, "cache"),
		taskIndex: join(runtime, "cache", "task-index.json"),
		logsDir: join(runtime, "logs"),
	};
}

/** Defense in depth: derived paths must stay inside their base directory. */
function contained(taskId: string, base: string, suffix = ""): string {
	assertValidTaskId(taskId);
	const resolved = join(base, `${taskId}${suffix}`);
	if (!resolved.startsWith(base)) throw new Error(`path escapes .symphony: ${taskId}`);
	return resolved;
}

function containedDir(taskId: string, base: string, sub: string): string {
	assertValidTaskId(taskId);
	return join(base, taskId, sub);
}

/** Task markdown file name (one file per task, collision-safe IDs). */
export function taskFileName(taskId: string): string {
	assertValidTaskId(taskId);
	return `${taskId}.md`;
}
