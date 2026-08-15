import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const appSource = readFileSync(new URL("../src/web/spa/app.js", import.meta.url), "utf8");
const readmeSource = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const landingSource = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
	version: string;
	packages: { "": { version: string } };
};

type EventRecord = Record<string, unknown>;
type Listener = (event: EventRecord) => unknown;

class FakeElement {
	textContent = "";
	className = "";
	innerHTML = "";
	value = "";
	dataset: Record<string, string> = {};
	private readonly classes: Set<string>;
	private readonly listeners = new Map<string, Listener[]>();
	readonly classList = {
		contains: (name: string) => this.classes.has(name),
		add: (name: string) => void this.classes.add(name),
		toggle: (name: string, force?: boolean) => {
			const active = force ?? !this.classes.has(name);
			if (active) this.classes.add(name);
			else this.classes.delete(name);
			return active;
		},
	};

	constructor(classes: string[] = []) {
		this.classes = new Set(classes);
	}

	addEventListener(type: string, listener: Listener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	async dispatch(type: string, event: EventRecord): Promise<void> {
		for (const listener of this.listeners.get(type) ?? []) await listener(event);
	}

	click(): void {
		void this.dispatch("click", { target: this });
	}

	focus(): void {}

	closest(selector: string): FakeElement | null {
		return selector === "button.nav" && this.classes.has("nav") ? this : null;
	}
}

class FakeDocument {
	readonly body = new FakeElement();
	private readonly listeners = new Map<string, Listener[]>();
	constructor(
		private readonly elements: Map<string, FakeElement>,
		private readonly nav: FakeElement,
		private readonly buttons: FakeElement[],
	) {}

	getElementById(id: string): FakeElement | null {
		return this.elements.get(id) ?? null;
	}

	querySelector(selector: string): FakeElement | null {
		return selector === "nav[aria-label='Primary']" ? this.nav : null;
	}

	querySelectorAll(selector: string): FakeElement[] {
		return selector === "button.nav" ? this.buttons : [];
	}

	addEventListener(type: string, listener: Listener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
}

class FakeSseStream {
	private readonly chunks: Uint8Array[] = [];
	private pending: ((result: { done: boolean; value?: Uint8Array }) => void) | undefined;
	private ended = false;

	getReader() {
		return {
			read: async () => {
				if (this.chunks.length > 0) return { done: false, value: this.chunks.shift() };
				if (this.ended) return { done: true };
				return new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => { this.pending = resolve; });
			},
			cancel: async () => this.end(),
		};
	}

	push(text: string): void {
		if (this.ended) return;
		const result = { done: false, value: new TextEncoder().encode(text) };
		if (this.pending) {
			const resolve = this.pending;
			this.pending = undefined;
			resolve(result);
		} else {
			this.chunks.push(result.value);
		}
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.pending?.({ done: true });
		this.pending = undefined;
	}
}

function makeSpaContext() {
	const elements = new Map<string, FakeElement>([
		["view", new FakeElement()],
		["connection", new FakeElement()],
		["repo", new FakeElement()],
		["status", new FakeElement()],
		["events", new FakeElement()],
	]);
	const views = ["overview", "tasks", "run", "review", "verification", "configuration", "diagnostics"];
	const buttons = views.map((view, index) => {
		const button = new FakeElement(["nav"]);
		button.dataset.view = view;
		if (index === 0) button.classList.add("active");
		return button;
	});
	const nav = new FakeElement();
	const document = new FakeDocument(elements, nav, buttons);
	const snapshot = {
		repositoryId: "repo-1",
		repositoryPath: "/tmp/repo",
		configValid: true,
		configHash: "hash",
		lastEventSequence: 1,
		projectionVersion: 1,
		tasks: [],
	};
	const fetchCalls: Array<{ input: string; init?: { headers?: Record<string, string>; signal?: AbortSignal } }> = [];
	const eventStreams: FakeSseStream[] = [];
	const fetch = async (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
		fetchCalls.push({ input, init });
		if (input === "/api/v1/events") {
			const stream = new FakeSseStream();
			eventStreams.push(stream);
			init?.signal?.addEventListener("abort", () => stream.end(), { once: true });
			return { status: 200, ok: true, body: stream, json: async () => snapshot };
		}
		return { status: 200, ok: true, json: async () => snapshot };
	};

	return {
		document,
		buttons,
		fetchCalls,
		eventStreams,
		fetch,
		context: {
			document,
			window: { location: { hash: "#token=test-token" } },
			HTMLElement: FakeElement,
			AbortController,
			TextDecoder,
			setTimeout,
			clearTimeout,
			crypto: { randomUUID: () => "command-id" },
			fetch,
			confirm: () => true,
			console,
		},
	};
}

describe("release regressions", () => {
	it("keeps Pi install instructions valid and lock metadata aligned", () => {
		for (const source of [readmeSource, landingSource]) {
			expect(source).not.toContain("pi install github:cskwork/pi-symphony");
			expect(source).toContain("pi install git:github.com/cskwork/pi-symphony");
		}
		expect(packageLock.version).toBe(packageJson.version);
		expect(packageLock.packages[""].version).toBe(packageJson.version);
	});

	it("routes nav clicks and reconnects SSE from a clean snapshot", async () => {
		expect(appSource).toContain("state.lastEventId = sseEvent.lastEventId || state.lastEventId");
		expect(appSource).toContain('headers["Last-Event-ID"] = state.lastEventId');
		expect(appSource).not.toContain("new EventSource");

		const { context, document, buttons, eventStreams, fetchCalls } = makeSpaContext();
		runInNewContext(appSource, context);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));

		const view = document.getElementById("view")!;
		const initial = eventStreams[0]!;
		expect(fetchCalls.find((call) => call.input === "/api/v1/events")?.init?.headers?.Authorization).toBe("Bearer test-token");

		await document.querySelector("nav[aria-label='Primary']")!.dispatch("click", { target: buttons[1] });
		expect(view.innerHTML).toContain("<h2>Tasks</h2>");
		expect(buttons[1]!.classList.contains("active")).toBe(true);

		initial.push('event: task.created\nid: 7-bridge-id\ndata: {"eventId":"payload-id","sequence":2,"type":"task.created"}\n\n');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		initial.end();
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		const resumedCall = fetchCalls.filter((call) => call.input === "/api/v1/events")[1]!;
		expect(resumedCall.init?.headers?.["Last-Event-ID"]).toBe("7-bridge-id");

		const resumed = eventStreams[1]!;
		resumed.push("event: snapshot_required\ndata: {}\n\n");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const freshCall = fetchCalls.filter((call) => call.input === "/api/v1/events")[2]!;
		expect(freshCall.init?.headers?.["Last-Event-ID"]).toBeUndefined();
	});
});
