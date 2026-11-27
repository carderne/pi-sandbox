import test, { type TestContext } from "node:test";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

import * as prompts from "../src/ui.ts";

type Component = {
  render(width: number): string[];
  handleInput?(data: string): void;
  dispose?(): void;
};
type Blocked = { kind: string; message: string };
type Factory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string },
  keybindings: unknown,
  done: (result: unknown) => void,
) => Component;

/** Mirrors Pi's inline ctx.ui.custom(): a dialog stack where the top entry gets input. */
function fixture(t: TestContext) {
  const mounts: { component: Component; blocked?: Blocked }[] = [];
  const active: Component[] = [];
  const pi = { events: { emit() {} } } as unknown as ExtensionAPI;
  const tui = { requestRender() {} };
  const ctx = {
    hasUI: true,
    cwd: "/workspace",
    ui: {
      custom(factory: Factory, options?: { blocked?: Blocked }) {
        return new Promise((resolve, reject) => {
          let component: Component | undefined;
          let closed = false;
          const close = (result: unknown) => {
            if (closed) return;
            closed = true;
            if (component) active.splice(active.indexOf(component), 1);
            resolve(result);
            component?.dispose?.();
          };
          try {
            const created = factory(tui, { fg: (_color, text) => text }, {}, close);
            if (closed) return;
            component = created;
            mounts.push({ component, blocked: options?.blocked });
            active.push(component);
          } catch (error) {
            reject(error);
          }
        });
      },
    },
  };
  t.after(() => prompts.cancelPermissionPrompts(pi));
  return {
    pi,
    ctx,
    mounts,
    active,
    send: (data: string) => active.at(-1)?.handleInput?.(data),
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

test("prompts report blocked permission status through Pi", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const pending = f.ask("example.test");
  await setImmediate();
  assert.deepEqual(f.mounts[0]!.blocked, { kind: "permission", message: "Blocked" });
  f.send("s");
  assert.equal((await pending).action, "session");
  assert.equal(f.active.length, 0);
});

test("arrow keys move the selection", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const pending = f.ask("keyboard");
  await setImmediate();
  const selected = () =>
    f.mounts[0]!.component.render(120).find((line) => line.startsWith(" → ["))!;
  assert.match(selected(), /Allow for this session only/);
  f.send("\x1b[B");
  assert.match(selected(), /Abort/);
  f.send("\x1b[B");
  assert.match(selected(), /Allow for this project/);
  f.send("\x1b[A");
  assert.match(selected(), /Abort/);
  f.send("\r");
  assert.equal((await pending).action, "abort");
});

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
      assert.equal(f.active.length, 1);
      f.send("s");
      await setImmediate();
    }
    assert.deepEqual(
      await Promise.all(requests),
      ["one", "two", "three"].map((value) => ({ action: "session", value })),
    );
    assert.equal(f.active.length, 0);
  },
);

test("a queued request sees grants saved by the prompt before it", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  let granted = false;
  const hooks = {
    isAllowed: () => granted,
    apply: async () => {
      await setImmediate();
      granted = true;
    },
  };
  const ask = (value: string) =>
    prompts.showPermissionPrompt(f.pi, f.ctx as never, "Blocked", value, () => null, 0, hooks);
  const a = ask("first");
  const b = ask("second");
  await setImmediate();
  f.send("s");
  assert.equal((await a).action, "session");
  assert.deepEqual(await b, { action: "allowed", value: "second" });
  assert.equal(f.mounts.length, 1);
});

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
    f.send("s");
    await a;
    await setImmediate();
    assert.equal(f.mounts.length, 2);
    f.send("s");
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
    assert.equal(f.active.length, 1);
    assert.equal(f.mounts.length, 2);
    f.send("s");
    f.send("s");
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
    assert.equal(f.active.length, 0);
    assert.equal((await f.ask("closed")).action, "abort");
    prompts.resetPermissionPrompts(f.pi);
    const next = f.ask("new");
    await setImmediate();
    f.send("s");
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
    assert.equal(parent.active.length, 1);
    parent.send("s");
    assert.equal((await a).action, "session");
  },
);

test("timeout aborts one prompt and advances the queue", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const a = f.ask("timeout", undefined, 0.01);
  const b = f.ask("next");
  assert.equal((await a).action, "abort");
  await setImmediate();
  f.send("s");
  assert.equal((await b).action, "session");
});

test("Pi disposing the prompt rejects its request", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const pending = f.ask("sandbox");
  await setImmediate();
  f.active[0]!.dispose?.();
  assert.equal((await pending).action, "abort");
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
  f.send("s");
  assert.equal((await b).action, "session");
});
