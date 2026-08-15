import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SymphonyCore } from "../core.ts";
import type { SymphonyEvent, TaskStage } from "../types.ts";
import {
	MAX_SSE_RETAINED_EVENTS,
	type SnapshotViewModel,
	type TaskViewModel,
} from "./protocol.ts";

/** Ring entry: the bridge's own global sequence + the domain event. */
export interface BridgeEvent {
	/** Global, monotonic, strictly ordered across ALL aggregates. */
	bridgeSequence: number;
	event: SymphonyEvent;
}

/**
 * Event store + projection bridge between SymphonyCore and the web client.
 *
 * Tails the per-task JSONL ledgers into an ordered ring with its OWN global
 * sequence (per-aggregate ledger sequences are not comparable across tasks —
 * using them for Last-Event-ID replay drops or duplicates events). Emission
 * is idempotent by eventId, so ledger torn-tail truncation and re-append
 * never produces silent gaps or duplicates.
 */
export class EventBridge {
	private ring: BridgeEvent[] = [];
	private emittedIds = new Set<string>();
	private subscribers = new Set<(entry: BridgeEvent) => void>();
	private timer?: NodeJS.Timeout;
	private nextBridgeSequence = 1;
	private projectionVersion = 1;

	constructor(
		private core: () => SymphonyCore,
		private eventsDir: string,
	) {}

	start(pollMs = 200): void {
		if (this.timer) return;
		this.poll(); // ingest existing history immediately (bounded by retention)
		this.timer = setInterval(() => this.poll(), pollMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	retained(): BridgeEvent[] {
		return this.ring;
	}

	subscribe(listener: (entry: BridgeEvent) => void): () => void {
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}

	/** Push a synthetic event (e.g. config.applied) through the same stream. */
	publish(event: SymphonyEvent): void {
		this.append(event);
	}

	getProjectionVersion(): number {
		return this.projectionVersion;
	}

	/** Global (bridge) sequence of the most recent retained entry. */
	lastBridgeSequence(): number {
		return this.ring.length > 0 ? this.ring[this.ring.length - 1]!.bridgeSequence : 0;
	}

	/** Bridge sequence for a given SSE id ("<bridgeSeq>-<eventId>"). */
	bridgeSequenceOf(eventId: string): number | undefined {
		return this.ring.find((entry) => entry.event.eventId === eventId)?.bridgeSequence;
	}

	private poll(): void {
		if (!existsSync(this.eventsDir)) return;
		for (const file of readdirSync(this.eventsDir)) {
			if (!file.endsWith(".jsonl") || file.startsWith("_")) continue;
			this.pollFile(join(this.eventsDir, file));
		}
	}

	/**
	 * Idempotent file tailing: parse every VALID event in the file and emit
	 * exactly the ones we have not emitted yet (by eventId). This is robust
	 * to torn-tail truncation (earlier valid ids are unchanged, the torn
	 * line is skipped until completed) and to file rewrites that preserve
	 * valid prefixes.
	 */
	private pollFile(path: string): void {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			return;
		}
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let event: SymphonyEvent;
			try {
				event = JSON.parse(trimmed) as SymphonyEvent;
			} catch {
				continue; // torn tail: skip until the write completes
			}
			if (!event.eventId || !event.type) continue;
			if (!this.emittedIds.has(event.eventId)) this.append(event);
		}
	}

	private append(event: SymphonyEvent): void {
		this.emittedIds.add(event.eventId);
		if (this.emittedIds.size > MAX_SSE_RETAINED_EVENTS * 2) {
			// bounded bookkeeping: drop the oldest ids no longer in the ring
			const keep = new Set(this.ring.slice(-MAX_SSE_RETAINED_EVENTS).map((e) => e.event.eventId));
			keep.add(event.eventId);
			this.emittedIds = keep;
		}
		const entry: BridgeEvent = { bridgeSequence: this.nextBridgeSequence++, event };
		this.ring.push(entry);
		if (this.ring.length > MAX_SSE_RETAINED_EVENTS) {
			this.ring.splice(0, this.ring.length - MAX_SSE_RETAINED_EVENTS);
		}
		this.projectionVersion += 1;
		for (const subscriber of this.subscribers) subscriber(entry);
	}
}

/** Build the immutable snapshot view model from the core's own projections. */
export function buildSnapshot(core: SymphonyCore, bridge: EventBridge, repositoryId: string): SnapshotViewModel {
	const tasks: TaskViewModel[] = core.listTasks().map((fm) => {
		const checks = [...core.checkRunsFor(fm.id).values()].map((run) => ({ name: run.check, status: run.status }));
		return {
			id: fm.id,
			title: fm.title,
			kind: fm.kind,
			stage: fm.stage as TaskStage,
			runState: fm.runState,
			revision: fm.revision,
			updatedAt: fm.updatedAt,
			acceptanceTotal: fm.acceptance.length,
			checks,
			hasReports: {
				plan: core.hasReport(fm.id, "plan"),
				implementation: core.hasReport(fm.id, "implementation"),
				review: core.hasReport(fm.id, "review"),
			},
			integration: fm.integration
				? { revision: fm.integration.revision, targetBranch: fm.integration.targetBranch, integratedAt: fm.integration.integratedAt }
				: undefined,
		};
	});
	return {
		projectionVersion: bridge.getProjectionVersion(),
		repositoryId,
		repositoryPath: core.deps.repoRoot,
		configHash: "", // filled by server via configHash(core.config)
		configValid: core.configIssues.length === 0,
		tasks,
		lastEventSequence: bridge.lastBridgeSequence(),
		serverStartedAt: new Date().toISOString(),
	};
}
