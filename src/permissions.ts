import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { domainIsAllowed, matchesPattern } from "./policy.ts";
import { renderPermissionPrompt } from "./ui.ts";

export type PermissionChoice = "abort" | "session" | "project" | "global";

export interface PermissionPromptResult {
  action: PermissionChoice;
  value: string;
}

interface PermissionPromptQueue {
  tail: Promise<void>;
  controller: AbortController;
}

const promptQueues = new WeakMap<ExtensionAPI, PermissionPromptQueue>();

function getPromptQueue(pi: ExtensionAPI): PermissionPromptQueue {
  let queue = promptQueues.get(pi);
  if (!queue) {
    queue = { tail: Promise.resolve(), controller: new AbortController() };
    promptQueues.set(pi, queue);
  }
  return queue;
}

export function cancelPermissionPrompts(pi: ExtensionAPI): void {
  getPromptQueue(pi).controller.abort();
}

export function resetPermissionPrompts(pi: ExtensionAPI): void {
  cancelPermissionPrompts(pi);
  promptQueues.delete(pi);
}

export async function showPermissionPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string,
  originalValue: string,
  validateValue: (value: string) => string | null,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  const aborted: PermissionPromptResult = { action: "abort", value: originalValue };
  if (!ctx.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) return aborted;

  const queue = getPromptQueue(pi);
  const operationSignal = ctx.signal;
  const signal = AbortSignal.any([
    queue.controller.signal,
    ...(operationSignal ? [operationSignal] : []),
  ]);
  if (signal.aborted) return aborted;

  const previous = queue.tail;
  let release!: () => void;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.tail = previous.then(() => finished);
  let onAbort: () => void = () => {};
  const cancelled = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const ready = await Promise.race([previous.then(() => true), cancelled]);
    signal.removeEventListener("abort", onAbort);
    if (!ready || signal.aborted) return aborted;
    return await renderPermissionPrompt(
      pi,
      ctx,
      title,
      originalValue,
      validateValue,
      signal,
      timeoutSeconds,
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
    release();
  }
}

const validRule = (value: string, matches: boolean, target: string): string | null => {
  if (value.length === 0) return "Rule cannot be empty.";
  return matches ? null : `Rule must match the blocked ${target}.`;
};

export function promptDomainBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  domain: string,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    `🌐 Network blocked: "${domain}" is not in allowedDomains`,
    domain,
    (value) => validRule(value, domainIsAllowed(domain, [value]), `domain "${domain}"`),
    timeoutSeconds,
  );
}

export function promptReadBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    `📖 Read blocked: "${path}" is not in allowRead`,
    path,
    (value) => validRule(value, matchesPattern(path, [value], ctx.cwd), `path "${path}"`),
    timeoutSeconds,
  );
}

export function promptWriteBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    `📝 Write blocked: "${path}" is not in allowWrite`,
    path,
    (value) => validRule(value, matchesPattern(path, [value], ctx.cwd), `path "${path}"`),
    timeoutSeconds,
  );
}
