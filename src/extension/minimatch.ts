/**
 * Minimal glob matcher for protected-path patterns.
 * Supports: *, **, ? and character classes — enough for policy globs like
 * `.env.*` and `.git/**`. Deliberately dependency-free.
 */

export function minimatch(path: string, pattern: string): boolean {
	const re = globToRegExp(pattern);
	return re.test(path);
}

function globToRegExp(pattern: string): RegExp {
	let source = "";
	let i = 0;
	while (i < pattern.length) {
		const char = pattern[i]!;
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				// `**` matches across separators; swallow a following `/` too
				source += "(?:.*)";
				i += 2;
				if (pattern[i] === "/") i += 1;
			} else {
				source += "[^/]*";
				i += 1;
			}
		} else if (char === "?") {
			source += "[^/]";
			i += 1;
		} else if (char === "[") {
			const end = pattern.indexOf("]", i);
			if (end < 0) {
				source += escapeRegExp(char);
				i += 1;
			} else {
				source += pattern.slice(i, end + 1);
				i = end + 1;
			}
		} else {
			source += escapeRegExp(char);
			i += 1;
		}
	}
	return new RegExp(`^${source}$`);
}

function escapeRegExp(char: string): string {
	return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
