import { describe, expect, it } from "vitest";
import { runCheck, buildCheckEnv, isStale } from "../src/checks.ts";
import type { CommandExecutor } from "../src/checks.ts";

const baseOptions = { cwd: process.cwd(), revision: "rev-1", env: { PATH: process.env.PATH ?? "" } };

describe("check runner", () => {
	it("records passed for exit 0", async () => {
		const outcome = await runCheck("unit", { argv: ["true"], timeoutMs: 2000 }, baseOptions);
		expect(outcome.status).toBe("passed");
		expect(outcome.evidence.exitCode).toBe(0);
	});

	it("records failed for non-zero exit", async () => {
		const outcome = await runCheck("unit", { argv: ["false"], timeoutMs: 2000 }, baseOptions);
		expect(outcome.status).toBe("failed");
	});

	it("records timeout and kills the process", async () => {
		const outcome = await runCheck("unit", { argv: ["sleep", "5"], timeoutMs: 150 }, baseOptions);
		expect(outcome.status).toBe("timeout");
		expect(outcome.evidence.durationMs).toBeLessThan(3000);
	});

	it("records unavailable when the executable is missing", async () => {
		const outcome = await runCheck("unit", { argv: ["definitely-not-a-command-xyz"], timeoutMs: 2000 }, baseOptions);
		expect(outcome.status).toBe("unavailable");
	});

	it("redacts secrets before persisting output", async () => {
		const executor: CommandExecutor = async () => ({
			code: 0,
			stdout: "ok\npassword=hunter2bornot\nAPI_KEY: sk-abcdef1234567890abcdef",
			stderr: "",
			timedOut: false,
		});
		const outcome = await runCheck("unit", { argv: ["x"], timeoutMs: 1000 }, { ...baseOptions, executor });
		expect(outcome.evidence.output).not.toContain("hunter2bornot");
		expect(outcome.evidence.output).not.toContain("sk-abcdef1234567890abcdef");
		expect(outcome.evidence.output).toMatch(/REDACTED/);
	});

	it("truncates oversized output deterministically", async () => {
		const executor: CommandExecutor = async () => ({
			code: 0,
			stdout: "x".repeat(500_000),
			stderr: "",
			timedOut: false,
		});
		const outcome = await runCheck("unit", { argv: ["x"], timeoutMs: 1000, maxOutputBytes: 10_000 }, { ...baseOptions, executor });
		expect(outcome.evidence.truncated).toBe(true);
		expect(outcome.evidence.output.length).toBeLessThan(20_000);
		expect(outcome.evidence.output).toMatch(/truncated at 10000 bytes/);
	});

	it("builds an allowlisted environment without implicit credentials", () => {
		const env = buildCheckEnv({ argv: [], timeoutMs: 1, envAllowlist: ["CI"] }, {
			PATH: "/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-secret", CI: "1",
		} as NodeJS.ProcessEnv);
		expect(env.PATH).toBe("/bin");
		expect(env.CI).toBe("1");
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("marks evidence stale against a different revision", () => {
		const evidence = { check: "x", runId: "r", status: "passed" as const, exitCode: 0, durationMs: 1, startedAt: "", finishedAt: "", output: "", truncated: false, revision: "a", command: [] };
		expect(isStale(evidence, "b")).toBe(true);
		expect(isStale(evidence, "a")).toBe(false);
		expect(isStale({ ...evidence, revision: null }, "b")).toBe(false);
	});
});
