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

		const listLines = this.renderList(listWidth);
		if (wide) {
			const detailLines = this.renderDetail(detailWidth);
			const rows = Math.max(listLines.length, detailLines.length, 4);
			for (let i = 0; i < rows; i++) {
				const left = listLines[i] ?? "".padEnd(listWidth);
				const right = detailLines[i] ?? "";
				lines.push(`│${fit(left, listWidth)}${fit(right, detailWidth)}│`);
			}
		} else if (this.focus === "list") {
			for (const line of listLines) lines.push(`│${fit(line, inner)}│`);
		} else {
			for (const line of this.renderDetail(inner)) lines.push(`│${fit(line, inner)}│`);
		}
		const footer = this.focus === "list"
			? "↑/↓ select · enter detail · tab pane · esc close"
			: "←/→ tab · ↑/↓ action · enter run · tab pane · esc back";
		lines.push(`├${border}┤`);
		lines.push(`│${pad(footer, inner)}│`);
		lines.push(`└${border}┘`);
		return lines;
	}

	private renderList(width: number): string[] {
		const lines: string[] = [];
		for (let i = 0; i < this.model.tasks.length; i++) {
			const task = this.model.tasks[i]!;
			const icon = STAGE_ICON[task.stage] ?? "?";
			const run = RUN_ICON[task.runState] ?? " ";
			const marker = this.focus === "list" && i === this.selected ? "›" : " ";
			const text = `${marker}${icon} ${task.id} ${task.stage} ${run} ${task.title}`;
			lines.push(truncateToWidth(text, width));
		}
		return lines;
	}

	private renderDetail(width: number): string[] {
		const task = this.model.tasks[this.selected];
		const lines: string[] = [];
		const tabs = Object.keys(this.model.detail) as DetailTab[];
		lines.push(truncateToWidth(tabs.map((t) => (t === this.tab ? `[${t}]` : t)).join(" "), width));
		lines.push("─".repeat(Math.max(1, width - 1)));
		if (!task) {
			lines.push("(no task selected)");
			return lines;
		}
		for (const line of this.model.detail[this.tab] ?? []) {
			lines.push(truncateToWidth(line, width));
		}
		lines.push("─".repeat(Math.max(1, width - 1)));
		lines.push("Actions:");
		this.model.actions.forEach((action, i) => {
			const marker = i === this.actionIndex ? "›" : " ";
			lines.push(truncateToWidth(`${marker} ${action.label}`, width));
		});
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
