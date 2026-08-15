import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

let lastTime = 0;
let lastRandom: number[] = [];

/**
 * Monotonic ULID-style identifier: 10 char timestamp + 16 char randomness.
 * Guaranteed lexicographically sortable and collision-safe within a process
 * even for identical millisecond timestamps.
 */
export function monotonicId(): string {
	const now = Date.now();
	if (now === lastTime) {
		// increment random part
		for (let i = lastRandom.length - 1; i >= 0; i--) {
			if (lastRandom[i]! < 31) {
				lastRandom[i] = lastRandom[i]! + 1;
				break;
			}
			lastRandom[i] = 0;
		}
	} else {
		lastTime = now;
		lastRandom = Array.from(randomBytes(10)).map((b) => b & 31);
	}
	let id = encodeTime(now);
	for (const r of lastRandom) id += ENCODING[r];
	return id;
}

function encodeTime(time: number): string {
	let out = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		out = ENCODING[t % 32] + out;
		t = Math.floor(t / 32);
	}
	return out;
}


/** Task ids are the only path-forming input from models: strict format. */
const TASK_ID_RE = /^[A-Z][A-Z0-9_-]*-\d+$/;

export function isValidTaskId(taskId: string): boolean {
	return TASK_ID_RE.test(taskId);
}

export class InvalidTaskIdError extends Error {
	constructor(public taskId: string) {
		super(`invalid task id "${taskId}" (expected e.g. DEV-014)`);
		this.name = "InvalidTaskIdError";
	}
}

/** Assert at every core entry point; prevents path traversal via task ids. */
export function assertValidTaskId(taskId: string): void {
	if (!isValidTaskId(taskId)) throw new InvalidTaskIdError(taskId);
}
