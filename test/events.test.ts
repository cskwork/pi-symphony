import { describe, expect, it } from "vitest";
import { EventLedger } from "../src/events.ts";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("event ledger", () => {
	it("appends monotonically sequenced events and replays them", () => {
		const dir = mkdtempSync(join(tmpdir(), "sym-events-"));
		try {
			const file = (id: string) => join(dir, `${id}.jsonl`);
			const ledger = new EventLedger(file);
			ledger.append("DEV-001", "task.created", { title: "x" }, { aggregateRevision: 1 });
			ledger.append("DEV-001", "task.stage_changed", { from: "backlog", to: "plan" }, { aggregateRevision: 2 });
			const events = ledger.read("DEV-001");
			expect(events.map((e) => e.sequence)).toEqual([1, 2]);
			expect(events[1]!.eventId > events[0]!.eventId).toBe(true);
			// projection rebuild is owned by SymphonyCore; ledger shape is the contract
			expect(events[1]!.type).toBe("task.stage_changed");
			expect(events[1]!.data).toEqual({ from: "backlog", to: "plan" });

			// a new ledger instance continues the sequence (crash simulation)
			const reborn = new EventLedger(file);
			reborn.append("DEV-001", "task.updated", { title: "y" }, { aggregateRevision: 3 });
			expect(reborn.read("DEV-001")[2]!.sequence).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tolerates a torn tail write from a crash", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sym-events-"));
		try {
			const file = join(dir, "DEV-001.jsonl");
			const { writeFileSync, mkdirSync } = await import("node:fs");
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, `{"eventId":"a","sequence":1,"type":"task.created","aggregateId":"DEV-001","aggregateRevision":1,"emittedAt":"now","data":{}}\n{"eventId":"b","sequ`, "utf8");
			const ledger = new EventLedger(() => file);
			const events = ledger.read("DEV-001");
			expect(events).toHaveLength(1);
			ledger.append("DEV-001", "task.updated", {}, { aggregateRevision: 2 });
			expect(ledger.read("DEV-001")[1]!.sequence).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
