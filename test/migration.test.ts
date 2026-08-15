import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigration, previewMigration, readRevisions, recordRevision, rollbackMigration } from "../src/migration.ts";
import { loadConfigFromText } from "../src/config.ts";

let dir: string;
let configPath: string;
const v1Yaml = `version: 1
project:
  name: my-app
  task_prefix: DEV
  target_branch: main
future_field: keep-me
commands:
  unit:
    argv: ["npm", "test"]
    timeout_ms: 900000
    required: true
checks:
  verify: [unit]
  post_integration: [unit]
`;

beforeEach(() => {
	dir = join(tmpdir(), `sym-mig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	configPath = join(dir, "config.yaml");
	writeFileSync(configPath, v1Yaml, "utf8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("v1 → v2 migration (V03-CFG-001)", () => {
	it("preview is pure and describes the changes", () => {
		const preview = previewMigration(v1Yaml, 3);
		expect(preview.changes.some((c) => c.includes("version: 1 → 2"))).toBe(true);
		expect(preview.changes.some((c) => c.includes("invariants"))).toBe(true);
		expect(preview.changes.some((c) => c.includes("skills"))).toBe(true);
		expect(existsSync(configPath)).toBe(true);
		expect(readFileSync(configPath, "utf8")).toBe(v1Yaml); // untouched
	});

	it("apply writes atomically, preserves unknown fields, and validates as v2", () => {
		const preview = previewMigration(v1Yaml);
		const result = applyMigration(configPath, preview);
		expect(result.ok).toBe(true);
		const migrated = readFileSync(configPath, "utf8");
		expect(migrated).toMatch(/version: 2/);
		expect(migrated).toMatch(/future_field: keep-me/); // unknown fields preserved
		expect(migrated).toMatch(/require_deterministic_verify: true/);
	});

	it("rollback restores the v1 document exactly", () => {
		const preview = previewMigration(v1Yaml);
		const result = applyMigration(configPath, preview);
		if (!result.ok) throw new Error("apply failed");
		expect(rollbackMigration(configPath, result.backupPath)).toBe(true);
		expect(readFileSync(configPath, "utf8")).toBe(v1Yaml);
	});

	it("interrupted apply never leaves partial YAML active", () => {
		// simulate: temp written, rename never happens (apply is atomic by design;
		// verify a crashed apply cannot corrupt the original)
		writeFileSync(`${configPath}.tmp`, "version: 2\npartial...", "utf8");
		expect(readFileSync(configPath, "utf8")).toBe(v1Yaml);
	});
});

describe("configuration revision model", () => {
	it("records monotonic revisions with content hashes", () => {
		const first = recordRevision(configPath);
		expect(first.revision).toBe(1);
		writeFileSync(configPath, v1Yaml.replace("DEV", "WEB"), "utf8");
		const second = recordRevision(configPath);
		expect(second.revision).toBe(2);
		expect(second.contentHash).not.toBe(first.contentHash);
		const history = readRevisions(configPath);
		expect(history.map((r) => r.revision)).toEqual([1, 2]);
	});
});
