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
		taskId: string,
		type: string,
		data: Record<string, unknown>,
		options: { aggregateRevision: number; attemptId?: string; now?: Date },
	): SymphonyEvent {
		const file = this.eventsFile(taskId);
		mkdirSync(dirname(file), { recursive: true });
		this.truncateTornTail(file);
		const sequence = (this.sequences.get(taskId) ?? this.readLastSequence(taskId)) + 1;
		const event: SymphonyEvent = {
			eventId: monotonicId(),
			sequence,
			type,
			aggregateId: taskId,
			aggregateRevision: options.aggregateRevision,
			attemptId: options.attemptId,
			emittedAt: (options.now ?? new Date()).toISOString(),
			data,
		};
		appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
		this.sequences.set(taskId, sequence);
		return event;
	}

	read(taskId: string): SymphonyEvent[] {
		const file = this.eventsFile(taskId);
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
		this.sequences.set(taskId, events.length > 0 ? (events[events.length - 1]!.sequence) : 0);
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

	private readLastSequence(taskId: string): number {
		const events = this.read(taskId);
		return events.length > 0 ? events[events.length - 1]!.sequence : 0;
	}
}

/** Rebuild the current projection of an aggregate from its event stream. */
export function replayEvents(events: SymphonyEvent[]): Record<string, unknown> {
	const state: Record<string, unknown> = {};
	for (const event of events) {
		applyEvent(state, event);
	}
	return state;
}

function applyEvent(state: Record<string, unknown>, event: SymphonyEvent): void {
	switch (event.type) {
		case "task.created":
			state["id"] = event.aggregateId;
			state["title"] = event.data["title"];
			state["stage"] = event.data["stage"];
			state["revision"] = event.aggregateRevision;
			break;
		case "task.stage_changed":
			state["stage"] = event.data["to"];
			state["revision"] = event.aggregateRevision;
			break;
		case "task.run_state_changed":
			state["runState"] = event.data["to"];
			state["revision"] = event.aggregateRevision;
			break;
		case "task.updated":
			state["revision"] = event.aggregateRevision;
			for (const [k, v] of Object.entries(event.data)) state[k] = v;
			break;
		case "attempt.started":
			state["attempt"] = { id: event.attemptId, status: "running", stage: event.data["stage"] };
			break;
		case "attempt.completed":
		case "attempt.interrupted":
			if (state["attempt"]) (state["attempt"] as Record<string, unknown>)["status"] = event.data["status"];
			break;
		default:
			break;
	}
	state[`lastEvent:${event.type}`] = event.eventId;
}
