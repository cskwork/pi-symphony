/**
 * Secret redaction applied before any output is persisted or displayed.
 * Runs with user permissions; this is hygiene, not a sandbox.
 */

const SECRET_PATTERNS: Array<{ name: string; re: RegExp; replacement: string }> = [
	{ name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED:aws-key]" },
	{ name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED:github-token]" },
	{ name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED:api-key]" },
	{ name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED:api-key]" },
	{
		name: "key-value",
		re: /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*("([^"\n]{4,})"|[']([^'\n]{4,})[']|(\S{4,}))/gi,
		replacement: "$1=[REDACTED]",
	},
	{
		name: "private-key-block",
		re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		replacement: "[REDACTED:private-key]",
	},
];

export function redactSecrets(text: string): string {
	let out = text;
	for (const { re, replacement } of SECRET_PATTERNS) {
		out = out.replace(re, replacement);
	}
	return out;
}

/** Redact every value of credentials passed as an environment mapping. */
export function redactEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		out[k] = v === undefined ? "" : "[REDACTED]";
	}
	return out;
}
