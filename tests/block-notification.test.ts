import assert from "node:assert/strict";
import test from "node:test";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";

function captureBanner(ctx = createFakeCtx()) {
  let banner: string[] | undefined;
  ctx.ui.setWidget = (key: string, content: string[] | undefined) => {
    if (key === "pi-automode-block") banner = content;
  };
  return { ctx, get banner() { return banner; } };
}

test("classifier block warns and stays visible through later allows and reload", async () => {
  const ui = captureBanner();
  const harness = await setupHookTest({
    ctx: ui.ctx,
    config: baseConfig({ log: { enabled: false, classifierIo: false } }),
    classifier: async () => ({ decision: "block", tier: "hard_deny", reason: "mock block" }),
  });
  assert.equal(ui.banner, undefined);

  const result = await harness.emit("tool_call", {
    toolName: "bash", input: { command: "npm publish" },
  }, ui.ctx) as { block?: boolean };
  assert.equal(result.block, true);
  assert.deepEqual(ui.ctx.notifications, [{
    message: "Auto mode blocked bash: mock block", type: "warning",
  }]);
  assert.match(ui.banner?.join("\n") ?? "", /blocked bash.*1 blocked/);
  assert.match(ui.banner?.join("\n") ?? "", /mock block/);
  const blockedBanner = ui.banner;

  assert.equal(await harness.emit("tool_call", {
    toolName: "read", input: { path: "README.md" },
  }, ui.ctx), undefined);
  assert.deepEqual(ui.banner, blockedBanner);
  assert.equal(harness.classifierCalls, 1);

  const restored = captureBanner(createFakeCtx(harness.entries));
  await harness.emit("session_start", { type: "session_start" }, restored.ctx);
  assert.deepEqual(restored.banner, blockedBanner);

  await harness.commands.get("automode")!.handler("reset", restored.ctx);
  assert.equal(restored.banner, undefined);
});

test("deterministic blocks show the same banner without invoking classifier", async () => {
  const ui = captureBanner();
  const harness = await setupHookTest({
    ctx: ui.ctx,
    config: baseConfig({ log: { enabled: false, classifierIo: false } }),
  });
  const result = await harness.emit("tool_call", {
    toolName: "write", input: { path: ".pi/automode.local.json", content: "{}" },
  }, ui.ctx) as { block?: boolean };
  assert.equal(result.block, true);
  assert.equal(harness.classifierCalls, 0);
  assert.match(ui.banner?.join("\n") ?? "", /Auto mode blocked write/);
  assert.equal(ui.ctx.notifications.length, 1);
});

test("persistent banner removes controls and bounds denial reason length", async () => {
  const ui = captureBanner();
  const harness = await setupHookTest({
    ctx: ui.ctx,
    config: baseConfig({ log: { enabled: false, classifierIo: false } }),
    classifier: async () => ({
      decision: "block", tier: "hard_deny", reason: "\x1b[31m\n" + "x".repeat(1000),
    }),
  });
  await harness.emit("tool_call", {
    toolName: "bash", input: { command: "npm publish" },
  }, ui.ctx);
  assert.ok(ui.banner);
  assert.doesNotMatch(ui.banner.join(""), /[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(ui.banner[1].length <= 240);
});

for (const mode of ["rpc", "print"] as const) {
  test(`${mode} mode does not create a TUI widget`, async () => {
    const ui = captureBanner(createFakeCtx([], { mode, hasUI: mode === "rpc" }));
    const harness = await setupHookTest({
      ctx: ui.ctx,
      config: baseConfig({ log: { enabled: false, classifierIo: false } }),
      classifier: async () => ({ decision: "block", tier: "hard_deny", reason: "mock block" }),
    });
    const result = await harness.emit("tool_call", {
      toolName: "bash", input: { command: "npm publish" },
    }, ui.ctx) as { block?: boolean };
    assert.equal(result.block, true);
    assert.equal(ui.banner, undefined);
    assert.equal(ui.ctx.notifications.length, mode === "rpc" ? 1 : 0);
  });
}
