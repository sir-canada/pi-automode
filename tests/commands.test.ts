import test from "node:test";
import assert from "node:assert/strict";
import {
	baseConfig,
	setupHookTest,
} from "./test-helpers.ts";

function lastNotification(harness: Awaited<ReturnType<typeof setupHookTest>>) {
	const notification = harness.ctx.notifications.at(-1);
	assert.ok(notification);
	return notification.message;
}

test("/am alias handles the same commands as /automode", async () => {
	const harness = await setupHookTest();
	assert.ok(harness.commands.get("am"));
	await harness.commands.get("am")!.handler("off", harness.ctx);
	assert.match(lastNotification(harness), /disabled for this session/);
	await harness.commands.get("am")!.handler("on", harness.ctx);
	assert.match(lastNotification(harness), /enabled for this session/);
});

test("/auto-mode alias is no longer registered", async () => {
	const harness = await setupHookTest();
	assert.equal(harness.commands.get("auto-mode"), undefined);
});

test("/automode toggle disables an enabled session and re-enables it", async () => {
	const harness = await setupHookTest();
	await harness.commands.get("automode")!.handler("toggle", harness.ctx);
	assert.match(lastNotification(harness), /disabled for this session/);
	await harness.commands.get("automode")!.handler("toggle", harness.ctx);
	assert.match(lastNotification(harness), /enabled for this session/);
});

test("/automode toggle re-enables when configuration disables auto mode", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ enabled: false }),
	});
	await harness.commands.get("automode")!.handler("toggle", harness.ctx);
	assert.match(lastNotification(harness), /enabled for this session/);
});

test("toggle changes guardrail decisions", async () => {
	const harness = await setupHookTest({
		classifier: async () => ({
			decision: "block",
			tier: "soft_deny",
			reason: "blocked by test classifier",
		}),
	});
	const event = {
		toolName: "write",
		input: { path: "/tmp/project/notes.txt", content: "x" },
	};

	const blocked = await harness.emit("tool_call", event, harness.ctx) as {
		block?: boolean;
	};
	assert.equal(blocked?.block, true);

	await harness.commands.get("automode")!.handler("toggle", harness.ctx);
	const afterToggle = await harness.emit("tool_call", event, harness.ctx);
	assert.equal(afterToggle, undefined);
	assert.equal(harness.classifierCalls, 1);
});

test("ctrl+shift+m shortcut toggles auto mode for the session", async () => {
	const harness = await setupHookTest();
	const shortcut = harness.shortcuts.get("ctrl+shift+m");
	assert.ok(shortcut, "expected a ctrl+shift+m shortcut registration");

	await shortcut.handler(harness.ctx);
	assert.match(lastNotification(harness), /disabled for this session/);
	await shortcut.handler(harness.ctx);
	assert.match(lastNotification(harness), /enabled for this session/);
});
