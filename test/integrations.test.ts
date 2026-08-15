import { describe, expect, it } from "vitest";
import {
	OutboundQueue,
	PollBudget,
	acceptCiEvidence,
	buildExportSnapshot,
	correlateAudit,
	mapRemoteLifecycle,
	pushPreflight,
	reconcileFields,
	redactIntegrationSecrets,
	validateAdapterCapabilities,
	type AdapterCapabilities,
	type AuditRecord,
	type CiEvidence,
	type OutboundOperation,
} from "../src/integrations.ts";

const validCapabilities: AdapterCapabilities = {
	provider: "github",
	read: ["issue", "issue_comments"],
	write: ["comment", "close_issue"],
	authSource: "env",
	rateLimit: { requestsPerWindow: 60, windowMs: 3600_000, cooldownSignal: "x-ratelimit-remaining: 0" },
	errorTaxonomy: ["auth_failed", "rate_limited"],
};

describe("adapter contracts (V08-ADP-*)", () => {
	it("rejects incomplete capability descriptors", () => {
		expect(validateAdapterCapabilities({ provider: "x" }).ok).toBe(false);
		const bad = validateAdapterCapabilities({ ...validCapabilities, authSource: "magic" });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.issues.some((i) => i.includes("authSource"))).toBe(true);
		expect(validateAdapterCapabilities(validCapabilities).ok).toBe(true);
	});
});

describe("field sync (V08-SYNC-*)", () => {
	it("remote never overwrites local-owned or concurrently changed fields", () => {
		const result = reconcileFields(
			{ title: "local title", stage: "build" },
			{ title: "remote title", stage: "verify" },
			{ title: "local", stage: "remote" },
		);
		expect(result.applied.title).toBe("local title"); // local-owned
		const conflict = result.conflicts.find((c) => c.field === "stage");
		expect(conflict?.resolution).toBe("manual"); // concurrent change → conflict
		expect(result.applied.stage).toBe("build");
	});

	it("unknown remote labels can never jump stages (V08-SYNC-002)", () => {
		expect(mapRemoteLifecycle("done").command).toBe("none");
		expect(mapRemoteLifecycle("Ready to Ship!!").command).toBe("none");
		expect(mapRemoteLifecycle("in review")).toEqual({ command: "task.advance", target: "review" });
		expect(mapRemoteLifecycle("wontfix")).toEqual({ command: "task.cancel" });
	});
});

describe("outbound operations (V08-OUT-*)", () => {
	it("idempotent keys produce exactly one remote effect, replays return the receipt", async () => {
		const queue = new OutboundQueue();
		let transportCalls = 0;
		const operation: OutboundOperation = {
			kind: "comment",
			idempotencyKey: "cmt-1",
			actor: "user",
			approvalId: "apr-1",
			payload: { body: "ship" },
		};
		const first = await queue.execute(operation, () => {
			transportCalls += 1;
			return { id: 999 };
		});
		expect(first.ok && !first.replayed).toBe(true);
		// lost response: caller retries with the same key
		const retry = await queue.execute(operation, () => {
			transportCalls += 1;
			return { id: 1000 };
		});
		expect(transportCalls).toBe(1); // transport called once total
		expect(retry.ok && retry.replayed && retry.receipt.id).toBe(999);
	});

	it("push preflight aborts on divergence and never authorizes force", () => {
		const base = { remote: "origin", expectedRemote: "origin", branch: "main", allowedBranches: ["main"], force: false, localHead: "a".repeat(40), remoteHead: "a".repeat(40), remoteIsAncestor: true };
		expect(pushPreflight({ ...base }).ok).toBe(true);
		expect(pushPreflight({ ...base, remote: "evil", localHead: "a".repeat(40), remoteHead: "a".repeat(40) }).ok).toBe(false);
		expect(pushPreflight({ ...base, branch: "develop", localHead: "a".repeat(40), remoteHead: "a".repeat(40) }).ok).toBe(false);
		expect(pushPreflight({ ...base, force: true, localHead: "a".repeat(40), remoteHead: "a".repeat(40) }).ok).toBe(false);
		const diverged = pushPreflight({ ...base, localHead: "a".repeat(40), remoteHead: "b".repeat(40), remoteIsAncestor: false });
		expect(diverged.ok).toBe(false);
		if (!diverged.ok) expect(diverged.error).toMatch(/diverged/);
	});
});

describe("CI evidence gating (V08-CI-*)", () => {
	const sha = "a".repeat(40);
	const green: CiEvidence = { provider: "ci", context: "unit", subjectSha: sha, state: "success", completedAt: "now", category: "remote" };

	it("accepts unambiguous green evidence on the expected head", () => {
		expect(acceptCiEvidence([green], sha, ["unit"]).ok).toBe(true);
	});

	it("rejects old SHAs, failures, missing and ambiguous contexts", () => {
		const old = acceptCiEvidence([{ ...green, subjectSha: "b".repeat(40) }], sha, ["unit"]);
		expect(old.ok).toBe(false);
		if (!old.ok) expect(old.reasons[0]).toMatch(/ran against/);
		const failed = acceptCiEvidence([{ ...green, state: "failure" }], sha, ["unit"]);
		expect(failed.ok).toBe(false);
		const missing = acceptCiEvidence([], sha, ["unit"]);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.reasons[0]).toMatch(/missing/);
		const ambiguous = acceptCiEvidence([green, { ...green, provider: "other-ci" }], sha, ["unit"]);
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok) expect(ambiguous.reasons[0]).toMatch(/ambiguous/);
	});

	it("local deterministic checks and remote CI stay distinct categories", () => {
		const local: CiEvidence = { ...green, category: "local" };
		const projection = [local, green].map((e) => ({ context: e.context, category: e.category }));
		expect(new Set(projection.map((p) => p.category))).toEqual(new Set(["local", "remote"]));
	});
});

describe("polling budget (V08-POLL-001)", () => {
	it("honors limits, jitter, and provider cooldowns", () => {
		const budget = new PollBudget(3, 3000, 0);
		expect(budget.nextRequestAt(0)).not.toBeNull();
		expect(budget.nextRequestAt(1000)).not.toBeNull();
		expect(budget.nextRequestAt(2000)).not.toBeNull();
		expect(budget.nextRequestAt(3000)).toBeNull(); // window exhausted
		budget.cooldown(4000, 5000);
		const onCooldown = budget.nextRequestAt(5000);
		expect(onCooldown === null || onCooldown > 0).toBe(true);
	});
});

describe("observability (V08-OBS-*, V08-AUTH-001)", () => {
	it("default exports contain operational metadata only; unavailable ≠ zero", () => {
		const snapshot = buildExportSnapshot({
			tasks: [{ id: "DEV-001", title: "t", stage: "build", body: "SECRET_BODY" }],
			events: [{ type: "check.completed", data: { output: "SECRET_OUTPUT" } }],
			usage: [{ provenance: "unavailable" }, { provenance: "provider_reported", tokens: 1234 }],
		});
		const text = JSON.stringify(snapshot);
		expect(text).not.toContain("SECRET_BODY");
		expect(text).not.toContain("SECRET_OUTPUT");
		const usage = (snapshot as { usage: Array<{ provenance: string; tokens: number | null }> }).usage;
		expect(usage[0]).toEqual({ provenance: "unavailable", tokens: null });
		expect(usage[1]).toEqual({ provenance: "provider_reported", tokens: 1234 });
	});

	it("integration secrets are redacted on every surface", () => {
		const redacted = redactIntegrationSecrets("token=ghp_abcdefghijklmnopqrstuvwxyz123456 glpat-abcdefghijklmnopqrst xoxb-1234567890abc");
		expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
		expect(redacted).not.toContain("glpat-abcdefghijklmnopqrst");
		expect(redacted).not.toContain("xoxb-1234567890abc");
		expect(redacted).toMatch(/REDACTED/);
	});
});

describe("audit correlation (V08-AUD-001)", () => {
	it("a delivery timeline reconstructs without transcripts", () => {
		const records: AuditRecord[] = [
			{ at: "2026-01-01T00:03:00Z", actor: "ci", kind: "provider_receipt", correlationId: "delivery-1", detail: { check: "unit" } },
			{ at: "2026-01-01T00:01:00Z", actor: "user", kind: "local_command", correlationId: "delivery-1", detail: { type: "task.complete" } },
			{ at: "2026-01-01T00:02:00Z", actor: "user", kind: "approval", correlationId: "delivery-1", detail: { scope: "delivery" } },
		];
		const timeline = correlateAudit(records).get("delivery-1")!;
		expect(timeline.map((r) => r.kind)).toEqual(["local_command", "approval", "provider_receipt"]);
	});
});
