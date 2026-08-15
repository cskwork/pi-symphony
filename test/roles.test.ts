import { describe, expect, it } from "vitest";
import type { RoleKind } from "../src/roles.ts";
import {
	HandoffLedger,
	RoleSessionRegistry,
	TOPOLOGIES,
	assertReadOnlyManifest,
	artifactDigest,
	type RoleManifest,
} from "../src/roles.ts";

function manifest(overrides: Partial<RoleManifest> = {}): RoleManifest {
	return {
		role: "scout",
		taskId: "DEV-001",
		stage: "plan",
		attemptId: "plan-1",
		revision: "abc123",
		configHash: "0123456789abcdef",
		inputs: ["task_contract"],
		tools: ["read", "grep"],
		skills: [],
		limits: { maxTurns: 4, wallClockMs: 60_000 },
		omitted: ["implementer_transcript"],
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("role sessions (V04-ROLE-*)", () => {
	it("launches within configured and hard caps (V04-ROLE-003)", () => {
		const registry = new RoleSessionRegistry();
		const first = registry.launch(manifest(), { hardCap: 1, configCap: 2 });
		expect(first.ok).toBe(true);
		const second = registry.launch(manifest({ role: "reviewer" }), { hardCap: 1, configCap: 2 });
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error).toMatch(/concurrency cap/);
		// hard cap also binds when config allows more
		const permissive = new RoleSessionRegistry();
		expect(permissive.launch(manifest(), { hardCap: 2, configCap: 5 }).ok).toBe(true);
		expect(permissive.launch(manifest({ role: "reviewer" }), { hardCap: 2, configCap: 5 }).ok).toBe(true);
		expect(permissive.launch(manifest({ role: "architect" }), { hardCap: 2, configCap: 5 }).ok).toBe(false);
	});

	it("terminal lifecycle states never resurrect (V04-ROLE-004)", () => {
		const registry = new RoleSessionRegistry();
		const launched = registry.launch(manifest(), { hardCap: 4, configCap: 4 });
		if (!launched.ok) throw new Error(launched.error);
		const id = launched.session.id;
		expect(registry.setLifecycle(id, "failed", "model error")).toBe(true);
		expect(registry.setLifecycle(id, "running")).toBe(false);
		expect(registry.get(id)!.lifecycle).toBe("failed");
		expect(registry.setLifecycle(id, "cancelled")).toBe(false);
		// superseded is reachable from running
		const other = registry.launch(manifest({ role: "reviewer" }), { hardCap: 4, configCap: 4 });
		if (!other.ok) throw new Error(other.error);
		expect(registry.setLifecycle(other.session.id, "superseded")).toBe(true);
	});

	it("read-only guarantee: mutation tools are rejected in manifests (V04-ROLE-002)", () => {
		expect(() => assertReadOnlyManifest(manifest({ tools: ["read", "write"] }))).toThrow(/read-only/);
		expect(() => assertReadOnlyManifest(manifest({ tools: ["bash"] }))).toThrow(/read-only/);
		expect(() => assertReadOnlyManifest(manifest())).not.toThrow();
	});

	it("restart marks lost sessions interrupted without touching completed ones (V04-REC-001)", () => {
		const registry = new RoleSessionRegistry();
		const a = registry.launch(manifest(), { hardCap: 4, configCap: 4 });
		const b = registry.launch(manifest({ role: "reviewer" }), { hardCap: 4, configCap: 4 });
		if (!a.ok || !b.ok) throw new Error("launch failed");
		registry.setLifecycle(b.session.id, "completed");
		const interrupted = registry.recover((id) => id === "alive");
		expect(interrupted).toEqual([a.session.id]);
		expect(registry.get(a.session.id)!.lifecycle).toBe("interrupted");
		expect(registry.get(b.session.id)!.lifecycle).toBe("completed");
	});

	it("topology presets are bounded and role-complete", () => {
		expect(TOPOLOGIES.quick.roles).toHaveLength(1);
		expect(TOPOLOGIES.standard.maxConcurrent).toBe(2);
		expect(TOPOLOGIES.deep.roles.map((r) => r.role)).toContain("security_reviewer");
		for (const topo of Object.values(TOPOLOGIES)) {
			for (const role of topo.roles) {
				expect(role.limits.maxTurns).toBeGreaterThan(0);
				expect(role.limits.wallClockMs).toBeGreaterThan(0);
			}
		}
	});
});

describe("handoff ledger (V04-HOF-*)", () => {
	function submitInput(overrides: Partial<Parameters<HandoffLedger["submit"]>[0]> = {}) {
		return {
			idempotencyKey: "key-1",
			fromRole: "implementer" as RoleKind,
			toRole: "reviewer" as RoleKind,
			taskId: "DEV-001",
			stage: "review",
			attemptId: "review-1",
			revision: "abc123",
			configHash: "0123456789abcdef",
			manifestId: "role-abc",
			artifacts: [{ kind: "diff", ref: ".symphony/evidence/DEV-001/diff.txt", sha256: artifactDigest("diff") }],
			payloadSummary: "review requested",
			...overrides,
		};
	}

	it("validates every identity and integrity field (V04-HOF-002)", () => {
		const ledger = new HandoffLedger();
		expect(ledger.submit(submitInput({ fromRole: "reviewer" })).ok).toBe(false); // same role
		expect(ledger.submit(submitInput({ taskId: "" })).ok).toBe(false);
		expect(ledger.submit(submitInput({ configHash: "not-a-hash" })).ok).toBe(false);
		expect(ledger.submit(submitInput({ artifacts: [{ kind: "diff", ref: "", sha256: "zz" }] })).ok).toBe(false);
		expect(ledger.submit(submitInput({ payloadSummary: "x".repeat(3000) })).ok).toBe(false);
	});

	it("idempotent resubmission returns the same handoff (V04-HOF-004)", () => {
		const ledger = new HandoffLedger();
		const first = ledger.submit(submitInput());
		if (!first.ok) throw new Error(first.error);
		const retry = ledger.submit(submitInput());
		expect(retry.ok).toBe(true);
		if (retry.ok) {
			expect(retry.duplicate).toBe(true);
			expect(retry.handoff.id).toBe(first.handoff.id);
		}
		expect(ledger.all()).toHaveLength(1);
	});

	it("acceptance validates role, task, stage, attempt, and topology snapshot (V04-HOF-005)", () => {
		const ledger = new HandoffLedger();
		const submitted = ledger.submit(submitInput());
		if (!submitted.ok) throw new Error(submitted.error);
		const id = submitted.handoff.id;
		const recipient: Parameters<HandoffLedger["accept"]>[1] = { role: "reviewer", taskId: "DEV-001", stage: "review", attemptId: "review-1", manifestId: "role-abc" };

		expect(ledger.accept(id, { ...recipient, role: "scout" }, "u").ok).toBe(false);
		expect(ledger.accept(id, { ...recipient, stage: "verify" }, "u").ok).toBe(false);
		expect(ledger.accept(id, { ...recipient, attemptId: "review-2" }, "u").ok).toBe(false);
		expect(ledger.accept(id, { ...recipient, manifestId: "role-REPLACED" }, "u").ok).toBe(false);
		expect(ledger.accept(id, recipient, "user").ok).toBe(true);
		expect(ledger.complete(id, "reviewer")).toBe(true);
		expect(ledger.complete(id, "reviewer")).toBe(false); // already completed
		// completed handoffs cannot be accepted again
		expect(ledger.accept(id, recipient, "u").ok).toBe(false);
	});

	it("lifecycle is append-only audited and replayable (V04-HOF-003)", () => {
		const ledger = new HandoffLedger();
		const submitted = ledger.submit(submitInput());
		if (!submitted.ok) throw new Error(submitted.error);
		const id = submitted.handoff.id;
		ledger.accept(id, { role: "reviewer", taskId: "DEV-001", stage: "review", attemptId: "review-1", manifestId: "role-abc" }, "user");
		ledger.complete(id, "reviewer");
		const events = ledger.eventLog().filter((e) => e.handoffId === id);
		expect(events.map((e) => e.type)).toEqual(["queued", "accepted", "completed"]);
		const replayed = HandoffLedger.replay(events);
		expect(replayed.get(id)!.state).toBe("completed");
	});

	it("supersession and failure are auditable (V04-ROLE-004 / V04-HOF-003)", () => {
		const ledger = new HandoffLedger();
		const a = ledger.submit(submitInput());
		if (!a.ok) throw new Error(a.error);
		expect(ledger.supersede(a.handoff.id, "operator")).toBe(true);
		expect(ledger.fail(a.handoff.id, "late", "x")).toBe(false); // already superseded
		const b = ledger.submit(submitInput({ idempotencyKey: "key-2" }));
		if (!b.ok) throw new Error(b.error);
		expect(ledger.fail(b.handoff.id, "model error", "system")).toBe(true);
	});
});
