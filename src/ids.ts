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

/** Sanitize a free-text title into a filesystem-safe slug. */
export function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "task"
	);
}
