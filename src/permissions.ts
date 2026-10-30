import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  domainIsAllowed,
  matchesPattern,
  resolveWritePermission as resolveWritePolicy,
} from "./policy.ts";
import { renderPermissionPrompt } from "./ui.ts";

export type PermissionChoice = "abort" | "session" | "project" | "global";

export interface PermissionPromptResult {
  action: PermissionChoice;
  value: string;
}

interface PermissionRequestQueue {
  tail: Promise<void>;
  controller: AbortController;
}

const requestQueues = new WeakMap<ExtensionAPI, PermissionRequestQueue>();

function getRequestQueue(pi: ExtensionAPI): PermissionRequestQueue {
  let queue = requestQueues.get(pi);
  if (!queue) {
    queue = { tail: Promise.resolve(), controller: new AbortController() };
    requestQueues.set(pi, queue);
  }
  return queue;
}

export function cancelPermissionPrompts(pi: ExtensionAPI): void {
  getRequestQueue(pi).controller.abort();
}

export function resetPermissionPrompts(pi: ExtensionAPI): void {
  cancelPermissionPrompts(pi);
  requestQueues.delete(pi);
}

export async function runPermissionRequest<T>(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: (signal: AbortSignal) => Promise<T>,
  aborted: T,
): Promise<T> {
  const queue = getRequestQueue(pi);
  const signal = AbortSignal.any([queue.controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
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
    return await run(signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
    release();
  }
}

export async function showPermissionPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string,
  originalValue: string,
  validateValue: (value: string) => string | null,
  timeoutSeconds?: number,
  onChoice?: (choice: PermissionPromptResult) => Promise<void>,
): Promise<PermissionPromptResult> {
  const aborted: PermissionPromptResult = { action: "abort", value: originalValue };
  if (!ctx.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) return aborted;
  return runPermissionRequest(
    pi,
    ctx,
    async (signal) => {
      const choice = await renderPermissionPrompt(
        pi,
        ctx,
        title,
        originalValue,
        validateValue,
        signal,
        timeoutSeconds,
      );
      await onChoice?.(choice);
      return choice;
    },
    aborted,
  );
}

const validRule = (value: string, matches: boolean, target: string): string | null => {
  if (value.length === 0) return "Rule cannot be empty.";
  return matches ? null : `Rule must match the blocked ${target}.`;
};

export const promptDomainBlock = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  domain: string,
  timeoutSeconds?: number,
  onChoice?: (choice: PermissionPromptResult) => Promise<void>,
): Promise<PermissionPromptResult> =>
  showPermissionPrompt(
    pi,
    ctx,
    `🌐 Network blocked: "${domain}" is not in allowedDomains`,
    domain,
    (value) => validRule(value, domainIsAllowed(domain, [value]), `domain "${domain}"`),
    timeoutSeconds,
    onChoice,
  );

export const promptReadBlock = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  timeoutSeconds?: number,
  onChoice?: (choice: PermissionPromptResult) => Promise<void>,
): Promise<PermissionPromptResult> =>
  showPermissionPrompt(
    pi,
    ctx,
    `📖 Read blocked: "${path}" is not in allowRead`,
    path,
    (value) => validRule(value, matchesPattern(path, [value], ctx.cwd), `path "${path}"`),
    timeoutSeconds,
    onChoice,
  );

export const resolveWritePermission = ({
  pi,
  ctx,
  timeoutSeconds,
  ...policy
}: Omit<Parameters<typeof resolveWritePolicy>[0], "prompt"> & {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  timeoutSeconds?: number;
}) =>
  runPermissionRequest(
    pi,
    ctx,
    async (signal) =>
      resolveWritePolicy({
        ...policy,
        prompt: async (path) => {
          if (!ctx.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) {
            return { action: "abort", value: path };
          }
          return renderPermissionPrompt(
            pi,
            ctx,
            `📝 Write blocked: "${path}" is not in allowWrite`,
            path,
            (value) => validRule(value, matchesPattern(path, [value], ctx.cwd), `path "${path}"`),
            signal,
            timeoutSeconds,
          );
        },
      }),
    { action: "abort" },
  );
