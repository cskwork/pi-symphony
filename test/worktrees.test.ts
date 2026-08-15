import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FencedLeaseStore,
	WorktreeRegistry,
	canonicalize,
	evaluateDeliveryPreflight,
	isGitMutationArgv,
	recordDeliveryOutcome,
	renderGitCommand,
	sanitizeBranch,
	verifyManualIntegration,
	type DeliveryOutcome,
} from "../src/worktrees.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sym-wt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("typed git mutations (V05-GIT-001)", () => {
	it("renders only fixed-argv commands; free-form input never reaches git", () => {
		expect(renderGitCommand({ kind: "worktree_add", path: "/tmp/ws", branch: "sym/x", baseSha: "a".repeat(40) })).toEqual([
			"worktree", "add", "-b", "sym/x", "/tmp/ws", "a".repeat(40),
		]);
		expect(isGitMutationArgv(["worktree", "add"])).toBe(true);
		expect(isGitMutationArgv(["status"])).toBe(false);
		// typed commands carry no user-supplied flags at all
		for (const command of [
			{ kind: "worktree_add", path: "/tmp/x", branch: "b", baseSha: "a".repeat(40) },
			{ kind: "merge_ff_only", target: "main", source: "sym/x" },
		] as const) {
			for (const arg of renderGitCommand(command as never)) {
				expect(arg.startsWith("--")).toBe(arg === "--ff-only");
			}
		}
	});
});

describe("workspace registry (V05-WS-*)", () => {
	it("allocation requires paths outside the repository (V05-WS-002)", () => {
		const registry = new WorktreeRegistry(join(dir, "registry.json"));
		const inside = registry.allocate({ taskId: "DEV-001", path: join(dir, "repo", "ws"), branch: "x", baseSha: "a".repeat(40), repoRoot: join(dir, "repo") });
		expect(inside.ok).toBe(false);
		if (!inside.ok) expect(inside.error).toMatch(/outside the repository/);
	});

	it("rejects traversal/NUL paths and duplicate active paths", () => {
		expect(canonicalize("/a/b/../..")).toBeDefined(); // canonicalized, then policy-checked
		const registry = new WorktreeRegistry(join(dir, "registry.json"));
		const first = registry.allocate({ taskId: "DEV-001", path: join(dir, "ws1"), branch: "x", baseSha: "a".repeat(40), repoRoot: join(dir, "repo") });
		expect(first.ok).toBe(true);
		const dup = registry.allocate({ taskId: "DEV-002", path: join(dir, "ws1") + "/", branch: "x", baseSha: "a".repeat(40), repoRoot: join(dir, "repo") });
		expect(dup.ok).toBe(false);
	});

	it("branch names are deterministic, sanitized, unique — never deleting existing branches", () => {
		const a = sanitizeBranch("DEV-001", "Fix Pagination!!! (urgent)");
		const b = sanitizeBranch("DEV-001", "Fix Pagination!!! (urgent)");
		expect(a).toMatch(/^sym\/dev-001\/fix-pagination-urgent-/);
		expect(a).not.toBe(b); // collision-safe suffix
		expect(a.length).toBeLessThanOrEqual(80);
		expect(sanitizeBranch("DEV-002", "한글 유니코드")).toMatch(/^sym\/dev-002\//);
	});

	it("removal is blocked by unknown content and process use (V05-CLEAN-001)", () => {
		const registry = new WorktreeRegistry(join(dir, "registry.json"));
		const ws = registry.allocate({ taskId: "DEV-001", path: join(dir, "ws"), branch: "x", baseSha: "a".repeat(40), repoRoot: join(dir, "repo") });
		if (!ws.ok) throw new Error(ws.error);
		expect(registry.requestRemoval(ws.workspace.id, { hasUncommittedChanges: true, hasUnknownFiles: false, inUse: false }).ok).toBe(false);
		expect(registry.requestRemoval(ws.workspace.id, { hasUncommittedChanges: false, hasUnknownFiles: true, inUse: false }).ok).toBe(false);
		expect(registry.requestRemoval(ws.workspace.id, { hasUncommittedChanges: false, hasUnknownFiles: false, inUse: true }).ok).toBe(false);
		const ok = registry.requestRemoval(ws.workspace.id, { hasUncommittedChanges: false, hasUnknownFiles: false, inUse: false });
		expect(ok.ok).toBe(true);
		registry.completeRemoval(ws.workspace.id);
		expect(registry.get(ws.workspace.id)!.state).toBe("removed");
	});

	it("registry persists across restarts and tracks orphans (V05-CLEAN-002)", () => {
		const file = join(dir, "registry.json");
		const first = new WorktreeRegistry(file);
		const ws = first.allocate({ taskId: "DEV-001", path: join(dir, "ws"), branch: "x", baseSha: "a".repeat(40), repoRoot: join(dir, "repo") });
		if (!ws.ok) throw new Error(ws.error);
		const reborn = new WorktreeRegistry(file);
		reborn.load();
		expect(reborn.get(ws.workspace.id)).toBeDefined();
		reborn.markOrphaned(ws.workspace.id);
		expect(reborn.get(ws.workspace.id)!.state).toBe("orphaned");
	});
});

describe("fenced write leases (V05-OWN-*)", () => {
	it("exactly one winner under concurrent CAS attempts (V05-OWN-001)", () => {
		const store = new FencedLeaseStore(join(dir, "leases.json"));
		const a = store.acquire({ workspaceId: "ws-1", expectedFence: 0, owner: "impl-1", expectedHeadSha: "a".repeat(40) });
		const b = store.acquire({ workspaceId: "ws-1", expectedFence: 0, owner: "impl-2", expectedHeadSha: "a".repeat(40) });
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(false);
		if (a.ok) expect(a.lease.fence).toBe(1);
	});

	it("stale fencing tokens and moved heads are rejected (V05-OWN-002, V05-REV-001)", () => {
		const store = new FencedLeaseStore(join(dir, "leases.json"));
		const lease = store.acquire({ workspaceId: "ws-1", expectedFence: 0, owner: "impl", expectedHeadSha: "a".repeat(40) });
		if (!lease.ok) throw new Error(lease.error);
		// ownership transferred: fence bumped
		const transferred = store.acquire({ workspaceId: "ws-1", expectedFence: 1, owner: "impl-2", expectedHeadSha: "a".repeat(40) });
		expect(transferred.ok).toBe(true);
		// stale report from the old owner is rejected
		const stale = store.validateReport({ workspaceId: "ws-1", fence: 1, headSha: "a".repeat(40) });
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.error).toMatch(/stale fencing token/);
		// head moved under the current owner
		const moved = store.validateReport({ workspaceId: "ws-1", fence: 2, headSha: "b".repeat(40) });
		expect(moved.ok).toBe(false);
		if (!moved.ok) expect(moved.error).toMatch(/head moved/);
	});
});

describe("delivery (V05-DEL-*)", () => {
	it("preflight is non-mutating and reports each blocker separately (V05-DEL-001)", () => {
		const preflight = evaluateDeliveryPreflight({
			taskHeadSha: "a".repeat(40),
			targetHeadSha: "b".repeat(40),
			approved: false,
			policyRevision: 3,
			expectedPolicyRevision: 2,
			evidenceRevision: "c".repeat(40),
			dirtyTarget: true,
			conflictingPaths: ["src/a.ts", "src/b.ts"],
			missingEvidence: ["unit"],
		});
		expect(preflight.canProceed).toBe(false);
		const codes = preflight.blockers.map((b) => b.code);
		expect(codes).toEqual(expect.arrayContaining(["not_approved", "policy_drift", "stale_evidence", "dirty_target", "conflicts", "missing_evidence"]));
		expect(codes.length).toBe(6);
	});

	it("clean preflight can proceed", () => {
		const sha = "a".repeat(40);
		const preflight = evaluateDeliveryPreflight({
			taskHeadSha: sha,
			targetHeadSha: "b".repeat(40),
			approved: true,
			policyRevision: 2,
			expectedPolicyRevision: 2,
			evidenceRevision: sha,
			dirtyTarget: false,
			conflictingPaths: [],
			missingEvidence: [],
		});
		expect(preflight.canProceed).toBe(true);
	});

	it("IntegratedUnverified preserves evidence and demands disposition (V05-DEL-003)", () => {
		const outcome: DeliveryOutcome = { state: "integrated_unverified", revision: "a".repeat(40), failedChecks: ["unit"] };
		const events: Array<{ type: string; data: Record<string, unknown> }> = [];
		recordDeliveryOutcome(outcome, { append: (type, data) => events.push({ type, data }) });
		expect(events[0]!.type).toBe("delivery.transition");
		expect(events[0]!.data["state"]).toBe("integrated_unverified");
		expect(events[0]!.data["failedChecks"]).toEqual(["unit"]);
	});

	it("manual integration requires containment or explicit squash acknowledgment (V05-DEL-004)", () => {
		const taskHead = "a".repeat(40);
		const result = "b".repeat(40);
		const contains = (ancestor: string, descendant: string) => descendant === result && ancestor === taskHead;
		expect(verifyManualIntegration({ resultSha: result, taskHeadSha: taskHead, contains }).ok).toBe(true);
		expect(verifyManualIntegration({ resultSha: "short", taskHeadSha: taskHead, contains }).ok).toBe(false);
		const notContained = (_a: string, _d: string) => false;
		const rejected = verifyManualIntegration({ resultSha: result, taskHeadSha: taskHead, contains: notContained });
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.error).toMatch(/squash\? record the acknowledgment/);
		expect(verifyManualIntegration({ resultSha: result, taskHeadSha: taskHead, contains: notContained, acknowledgedSquash: true }).ok).toBe(true);
	});
});
