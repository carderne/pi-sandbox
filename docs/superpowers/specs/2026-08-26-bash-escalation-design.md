# Explicit Bash Sandbox Escalation

Status: Proposed

Date: 2026-08-26

Issue: [carderne/pi-sandbox#50](https://github.com/carderne/pi-sandbox/issues/50)

## Summary

Extend the existing `bash` tool with a Codex-style, model-requested escalation path. Bash remains sandboxed by default. When a command cannot complete because of a sandbox restriction, the model may issue a new `bash` call with `sandbox_permissions: "require_escalated"` and a short justification. In a TUI session, pi-sandbox shows the user the justification, the exact command, and a warning that the command will bypass all pi-sandbox filesystem and network restrictions. The command runs through Pi's ordinary local Bash implementation only if the user approves that single invocation.

The extension does not infer that escalation is required and does not automatically rerun a failed command. While pi-sandbox is active, the model must explicitly request escalation and the user must explicitly approve it. Denial, timeout, cancellation, and non-TUI use all fail closed and return an unambiguous result. If the user has already disabled pi-sandbox, the existing local-execution behavior remains authoritative.

## Motivation

Today, a Bash command can fail for a restriction that pi-sandbox cannot turn into one of its fine-grained domain or path prompts. The model sees a failure but has no supported way to ask the user to run the command outside the sandbox. It may repeatedly retry, search for workarounds, or spend the rest of the turn reasoning without making progress.

The desired behavior is the same broad pattern used by Codex:

1. Try the command under the normal sandbox policy.
2. If the sandbox blocks necessary work, explicitly request elevated execution and explain why.
3. Show the user exactly what would run and wait for a decision.
4. Run once outside the sandbox only after approval.

This is deliberately narrower than the automatic bypass and shell-policy machinery attempted in [PR #27](https://github.com/carderne/pi-sandbox/pull/27), and narrower than the separate-tool workaround in [`pi-bash-sandbox-bypass`](https://github.com/jacktwilliams/pi-bash-sandbox-bypass). It adds one explicit escape hatch without introducing a command parser or a large allowlist policy.

## Goals

- Give the model a first-class way to request permission after a sandbox-related failure.
- Keep every ordinary Bash call sandboxed exactly as it is today.
- Require informed, one-time user approval for each unsandboxed command.
- Make all non-approval outcomes explicit so the model knows the command did not run and should not loop.
- Reuse Pi's existing `bash` tool, streaming, timeout, cancellation, truncation, and rendering behavior.
- Keep the first implementation small enough to maintain and review.

## Non-goals

- Automatically detect sandbox failures and rerun commands.
- Parse shell syntax to determine whether a command is safe.
- Add a second `bash_no_sandbox` or `bash_full_permissions` tool.
- Persist approvals by command, prefix, project, session, or global configuration.
- Let the model broaden or edit a command after it has been approved.
- Support escalation in RPC, JSON, or print mode. Version 1 requires Pi's local TUI approval surface even though RPC reports itself as UI-capable.
- Change the `!command`/`user_bash` flow.
- Escape a sandbox imposed on the Pi process by a parent application, container, or operating system.

## User and model flow

### Normal execution

The model calls:

```json
{
  "command": "pnpm test"
}
```

The extension follows the current sandboxed execution path. Existing domain prompts, blocked-write recovery, timeout handling, output streaming, and truncation remain unchanged.

### Escalated execution

After a relevant failure, the model may call:

```json
{
  "command": "pnpm install",
  "sandbox_permissions": "require_escalated",
  "justification": "Allow pnpm to reach the registry and update its cache outside this workspace?"
}
```

When pi-sandbox is active in TUI mode, the extension pauses before spawning a process and displays:

- a clear “Run outside pi-sandbox?” title;
- the model-provided justification;
- the complete command, rendered so terminal control characters cannot spoof the prompt;
- a warning that this invocation bypasses all pi-sandbox filesystem read/write and network restrictions, including configured deny rules;
- two choices: **Allow once** and **Deny**.

Approval applies only to the exact command string in that tool call. The command is not editable from the approval prompt. Choosing **Allow once** executes it once with Pi's normal local Bash backend. Choosing **Deny**, pressing Escape/Ctrl-C inside the prompt, allowing the prompt to time out, or losing the TUI does not execute it.

If pi-sandbox has already been explicitly disabled, Bash already uses Pi's local backend. Existing behavior is preserved and no extra escalation prompt is added.

### Model guidance

The overridden Bash definition adds `promptGuidelines` with these self-contained rules. Pi flattens active tools' guidelines into a shared list, so each rule names Bash explicitly:

- When using Bash, use the default sandbox first unless the operation is inherently known to require execution outside pi-sandbox.
- For Bash, use `require_escalated` only when the command is necessary and sandbox restrictions prevent it from succeeding.
- For Bash escalation, include a concise, user-facing justification describing the capability being requested.
- For Bash escalation, do not retry after a denial, cancellation, timeout, or unavailable result unless the user explicitly asks.
- For Bash escalation, do not claim the command ran unless the tool returns its actual command output.

These are behavioral instructions, not a brittle enforcement mechanism. The extension will not parse prior output or require proof of a preceding sandbox failure. A human approval gate is the final authority.

## Tool contract

The existing Bash schema is replaced with a compatible superset:

```ts
interface SandboxBashInput {
  command: string;
  timeout?: number;
  sandbox_permissions?: "use_default" | "require_escalated";
  justification?: string;
}
```

Parameter semantics:

| Parameter | Meaning |
| --- | --- |
| `command` | Unchanged: the exact shell command Pi will execute. |
| `timeout` | Unchanged: optional execution timeout in seconds. Time spent waiting for approval does not consume this timeout. |
| `sandbox_permissions` | Omitted or `use_default` uses the normal sandbox. `require_escalated` requests one unsandboxed execution. |
| `justification` | Required at runtime for `require_escalated`; ignored for ordinary execution. It must contain non-whitespace text and be at most 500 Unicode code points. |

`sandbox_permissions` uses Codex's established name and values so models familiar with that protocol can transfer the behavior. `justification` remains optional in the JSON schema because conditional requirements are inconsistently handled across model providers; the runtime enforces its presence, non-whitespace content, and code-point length before showing a prompt or running anything.

The tool's details extend Pi's existing Bash details with rendering-only escalation metadata:

```ts
type BashEscalationStatus =
  | "requested"
  | "approved_once"
  | "denied"
  | "cancelled"
  | "timed_out"
  | "unavailable"
  | "invalid";

interface SandboxBashDetails extends BashToolDetails {
  escalation?: { status: BashEscalationStatus };
}
```

This metadata is for durable UI/history rendering and tests; it is not shell output and must not be inserted into stdout or stderr content.

The project should import TypeBox directly to define this schema and therefore add `typebox` as a direct dependency rather than relying on Pi's transitive installation.

## Execution design

The registered tool continues to spread Pi's `createBashToolDefinition` result so its name, output accumulator, streaming updates, truncation behavior, and ordinary timeout behavior are retained. It overrides the parameter schema, prompt guidance, label, execution router, and call rendering, and narrowly wraps result rendering. The call renderer preserves Pi's command and timeout display while adding a durable escalation marker. The result wrapper updates the shared render state from escalation metadata and then delegates to Pi's existing Bash result renderer unchanged. The marker progresses from **outside pi-sandbox requested** to either **outside pi-sandbox — approved once** or **outside pi-sandbox — not run (`reason`)**. It must never label a denied or unavailable request as approved.

The router and its wrapped update callback merge escalation metadata into Bash details without replacing truncation or full-output metadata. After **Allow once** and the final pre-spawn abort check, the router emits/records `approved_once` before delegating. Because Pi replaces a thrown tool error with a fresh result whose details are empty, the extension also tracks approved tool-call IDs until `tool_result` and merges `approved_once` into that final result. The marker therefore remains even if local process creation or execution later fails and after the session is restored. Default Bash calls have no escalation metadata and render exactly as they do today.

The router has two explicit paths:

```text
bash tool call
├── omitted / use_default
│   └── current sandboxed Bash path
└── require_escalated
    ├── validate justification and TUI availability
    ├── wait for the escalation-prompt queue
    ├── show one-time approval prompt
    ├── non-approval → stable “not run” result
    └── approval → Pi local Bash path, once
```

For an approved call, the extension checks the abort signal again, then passes the original command, timeout, abort signal, and update callback to the already-created local Bash definition. It must not rebuild, normalize, prepend to, or otherwise mutate the approved command. Extra escalation fields are removed or ignored before delegation.

The existing `tool_call` domain preflight must recognize `require_escalated` and skip its fine-grained domain prompt for that call. Otherwise users could receive both a domain approval and a full-bypass approval for the same invocation. The full-bypass prompt supersedes every pi-sandbox rule for that one command. Default Bash calls continue through domain preflight unchanged.

The blocked-write output parser and automatic retry remain available only on the default path. An escalated call must never be fed back through sandbox failure recovery or executed a second time.

## Approval prompt and safe rendering

Add a dedicated escalation prompt rather than adapting the existing path/domain permission prompt. Path and domain prompts support rule editing and persistent scopes; escalation intentionally supports neither.

### Supported modes

Version 1 supports escalation only when both `ctx.mode === "tui"` and `ctx.hasUI` are true. `hasUI` is not sufficient by itself: Pi sets it to true in RPC mode because RPC can transport simple dialogs, but RPC's `ctx.ui.custom()` cannot render this approval component and returns `undefined`. RPC, JSON, and print mode therefore return the explicit unavailable result without calling `ctx.ui.custom()` or either Bash executor.

If a future version supports RPC, it must define an RPC approval transport that preserves complete safe command disclosure and an explicit response. It must not inherit approval merely from RPC's current `hasUI` value.

### Prompt serialization

Pi executes tool calls in parallel by default. The extension therefore maintains a cancellation-aware FIFO queue for escalation prompts so at most one is visible at a time. Each queue entry closes over its own tool-call ID, exact command, justification, signal, and resolver; a decision can never be applied to a different queued command.

Only escalated execution is queued. Ordinary Bash retains Pi's parallel behavior, and the existing domain/path `tool_call` prompts already run during Pi's sequential preflight phase. Setting the entire Bash tool to `executionMode: "sequential"` would unnecessarily serialize ordinary commands and is not part of this design.

A queued request whose signal aborts is removed without opening a prompt or invoking an executor. The permission timeout starts only when that request becomes visible, not while it waits behind another prompt. Every resolution path releases the active slot in `finally`-equivalent cleanup so denial, timeout, cancellation, disposal, or rendering failure cannot block later requests. Unexpected prompt construction or rendering failures become the stable `unavailable` non-run result; only a recognized tool-abort error propagates as an abort.

The prompt returns a discriminated result such as:

```ts
type EscalationDecision =
  | { action: "allow_once" }
  | { action: "deny"; reason: "user" | "timeout" | "cancelled" | "unavailable" };
```

Both the command and justification are untrusted model-generated text. The prompt uses a fixed header and fixed approval controls with a bounded, scrollable content viewport between them, so a very long command cannot push **Allow once** and **Deny** off-screen. The complete command remains inspectable; it is never silently truncated.

Display text is derived without changing the approved value. It visibly escapes C0/C1 controls, DEL, ANSI escape bytes, and Unicode format characters such as bidirectional overrides/isolates and zero-width controls. Newlines and tabs receive unambiguous visible representations. The UI wraps according to terminal display width, not JavaScript string length. The original command string—not the escaped display form—is retained in the queue entry and passed to execution after approval.

The prompt reuses `permissionPromptTimeoutSeconds` and the existing `request-attention` event. Its default selection and all exceptional exits are **Deny**. Timers and abort listeners are cleared when the component resolves or is disposed.

### Cancellation contract

Prompt dismissal and tool cancellation have different semantics:

- Escape or Ctrl-C handled by the approval component is a user denial with reason `cancelled`. It returns the stable non-run result and does not abort the surrounding agent turn.
- Once the extension's Bash `execute()` has begun, if the tool's `AbortSignal` is already aborted, aborts while queued, or aborts while the prompt is visible, the request closes/removes itself, invokes neither executor, and throws a Pi-compatible error whose message includes `aborted` and `escalated command was not run`. Pi may short-circuit an already-aborted batch after `tool_call` preflight and before invoking `execute()`; that earlier core-owned path returns Pi's generic `Operation aborted` result and still runs neither executor.
- After **Allow once**, the router checks the signal once more immediately before delegating. An abort that wins this race prevents process creation and follows the same error path.
- Once the local process has been spawned, Pi's local Bash implementation owns signal handling and preserves its existing process-tree cancellation behavior.

This split gives the model an explicit result for a declined prompt while preserving Pi's batch-level abort semantics for an actual tool cancellation.

## Failure semantics

Every extension-owned non-spawn path produces text that clearly says the command was not run outside the sandbox. Prompt-level non-approval returns a stable tool result and tells the model not to repeat the request without new user direction. Tool-level abort observed after extension `execute()` begins throws an explicit Pi-compatible error containing the same non-run fact so Pi can preserve cancellation semantics. The only exception is the documented Pi-owned pre-`execute()` abort, whose generic result is outside the extension's control.

| Condition | Result |
| --- | --- |
| Missing/blank justification | Invalid escalation request; command not run. |
| Justification over 500 Unicode code points | Invalid escalation request; command not run. |
| Mode is not TUI, or TUI is unavailable | Escalation unavailable; local TUI approval required; command not run. |
| User denies | Escalation denied; command not run. |
| Prompt expires after becoming visible | Escalation timed out; command not run. |
| User dismisses prompt with Escape/Ctrl-C | Escalation cancelled by user; stable result; command not run. |
| Tool signal aborts after extension `execute()` begins but before process spawn | Close/remove prompt, throw an explicit aborted/non-run error, and preserve Pi's surrounding cancellation semantics. |
| Pi observes an aborted batch before extension `execute()` begins | Pi returns its generic `Operation aborted` result; neither executor runs. |
| Prompt construction or rendering fails | Escalation unavailable; stable non-run result; advance the queue. |
| User approves | Return Pi's normal streamed Bash result, including exit status behavior and truncation metadata. |
| Local execution fails after approval | Return/throw the same failure Pi's normal local Bash tool would; do not fall back to sandboxed execution and do not retry. |

The exact denial strings should be centralized so tests can assert them and future prompt changes do not accidentally make the outcome ambiguous.

## Security model

This feature is intentionally a full pi-sandbox bypass, not a narrow exception. Once approved, the command and every subprocess it launches can use the filesystem and network permissions of the Pi process. In particular, it bypasses:

- `filesystem.allowRead`, `filesystem.denyRead`, `filesystem.allowWrite`, and `filesystem.denyWrite`;
- `network.allowedDomains` and `network.deniedDomains`;
- the default protection that denies broad reads from `/Users` and `/home`.

The prompt must say this plainly. “Outside pi-sandbox” is more accurate than “unrestricted,” because a parent container, application sandbox, operating-system policy, or permission boundary can still block the process.

Codex refuses some full-sandbox-removal requests when doing so would discard configured denied-read paths. This design intentionally does not copy that safeguard: pi-sandbox's local Bash backend cannot both run outside pi-sandbox and continue enforcing its denied-read rules. The one-time prompt therefore treats loss of those rules as part of the capability being approved. A future narrower exception mechanism would be a separate design, not an implicit promise of this one.

The safety boundary consists of explicit tool intent, complete command disclosure, safe display rendering, and one-time human approval. There is no shell allowlist because a shell string is not safely reducible to command prefixes: substitutions, redirections, sourced files, interpreters, and nested shells make prefix parsing misleading. There is no approval cache, so approval of one string conveys no authority to a later call.

## Code organization

The implementation is expected to touch these areas:

- `src/extension.ts`: define/register the expanded tool contract, route default versus escalated calls, bypass domain preflight for valid escalation requests, and add the durable escalated-call marker.
- `src/ui.ts`: add the one-time escalation prompt, scrollable safe text rendering, timeout, and prompt-level cancellation handling.
- A small focused module such as `src/bash-permissions.ts`: own escalation types, validation, the FIFO prompt queue, tool-signal handling, and stable result/error messages if extraction keeps the extension and UI independently testable.
- `package.json` and `pnpm-lock.yaml`: add the direct TypeBox dependency.
- Tests: cover schema, routing, UI outcomes, and non-execution guarantees.
- `README.md`: document the new parameters, approval flow, TUI-only behavior, and full-bypass warning.

Exact helper boundaries can be adjusted during implementation, but policy decisions and execution must remain separated enough that denial paths can be tested without spawning real unsandboxed commands.

## Testing strategy

Unit and integration-style tests should prove the safety boundary, not merely the happy path.

### Tool contract

- Omitted and `use_default` permissions validate and use the existing sandboxed path.
- `require_escalated` validates as a schema value; unknown values are rejected.
- Missing, whitespace-only, or over-500-code-point justification never opens a prompt and never invokes either executor.
- Existing `command` and `timeout` calls remain backward-compatible.

### Approval routing

- Approval invokes the local executor exactly once with the exact command and original timeout.
- Denial, timeout, prompt dismissal, tool cancellation, and unsupported modes invoke neither local nor sandboxed execution.
- `{ mode: "rpc", hasUI: true }` is unavailable, does not call `ctx.ui.custom()`, and invokes neither executor.
- Only `{ mode: "tui", hasUI: true }` can open an escalation prompt while pi-sandbox is active.
- A local execution error after approval is not retried.
- An escalated call skips fine-grained domain and blocked-write recovery paths.
- A default call retains existing domain and blocked-write behavior.
- Two simultaneous escalation requests display FIFO, and each decision is bound to the exact command that was visible.
- Aborting a queued request removes only that request and does not disturb the active or subsequent prompt.
- A queued prompt's permission timeout starts when it becomes visible, and every resolution path advances the queue.
- Signal abort observed after extension `execute()` begins—before prompting, while queued, while visible, and immediately after approval—invokes no executor and produces the explicit aborted/non-run error. A core-owned abort before `execute()` returns Pi's generic abort result and also invokes no executor.
- Signal abort after process spawn is delegated to Pi's local Bash behavior.

Use injected executor and prompt fakes for these tests; never run a genuinely unsandboxed fixture command as part of the test suite.

### UI

- The prompt renders the complete inspectable command, justification, and full-bypass warning while keeping its header and controls fixed.
- Long commands use the scrollable viewport and cannot push approval controls off-screen.
- ANSI, C0/C1, DEL, bidirectional, zero-width, and other Unicode format controls cannot alter or hide the approval UI.
- Allow and deny keys resolve to the expected decision.
- Escape and Ctrl-C return prompt-level cancellation without aborting the agent turn.
- Timeout, disposal, lost TUI, and tool-signal abort fail closed with their specified distinct semantics.
- Timers/listeners are cleaned up after every resolution path.
- The render wrappers retain Pi's command/timeout and Bash-result behavior, preserve truncation/full-output details when merging escalation metadata, and show the correct requested, approved-once, or not-run marker. Tests mirror Pi's call-then-result renderer order and inspect the already-created call component without requiring another render cycle.
- Approved local failures receive `approved_once` details through the final `tool_result` hook so live and restored history retain the marker.
- `require_escalated` calls remain visibly marked in live and restored session history without calling denied requests approved.

### Regression verification

Run the existing `pnpm test`, type checking, lint, and formatting checks. Manual verification should cover one denied and one approved command in an interactive Pi session, including a command that the default sandbox actually blocks.

## Documentation and rollout

The README should show the normal-failure/explicit-retry sequence and include the warning that approval bypasses deny rules as well as allow rules. It should state that version 1 is TUI-only, including the non-obvious fact that RPC's `hasUI: true` does not make the custom approval component available. It should also document the durable call marker, prompt queue behavior, distinct prompt/tool cancellation semantics, and absence of remembered approvals.

No configuration migration is required. Existing calls omit the new fields and behave exactly as before. The feature can ship without a persistent policy format, keeping future policy choices backward-compatible.

## Alternatives considered

### Separate unsandboxed Bash tool

A `bash_no_sandbox` tool makes the capability obvious but duplicates the Bash surface, renderer, and model guidance. It also encourages models to choose the powerful tool up front. Extending the existing tool makes sandboxing the default and represents escalation as a property of a specific call.

### Automatic retry after parsing sandbox output

This would be convenient for recognized failures but cannot reliably distinguish sandbox failures from ordinary permission errors across macOS, Linux, shells, and subprocesses. More importantly, an automatic retry can cross a security boundary without a deliberate model request. Output parsing remains suitable for the existing narrow write-path recovery, not full bypass.

### Persistent command or prefix approvals

Codex supports richer approval decisions, but shell prefixes are difficult to secure and add policy, storage, matching, revocation, and UI complexity. One-time approval solves the immediate blocked-agent problem without committing to those semantics. Exact-command session approval could be designed later from observed use.

### Large allowlist parser

An allowlist can reduce prompts for simple commands but becomes a shell-language security project and overlaps sandbox policy. It is outside the maintenance scope of this extension and is not necessary for explicit human-approved escalation.

## Follow-up possibilities

After the one-time flow has real-world use, separate proposals may consider:

- exact-command approvals scoped to the current session;
- an approval-policy setting that disables escalation requests entirely;
- an RPC approval transport for non-TUI clients that does not rely on `hasUI` alone;
- structured diagnostics from the sandbox runtime so models receive clearer default-path failures.

None of these are prerequisites for this design.

## References

- [Codex approval and security model](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Codex on-request model instructions](https://github.com/openai/codex/blob/daa3eaf10fda93ad8949b926c059dd8cc399f76a/codex-rs/prompts/templates/permissions/approval_policy/on_request.md)
- [Codex shell tool schema](https://github.com/openai/codex/blob/daa3eaf10fda93ad8949b926c059dd8cc399f76a/codex-rs/core/src/tools/handlers/shell_spec.rs)
- [Codex approval/retry orchestration](https://github.com/openai/codex/blob/daa3eaf10fda93ad8949b926c059dd8cc399f76a/codex-rs/core/src/tools/orchestrator.rs#L362-L499)
- [Codex denied-read escalation safeguard](https://github.com/openai/codex/blob/daa3eaf10fda93ad8949b926c059dd8cc399f76a/codex-rs/core/src/tools/sandboxing.rs#L269-L291)
- [Codex approval decision types](https://github.com/openai/codex/blob/daa3eaf10fda93ad8949b926c059dd8cc399f76a/codex-rs/protocol/src/protocol.rs#L3977-L4015)
- [Pi Bash tool source](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/bash.ts)
- [Issue #50 workaround comment](https://github.com/carderne/pi-sandbox/issues/50#issuecomment-4736302817)
