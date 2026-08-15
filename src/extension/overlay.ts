import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TaskFrontmatter } from "../types.ts";

/**
 * Responsive Symphony overlay: task list + selected-task detail.
 * Wide terminals (>=100 cols) show panes side by side; narrow terminals
 * switch between screens. Every line respects the render width so the
 * overlay is usable at 80×24 without horizontal scrolling (V01-UI-001).
 */

export type DetailTab = "overview" | "contract" | "changes" | "review" | "checks" | "history";

export interface OverlayTask extends Pick<TaskFrontmatter, "id" | "title" | "stage" | "runState" | "updatedAt"> {
	acceptanceTotal: number;
	checksSummary: string;
}

export interface OverlayAction {
	id: string;
	label: string;
}

export interface OverlayModel {
	tasks: OverlayTask[];
	/** Rendered detail lines per tab. */
	detail: Record<DetailTab, string[]>;
	actions: OverlayAction[];
	status?: string;
}

const STAGE_ICON: Record<string, string> = {
	backlog: "○",
	plan: "◇",
	build: "●",
	review: "◈",
	verify: "✓",
	ready: "▲",
	postverify: "⟳",
	done: "■",
	blocked: "⊘",
	cancelled: "×",
};

const RUN_ICON: Record<string, string> = {
	idle: " ",
	running: "●",
	waiting: "…",
	interrupted: "⚠",
};

export class SymphonyOverlay {
	private focus: "list" | "detail" = "list";
	private selected = 0;
	private tab: DetailTab = "overview";
	private actionIndex = 0;
	private result: string | null = null;
	private closed = false;

	constructor(
		private model: OverlayModel,
		private onAction: (action: OverlayAction) => void,
		/** Terminal height bound; the overlay never renders more lines. */
		private maxHeight = 24,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.result = null;
			this.closed = true;
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.result = null;
			this.closed = true;
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.focus = this.focus === "list" ? "detail" : "list";
			return;
		}
		if (this.focus === "list") {
			if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
				if (this.selected > 0) this.selected--;
				this.actionIndex = 0;
			} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
				if (this.selected < this.model.tasks.length - 1) this.selected++;
				this.actionIndex = 0;
			} else if (matchesKey(data, Key.enter)) {
				this.focus = "detail";
			}
			return;
		}
		// detail focus
		if (matchesKey(data, Key.left) || matchesKey(data, "h")) {
			const tabs = Object.keys(this.model.detail) as DetailTab[];
			const idx = tabs.indexOf(this.tab);
			this.tab = tabs[(idx - 1 + tabs.length) % tabs.length]!;
		} else if (matchesKey(data, Key.right) || matchesKey(data, "l")) {
			const tabs = Object.keys(this.model.detail) as DetailTab[];
			const idx = tabs.indexOf(this.tab);
			this.tab = tabs[(idx + 1) % tabs.length]!;
		} else if (matchesKey(data, Key.up)) {
			if (this.actionIndex > 0) this.actionIndex--;
		} else if (matchesKey(data, Key.down)) {
			if (this.actionIndex < this.model.actions.length - 1) this.actionIndex++;
		} else if (matchesKey(data, Key.enter)) {
			const action = this.model.actions[this.actionIndex];
			if (action) {
				this.result = action.id;
				this.closed = true;
				this.onAction(action);
			}
		}
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** Action id when closed via action; null when dismissed with Escape. */
	get closeResult(): string | null {
		return this.closed ? this.result : null;
	}

	get selectedTaskId(): string | undefined {
		return this.model.tasks[this.selected]?.id;
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 2);
		const border = `─`.repeat(inner);
		const lines: string[] = [];
		lines.push(`┌${border}┐`);
		lines.push(`│${pad(`SYMPHONY — tasks${this.model.status ? ` · ${this.model.status}` : ""}`, inner)}│`);
		lines.push(`├${border}┤`);
		if (this.model.tasks.length === 0) {
			lines.push(`│${pad("No tasks yet — create one with /sym new", inner)}│`);
		}
		const wide = inner >= 96;
		const listWidth = wide ? Math.floor(inner / 2) : inner;
		const detailWidth = wide ? inner - listWidth : inner;

		// Reserve chrome lines (header 3 + footer 3) and clamp body rows so the
		// overlay always fits the terminal height (V01-UI-001: usable at 80×24).
		const chrome = 6;
		const bodyBudget = Math.max(3, this.maxHeight - chrome);
		const listLines = this.renderList(listWidth, bodyBudget);
		if (wide) {
			const detailLines = this.renderDetail(detailWidth, bodyBudget);
			const rows = Math.min(bodyBudget, Math.max(listLines.length, detailLines.length, 4));
			for (let i = 0; i < rows; i++) {
				const left = listLines[i] ?? "".padEnd(listWidth);
				const right = detailLines[i] ?? "";
				lines.push(`│${fit(left, listWidth)}${fit(right, detailWidth)}│`);
			}
		} else if (this.focus === "list") {
			for (const line of listLines.slice(0, bodyBudget)) lines.push(`│${fit(line, inner)}│`);
		} else {
			for (const line of this.renderDetail(inner, bodyBudget)) lines.push(`│${fit(line, inner)}│`);
		}
		const footer = this.focus === "list"
			? "↑/↓ select · enter detail · tab pane · esc close"
			: "←/→ tab · ↑/↓ action · enter run · tab pane · esc back";
		lines.push(`├${border}┤`);
		lines.push(`│${pad(footer, inner)}│`);
		lines.push(`└${border}┘`);
		return lines.slice(0, this.maxHeight);
	}

	private renderList(width: number, maxRows: number): string[] {
		const lines: string[] = [];
		const visible = Math.min(this.model.tasks.length, Math.max(1, maxRows - 1));
		// Keep the selected row inside the visible window (scrolling list).
		if (this.selected < 0) this.selected = 0;
		const start = Math.max(0, Math.min(this.selected - visible + 1, this.model.tasks.length - visible));
		for (let i = start; i < start + visible && i < this.model.tasks.length; i++) {
			const task = this.model.tasks[i]!;
			const icon = STAGE_ICON[task.stage] ?? "?";
			const run = RUN_ICON[task.runState] ?? " ";
			const marker = this.focus === "list" && i === this.selected ? "›" : " ";
			const text = `${marker}${icon} ${task.id} ${task.stage} ${run} ${task.title}`;
			lines.push(truncateToWidth(text, width));
		}
		if (this.model.tasks.length > visible) {
			lines.push(truncateToWidth(`  … ${this.model.tasks.length - visible} more task(s) — ↑/↓ to scroll`, width));
		}
		return lines;
	}

	private renderDetail(width: number, maxRows: number): string[] {
		const task = this.model.tasks[this.selected];
		const lines: string[] = [];
		const tabs = Object.keys(this.model.detail) as DetailTab[];
		lines.push(truncateToWidth(tabs.map((t) => (t === this.tab ? `[${t}]` : t)).join(" "), width));
		lines.push("─".repeat(Math.max(1, width - 1)));
		if (!task) {
			lines.push("(no task selected)");
			return lines;
		}
		const actionLines = this.model.actions.map((action, i) =>
			truncateToWidth(`${i === this.actionIndex ? "›" : " "} ${action.label}`, width),
		);
		// Reserve rows for actions so they are always reachable within budget.
		const reserved = actionLines.length + 3;
		const detailBudget = Math.max(0, maxRows - reserved - lines.length);
		for (const line of (this.model.detail[this.tab] ?? []).slice(0, detailBudget)) {
			lines.push(truncateToWidth(line, width));
		}
		if ((this.model.detail[this.tab] ?? []).length > detailBudget) {
			lines.push(truncateToWidth(`… ${(this.model.detail[this.tab] ?? []).length - detailBudget} more line(s) — ←/→ tabs`, width));
		}
		lines.push("─".repeat(Math.max(1, width - 1)));
		lines.push("Actions:");
		lines.push(...actionLines);
		return lines;
	}

	invalidate(): void {
		// no cached state; render is pure
	}
}

function pad(text: string, width: number): string {
	const w = visibleWidth(text);
	return w >= width ? truncateToWidth(text, width) : text + " ".repeat(width - w);
}

function fit(line: string, width: number): string {
	const w = visibleWidth(line);
	return w > width ? truncateToWidth(line, width) : line + " ".repeat(width - w);
}
