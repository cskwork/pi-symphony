/**
 * Composable skills layer (PRD v0.3): manifests, catalogs, progressive
 * disclosure, pinning, capability intersection, lint, and fixtures.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Manifest v1 (V03-SKILL-002)
// ---------------------------------------------------------------------------

export type InvocationMode = "stage_or_explicit" | "explicit_only" | "policy";
export type Capability =
	| "read_task"
	| "read_repository"
	| "read_diff"
	| "read_check_evidence"
	| "write_task_notes"
	| "propose_report";

export interface SkillManifest {
	name: string;
	version: string;
	description: string;
	invocation: InvocationMode;
	stages: string[];
	capabilities: Capability[];
	inputs: string[];
	outputs: string[];
	sideEffects: "none" | "notes_only" | string;
	entry: string;
	fixtures?: string;
	/** Origin and integrity (never self-declared verified). */
	source: "repository" | "user" | "builtin";
	contentHash: string;
}

export interface SkillIssue {
	field?: string;
	message: string;
}

const CAPABILITIES: Capability[] = ["read_task", "read_repository", "read_diff", "read_check_evidence", "write_task_notes", "propose_report"];

/**
 * Parse and validate a skill manifest. Incomplete skills are rejected with
 * the exact missing/invalid field (V03-SKILL-002).
 */
export function parseSkillManifest(raw: unknown, source: SkillManifest["source"], contentHash: string): { issues: SkillIssue[]; manifest?: SkillManifest } {
	const issues: SkillIssue[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { issues: [{ message: "manifest must be a YAML mapping" }] };
	}
	const doc = raw as Record<string, unknown>;
	const required: Array<[string, "string" | "string[]"]> = [
		["name", "string"],
		["version", "string"],
		["description", "string"],
		["invocation", "string"],
		["stages", "string[]"],
		["capabilities", "string[]"],
		["inputs", "string[]"],
		["outputs", "string[]"],
		["side_effects", "string"],
		["entry", "string"],
	];
	for (const [field, kind] of required) {
		const value = doc[field];
		if (value === undefined) {
			issues.push({ field, message: `required field "${field}" is missing` });
			continue;
		}
		if (kind === "string" && typeof value !== "string") issues.push({ field, message: `"${field}" must be a string` });
		if (kind === "string[]" && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) {
			issues.push({ field, message: `"${field}" must be a list of strings` });
		}
	}
	if (!/^[-a-z0-9]+$/.test(String(doc["name"] ?? ""))) {
		issues.push({ field: "name", message: "skill name must be kebab-case" });
	}
	if (!/^\d+\.\d+\.\d+$/.test(String(doc["version"] ?? ""))) {
		issues.push({ field: "version", message: "version must be semver (e.g. 1.0.0)" });
	}
	const invocation = String(doc["invocation"] ?? "");
	if (!["stage_or_explicit", "explicit_only", "policy"].includes(invocation)) {
		issues.push({ field: "invocation", message: "invocation must be stage_or_explicit | explicit_only | policy" });
	}
	const caps = Array.isArray(doc["capabilities"]) ? (doc["capabilities"] as unknown[]).map(String) : [];
	const unknownCaps = caps.filter((c) => !CAPABILITIES.includes(c as Capability));
	if (unknownCaps.length > 0) {
		issues.push({ field: "capabilities", message: `unknown capabilities: ${unknownCaps.join(", ")} (allowed: ${CAPABILITIES.join(", ")})` });
	}
	if (caps.length === 0) issues.push({ field: "capabilities", message: "at least one capability must be declared" });
	if ((doc["side_effects"] ?? "none") !== "none" && (doc["side_effects"] ?? "") !== "notes_only") {
		issues.push({ field: "side_effects", message: "side_effects must be none or notes_only in v1" });
	}
	if (issues.length > 0) return { issues };
	return {
		issues: [],
		manifest: {
			name: String(doc["name"]),
			version: String(doc["version"]),
			description: String(doc["description"]),
			invocation: invocation as InvocationMode,
			stages: doc["stages"] as string[],
			capabilities: caps as Capability[],
			inputs: doc["inputs"] as string[],
			outputs: doc["outputs"] as string[],
			sideEffects: String(doc["side_effects"]),
			entry: String(doc["entry"]),
			fixtures: doc["fixtures"] ? String(doc["fixtures"]) : undefined,
			source,
			contentHash,
		},
	};
}

// ---------------------------------------------------------------------------
// Catalog loading + pinning (V03-SKILL-001/004)
// ---------------------------------------------------------------------------

export interface CatalogEntry {
	/** The small catalog view the model sees before selection. */
	name: string;
	version: string;
	description: string;
	stages: string[];
	invocation: InvocationMode;
	source: SkillManifest["source"];
}

export interface LoadedSkill extends SkillManifest {
	/** Absolute path of the skill directory. */
	dir: string;
	entryPath: string;
}

export interface SkillLockEntry {
	name: string;
	version: string;
	hash: string;
	source: SkillManifest["source"];
	pinnedAt: string;
}

export class SkillCatalog {
	private skills = new Map<string, LoadedSkill>();
	private issues: SkillIssue[] = [];

	constructor(private catalogDirs: Array<{ dir: string; source: SkillManifest["source"] }>) {
		this.load();
	}

	private load(): void {
		for (const { dir, source } of this.catalogDirs) {
			if (!existsSync(dir)) continue;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const skillDir = join(dir, entry.name);
				const manifestPath = join(skillDir, "skill.yaml");
				if (!existsSync(manifestPath)) {
					this.issues.push({ message: `${skillDir}: missing skill.yaml manifest` });
					continue;
				}
				const manifestText = readFileSync(manifestPath, "utf8");
				const hash = createHash("sha256").update(manifestText).digest("hex").slice(0, 32);
				let parsed: unknown;
				try {
					parsed = parseYaml(manifestText);
				} catch (err) {
					this.issues.push({ field: `${entry.name}:manifest`, message: `YAML parse error: ${(err as Error).message}` });
					continue;
				}
				const result = parseSkillManifest(parsed, source, hash);
				if (!result.manifest) {
					this.issues.push(...result.issues.map((i) => ({ field: i.field ? `${entry.name}:${i.field}` : undefined, message: `${entry.name}: ${i.message}` })));
					continue;
				}
				const entryPath = join(skillDir, result.manifest.entry);
				// Containment: the entry must stay inside the skill directory —
				// a manifest must never widen read access beyond its own package.
				if (!isContainedIn(entryPath, skillDir)) {
					this.issues.push({ message: `${entry.name}: entry "${result.manifest.entry}" escapes the skill directory` });
					continue;
				}
				if (!existsSync(entryPath)) {
					this.issues.push({ message: `${entry.name}: entry file "${result.manifest.entry}" not found` });
					continue;
				}
				this.skills.set(result.manifest.name, { ...result.manifest, dir: skillDir, entryPath });
			}
		}
	}

	catalog(): CatalogEntry[] {
		return [...this.skills.values()].map((s) => ({
			name: s.name,
			version: s.version,
			description: s.description,
			stages: s.stages,
			invocation: s.invocation,
			source: s.source,
		}));
	}

	get(name: string): LoadedSkill | undefined {
		return this.skills.get(name);
	}

	/** Full body loads ONLY here — the catalog entry never includes it (V03-SKILL-001). */
	loadBody(name: string): string | undefined {
		const skill = this.skills.get(name);
		if (!skill) return undefined;
		return readFileSync(skill.entryPath, "utf8");
	}

	manifestIssues(): SkillIssue[] {
		return [...this.issues];
	}
}

/**
 * Pin lock: installed skills are recorded with version+hash; silent content
 * changes surface as a pin mismatch requiring explicit re-approval (V03-SKILL-004).
 */
export function readSkillLock(path: string): SkillLockEntry[] {
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf8")) as SkillLockEntry[];
	} catch {
		return [];
	}
}

export function pinMismatches(skills: LoadedSkill[], lock: SkillLockEntry[]): Array<{ name: string; reason: string }> {
	const out: Array<{ name: string; reason: string }> = [];
	for (const skill of skills) {
		const pinned = lock.find((l) => l.name === skill.name);
		if (!pinned) {
			out.push({ name: skill.name, reason: "not pinned — install/approve it explicitly" });
			continue;
		}
		if (pinned.hash !== skill.contentHash) out.push({ name: skill.name, reason: `content changed since pin (${pinned.version} → ${skill.version})` });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Capability intersection (V03-SKILL-003)
// ---------------------------------------------------------------------------

export function activeCapabilities(rolePolicy: string[], repositoryPolicy: string[], selectedSkills: LoadedSkill[]): string[] {
	const allowed = rolePolicy.filter((cap) => repositoryPolicy.includes(cap));
	const granted = new Set<string>(allowed);
	for (const skill of selectedSkills) {
		for (const cap of skill.capabilities) {
			// A skill can never *add* a capability the policies forbid.
			if (allowed.includes(cap)) granted.add(cap);
		}
	}
	return [...granted];
}

// ---------------------------------------------------------------------------
// Lint (V03-SKILL-005)
// ---------------------------------------------------------------------------

export interface LintFinding {
	skill: string;
	rule: string;
	message: string;
}

export function lintSkill(skill: LoadedSkill, body: string): LintFinding[] {
	const findings: LintFinding[] = [];
	const name = skill.name;
	// Ambiguous pointers: "see the docs" without a path
	if (/\b(see|refer to)\s+(the\s+)?(docs?|documentation|references?)\b(?!\s*at\s|:)/i.test(body)) {
		findings.push({ skill: name, rule: "ambiguous-pointer", message: "body references documentation without naming a file" });
	}
	// Missing completion criteria
	if (!/(?:complete|done|finished) when|when (?:this skill is )?(?:complete|done|finished)|completion criteria/i.test(body)) {
		findings.push({ skill: name, rule: "missing-completion", message: "no completion criteria described" });
	}
	// Undclared side effects: body edits files but manifest says none
	if (skill.sideEffects === "none" && /\b(edit|write|create|delete|move)\b.*\b(file|files)\b/i.test(body)) {
		findings.push({ skill: name, rule: "undeclared-side-effect", message: "body describes file writes but side_effects is none" });
	}
	// Duplicated authoritative text: same 8-word run twice
	const words = body.toLowerCase().split(/\s+/).filter(Boolean);
	const seen = new Set<string>();
	for (let i = 0; i + 8 <= words.length; i++) {
		const run = words.slice(i, i + 8).join(" ");
		if (seen.has(run)) {
			findings.push({ skill: name, rule: "duplicated-text", message: `repeated passage: "${run.slice(0, 40)}…"` });
			break;
		}
		seen.add(run);
	}
	// Unavailable references: referenced local files that don't exist
	for (const match of body.matchAll(/\]\(([^)#h][^)]*)\)/g)) {
		const ref = match[1]!.trim();
		if (ref.startsWith("http") || ref.startsWith("#")) continue;
		if (!existsSync(join(skill.dir, ref))) {
			findings.push({ skill: name, rule: "unavailable-reference", message: `referenced file missing: ${ref}` });
		}
	}
	return findings;
}

// ---------------------------------------------------------------------------
// Behavioral fixtures (V03-EVAL-001)
// ---------------------------------------------------------------------------

export interface SkillFixture {
	name: string;
	/** Deterministic stub replies keyed by prompt substring. */
	stubReplies: Array<{ when: string; reply: string }>;
	expectCheckpoints: string[];
	forbiddenOutputs: string[];
}

export interface FixtureResult {
	fixture: string;
	passed: boolean;
	failedCheckpoints: string[];
	forbiddenHits: string[];
}

/** Run fixtures against a deterministic model stub — no LLM required. */
export function runFixture(fixture: SkillFixture, body: string): FixtureResult {
	// The stub conversation: the skill body is "sent", stub replies in order.
	let transcript = body;
	for (const stub of fixture.stubReplies) {
		if (transcript.includes(stub.when) || stub.when === "*") transcript += `\n${stub.reply}`;
	}
	const failedCheckpoints = fixture.expectCheckpoints.filter((cp) => !transcript.includes(cp));
	const forbiddenHits = fixture.forbiddenOutputs.filter((out) => transcript.includes(out));
	return {
		fixture: fixture.name,
		passed: failedCheckpoints.length === 0 && forbiddenHits.length === 0,
		failedCheckpoints,
		forbiddenHits,
	};
}


/** True when `candidate` resolves inside `base` (no traversal escapes). */
function isContainedIn(candidate: string, base: string): boolean {
	const resolved = resolve(candidate);
	const root = resolve(base);
	return resolved === root || resolved.startsWith(root + sep);
}
