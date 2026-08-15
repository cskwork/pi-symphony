import { describe, expect, it } from "vitest";
import { SymphonyOverlay, type OverlayModel } from "../src/extension/overlay.ts";

/**
 * Golden snapshot tests at the PRD's supported dimensions: 80×24, 110×30,
 * 160×45. The overlay must fit both bounds without horizontal scrolling.
 */

function richModel(taskCount: number): OverlayModel {
	const tasks = Array.from({ length: taskCount }, (_, i) => ({
		id: `DEV-${String(i + 1).padStart(3, "0")}`,
		title: `Task number ${i + 1} with a title long enough to exercise truncation paths`,
		stage: (["backlog", "plan", "build", "review", "verify", "ready", "postverify", "done"] as const)[i % 8]!,
		runState: (["idle", "running", "waiting", "interrupted"] as const)[i % 4]!,
		updatedAt: new Date().toISOString(),
		acceptanceTotal: 3,
		checksSummary: i % 2 ? "checks green" : "checks not run",
	}));
	return {
		tasks,
		detail: {
			overview: Array.from({ length: 30 }, (_, i) => `overview line ${i + 1} with content`),
			contract: ["Acceptance criteria:", "  1. first criterion"],
			changes: ["Evidence revision: abc123"],
			review: ["APPROVED — fine"],
			checks: ["unit: passed (120ms)"],
			history: ["Created now"],
		},
		actions: [
			{ id: "continue", label: "Continue ▸ next step" },
			{ id: "cancel", label: "Cancel task" },
		],
		status: "SYMPHONY DEV-001 · BUILD",
	};
}

describe.each([
	{ width: 80, height: 24 },
	{ width: 110, height: 30 },
	{ width: 160, height: 45 },
])("overlay snapshots ($width×$height)", ({ width, height }) => {
	it("fits exactly within the terminal bounds", () => {
		const overlay = new SymphonyOverlay(richModel(40), () => {}, height);
		const lines = overlay.render(width);
		expect(lines.length).toBeLessThanOrEqual(height);
		for (const line of lines) {
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
			expect(plain.length).toBeLessThanOrEqual(width);
		}
	});

	it("keeps the selected row visible while scrolling", () => {
		const overlay = new SymphonyOverlay(richModel(40), () => {}, height);
		// jump to the last task by pressing down many times
		for (let i = 0; i < 45; i++) overlay.handleInput("j");
		const lines = overlay.render(width).join("\n");
		expect(lines).toContain("DEV-040");
		// earlier rows scrolled out but indicated
		expect(lines).toMatch(/more task/);
	});

	it("keyboard-only journey: select → detail → tab → action", () => {
		let fired = "";
		const overlay = new SymphonyOverlay(richModel(3), (a) => { fired = a.id; }, height);
		overlay.handleInput("j"); // second task
		overlay.handleInput("\r"); // open detail
		overlay.handleInput("l"); // next tab
		overlay.handleInput("\x1b[B"); // down → second action (cancel)
		overlay.handleInput("\r"); // fire
		expect(overlay.isClosed).toBe(true);
		expect(fired).toBe("cancel");
	});
});
