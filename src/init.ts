import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitSnapshot, type GitExec } from "./gitinfo.ts";

/**
 * Repository inspection for /sym init. Everything here is read-only file
 * inspection — project scripts are never executed (V01-PROJ-001).
 */
export interface InitProposal {
	projectName: string;
	taskPrefix: string;
	targetBranch: string;
	isGitRepo: boolean;
	suggestedChecks: Array<{ name: string; argv: string[]; note: string }>;
	inspectedFiles: string[];
	warnings: string[];
}

export async function proposeInit(repoRoot: string, gitExec: GitExec): Promise<InitProposal> {
	const warnings: string[] = [];
	const inspectedFiles: string[] = [];
	const snapshot = await gitSnapshot(gitExec, repoRoot);
	if (!snapshot.isRepo) warnings.push("directory is not a git repository — git-dependent evidence will show unavailable");

	let projectName = repoRoot.split("/").filter(Boolean).pop() ?? "project";
	const suggested: InitProposal["suggestedChecks"] = [];

	const pkgPath = join(repoRoot, "package.json");
	try {
		const pkg = JSON.parse(await readFile(pkgPath)) as Record<string, unknown>;
		inspectedFiles.push("package.json");
		if (typeof pkg["name"] === "string" && pkg["name"]) projectName = pkg["name"];
		const scripts = (pkg["scripts"] ?? {}) as Record<string, string>;
		const pm = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"]
			.map((f) => (fileExists(join(repoRoot, f)) ? f : null))
			.find(Boolean);
		const runner = pm?.startsWith("pnpm") ? "pnpm" : pm?.startsWith("yarn") ? "yarn" : "npm";
		if (scripts["test"]) suggested.push({ name: "unit", argv: [runner, "test"], note: `scripts.test via ${runner}` });
		if (scripts["typecheck"]) suggested.push({ name: "typecheck", argv: [runner, "run", "typecheck"], note: "scripts.typecheck" });
		if (scripts["lint"]) suggested.push({ name: "lint", argv: [runner, "run", "lint"], note: "scripts.lint" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`package.json is malformed: ${(err as Error).message}`);
	}

	if (suggested.length === 0 && fileExists(join(repoRoot, "pyproject.toml"))) {
		inspectedFiles.push("pyproject.toml");
		suggested.push({ name: "unit", argv: ["python3", "-m", "pytest"], note: "python project" });
	}
	if (suggested.length === 0 && fileExists(join(repoRoot, "pom.xml"))) {
		inspectedFiles.push("pom.xml");
		suggested.push({ name: "unit", argv: ["mvn", "-q", "test"], note: "maven project" });
	}
	if (suggested.length === 0) {
		suggested.push({ name: "smoke", argv: ["node", "--version"], note: "placeholder — replace with a real check in config.yaml" });
	}

	return {
		projectName,
		taskPrefix: "DEV",
		targetBranch: snapshot.branch && snapshot.branch !== "HEAD" ? snapshot.branch : "main",
		isGitRepo: snapshot.isRepo,
		suggestedChecks: suggested,
		inspectedFiles,
		warnings,
	};
}

async function readFile(path: string): Promise<string> {
	const { readFile: rf } = await import("node:fs/promises");
	return rf(path, "utf8");
}

function fileExists(path: string): boolean {
	return existsSync(path);
}
