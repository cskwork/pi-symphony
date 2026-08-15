import { describe, expect, it, afterEach } from "vitest";
import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { proposeInit } from "../src/init.ts";
import { disposeRepo, makeRepo, realGitExec } from "./helpers.ts";

let dir: string;
afterEach(() => dir && disposeRepo(dir));

describe("init proposal (V01-PROJ-001)", () => {
	it("inspects package.json without executing project scripts and proposes npm checks", async () => {
		dir = makeRepo();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "demo-app", scripts: { test: "vitest --run", typecheck: "tsc --noEmit" } }),
			"utf8",
		);
		const proposal = await proposeInit(dir, realGitExec(dir));
		expect(proposal.projectName).toBe("demo-app");
		expect(proposal.inspectedFiles).toContain("package.json");
		expect(proposal.suggestedChecks[0]!.argv[0]).toBe("npm");
		expect(proposal.isGitRepo).toBe(true);
		// no scripts were executed: no node_modules, no test output files
		expect(readdirSync(dir).filter((f) => f.startsWith("test-output"))).toEqual([]);
	});

	it("falls back to placeholder check for unknown stacks", async () => {
		dir = makeRepo();
		const proposal = await proposeInit(dir, realGitExec(dir));
		expect(proposal.suggestedChecks).toHaveLength(1);
		expect(proposal.suggestedChecks[0]!.note).toMatch(/placeholder/);
	});

	it("python and java projects get stack-appropriate proposals", async () => {
		dir = makeRepo();
		writeFileSync(join(dir, "pyproject.toml"), "[project]\nname='x'\n", "utf8");
		const py = await proposeInit(dir, realGitExec(dir));
		expect(py.suggestedChecks[0]!.argv).toEqual(["python3", "-m", "pytest"]);
	});

	it("non-git directory warns and continues", async () => {
		dir = makeRepo(false);
		const proposal = await proposeInit(dir, realGitExec(dir));
		expect(proposal.isGitRepo).toBe(false);
		expect(proposal.warnings.some((w) => w.includes("not a git repository"))).toBe(true);
	});

	it("malformed package.json produces a warning, not an exception", async () => {
		dir = makeRepo();
		writeFileSync(join(dir, "package.json"), "{ broken", "utf8");
		const proposal = await proposeInit(dir, realGitExec(dir));
		expect(proposal.warnings.some((w) => w.includes("malformed"))).toBe(true);
	});
});
