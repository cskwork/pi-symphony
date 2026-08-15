import { join } from "node:path";

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
		evidenceDir: (taskId: string) => join(evidence, taskId),
		checksDir: (taskId: string) => join(evidence, taskId, "checks"),
		reviewDir: (taskId: string) => join(evidence, taskId, "review"),
		integrationDir: (taskId: string) => join(evidence, taskId, "integration"),
		runtimeDir: runtime,
		eventsFile: (taskId: string) => join(runtime, "events", `${taskId}.jsonl`),
		leaseFile: join(runtime, "leases", "active.json"),
		cacheDir: join(runtime, "cache"),
		taskIndex: join(runtime, "cache", "task-index.json"),
		logsDir: join(runtime, "logs"),
	};
}

/** Task markdown file name (one file per task, collision-safe IDs). */
export function taskFileName(taskId: string): string {
	return `${taskId}.md`;
}
