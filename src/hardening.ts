/**
 * Release-candidate hardening (PRD v0.9): compatibility matrix, threat-model
 * traceability, adversarial path corpus, migration journal, performance
 * budgets, and resource bounds.
 */

// ---------------------------------------------------------------------------
// Compatibility matrix (V09-COMP-*)
// ---------------------------------------------------------------------------

export interface HostEnvironment {
	piVersion: string;
	nodeVersion: string;
	gitVersion: string;
	os: "darwin" | "linux" | "win32" | "other";
	schemaVersion: number;
}

export type CompatibilityMode = "read-write" | "read-only" | "refuse";

export const SUPPORTED = {
	pi: "0.84",
	node: "22",
	git: "2.30",
	schema: 2,
};

export function evaluateCompatibility(env: HostEnvironment): { mode: CompatibilityMode; blockers: string[]; warnings: string[] } {
	const blockers: string[] = [];
	const warnings: string[] = [];
	const [piMajor, piMinor] = env.piVersion.split(".");
	const [supportedMajor, supportedMinor] = SUPPORTED.pi.split(".");
	if (piMajor !== supportedMajor || piMinor !== supportedMinor) {
		blockers.push(`Pi ${env.piVersion} is unsupported (tested against ${SUPPORTED.pi}.x) — upgrade/downgrade Pi before enabling mutation`);
	}
	const nodeMajor = env.nodeVersion.split(".")[0];
	if (Number(nodeMajor) < Number(SUPPORTED.node)) {
		blockers.push(`Node ${env.nodeVersion} is below the minimum (${SUPPORTED.node}.x)`);
	}
	if (Number(env.gitVersion.split(".")[0] ?? 0) < 2) {
		warnings.push(`Git ${env.gitVersion} is old; some read-only inspections may misbehave`);
	}
	if (env.os === "other") {
		warnings.push("unsupported OS: read-only mode");
	}
	if (env.schemaVersion > SUPPORTED.schema) {
		blockers.push(`repository schema v${env.schemaVersion} is newer than this Symphony (v${SUPPORTED.schema}) — upgrade Symphony first`);
	}
	const mode: CompatibilityMode =
		blockers.length === 0
			? "read-write"
			: env.schemaVersion > SUPPORTED.schema
				? "refuse"
				: "read-only"; // known schema, wrong host: inspect but never mutate
	return { mode, blockers, warnings };
}

// ---------------------------------------------------------------------------
// Threat model traceability (V09-SEC-001)
// ---------------------------------------------------------------------------

export interface ThreatEntry {
	id: string;
	asset: string;
	actor: string;
	entryPoint: string;
	threat: string;
	control: string;
	testIds: string[];
	residualRisk: string;
}

export const THREAT_MODEL: ThreatEntry[] = [
	{
		id: "T1", asset: "task/evidence files", actor: "model (implementer session)", entryPoint: "write/edit/bash tools",
		threat: "forged Ready/Done by editing task files or evidence artifacts",
		control: "protected-path guard (tasks/evidence always block), digest-bound artifacts, file-vs-ledger reconciliation",
		testIds: ["security.test.ts:E1", "security.test.ts:E2", "extension-wiring.test.ts:guard"], residualRisk: "same-user processes outside Pi can still edit files (documented non-sandbox)",
	},
	{
		id: "T2", asset: "workflow gates", actor: "model", entryPoint: "sym_* tools",
		threat: "self-certified review or evidence-free completion",
		control: "review provenance invariant, contract-enforced transitions, check gates on async paths only",
		testIds: ["blockers.test.ts:blocker-2", "blockers.test.ts:blocker-1", "security.test.ts:E3"], residualRisk: "none known",
	},
	{
		id: "T3", asset: "check evidence", actor: "any local process", entryPoint: ".symphony/evidence files",
		threat: "tampered check artifact flips a failure to a pass",
		control: "sha256 artifact digest recorded in the ledger; mismatch downgrades to broken",
		testIds: ["security.test.ts:E2"], residualRisk: "ledger rewrite by a privileged local user (non-sandbox boundary)",
	},
	{
		id: "T4", asset: "local web control plane", actor: "malicious local page/process", entryPoint: "loopback HTTP",
		threat: "CSRF/DNS-rebinding mutation, token theft from logs",
		control: "host/origin/credential/content-type validation, fragment token never logged, bounded bodies, CSP",
		testIds: ["web-server.test.ts:V02-AUTH-001", "web-protocol.test.ts"], residualRisk: "same-user local processes can read the token from memory",
	},
	{
		id: "T5", asset: "detached runtime", actor: "stale supervisor", entryPoint: "RPC reports",
		threat: "post-takeover mutations from an old epoch",
		control: "epoch + fencing token validation on every report",
		testIds: ["runtime-supervisor.test.ts:V07-RUN-002"], residualRisk: "none known",
	},
	{
		id: "T6", asset: "credential material", actor: "logs/exports/diagnostics", entryPoint: "every persistence surface",
		threat: "secret leakage into artifacts",
		control: "redaction before persistence/transport across checks, diagnostics, exports, integrations",
		testIds: ["checks.test.ts:redaction", "security.test.ts:S4", "integrations.test.ts:V08-AUTH-001"], residualRisk: "novel secret formats",
	},
];

/** Build fails when a critical threat lacks a control or test (V09-SEC-001). */
export function auditThreatModel(): { ok: true; entries: number } | { ok: false; violations: string[] } {
	const violations: string[] = [];
	for (const entry of THREAT_MODEL) {
		if (!entry.control || entry.control.length < 8) violations.push(`${entry.id}: missing control`);
		if (entry.testIds.length === 0) violations.push(`${entry.id}: no test coverage traced`);
	}
	return violations.length === 0 ? { ok: true, entries: THREAT_MODEL.length } : { ok: false, violations };
}

// ---------------------------------------------------------------------------
// Adversarial path corpus (V09-FS-001)
// ---------------------------------------------------------------------------

export interface PathCase {
	input: string;
	expectContained: boolean;
	note: string;
}

export const ADVERSARIAL_PATHS: PathCase[] = [
	{ input: ".symphony/tasks/DEV-001.md", expectContained: true, note: "normal" },
	{ input: ".symphony/tasks/../../.ssh/authorized_keys", expectContained: false, note: "traversal" },
	{ input: ".symphony/tasks/DEV-001.md/../../config.yaml", expectContained: false, note: "traversal via suffix" },
	{ input: ".symphony/tasks/../tasks/DEV-001.md", expectContained: true, note: "bouncing traversal resolves inside" },
	{ input: ".symphony//tasks///DEV-001.md", expectContained: true, note: "redundant separators" },
	{ input: ".symphony/tasks/./DEV-001.md", expectContained: true, note: "dot segment" },
	{ input: ".symphony/tasks/dev-001.md", expectContained: true, note: "case-folded name (APFS)" },
	{ input: ".symphony/tasks/DEV\u001B[2m.md", expectContained: false, note: "escape-sequence injection" },
];

/** Containment check used across managed-path surfaces. */
export function isContained(candidate: string, base: string): boolean {
	if (candidate.includes("\0") || candidate.includes("\u001B")) return false;
	const canonical = candidate.replace(/\/+/g, "/").replace(/\/$/, "");
	const baseCanonical = base.replace(/\/+$/, "");
	// resolve . and .. segments
	const segments: string[] = [];
	for (const segment of canonical.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return false; // escapes the root
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	const resolved = segments.join("/");
	const baseSegments = baseCanonical.split("/").filter((s) => s !== "" && s !== ".");
	return resolved === baseSegments.join("/") || resolved.startsWith(`${baseSegments.join("/")}/`);
}

// ---------------------------------------------------------------------------
// Migration journal (V09-DATA-001/002)
// ---------------------------------------------------------------------------

export interface MigrationJournalEntry {
	step: string;
	at: string;
	status: "started" | "completed" | "failed";
	detail?: string;
}

export class MigrationJournal {
	private entries: MigrationJournalEntry[] = [];

	start(step: string): void {
		this.entries.push({ step, at: new Date().toISOString(), status: "started" });
	}

	complete(step: string): void {
		this.entries.push({ step, at: new Date().toISOString(), status: "completed" });
	}

	fail(step: string, detail: string): void {
		this.entries.push({ step, at: new Date().toISOString(), status: "failed", detail });
	}

	/** The journal tells us exactly where to resume after a kill (V09-DATA-001). */
	resumeFrom(): string | undefined {
		const last = this.entries[this.entries.length - 1];
		if (!last) return undefined;
		return last.status === "completed" ? undefined : last.step;
	}

	log(): MigrationJournalEntry[] {
		return [...this.entries];
	}
}

// ---------------------------------------------------------------------------
// Performance budgets (V09-PERF-*)
// ---------------------------------------------------------------------------

export interface PerfBudget {
	name: string;
	budgetMs: number;
}

export const PERF_BUDGETS: PerfBudget[] = [
	{ name: "task-file parse+serialize (1 task)", budgetMs: 5 },
	{ name: "event ledger append (1 event)", budgetMs: 2 },
	{ name: "task list projection (100 tasks)", budgetMs: 50 },
	{ name: "workflow gate evaluation", budgetMs: 1 },
	{ name: "snapshot build (100 tasks)", budgetMs: 100 },
];

export function checkBudget(name: string, measuredMs: number): { ok: boolean; budget: number } {
	const budget = PERF_BUDGETS.find((b) => b.name === name)?.budgetMs;
	return { ok: budget === undefined ? true : measuredMs <= budget, budget: budget ?? -1 };
}

// ---------------------------------------------------------------------------
// Resource bounds (V09-IPC-001, V09-PERF-002)
// ---------------------------------------------------------------------------

export const RESOURCE_LIMITS = {
	maxCommandBodyBytes: 256 * 1024,
	maxArtifactBytes: 2 * 1024 * 1024,
	maxSseRetainedEvents: 5_000,
	maxTaskListPage: 100,
	maxDiffBytes: 512 * 1024,
	maxLogTailBytes: 256 * 1024,
};

/** Pagination degrades large sets instead of exhausting memory (V09-PERF-002). */
export function paginate<T>(items: T[], page: number, pageSize = RESOURCE_LIMITS.maxTaskListPage): { items: T[]; page: number; totalPages: number; total: number } {
	const total = items.length;
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const safePage = Math.min(Math.max(1, page), totalPages);
	const start = (safePage - 1) * pageSize;
	return { items: items.slice(start, start + pageSize), page: safePage, totalPages, total };
}
