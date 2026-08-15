import { describe, expect, it } from "vitest";
import { SymphonyOverlay, type OverlayModel } from "../src/extension/overlay.ts";

function model(): OverlayModel {
	return {
		tasks: [
			{ id: "DEV-001", title: "First task with a fairly long title to force truncation checks", stage: "build", runState: "running", updatedAt: "now", acceptanceTotal: 3, checksSummary: "checks not run" },
			{ id: "DEV-002", title: "Second", stage: "done", runState: "idle", updatedAt: "now", acceptanceTotal: 1, checksSummary: "checks green" },
		],
		detail: {
			overview: ["ID: DEV-001", "Stage: build"],
			contract: ["1. criterion one"],
			changes: [],
			review: [],
			checks: ["unit: passed"],
			history: [],
		},
		actions: [
			{ id: "continue", label: "Continue ▸ next step" },
			{ id: "cancel", label: "Cancel task" },
		],
		status: "SYMPHONY DEV-001 · BUILD",
	};
}

function press(overlay: SymphonyOverlay, key: string): void {
	overlay.handleInput(key);
}

describe("overlay component (V01-UI-001)", () => {
	it("renders within 80 columns at 80×24 without horizontal overflow", () => {
		const overlay = new SymphonyOverlay(model(), () => {});
		const lines = overlay.render(80);
		expect(lines.length).toBeLessThanOrEqual(22);
		for (const line of lines) {
			// strip ANSI escapes for width check
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
			expect(plain.length).toBeLessThanOrEqual(80);
		}
		expect(lines.join("\n")).toContain("DEV-001");
	});

	it("renders wide side-by-side layout at 160 columns", () => {
		const overlay = new SymphonyOverlay(model(), () => {});
		const lines = overlay.render(160);
		for (const line of lines) {
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
			expect(plain.length).toBeLessThanOrEqual(160);
		}
	});

	it("keyboard navigation: j/k moves selection, enter opens detail, tab toggles panes", () => {
		const overlay = new SymphonyOverlay(model(), () => {});
		expect(overlay.selectedTaskId).toBe("DEV-001");
		press(overlay, "j");
		expect(overlay.selectedTaskId).toBe("DEV-002");
		press(overlay, "k");
		expect(overlay.selectedTaskId).toBe("DEV-001");
		press(overlay, "\r"); // enter → detail
		press(overlay, "\t"); // tab → back to list
		press(overlay, "\x1b"); // escape → close
		expect(overlay.isClosed).toBe(true);
		expect(overlay.closeResult).toBeNull(); // Escape never mutates state
	});

	it("running an action closes with that action id", () => {
		let fired = "";
		const overlay = new SymphonyOverlay(model(), (action) => {
			fired = action.id;
		});
		press(overlay, "\r"); // to detail
		press(overlay, "l"); // to next tab
		press(overlay, "\r"); // run selected action
		expect(overlay.isClosed).toBe(true);
		expect(overlay.closeResult).toBe("continue");
		expect(fired).toBe("continue");
	});

	it("color is never the only carrier: every status row includes textual stage", () => {
		const overlay = new SymphonyOverlay(model(), () => {});
		const text = overlay.render(100).join("\n");
		expect(text).toMatch(/DEV-001 build/);
		expect(text).toMatch(/DEV-002 done/);
	});
});
