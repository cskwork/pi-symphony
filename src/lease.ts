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

	acquire(record: LeaseRecord): void {
		mkdirSync(dirname(this.leaseFile), { recursive: true });
		const tmp = `${this.leaseFile}.tmp`;
		writeFileSync(tmp, JSON.stringify(record, null, "\t"), "utf8");
		renameSync(tmp, this.leaseFile);
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

	/** Stale = file exists but owner process is dead (or record unreadable). */
	status(): { held: boolean; stale: boolean; record?: LeaseRecord } {
		const record = this.read();
		if (!record) return { held: false, stale: false };
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
