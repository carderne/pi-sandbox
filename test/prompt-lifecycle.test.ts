import test, { type TestContext } from "node:test";

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

import * as prompts from "../src/ui.ts";

type Component = {
  render(width: number): string[];
  dispose?(): void;
};
type Factory = (
  tui: { requestRender(): void; getFocusedComponent(): unknown },
  theme: { fg(color: string, text: string): string },
) => Component;

function fixture(t: TestContext) {
  const mounts: { component: Component; placement?: string }[] = [];
  const active = new Set<Component>();
  const listeners = new Set<(data: string) => { consume?: boolean } | undefined>();
  const pi = { events: { emit() {} } } as unknown as ExtensionAPI;
  const editor = Object.create(CustomEditor.prototype) as CustomEditor;
  editor.focused = true;
  let focus: unknown = editor;
  const tui = { requestRender() {}, getFocusedComponent: () => focus };
  let widget: Component | undefined;
  const ctx = {
    hasUI: true,
    cwd: "/workspace",
    ui: {
      onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
      setWidget(_key: string, factory?: Factory, options?: { placement?: string }) {
        const old = widget;
        widget = undefined;
        if (old) {
          active.delete(old);
          old.dispose?.();
        }
        if (!factory) return;
        widget = factory(tui, { fg: (_color, text) => text });
        mounts.push({ component: widget, placement: options?.placement });
        active.add(widget);
      },
    },
  };
  t.after(() => prompts.cancelPermissionPrompts(pi));
  return {
    pi,
    ctx,
    mounts,
    active,
    listeners,
    editor,
    tui,
    focus: (target: unknown) => {
      focus = target;
    },
    send: (data: string) => {
      for (const handler of listeners) if (handler(data)?.consume) return true;
      return false;
    },
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
  "arrow key release does not navigate twice and held keys still repeat",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t);
    const pending = f.ask("keyboard");
    await setImmediate();
    const selected = () =>
      f.mounts[0]!.component.render(120).find((line) => line.startsWith(" → ["))!;
    assert.match(selected(), /Allow for this session only/);
    assert.equal(f.send("\x1b[1;1:1B"), true);
    assert.match(selected(), /Abort/);
    assert.equal(f.send("\x1b[1;1:3B"), true);
    assert.match(selected(), /Abort/);
    f.send("\x1b[1;1:2B");
    assert.match(selected(), /Allow for this project/);
    f.send("\x1b[1;1:1A");
    assert.match(selected(), /Abort/);
    f.send("\x1b[1;1:3A");
    assert.match(selected(), /Abort/);
    f.send("\x1b[A");
    assert.match(selected(), /Allow for this session only/);
    f.send("\x1b[B");
    assert.match(selected(), /Abort/);
    f.send("\r");
    assert.equal((await pending).action, "abort");
    assert.equal(f.listeners.size, 0);
  },
);

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
      assert.equal(f.mounts[i]!.placement, "aboveEditor");
      f.send("s");
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
    assert.equal(f.active.size, 1);
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
    assert.equal(f.active.size, 0);
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
    assert.equal(parent.active.size, 1);
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

test(
  "other dialogs retain input ownership and permission resumes when the editor returns",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t);
    let settled = false;
    const pending = f.ask("sandbox").then((result) => {
      settled = true;
      return result;
    });
    await setImmediate();
    f.focus({ handleInput() {} });
    assert.equal(f.send("s"), false);
    await setImmediate();
    assert.equal(settled, false);
    assert.equal(f.active.size, 1);
    f.focus(f.editor);
    assert.equal(f.send("s"), true);
    assert.equal((await pending).action, "session");
    assert.equal(f.editor.focused, true);
    assert.equal(f.listeners.size, 0);
  },
);

test(
  "cancelling a prompt leaves another dialog focused and removes its listener",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t);
    const controller = new AbortController();
    const pending = f.ask("sandbox", controller.signal);
    await setImmediate();
    const other = {};
    f.focus(other);
    controller.abort();
    assert.equal((await pending).action, "abort");
    assert.equal(f.tui.getFocusedComponent(), other);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.active.size, 0);
  },
);

test(
  "disposing a widget rejects its request and removes input interception",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t);
    const pending = f.ask("sandbox");
    await setImmediate();
    f.ctx.ui.setWidget("sandbox-permission");
    assert.equal((await pending).action, "abort");
    assert.equal(f.listeners.size, 0);
    assert.equal(f.editor.focused, true);
  },
);

test("Pi 0.80 focus storage is supported without a getter", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  Reflect.deleteProperty(f.tui, "getFocusedComponent");
  Reflect.set(f.tui, "focusedComponent", f.editor);
  const pending = f.ask("legacy");
  await setImmediate();
  assert.equal(f.send("s"), true);
  assert.equal((await pending).action, "session");
});

test("missing focus inspection fails closed before mounting or listening", async (t) => {
  const f = fixture(t);
  Reflect.deleteProperty(f.tui, "getFocusedComponent");
  await assert.rejects(f.ask("unsupported"), /focus inspection/);
  assert.equal(f.mounts.length, 0);
  assert.equal(f.listeners.size, 0);
});

test("UI failures release the queue without granting permission", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const setWidget = f.ctx.ui.setWidget;
  let fail = true;
  f.ctx.ui.setWidget = (...args) => {
    if (fail) {
      fail = false;
      throw new Error("render failed");
    }
    return setWidget(...args);
  };
  const a = f.ask("failure");
  const b = f.ask("next");
  await assert.rejects(a, /render failed/);
  await setImmediate();
  f.send("s");
  assert.equal((await b).action, "session");
});
