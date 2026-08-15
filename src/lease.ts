import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One execution lease per checkout. The lease records the owner pid and Pi
 * session id; stale leases are reclaimed only after ownership validation.
 */
export interface LeaseRecord {
	taskId: string;
	stage: string;
	pid: number;
	sessionId: string;
	acquiredAt: string;
	heartbeatAt: string;
}

export class LeaseManager {
	constructor(private leaseFile: string) {}

	read(): LeaseRecord | undefined {
		if (!existsSync(this.leaseFile)) return undefined;
		try {
			return JSON.parse(readFileSync(this.leaseFile, "utf8")) as LeaseRecord;
		} catch {
			return undefined; // torn write — treat as absent
		}
	}

	/**
	 * Mutual exclusion: refuses to overwrite a lease held by another live
	 * owner. Returns false when the checkout is already leased; the caller
	 * must release or reclaim first.
	 */
	acquire(record: LeaseRecord): boolean {
		const current = this.read();
		if (current) {
			const sameOwner = current.pid === record.pid && current.sessionId === record.sessionId;
			if (!sameOwner && isProcessAlive(current.pid)) return false;
		}
		mkdirSync(dirname(this.leaseFile), { recursive: true });
		const tmp = `${this.leaseFile}.tmp`;
		writeFileSync(tmp, JSON.stringify(record, null, "\t"), "utf8");
		renameSync(tmp, this.leaseFile);
		return true;
	}

	release(): boolean {
		if (!existsSync(this.leaseFile)) return false;
		try {
			const rec = this.read();
			if (rec && isProcessAlive(rec.pid)) return false; // live owner must release
		} catch {
			// fallthrough: stale/corrupt lease can be removed
		}
		rmSync(this.leaseFile, { force: true });
		return true;
	}

	/**
	 * Stale = file exists but the owner process is dead or the record is
	 * unreadable (torn write). An unreadable lease is always reclaimable.
	 */
	status(): { held: boolean; stale: boolean; record?: LeaseRecord } {
		const record = this.read();
		if (!record) {
			const exists = existsSync(this.leaseFile);
			return exists ? { held: false, stale: true } : { held: false, stale: false };
		}
		const alive = isProcessAlive(record.pid);
		return { held: alive, stale: !alive, record };
	}
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}
