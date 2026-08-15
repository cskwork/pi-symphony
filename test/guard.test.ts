import { describe, expect, it } from "vitest";
import { classifyWrite, findDestructiveCommand, isProtectedPath } from "../src/extension/guard.ts";

const policy = { protectedPaths: [".env", ".env.*", ".git/**", ".symphony/runtime/**"], policy: "confirm" as const };
const blockPolicy = { ...policy, policy: "block" as const };

describe("protected-path interception matrix (V01-SAFE-001)", () => {
	it.each([
		[".env", true],
		[".env.production", true],
		[".git/config", true],
		[".git/hooks/pre-commit", true],
		[".symphony/runtime/leases/active.json", true],
		["src/index.ts", false],
		["docs/.env.example", false],
		[".envrc", false],
	])("isProtectedPath(%s) → %s", (path, expected) => {
		expect(isProtectedPath(path, policy)).toBe(expected);
	});

	it("confirm policy asks; block policy refuses", () => {
		expect(classifyWrite(".env", policy)).toBe("confirm");
		expect(classifyWrite(".env", blockPolicy)).toBe("block");
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
