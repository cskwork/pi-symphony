import { describe, expect, it } from "vitest";
import { parseReviewOutput, reviewPromptFor } from "../src/reviewer.ts";

describe("review report parsing", () => {
	it("parses a valid structured review", () => {
		const output = `Some narrative text.\n\`\`\`review\n{"verdict":"changes_requested","findings":[{"severity":"major","file":"src/a.ts","summary":"race condition"}],"summary":"needs work"}\n\`\`\`\n`;
		const report = parseReviewOutput(output, "sess-1");
		expect(report.verdict).toBe("changes_requested");
		expect(report.findings[0]!.severity).toBe("major");
		expect(report.sessionId).toBe("sess-1");
	});

	it("missing structured block is treated as changes_requested with a note", () => {
		const report = parseReviewOutput("I looked at it and it seemed fine", "s");
		expect(report.verdict).toBe("changes_requested");
		expect(report.findings[0]!.summary).toMatch(/did not emit a structured report/);
	});

	it("malformed JSON is treated as changes_requested", () => {
		const report = parseReviewOutput("```review\n{nope\n```", "s");
		expect(report.verdict).toBe("changes_requested");
	});

	it("prompt states the output contract and forbids write tools", () => {
		const prompt = reviewPromptFor("MANIFEST");
		expect(prompt).toContain("MANIFEST");
		expect(prompt).toMatch(/fenced block tagged `review`/);
		expect(prompt).toContain('"verdict"');
		expect(prompt).toContain("no write tools");
	});
});
