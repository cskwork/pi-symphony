import { describe, expect, it } from "vitest";
import { classifyWrite, findDestructiveCommand, isProtectedPath } from "../src/extension/guard.ts";

const policy = { protectedPaths: ["**/.env", "**/.env.*", "**/.envrc", "**/.git/**", ".symphony/**"], policy: "confirm" as const };
const blockPolicy = { ...policy, policy: "block" as const };

describe("protected-path interception matrix (V01-SAFE-001)", () => {
	it.each([
		[".env", true],
		[".env.production", true],
		["backend/.env", true],
		[".envrc", true],
		[".git/config", true],
		[".git/hooks/pre-commit", true],
		[".symphony/runtime/leases/active.json", true],
		[".symphony/tasks/DEV-001.md", true],
		[".ENV", true], // case-folded (APFS-style)
		["src/index.ts", false],
	])("isProtectedPath(%s) → %s", (path, expected) => {
		expect(isProtectedPath(path, policy)).toBe(expected);
	});

	it("confirm policy asks; block policy refuses; workflow state always blocks", () => {
		expect(classifyWrite(".symphony/config.yaml", policy)).toBe("confirm"); // human-owned config
		expect(classifyWrite(".env", policy)).toBe("block"); // credentials always block
		expect(classifyWrite(".env", blockPolicy)).toBe("block");
		expect(classifyWrite(".symphony/tasks/DEV-001.md", policy)).toBe("block"); // workflow truth
		expect(classifyWrite("src/main.ts", blockPolicy)).toBe("allow");
	});

	it.each([
		["git push origin main", "git push"],
		["git reset --hard HEAD~1", "git reset --hard"],
		["git clean -fd", "git clean"],
		["rm -rf build", "rm recursive/force"],
		["sudo apt install x", "sudo"],
		["git status --porcelain", undefined],
		["npm test", undefined],
		["echo hello", undefined],
	])("findDestructiveCommand(%j) → %j", (command, expected) => {
		expect(findDestructiveCommand(command)).toBe(expected);
	});
});
