/**
 * Fresh-context reviewer. The reviewer never receives the implementer
 * transcript: its initial context is the bounded review manifest only
 * (G04 / V01-AGENT-001). Review runs in a fresh Pi SDK session with a
 * read-only tool set.
 */

export interface ReviewFinding {
	severity: "blocker" | "major" | "minor" | "note";
	file?: string;
	summary: string;
	detail?: string;
}

export interface ReviewReport {
	verdict: "approved" | "changes_requested";
	findings: ReviewFinding[];
	summary: string;
	/** Session id of the fresh child that produced the report. */
	sessionId: string;
}

export interface ReviewerRunner {
	/** Run a fresh review session over the manifest; returns the structured report. */
	run(manifest: string, options: { signal?: AbortSignal; taskId: string }): Promise<ReviewReport>;
}

/**
 * Parse the reviewer's structured output. The reviewer is instructed to end
 * with a fenced ```review block containing verdict+findings JSON.
 */
export function parseReviewOutput(output: string, sessionId: string): ReviewReport {
	const match = output.match(/```review\s*([\s\S]*?)```/);
	if (!match) {
		return {
			verdict: "changes_requested",
			findings: [{ severity: "note", summary: "reviewer did not emit a structured report", detail: output.slice(0, 2000) }],
			summary: output.slice(0, 2000),
			sessionId,
		};
	}
	try {
		const parsed = JSON.parse(match[1]!) as Partial<ReviewReport>;
		return {
			verdict: parsed.verdict === "approved" ? "approved" : "changes_requested",
			findings: Array.isArray(parsed.findings)
				? parsed.findings.filter((f) => f && typeof f.summary === "string").map((f) => ({
						severity: (["blocker", "major", "minor", "note"].includes(String(f.severity)) ? f.severity : "note") as ReviewFinding["severity"],
						file: typeof f.file === "string" ? f.file : undefined,
						summary: String(f.summary),
						detail: typeof f.detail === "string" ? f.detail : undefined,
					}))
				: [],
			summary: typeof parsed.summary === "string" ? parsed.summary : "",
			sessionId,
		};
	} catch {
		return {
			verdict: "changes_requested",
			findings: [{ severity: "note", summary: "reviewer report was malformed JSON" }],
			summary: match[1]!.slice(0, 2000),
			sessionId,
		};
	}
}

export function reviewPromptFor(manifest: string): string {
	return [
		"You are an independent code reviewer in a fresh session.",
		"You did not write this change; judge only from the evidence below.",
		"Read referenced files with the read tool as needed. You have no write tools.",
		"",
		manifest,
		"",
		"## Output contract",
		"End your reply with exactly one fenced block tagged `review` containing JSON:",
		'{"verdict":"approved"|"changes_requested","findings":[{"severity":"blocker|major|minor|note","file":"path","summary":"...","detail":"..."}],"summary":"..."}',
		"Approve only if the acceptance criteria are met and no blocker/major finding remains.",
	].join("\n");
}

/**
 * SDK-backed reviewer runner. Uses createAgentSession with read-only tools,
 * an in-memory session, and a bounded system prompt. Import cost is deferred
 * so the domain layer can run without the SDK in unit tests.
 */
export class SdkReviewerRunner implements ReviewerRunner {
	async run(manifest: string, options: { signal?: AbortSignal; taskId: string }): Promise<ReviewReport> {
		const {
			createAgentSession,
			SessionManager,
			defineTool,
			DefaultResourceLoader,
			getAgentDir,
		} = await import("@earendil-works/pi-coding-agent");
		const { Type } = await import("typebox");

		const symTaskRead = defineTool({
			name: "sym_task_read",
			label: "Read Symphony task",
			description: "Read the Symphony task markdown file for the reviewed task",
			parameters: Type.Object({ taskId: Type.String() }),
			execute: async (_id, params) => ({
				content: [{ type: "text", text: manifest }],
				details: {},
			}),
		});

		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			// Fresh context isolation: no ambient extensions/skills/context files
			// leak into the reviewer session (V01-AGENT-001).
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
			systemPromptOverride: () =>
				[
					"You are Symphony's independent reviewer running in a fresh session.",
					"You have read-only tools. You never modify files.",
					"Judge only from the task contract, plan, diff, report, and evidence you are given.",
					"Finish with the required ```review JSON block.",
				].join("\n"),
		});
		await loader.reload();

		const { session } = await createAgentSession({
			resourceLoader: loader,
			tools: ["read", "grep", "find", "ls"],
			customTools: [symTaskRead],
			sessionManager: SessionManager.inMemory(),
		});

		let finalText = "";
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				const text = event.message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (text.trim()) finalText = text;
			}
		});
		try {
			if (options.signal?.aborted) throw new Error("review aborted before start");
			await session.prompt(reviewPromptFor(manifest));
		} finally {
			unsubscribe();
			session.dispose();
		}
		return parseReviewOutput(finalText, session.sessionId);
	}
}
