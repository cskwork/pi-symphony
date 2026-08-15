import { describe, expect, it } from "vitest";
import {
	assertLoopbackHost,
	replayWindow,
	validateCommandEnvelope,
	validateMutatingRequest,
	MAX_COMMAND_BODY_BYTES,
} from "../src/web/protocol.ts";

describe("command envelope validation (V02-CMD-001)", () => {
	const valid = {
		commandId: "01J5AAAAAAAAAAAA",
		type: "task.pause",
		repositoryId: "repo-7f1c",
		aggregateId: "DEV-014",
		expectedRevision: 9,
		payload: { reason: "manual inspection" },
	};

	it("accepts a valid envelope", () => {
		const result = validateCommandEnvelope(valid);
		expect(result.ok).toBe(true);
	});

	it("rejects unknown command types", () => {
		const result = validateCommandEnvelope({ ...valid, type: "shell.exec" });
		expect(result.ok === false && result.rejection.code).toBe("unknown_command");
	});

	it("rejects shell/file/deploy-shaped types outright", () => {
		for (const type of ["shell.exec", "file.write", "git.push", "stage.force", "deploy.run"]) {
			const result = validateCommandEnvelope({ ...valid, type });
			expect(result.ok === false && result.rejection.code).toBe("unknown_command");
		}
	});

	it("requires commandId, repositoryId and object payload", () => {
		expect(validateCommandEnvelope({ ...valid, commandId: "x" }).ok).toBe(false);
		expect(validateCommandEnvelope({ ...valid, repositoryId: "" }).ok).toBe(false);
		expect(validateCommandEnvelope({ ...valid, payload: "rm -rf /" }).ok).toBe(false);
	});

	it("requires numeric expectedRevision", () => {
		const result = validateCommandEnvelope({ ...valid, expectedRevision: "9" });
		expect(result.ok === false && result.rejection.code).toBe("bad_request");
	});
});

describe("SSE replay rules (V02-SYNC-003)", () => {
	const events = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((sequence) => ({ sequence }));

	it("replays events after Last-Event-ID within the window", () => {
		const result = replayWindow(events, 8, 10);
		expect(result.kind).toBe("replay");
		if (result.kind === "replay") expect(result.events.map((e) => e.sequence)).toEqual([9, 10]);
	});

	it("replays everything when the client is exactly at the oldest boundary", () => {
		const result = replayWindow(events, 0, 10);
		expect(result.kind).toBe("replay");
	});

	it("demands a snapshot when the gap predates retention", () => {
		const result = replayWindow(events.slice(5), 2, 10);
		expect(result.kind).toBe("snapshot_required");
	});

	it("empty stream replays nothing", () => {
		expect(replayWindow([], 5, 10)).toEqual({ kind: "replay", events: [] });
	});
});

describe("loopback and mutating-request security (V02-WEB-001, V02-AUTH-001)", () => {
	it("accepts only loopback hosts", () => {
		for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
			expect(assertLoopbackHost(host).ok).toBe(true);
		}
		for (const host of ["0.0.0.0", "192.168.1.5", "example.com"]) {
			expect(assertLoopbackHost(host).ok).toBe(false);
		}
	});

	const good = {
		host: "127.0.0.1:43127",
		origin: "http://127.0.0.1:43127",
		authorization: "Bearer tok-1",
		contentType: "application/json",
	};

	it("accepts a well-formed mutating request", () => {
		expect(
			validateMutatingRequest(good, { expectedHost: "127.0.0.1:43127", expectedOrigin: "http://127.0.0.1:43127", token: "tok-1" }).ok,
		).toBe(true);
	});

	it("rejects host mismatch (DNS rebinding)", () => {
		const result = validateMutatingRequest({ ...good, host: "evil.example" }, { expectedHost: "127.0.0.1:43127", expectedOrigin: "http://127.0.0.1:43127", token: "tok-1" });
		expect(result.ok === false && result.status).toBe(403);
	});

	it("rejects cross-origin and null origins", () => {
		for (const origin of ["http://evil.example", "null", "https://127.0.0.1:43127"]) {
			const result = validateMutatingRequest({ ...good, origin }, { expectedHost: "127.0.0.1:43127", expectedOrigin: "http://127.0.0.1:43127", token: "tok-1" });
			expect(result.ok === false && result.status).toBe(403);
		}
	});

	it("rejects missing/incorrect credentials", () => {
		const result = validateMutatingRequest({ ...good, authorization: "Bearer wrong" }, { expectedHost: "127.0.0.1:43127", expectedOrigin: "http://127.0.0.1:43127", token: "tok-1" });
		expect(result.ok === false && result.status).toBe(401);
	});

	it("rejects non-JSON content types", () => {
		const result = validateMutatingRequest({ ...good, contentType: "text/plain" }, { expectedHost: "127.0.0.1:43127", expectedOrigin: "http://127.0.0.1:43127", token: "tok-1" });
		expect(result.ok === false && result.status).toBe(415);
	});

	it("command body cap is bounded", () => {
		expect(MAX_COMMAND_BODY_BYTES).toBeLessThanOrEqual(256 * 1024);
	});
});
