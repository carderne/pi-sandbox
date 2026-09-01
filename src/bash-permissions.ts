import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type BashToolDetails,
  type BashToolInput,
  type ExtensionContext,
  createBashToolDefinition,
  isBashToolResult,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

export const MAX_JUSTIFICATION_CODE_POINTS = 500;

export const bashEscalationSchema = Type.Object(
  {
    justification: Type.String({
      description: "Concise user-facing reason for Bash escalation",
      minLength: 1,
      maxLength: MAX_JUSTIFICATION_CODE_POINTS,
      pattern: "\\S",
    }),
  },
  {
    additionalProperties: false,
    description: "Request one-time Bash execution outside pi-sandbox",
  },
);

export const sandboxBashSchema = Type.Object(
  {
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(
      Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
    ),
    escalation: Type.Optional(bashEscalationSchema),
  },
  { additionalProperties: false },
);

export type SandboxBashInput = Static<typeof sandboxBashSchema>;
export type BashEscalationStatus =
  | "requested"
  | "approved_once"
  | "aborted"
  | "denied"
  | "cancelled"
  | "timed_out"
  | "unavailable"
  | "invalid";

const BASH_ESCALATION_STATUSES: ReadonlySet<unknown> = new Set<BashEscalationStatus>([
  "requested",
  "approved_once",
  "aborted",
  "denied",
  "cancelled",
  "timed_out",
  "unavailable",
  "invalid",
]);

const NOT_RUN_ESCALATION_STATUSES: ReadonlySet<unknown> = new Set<BashEscalationStatus>([
  "aborted",
  "denied",
  "cancelled",
  "timed_out",
  "unavailable",
  "invalid",
]);

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

export type BashInputClassification =
  | { kind: "default" }
  | { kind: "escalation"; justification: string }
  | { kind: "invalid"; message: string };

export type EscalationPrompt = (request: EscalationPromptRequest) => Promise<EscalationDecision>;

export const BASH_ESCALATION_GUIDELINES = [
  "When using Bash, use the default sandbox first unless the operation is inherently known to require execution outside pi-sandbox.",
  "For ordinary Bash calls, omit the `escalation` field.",
  'Request Bash escalation only when the command is necessary and sandbox restrictions prevent it from succeeding. Use `escalation: { "justification": "<concise user-facing reason>" }`.',
  'When a sandboxed Bash attempt fails because of a sandbox restriction and the command is still needed, make one new Bash call with `escalation: { "justification": "<concise user-facing reason>" }`. Do not wait for the user to request escalation separately; the approval prompt is where the user decides whether to allow it.',
  "For Bash escalation, if the user declines that escalation prompt, or the escalation request is cancelled, times out, or is unavailable, stop. Do not submit another escalation request unless the user later explicitly asks.",
  "For Bash escalation, do not claim the command ran unless the tool returns its actual command output.",
] as const;

type JustificationValidation = { ok: true; justification: string } | { ok: false; message: string };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escalationStatusFromDetails(details: unknown): BashEscalationStatus | undefined {
  if (!isRecord(details) || !isRecord(details.escalation)) return undefined;
  const status = details.escalation.status;
  return BASH_ESCALATION_STATUSES.has(status) ? (status as BashEscalationStatus) : undefined;
}

function isNotRunEscalationStatus(status: BashEscalationStatus): boolean {
  return NOT_RUN_ESCALATION_STATUSES.has(status);
}

export function hasEscalationProperty(input: unknown): boolean {
  return isRecord(input) && Object.hasOwn(input, "escalation");
}

export function classifyBashInput(input: unknown): BashInputClassification {
  if (!isRecord(input)) {
    return { kind: "invalid", message: "Invalid Bash tool input." };
  }

  const allowedOuterKeys = new Set(["command", "timeout", "escalation"]);
  if (Object.keys(input).some((key) => !allowedOuterKeys.has(key))) {
    return { kind: "invalid", message: "Invalid Bash tool input." };
  }

  if (!hasEscalationProperty(input)) return { kind: "default" };
  const escalation = input.escalation;
  if (
    !isRecord(escalation) ||
    Object.keys(escalation).length !== 1 ||
    !Object.hasOwn(escalation, "justification")
  ) {
    return { kind: "invalid", message: "Invalid Bash escalation request." };
  }

  const validation = validateEscalationJustification(escalation.justification);
  return validation.ok
    ? { kind: "escalation", justification: validation.justification }
    : { kind: "invalid", message: validation.message };
}

export function isEscalationRequest(input: unknown): boolean {
  return classifyBashInput(input).kind === "escalation";
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

export type BashExecutor = (
  toolCallId: string,
  input: BashToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<BashToolDetails | undefined>>;

export interface ExecuteEscalatedBashOptions {
  toolCallId: string;
  input: SandboxBashInput;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<SandboxBashDetails | undefined>;
  ctx: ExtensionContext;
  promptTimeoutSeconds?: number;
  queue: EscalationPromptQueue;
  executeLocal: BashExecutor;
  onApproved?: (toolCallId: string) => void;
  onAborted?: (toolCallId: string) => void;
}

export async function executeEscalatedBash(
  options: ExecuteEscalatedBashOptions,
): Promise<AgentToolResult<SandboxBashDetails | undefined>> {
  const throwAborted = (): never => {
    options.onAborted?.(options.toolCallId);
    throw createEscalationAbortError();
  };

  const classification = classifyBashInput(options.input);
  if (classification.kind !== "escalation") {
    return createNotRunResult(
      "invalid",
      classification.kind === "invalid"
        ? classification.message
        : "Invalid Bash escalation request.",
    );
  }
  if (options.signal?.aborted) throwAborted();
  if (options.ctx.mode !== "tui" || !options.ctx.hasUI) {
    return createNotRunResult("unavailable");
  }

  let decision: EscalationDecision;
  try {
    decision = await options.queue.enqueue({
      toolCallId: options.toolCallId,
      command: options.input.command,
      justification: classification.justification,
      timeoutSeconds: options.promptTimeoutSeconds,
      signal: options.signal,
      ctx: options.ctx,
    });
  } catch (error) {
    if (isEscalationAbortError(error)) throwAborted();
    return createNotRunResult("unavailable", "Bash escalation approval could not be displayed.");
  }

  if (decision.action === "deny") {
    const status = {
      user: "denied",
      timeout: "timed_out",
      cancelled: "cancelled",
      unavailable: "unavailable",
    } as const;
    return createNotRunResult(status[decision.reason]);
  }

  if (options.signal?.aborted) throwAborted();
  const approved = "approved_once" as const;
  options.onApproved?.(options.toolCallId);
  options.onUpdate?.({ content: [], details: withEscalationStatus(undefined, approved) });

  const forwardUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined =
    options.onUpdate
      ? (update) =>
          options.onUpdate?.({
            ...update,
            details: withEscalationStatus(update.details, approved),
          })
      : undefined;
  const result = await options.executeLocal(
    options.toolCallId,
    stripEscalationFields(options.input),
    options.signal,
    forwardUpdate,
    options.ctx,
  );
  return { ...result, details: withEscalationStatus(result.details, approved) };
}

export interface CreateEscalatingBashToolOptions {
  base: ReturnType<typeof createBashToolDefinition>;
  label: string;
  isSandboxActive: () => boolean;
  executeDefault: BashExecutor;
  promptQueue: EscalationPromptQueue;
  getPromptTimeoutSeconds: (ctx: ExtensionContext) => number | undefined;
  onApproved?: (toolCallId: string) => void;
  onAborted?: (toolCallId: string) => void;
}

export function formatEscalationMarker(status: BashEscalationStatus): string {
  switch (status) {
    case "requested":
      return "outside pi-sandbox requested";
    case "approved_once":
      return "outside pi-sandbox — approved once";
    case "timed_out":
      return "outside pi-sandbox — not run (timed out)";
    default:
      return `outside pi-sandbox — not run (${status})`;
  }
}

class EscalationRenderComponent extends Container {
  readonly markerComponent = new Text("", 0, 0);

  constructor(
    private baseComponent: Component,
    private readonly formatDim: (text: string) => string,
    status: BashEscalationStatus | undefined,
  ) {
    super();
    this.addChild(baseComponent);
    this.addChild(this.markerComponent);
    this.updateMarker(status);
  }

  getBaseComponent(): Component {
    return this.baseComponent;
  }

  updateBaseComponent(component: Component): void {
    if (component === this.baseComponent) return;
    this.baseComponent = component;
    this.clear();
    this.addChild(component);
    this.addChild(this.markerComponent);
  }

  updateMarker(status: BashEscalationStatus | undefined): void {
    this.markerComponent.setText(
      status === undefined ? "" : `\n${this.formatDim(formatEscalationMarker(status))}`,
    );
  }
}

interface EscalationRendererState {
  escalationStatus?: BashEscalationStatus;
  escalationCallComponent?: EscalationRenderComponent;
}

function unwrapEscalationComponent(component: Component | undefined): Component | undefined {
  return component instanceof EscalationRenderComponent ? component.getBaseComponent() : component;
}

export function createEscalatingBashToolDefinition(options: CreateEscalatingBashToolOptions) {
  type BaseRenderCall = NonNullable<typeof options.base.renderCall>;
  type BaseRenderResult = NonNullable<typeof options.base.renderResult>;
  type BaseCallParameters = Parameters<BaseRenderCall>;
  type BaseResultParameters = Parameters<BaseRenderResult>;
  type RenderContext = BaseCallParameters[2];
  type ExtendedRenderContext = Omit<RenderContext, "args"> & { args: SandboxBashInput };

  const wrapRenderedComponent = (
    baseComponent: Component,
    status: BashEscalationStatus | undefined,
    theme: BaseCallParameters[1],
    lastComponent: Component | undefined,
  ): EscalationRenderComponent => {
    if (lastComponent instanceof EscalationRenderComponent) {
      lastComponent.updateBaseComponent(baseComponent);
      lastComponent.updateMarker(status);
      return lastComponent;
    }
    return new EscalationRenderComponent(baseComponent, (text) => theme.fg("dim", text), status);
  };

  const renderCall = options.base.renderCall
    ? (
        args: SandboxBashInput,
        theme: BaseCallParameters[1],
        context: ExtendedRenderContext,
      ): Component => {
        const state = context.state as typeof context.state & EscalationRendererState;
        const escalationRequested = hasEscalationProperty(args);
        const status = escalationRequested && options.isSandboxActive() ? "requested" : undefined;
        state.escalationStatus = status;
        const baseComponent = options.base.renderCall!(stripEscalationFields(args), theme, {
          ...context,
          args: stripEscalationFields(context.args),
          lastComponent: unwrapEscalationComponent(context.lastComponent),
        });
        if (!escalationRequested) {
          state.escalationCallComponent = undefined;
          return baseComponent;
        }
        const component = wrapRenderedComponent(
          baseComponent,
          status,
          theme,
          context.lastComponent,
        );
        state.escalationCallComponent = component;
        return component;
      }
    : undefined;

  const renderResult = options.base.renderResult
    ? (
        result: AgentToolResult<SandboxBashDetails | undefined>,
        renderOptions: BaseResultParameters[1],
        theme: BaseResultParameters[2],
        context: ExtendedRenderContext,
      ): Component => {
        const state = context.state as typeof context.state & EscalationRendererState;
        const isPiPreExecutionAbort =
          hasEscalationProperty(context.args) &&
          context.isError &&
          result.details?.escalation === undefined &&
          result.content.length === 1 &&
          result.content[0]?.type === "text" &&
          result.content[0].text === "Operation aborted";
        const status =
          result.details?.escalation?.status ??
          (isPiPreExecutionAbort ? "aborted" : state.escalationStatus);
        state.escalationStatus = status;
        state.escalationCallComponent?.updateMarker(status);
        const baseComponent = options.base.renderResult!(result, renderOptions, theme, {
          ...context,
          args: stripEscalationFields(context.args),
          lastComponent: unwrapEscalationComponent(context.lastComponent),
        });
        return baseComponent;
      }
    : undefined;

  return {
    ...options.base,
    label: options.label,
    parameters: sandboxBashSchema,
    promptGuidelines: [...BASH_ESCALATION_GUIDELINES],
    async execute(
      id: string,
      params: SandboxBashInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<SandboxBashDetails | undefined> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<SandboxBashDetails | undefined>> {
      const classification = classifyBashInput(params);
      if (classification.kind === "invalid") {
        return createNotRunResult("invalid", classification.message);
      }
      if (!options.isSandboxActive()) {
        return options.base.execute(id, stripEscalationFields(params), signal, onUpdate, ctx);
      }
      if (classification.kind === "default") {
        return options.executeDefault(id, stripEscalationFields(params), signal, onUpdate, ctx);
      }
      return executeEscalatedBash({
        toolCallId: id,
        input: params,
        signal,
        onUpdate,
        ctx,
        promptTimeoutSeconds: options.getPromptTimeoutSeconds(ctx),
        queue: options.promptQueue,
        executeLocal: options.base.execute.bind(options.base),
        onApproved: options.onApproved,
        onAborted: options.onAborted,
      });
    },
    renderCall,
    renderResult,
  };
}

export interface BashEscalationCallTracker {
  markApproved(toolCallId: string): void;
  markAborted(toolCallId: string): void;
  handleToolResult(
    event: ToolResultEvent,
  ): { details?: SandboxBashDetails; isError?: boolean } | undefined;
}

export function createBashEscalationCallTracker(): BashEscalationCallTracker {
  const statuses = new Map<string, "approved_once" | "aborted">();
  return {
    markApproved(toolCallId) {
      statuses.set(toolCallId, "approved_once");
    },
    markAborted(toolCallId) {
      statuses.set(toolCallId, "aborted");
    },
    handleToolResult(event) {
      if (!isBashToolResult(event)) return undefined;
      const trackedStatus = statuses.get(event.toolCallId);
      if (trackedStatus === undefined) {
        const detailStatus = escalationStatusFromDetails(event.details);
        return detailStatus !== undefined && isNotRunEscalationStatus(detailStatus)
          ? { isError: true }
          : undefined;
      }
      statuses.delete(event.toolCallId);
      return {
        details: withEscalationStatus(event.details, trackedStatus),
        ...(isNotRunEscalationStatus(trackedStatus) ? { isError: true } : {}),
      };
    },
  };
}

export function shouldPreflightBashDomains(input: SandboxBashInput): boolean {
  return !hasEscalationProperty(input);
}
