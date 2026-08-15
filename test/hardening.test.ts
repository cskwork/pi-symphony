import { describe, expect, it } from "vitest";
import {
	ADVERSARIAL_PATHS,
	MigrationJournal,
	PERF_BUDGETS,
	RESOURCE_LIMITS,
	THREAT_MODEL,
	auditThreatModel,
	checkBudget,
	evaluateCompatibility,
	isContained,
	paginate,
	type HostEnvironment,
} from "../src/hardening.ts";

function env(overrides: Partial<HostEnvironment> = {}): HostEnvironment {
	return { piVersion: "0.84.2", nodeVersion: "22.22.3", gitVersion: "2.45.0", os: "darwin", schemaVersion: 2, ...overrides };
}

describe("compatibility matrix (V09-COMP-*)", () => {
	it("supported hosts get read-write mode", () => {
		const result = evaluateCompatibility(env());
		expect(result.mode).toBe("read-write");
		expect(result.blockers).toEqual([]);
	});

	it("unsupported Pi/schema fail closed with actionable remediation", () => {
		const wrongPi = evaluateCompatibility(env({ piVersion: "0.99.0" }));
		expect(wrongPi.mode).not.toBe("read-write");
		expect(wrongPi.blockers[0]).toMatch(/upgrade\/downgrade Pi/);
		const newerSchema = evaluateCompatibility(env({ schemaVersion: 3 }));
		expect(newerSchema.mode).toBe("refuse");
		expect(newerSchema.blockers[0]).toMatch(/upgrade Symphony/);
		// old node: read-only at best, never speculative mutation
		const oldNode = evaluateCompatibility(env({ nodeVersion: "18.0.0" }));
		expect(["read-only", "refuse"]).toContain(oldNode.mode);
	});
});

describe("threat model traceability (V09-SEC-001)", () => {
	it("every threat has a control and traced tests", () => {
		const audit = auditThreatModel();
		expect(audit.ok).toBe(true);
		if (audit.ok) expect(audit.entries).toBe(THREAT_MODEL.length);
		expect(THREAT_MODEL.length).toBeGreaterThanOrEqual(5);
	});
});

describe("adversarial path corpus (V09-FS-001)", () => {
	it.each(ADVERSARIAL_PATHS)("$note: $input", (testCase) => {
		expect(isContained(testCase.input, ".symphony/tasks")).toBe(testCase.expectContained);
	});
});

describe("migration journal (V09-DATA-001)", () => {
	it("resumes from the exact interrupted step", () => {
		const journal = new MigrationJournal();
		journal.start("backup");
		journal.complete("backup");
		journal.start("write-v2");
		expect(journal.resumeFrom()).toBe("write-v2");
		journal.fail("write-v2", "EACCES");
		expect(journal.resumeFrom()).toBe("write-v2");
		journal.complete("write-v2");
		expect(journal.resumeFrom()).toBeUndefined();
	});
});

describe("performance budgets (V09-PERF-*)", () => {
	it("budgets are defined and checkable", () => {
		expect(PERF_BUDGETS.length).toBeGreaterThanOrEqual(5);
		expect(checkBudget("workflow gate evaluation", 0.5).ok).toBe(true);
		expect(checkBudget("workflow gate evaluation", 5).ok).toBe(false);
	});

	it("pagination bounds large sets without exhausting memory", () => {
		const big = Array.from({ length: 10_000 }, (_, i) => i);
		const page = paginate(big, 2);
		expect(page.items.length).toBe(RESOURCE_LIMITS.maxTaskListPage);
		expect(page.total).toBe(10_000);
		expect(page.totalPages).toBe(100);
		const clamped = paginate(big, 999);
		expect(clamped.page).toBe(100);
	});
});
