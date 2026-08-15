import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "../src/events.ts";
import { EventBridge } from "../src/web/store.ts";

/**
 * Regression tests for the v1.0 self-review findings in the event bridge:
 *  1. torn-tail truncation silently lost the first post-truncation event
 *  2. per-aggregate sequences collided across tasks in Last-Event-ID replay
 */

let dir: string;
let eventsDir: string;
let ledger: EventLedger;

beforeEach(() => {
	dir = join(tmpdir(), `sym-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	eventsDir = join(dir, ".symphony", "runtime", "events");
	mkdirSync(eventsDir, { recursive: true });
	ledger = new EventLedger((id) => join(eventsDir, `${id}.jsonl`));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("bridge torn-tail tolerance", () => {
	it("emits every post-truncation event exactly once (no silent gap)", async () => {
		// crash-torn tail: one valid line + one torn line
		writeFileSync(
			join(eventsDir, "DEV-001.jsonl"),
			'{"eventId":"a1","sequence":1,"type":"task.created","aggregateId":"DEV-001","aggregateRevision":1,"emittedAt":"t","data":{}}\n{"eventId":"a2","sequ',
			"utf8",
		);
		const bridge = new EventBridge(() => ({}) as never, eventsDir);
		const seen: string[] = [];
		bridge.subscribe((entry) => seen.push(`${entry.event.aggregateId}#${entry.event.sequence}`));
		bridge.start(25);
		await new Promise((r) => setTimeout(r, 100));

		// ledger append truncates the torn tail and writes two new events
		ledger.append("DEV-001", "task.updated", { n: 1 }, { aggregateRevision: 2 });
		ledger.append("DEV-001", "task.updated", { n: 2 }, { aggregateRevision: 3 });
		await new Promise((r) => setTimeout(r, 200));
		bridge.stop();

		// history + both new events, none lost, none duplicated
		expect(seen.filter((s) => s === "DEV-001#2")).toHaveLength(1);
		expect(seen.filter((s) => s === "DEV-001#3")).toHaveLength(1);
		expect(seen[0]).toBe("DEV-001#1");
	});

	it("is idempotent by eventId across re-polls", async () => {
		ledger.append("DEV-001", "task.created", {}, { aggregateRevision: 1 });
		const bridge = new EventBridge(() => ({}) as never, eventsDir);
		const seen: string[] = [];
		bridge.subscribe((entry) => seen.push(entry.event.eventId));
		bridge.start(25);
		await new Promise((r) => setTimeout(r, 150));
		bridge.stop();
		const unique = new Set(seen);
		expect(unique.size).toBe(seen.length); // never re-emitted
	});
});

describe("bridge global ordering", () => {
	it("bridge sequences are globally monotonic across aggregates", async () => {
		const bridge = new EventBridge(() => ({}) as never, eventsDir);
		bridge.start(25);
		await new Promise((r) => setTimeout(r, 80));
		ledger.append("DEV-001", "task.created", {}, { aggregateRevision: 1 }); // agg seq 1
		ledger.append("DEV-002", "task.created", {}, { aggregateRevision: 1 }); // agg seq 1 (collision)
		await new Promise((r) => setTimeout(r, 200));
		bridge.stop();
		const retained = bridge.retained();
		expect(retained.map((e) => e.bridgeSequence)).toEqual(
			[...retained.map((e) => e.bridgeSequence)].sort((a, b) => a - b),
		);
		// replay from the first bridge sequence yields exactly the rest —
		// regardless of which aggregate each event came from
		const afterFirst = retained.filter((e) => e.bridgeSequence > retained[0]!.bridgeSequence);
		expect(afterFirst.length).toBe(retained.length - 1);
		// per-aggregate sequences may collide but bridge sequences never do
		const aggSeqs = retained.map((e) => e.event.sequence);
		const bridgeSeqs = retained.map((e) => e.bridgeSequence);
		expect(new Set(bridgeSeqs).size).toBe(bridgeSeqs.length);
		expect(new Set(aggSeqs).size).toBeLessThan(aggSeqs.length); // the collision existed
	});
});
