import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import test, { type TestContext } from "node:test";

import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

import * as prompts from "../src/ui.ts";

type Component = {
  handleInput(data: string): void;
  render(width: number): string[];
  dispose?(): void;
};
type Factory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string },
  keys: object,
  done: (result: prompts.PermissionPromptResult) => void,
) => Component;

function fixture(t: TestContext) {
  const mounts: { component: Component; overlay: boolean; done(): void }[] = [];
  const active = new Set<Component>();
  const pi = { events: { emit() {} } } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    cwd: "/workspace",
    ui: {
      custom(factory: Factory, options?: { overlay?: boolean }) {
        return new Promise<prompts.PermissionPromptResult>((resolve) => {
          let component: Component | undefined;
          let closed = false;
          const done = (result: prompts.PermissionPromptResult) => {
            if (closed) return;
            closed = true;
            if (component) active.delete(component);
            resolve(result);
            component?.dispose?.();
          };
          component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, done);
          mounts.push({
            component,
            overlay: options?.overlay === true,
            done: () => done({ action: "abort", value: "cleanup" }),
          });
          if (!closed) active.add(component);
        });
      },
    },
  };
  t.after(() => {
    for (const mount of mounts) mount.done();
  });
  return {
    pi,
    ctx,
    mounts,
    active,
    ask: (value: string, signal?: AbortSignal, timeout = 0) =>
      prompts.showPermissionPrompt(
        pi,
        { ...ctx, signal } as unknown as ExtensionContext,
        "Blocked",
        value,
        () => null,
        timeout,
      ),
  };
}

test(
  "concurrent prompts mount one at a time and return their own answers",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t);
    const requests = [f.ask("one"), f.ask("two"), f.ask("three")];
    await setImmediate();
    assert.equal(f.mounts.length, 1);
    for (let i = 0; i < 3; i++) {
      assert.equal(f.mounts.length, i + 1);
      assert.equal(f.active.size, 1);
      assert.equal(f.mounts[i]!.overlay, true);
      f.mounts[i]!.component.handleInput("s");
      await setImmediate();
    }
    assert.deepEqual(
      await Promise.all(requests),
      ["one", "two", "three"].map((value) => ({ action: "session", value })),
    );
    assert.equal(f.active.size, 0);
  },
);

test(
  "aborting a queued request does not mount it or release the active request",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t);
    const controller = new AbortController();
    const a = f.ask("active");
    const b = f.ask("queued", controller.signal);
    const c = f.ask("next");
    await setImmediate();
    controller.abort();
    assert.equal((await b).action, "abort");
    assert.equal(f.mounts.length, 1);
    f.mounts[0]!.component.handleInput("s");
    await a;
    await setImmediate();
    assert.equal(f.mounts.length, 2);
    f.mounts[1]!.component.handleInput("s");
    assert.equal((await c).value, "next");
  },
);

test(
  "aborting an active request disposes it and advances the queue",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t);
    const controller = new AbortController();
    const a = f.ask("active", controller.signal);
    const b = f.ask("next");
    await setImmediate();
    controller.abort();
    assert.equal((await a).action, "abort");
    await setImmediate();
    assert.equal(f.active.size, 1);
    assert.equal(f.mounts.length, 2);
    f.mounts[0]!.component.handleInput("s");
    f.mounts[1]!.component.handleInput("s");
    assert.equal((await b).action, "session");
  },
);

test("already aborted and headless requests never mount", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await f.ask("cancelled", controller.signal)).action, "abort");
  assert.equal(
    (
      await prompts.showPermissionPrompt(
        f.pi,
        { ...f.ctx, hasUI: false } as unknown as ExtensionContext,
        "Blocked",
        "headless",
        () => null,
        0,
      )
    ).action,
    "abort",
  );
  assert.equal(f.mounts.length, 0);
});

test(
  "cancelling a lifecycle aborts all requests and reset allows a fresh queue",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t);
    const requests = [f.ask("one"), f.ask("two"), f.ask("three")];
    await setImmediate();
    prompts.cancelPermissionPrompts(f.pi);
    assert.ok((await Promise.all(requests)).every((r) => r.action === "abort"));
    assert.equal(f.mounts.length, 1);
    assert.equal(f.active.size, 0);
    assert.equal((await f.ask("closed")).action, "abort");
    prompts.resetPermissionPrompts(f.pi);
    const next = f.ask("new");
    await setImmediate();
    f.mounts[1]!.component.handleInput("s");
    assert.equal((await next).action, "session");
  },
);

test(
  "extension instances have independent queues and cancellation",
  { timeout: 2000 },
  async (t) => {
    const parent = fixture(t);
    const child = fixture(t);
    const a = parent.ask("parent");
    const b = child.ask("child");
    await setImmediate();
    assert.equal(parent.mounts.length, 1);
    assert.equal(child.mounts.length, 1);
    prompts.cancelPermissionPrompts(child.pi);
    assert.equal((await b).action, "abort");
    assert.equal(parent.active.size, 1);
    parent.mounts[0]!.component.handleInput("s");
    assert.equal((await a).action, "session");
  },
);

test("timeout aborts one prompt and advances the queue", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const a = f.ask("timeout", undefined, 0.01);
  const b = f.ask("next");
  assert.equal((await a).action, "abort");
  await setImmediate();
  f.mounts[1]!.component.handleInput("s");
  assert.equal((await b).action, "session");
});

test("UI failures release the queue without granting permission", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const custom = f.ctx.ui.custom;
  let fail = true;
  f.ctx.ui.custom = (...args) => {
    if (fail) {
      fail = false;
      return Promise.reject(new Error("render failed"));
    }
    return custom(...args);
  };
  const a = f.ask("failure");
  const b = f.ask("next");
  await assert.rejects(a, /render failed/);
  await setImmediate();
  f.mounts[0]!.component.handleInput("s");
  assert.equal((await b).action, "session");
});
