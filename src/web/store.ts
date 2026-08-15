import { existsSync, readdirSync, readFileSync, watchFile } from "node:fs";
import { join } from "node:path";
import type { SymphonyCore } from "../core.ts";
import type { SymphonyEvent, TaskStage } from "../types.ts";
import {
	MAX_SSE_RETAINED_EVENTS,
	type SnapshotViewModel,
	type TaskViewModel,
} from "./protocol.ts";

/**
 * Event store + projection bridge between SymphonyCore and the web client.
 *
 * Tails the per-task JSONL ledgers (append-only, multi-process safe) into an
 * ordered ring buffer, and rebuilds immutable snapshot view models from the
 * same projections the TUI uses (V02-SYNC-001).
 */
export class EventBridge {
	private ring: SymphonyEvent[] = [];
	private subscribers = new Set<(event: SymphonyEvent) => void>();
	private lastLineCounts = new Map<string, number>();
	private timer?: NodeJS.Timeout;
	private projectionVersion = 1;

	constructor(
		private core: () => SymphonyCore,
		private eventsDir: string,
	) {}

	start(pollMs = 200): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.poll(), pollMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** All retained events (bounded). */
	retained(): SymphonyEvent[] {
		return this.ring;
	}

	subscribe(listener: (event: SymphonyEvent) => void): () => void {
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

	private poll(): void {
		if (!existsSync(this.eventsDir)) return;
		for (const file of readdirSync(this.eventsDir)) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(this.eventsDir, file);
			let lines: string[];
			try {
				lines = readFileSync(path, "utf8").split("\n");
			} catch {
				continue;
			}
			const seen = this.lastLineCounts.get(path) ?? 0;
			const complete = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
			if (complete <= seen) continue;
			// On first sight of a file, only stream new appends after startup;
			// history is covered by the snapshot.
			const start = seen === 0 ? Math.max(0, complete - 1) : seen;
			for (let i = start; i < complete; i++) {
				const line = lines[i]!;
				try {
					const event = JSON.parse(line) as SymphonyEvent;
					if (event.eventId && event.type) this.append(event);
				} catch {
					// torn tail: skip until the write completes
				}
			}
			this.lastLineCounts.set(path, complete);
		}
	}

	private append(event: SymphonyEvent): void {
		if (this.ring.length > 0) {
			const last = this.ring[this.ring.length - 1]!;
			if (last.eventId === event.eventId) return; // dedup across poll double-reads
		}
		this.ring.push(event);
		if (this.ring.length > MAX_SSE_RETAINED_EVENTS) {
			this.ring.splice(0, this.ring.length - MAX_SSE_RETAINED_EVENTS);
		}
		this.projectionVersion += 1;
		for (const subscriber of this.subscribers) subscriber(event);
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
	const retained = bridge.retained();
	return {
		projectionVersion: bridge.getProjectionVersion(),
		repositoryId,
		repositoryPath: core.deps.repoRoot,
		configHash: "", // filled by server via configHash(core.config)
		configValid: core.configIssues.length === 0,
		tasks,
		lastEventSequence: retained.length > 0 ? retained[retained.length - 1]!.sequence : 0,
		serverStartedAt: new Date().toISOString(),
	};
}
