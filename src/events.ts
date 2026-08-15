import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { monotonicId } from "./ids.ts";
import type { SymphonyEvent } from "./types.ts";

/**
 * Append-only event ledger, one JSONL stream per task aggregate.
 * Sequence numbers are local to the aggregate stream. Corrections append a
 * new event; history is never rewritten.
 */
export class EventLedger {
	private sequences = new Map<string, number>();

	constructor(private eventsFile: (taskId: string) => string) {}

	append(
		aggregate: string,
		type: string,
		data: Record<string, unknown>,
		options: { aggregateRevision: number; attemptId?: string; now?: Date },
	): SymphonyEvent {
		const file = this.aggregateFile(aggregate);
		mkdirSync(dirname(file), { recursive: true });
		this.truncateTornTail(file);
		const sequence = (this.sequences.get(aggregate) ?? this.readLastSequence(aggregate)) + 1;
		const event: SymphonyEvent = {
			eventId: monotonicId(),
			sequence,
			type,
			aggregateId: aggregate,
			aggregateRevision: options.aggregateRevision,
			attemptId: options.attemptId,
			emittedAt: (options.now ?? new Date()).toISOString(),
			data,
		};
		appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
		this.sequences.set(aggregate, sequence);
		return event;
	}

	read(aggregate: string): SymphonyEvent[] {
		const file = this.aggregateFile(aggregate);
		if (!existsSync(file)) return [];
		const lines = readFileSync(file, "utf8").split("\n");
		const events: SymphonyEvent[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as SymphonyEvent;
				if (!parsed.eventId || !parsed.type) continue; // tolerate torn tail writes
				events.push(parsed);
			} catch {
				// torn write from a crash: stop replay at the corrupt tail
				break;
			}
		}
		this.sequences.set(aggregate, events.length > 0 ? (events[events.length - 1]!.sequence) : 0);
		return events;
	}

	/**
	 * Crash tolerance: if the stream ends with a torn (unparseable) line,
	 * rewrite the file with only the valid prefix before appending. Without
	 * this, a new event appended after a torn tail is unreachable.
	 */
	private truncateTornTail(file: string): void {
		if (!existsSync(file)) return;
		const raw = readFileSync(file, "utf8");
		const lines = raw.split("\n");
		const valid: string[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as SymphonyEvent;
				if (parsed.eventId && parsed.type) valid.push(line);
				else break;
			} catch {
				break;
			}
		}
		if (valid.length !== lines.filter((l) => l.trim()).length) {
			writeFileSync(file, valid.length > 0 ? valid.join("\n") + "\n" : "", "utf8");
		}
	}

	/** Task aggregates must be valid ids; system aggregates use a fixed file. */
	private aggregateFile(aggregate: string): string {
		if (aggregate === "runtime" || aggregate === "config") return this.systemFile;
		return this.eventsFile(aggregate);
	}

	private get systemFile(): string {
		// Derive the events directory without validating a fake task id.
		const probe = this.eventsFile("DEV-000");
		return probe.replace("DEV-000.jsonl", "_system.jsonl");
	}

	private readLastSequence(aggregate: string): number {
		const events = this.read(aggregate);
		return events.length > 0 ? events[events.length - 1]!.sequence : 0;
	}
}

/** Projection rebuild lives in SymphonyCore.replay (single owner). */
