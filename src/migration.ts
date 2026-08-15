/**
 * Configuration schema v1 → v2 migration (PRD v0.3): previewable, backup,
 * unknown-field preservation, explicit rollback (V03-CFG-001).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { monotonicId } from "./ids.ts";

export interface MigrationPreview {
	fromVersion: 1;
	toVersion: 2;
	changes: string[];
	/** v2 document that would be written. */
	nextYaml: string;
	backupPath?: string;
}

/**
 * Build the v2 preview from a v1 document. Pure: writes nothing.
 */
export function previewMigration(v1Yaml: string, repositoryRevision = 0): MigrationPreview {
	const changes: string[] = [];
	const lines: string[] = [];
	let inCommands = false;
	for (const line of v1Yaml.split("\n")) {
		if (/^version:\s*1\s*$/.test(line)) {
			lines.push("version: 2");
			changes.push("version: 1 → 2");
			continue;
		}
		if (/^workflow:/.test(line)) {
			lines.push(line);
			lines.push("  stages: default   # v1 software-dev preset expressed as the default v2 stage graph");
			lines.push("  invariants:");
			lines.push("    require_deterministic_verify: true");
			lines.push("    require_completion_evidence: true");
			changes.push("workflow: added stages + invariants block (defaults preserve v1 behavior)");
			continue;
		}
		if (/^  preset: software-dev\s*$/.test(line)) {
			changes.push("workflow.preset preserved (default graph)");
			lines.push(line);
			continue;
		}
		lines.push(line);
	}
	if (!/^workflow:/.test(v1Yaml)) {
		lines.push("workflow:");
		lines.push("  stages: default");
		lines.push("  invariants:");
		lines.push("    require_deterministic_verify: true");
		lines.push("    require_completion_evidence: true");
		changes.push("workflow: added stages + invariants block (defaults preserve v1 behavior)");
	}
	if (!/^skills:/.test(v1Yaml)) {
		lines.push("skills:");
		lines.push("  catalogs:");
		lines.push("    - path: .symphony/skills");
		lines.push("      trust: repository");
		lines.push("  stage_bindings: {}");
		lines.push("  model_selection:");
		lines.push("    enabled: true");
		lines.push("    max_selected: 2");
		changes.push("skills: added default catalog block (.symphony/skills, repository trust)");
	}
	const nextYaml = lines.join("\n");
	changes.push(`repository revision: ${repositoryRevision} → ${repositoryRevision + 1}`);
	return { fromVersion: 1, toVersion: 2, changes, nextYaml };
}

/**
 * Apply the migration atomically: backup → temp write → rename. Returns the
 * backup path for explicit rollback. An interrupted apply leaves the original
 * untouched because the rename is atomic.
 */
export function applyMigration(configPath: string, preview: Partial<MigrationPreview> | undefined): { ok: true; backupPath: string } | { ok: false; error: string } {
	if (!existsSync(configPath)) return { ok: false, error: `configuration not found: ${configPath}` };
	if (!preview || typeof preview.nextYaml !== "string" || preview.nextYaml.length === 0) {
		return { ok: false, error: "invalid migration preview: call previewMigration() first" };
	}
	const backupPath = `${configPath}.v1-backup-${monotonicId()}`;
	copyFileSync(configPath, backupPath);
	const tmp = `${configPath}.tmp`;
	mkdirSync(join(configPath, ".."), { recursive: true });
	writeFileSync(tmp, preview.nextYaml, "utf8");
	renameSync(tmp, configPath);
	return { ok: true, backupPath };
}

/** Explicit rollback: copy the backup back over the migrated file. */
export function rollbackMigration(configPath: string, backupPath: string): boolean {
	if (!existsSync(backupPath)) return false;
	copyFileSync(backupPath, configPath);
	return true;
}

/**
 * Configuration revision model: applied configurations carry a content hash
 * and a monotonic repository revision (persisted beside the config).
 */
export interface ConfigRevision {
	revision: number;
	contentHash: string;
	appliedAt: string;
}

export function revisionPath(configPath: string): string {
	return `${configPath}.revisions.json`;
}

export function readRevisions(configPath: string): ConfigRevision[] {
	const path = revisionPath(configPath);
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ConfigRevision[];
	} catch {
		return [];
	}
}

export function recordRevision(configPath: string): ConfigRevision {
	const history = readRevisions(configPath);
	const content = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
	const next: ConfigRevision = {
		revision: (history[history.length - 1]?.revision ?? 0) + 1,
		contentHash: createHash("sha256").update(content).digest("hex").slice(0, 32),
		appliedAt: new Date().toISOString(),
	};
	writeFileSync(revisionPath(configPath), JSON.stringify([...history, next], null, "\t"), "utf8");
	return next;
}
