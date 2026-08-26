import {
  type AgentToolResult,
  type BashToolDetails,
  type BashToolInput,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const MAX_JUSTIFICATION_CODE_POINTS = 500;

export const sandboxBashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
  sandbox_permissions: Type.Optional(
    Type.Union([Type.Literal("use_default"), Type.Literal("require_escalated")], {
      description: "Use pi-sandbox by default, or request one-time execution outside pi-sandbox",
    }),
  ),
  justification: Type.Optional(
    Type.String({ description: "Concise user-facing reason for Bash escalation" }),
  ),
});

export type SandboxBashInput = Static<typeof sandboxBashSchema>;
export type BashEscalationStatus =
  | "requested"
  | "approved_once"
  | "denied"
  | "cancelled"
  | "timed_out"
  | "unavailable"
  | "invalid";

export interface SandboxBashDetails extends BashToolDetails {
  escalation?: { status: BashEscalationStatus };
}

export type EscalationDecision =
  | { action: "allow_once" }
  | { action: "deny"; reason: "user" | "timeout" | "cancelled" | "unavailable" };

export interface EscalationPromptRequest {
  toolCallId: string;
  command: string;
  justification: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  ctx: ExtensionContext;
}

export type EscalationPrompt = (
  request: EscalationPromptRequest,
) => Promise<EscalationDecision>;

export const BASH_ESCALATION_GUIDELINES = [
  "When using Bash, use the default sandbox first unless the operation is inherently known to require execution outside pi-sandbox.",
  "For Bash, use require_escalated only when the command is necessary and sandbox restrictions prevent it from succeeding.",
  "For Bash escalation, include a concise, user-facing justification describing the capability being requested.",
  "For Bash escalation, do not retry after a denial, cancellation, timeout, or unavailable result unless the user explicitly asks.",
  "For Bash escalation, do not claim the command ran unless the tool returns its actual command output.",
] as const;

type JustificationValidation =
  | { ok: true; justification: string }
  | { ok: false; message: string };

export function validateEscalationJustification(value: unknown): JustificationValidation {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, message: "Bash escalation requires a non-blank justification." };
  }
  if ([...value].length > MAX_JUSTIFICATION_CODE_POINTS) {
    return {
      ok: false,
      message: `Bash escalation justification must be at most ${MAX_JUSTIFICATION_CODE_POINTS} Unicode code points.`,
    };
  }
  return { ok: true, justification: value.trim() };
}

export function isEscalationRequest(
  input: Pick<SandboxBashInput, "sandbox_permissions">,
): boolean {
  return input.sandbox_permissions === "require_escalated";
}

export function stripEscalationFields(input: SandboxBashInput): BashToolInput {
  return input.timeout === undefined
    ? { command: input.command }
    : { command: input.command, timeout: input.timeout };
}

export function withEscalationStatus(
  details: BashToolDetails | SandboxBashDetails | undefined,
  status: BashEscalationStatus,
): SandboxBashDetails {
  return { ...details, escalation: { status } };
}

const NOT_RUN_TEXT: Record<
  "invalid" | "unavailable" | "denied" | "cancelled" | "timed_out",
  string
> = {
  invalid:
    "Invalid Bash escalation request. The command was not run outside pi-sandbox. Do not retry without new user direction.",
  unavailable:
    "Bash escalation is unavailable because local TUI approval is required. The command was not run outside pi-sandbox. Do not retry without new user direction.",
  denied:
    "Bash escalation was denied. The command was not run outside pi-sandbox. Do not retry without new user direction.",
  cancelled:
    "Bash escalation was cancelled by the user. The command was not run outside pi-sandbox. Do not retry without new user direction.",
  timed_out:
    "Bash escalation timed out. The command was not run outside pi-sandbox. Do not retry without new user direction.",
};

export function createNotRunResult(
  status: keyof typeof NOT_RUN_TEXT,
  prefix?: string,
): AgentToolResult<SandboxBashDetails> {
  const text = prefix ? `${prefix} ${NOT_RUN_TEXT[status]}` : NOT_RUN_TEXT[status];
  return {
    content: [{ type: "text", text }],
    details: withEscalationStatus(undefined, status),
  };
}

export class BashEscalationAbortError extends Error {
  constructor() {
    super("aborted: escalated command was not run outside pi-sandbox");
    this.name = "BashEscalationAbortError";
  }
}

export function createEscalationAbortError(): BashEscalationAbortError {
  return new BashEscalationAbortError();
}

export function isEscalationAbortError(error: unknown): error is BashEscalationAbortError {
  return error instanceof BashEscalationAbortError;
}

export interface EscalationPromptQueue {
  enqueue(request: EscalationPromptRequest): Promise<EscalationDecision>;
}

interface QueueEntry {
  request: EscalationPromptRequest;
  resolve: (decision: EscalationDecision) => void;
  reject: (error: unknown) => void;
  removeQueuedAbortListener?: () => void;
}

export function createEscalationPromptQueue(prompt: EscalationPrompt): EscalationPromptQueue {
  const pending: QueueEntry[] = [];
  let active = false;

  const pump = (): void => {
    if (active) return;
    const entry = pending.shift();
    if (!entry) return;

    entry.removeQueuedAbortListener?.();
    if (entry.request.signal?.aborted) {
      entry.reject(createEscalationAbortError());
      queueMicrotask(pump);
      return;
    }

    active = true;
    Promise.resolve()
      .then(() => prompt(entry.request))
      .then(
        (decision) => {
          active = false;
          pump();
          entry.resolve(decision);
        },
        (error) => {
          active = false;
          pump();
          entry.reject(error);
        },
      );
  };

  return {
    enqueue(request) {
      if (request.signal?.aborted) return Promise.reject(createEscalationAbortError());

      return new Promise<EscalationDecision>((resolve, reject) => {
        const entry: QueueEntry = { request, resolve, reject };
        const onQueuedAbort = (): void => {
          const index = pending.indexOf(entry);
          if (index === -1) return;
          pending.splice(index, 1);
          reject(createEscalationAbortError());
        };
        if (request.signal) {
          request.signal.addEventListener("abort", onQueuedAbort, { once: true });
          entry.removeQueuedAbortListener = () =>
            request.signal?.removeEventListener("abort", onQueuedAbort);
        }
        pending.push(entry);
        pump();
      });
    },
  };
}
