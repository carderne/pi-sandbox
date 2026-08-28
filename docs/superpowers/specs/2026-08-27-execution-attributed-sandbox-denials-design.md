# Attempt-Attributed Sandbox Denials and Escalation Guidance

## Summary

`pi-sandbox` will associate each sandboxed Bash process with attempt-scoped denial evidence from `@carderne/sandbox-runtime`. When the final process attempt fails, Pi will use that attempt's structured evidence first and a Codex-compatible output heuristic as a fallback. In an interactive TUI where the existing escalation flow is available, an eligible failure remains a tool error and gains instructions for making a separate `sandbox_permissions: "require_escalated"` request.

Denial detection never runs a command outside the sandbox, requests approval, or retries automatically. The existing human-approved in-sandbox write recovery remains, and only its final process attempt can produce guidance.

This design intentionally limits the two-repository change to attempt attribution and guidance. It does not redesign Pi's sandbox state machine, shutdown behavior, process registry, cleanup ownership, SSH routing, or reviewer flow.

## Project context

The feature branch already supports explicit Bash escalation through `createEscalatingBashToolDefinition`. A model supplies `sandbox_permissions: "require_escalated"` and a justification; an existing TUI prompt shows the full command, and only human approval permits one local execution.

The missing piece is fresh context after an ordinary sandboxed Bash failure. Today, `executeDefaultBash` converts errors containing `Operation not permitted` into a normal tool result. That loses Pi's normal tool-error semantics and recognizes only one denial spelling. Runtime monitor events are also keyed by truncated command text, so concurrent identical commands and sequential retries are ambiguous.

One Bash tool call can run two sandboxed processes through the existing blocked-write flow: attempt A fails, the user grants or already has an allowance, and attempt B retries inside the sandbox. Guidance must use only attempt B when it exists. Pi's direct `user_bash` (`!command`) path is not model-facing and remains on the runtime's existing unattributed compatibility APIs.

## Goals

- Tell the model when the final failed sandboxed process appears to have encountered a sandbox denial.
- Isolate concurrent identical commands and sequential recovery attempts.
- Prefer exact attempt-scoped runtime evidence and use a Codex-compatible heuristic only when that attempt has no evidence.
- Preserve original command output, tool-error behavior, streaming, timeout, abort, and explicit escalation approval behavior.
- Keep the existing in-sandbox write recovery and use only its final process evidence.
- Publish updated macOS/Linux configuration for future attempts without resetting runtime monitors, proxies, or unrelated attempt attribution.
- Keep the Pi and runtime PRs additive and focused.

## Non-goals

- Automatically retrying outside the sandbox or opening an escalation prompt from denial detection.
- Adding reviewer-model approval or changing the existing human approval contract.
- Replacing Pi's sandbox booleans with a new lifecycle state machine.
- Adding session generations, an active-work registry, peer draining, shutdown arbitration, or prompt registries.
- Adding exact bwrap cleanup handles or changing current cleanup ownership.
- Migrating `user_bash` to attributed execution.
- Adding an authenticated SSH helper, changing Git/SSH routing, or changing the unauthenticated SOCKS default.
- Requiring structured evidence for legacy SSH, external proxy, or otherwise unattributed traffic.
- Reimplementing Pi's Bash tool output-retention or process-management pipeline.
- Adding Windows support.

## Architecture

```text
ordinary model Bash tool call
    -> run attributed attempt A under current config
       -> descriptor + runtime attempt handle
       -> existing process execution and cleanup
       -> runtime finish/drain after close
    -> optional existing write recovery
       -> publish updated config with updateConfig
       -> run attributed attempt B
       -> finish/drain B
    -> retain only the final attempt
    -> structured denial present?
       yes -> eligible denial
       no  -> apply output heuristic
    -> append guidance only to an eligible final tool error
```

There is no runtime outer execution. Pi already owns the tool-call boundary and the relationship between attempts A and B.

## Runtime initialization and configuration

`initializeSandbox` continues to build the complete runtime configuration and callback. It opts into runtime monitoring through the existing API:

```ts
await SandboxManager.initialize(runtimeConfig, networkAskCallback, true);
```

Monitor unavailability is diagnostic and does not disable enforcement. A missing structural event naturally reaches the heuristic fallback.

Permission-driven refresh no longer calls `reset()` followed by `initialize()`. On supported macOS and Linux sessions it builds the next complete runtime configuration and calls the existing synchronous API:

```ts
SandboxManager.updateConfig(nextRuntimeConfig);
```

The runtime compiles filesystem policy when each attributed descriptor is prepared. Attempt A therefore keeps its already prepared sandbox and Linux classification snapshot, while attempt B uses the updated configuration. Existing live proxy requests retain the runtime's current live network-policy behavior. Unrelated attempts, monitors, listeners, and credentials are not reset.

`createNetworkAskCallback` becomes a stable closure over a small mutable allowed-domain snapshot rather than the initialization array:

```ts
let currentAllowedDomains: readonly string[] = [];

const networkAskCallback: SandboxAskCallback = async ({ host }) =>
  domainIsAllowed(host, currentAllowedDomains);
```

Initialization sets the snapshot from the initial effective configuration. A refresh computes the next configuration, calls synchronous `updateConfig`, and then replaces the snapshot before yielding. If `updateConfig` throws, it keeps the previous snapshot and does not run a recovery attempt. No runtime callback-replacement API or policy-version object is introduced.

Reset remains limited to the extension's existing disablement, shutdown, and explicit reinitialization paths. This feature does not change those lifecycle paths.

## Attributed Bash attempt

Add a small attributed mode to `createSandboxedBashOps`, or a sibling helper sharing its existing process code. The attributed path calls:

```ts
const descriptor = await SandboxManager.prepareSandboxAttempt({
  command,
  binShell: shell,
  abortSignal: signal,
  cwd,
  env,
});
```

Preparation atomically returns the attempt handle with the descriptor. If preparation fails, it returns no handle and the error is a runtime error, not a command denial.

Pi spawns the descriptor exactly once:

```ts
spawn(descriptor.argv[0], descriptor.argv.slice(1), {
  cwd,
  env: descriptor.env,
  shell: false,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
```

The operations layer preserves existing `onData`, timeout, abort, and process-group termination behavior. It records only the small observation needed by the fallback:

```ts
interface SandboxAttemptObservation {
  sandboxBackend: SandboxBackend;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  termination: "exit" | "signal" | "timeout" | "aborted" | "spawn-error";
}
```

After child `close`, or after process creation fails, the operations layer performs the existing `SandboxManager.cleanupAfterCommand()` call and then awaits `finishSandboxAttempt(descriptor.attempt)`. It exposes the observation and returned denial summaries to the surrounding attempt helper before resolving or rejecting.

A child `error` is retained but does not bypass the existing close/cleanup path. Preparation failure has no descriptor and therefore performs neither command cleanup nor attempt finish. If the abort signal is already set after preparation but before the synchronous spawn call, Pi does not spawn, performs existing cleanup, finishes the returned attempt, and reports an abort. This needs one direct check, not a new process state machine or active-work registry.

The local `pi-sandbox` attempt-capture helper awaits both ordinary Pi Bash execution and the attributed `finished` promise. Its completed outcome is decision-complete and tagged, so it can preserve even an `undefined` throw:

```ts
export type CompletedAttributedBashAttempt<Result> =
  | { ok: true; result: Result; finished: FinishedSandboxProcessAttempt }
  | { ok: false; error: unknown; finished: FinishedSandboxProcessAttempt };
```

If Pi returned its normal successful `AgentToolResult` but the final observation is `termination: "signal"`, the helper extracts Pi's already-retained text content and turns that otherwise-successful result into a tool error with this exact shape:

```text
<retained Pi output>

Command terminated by signal <SIGNAL>
```

This is a local adapter for Pi's installed `{ exitCode: null }` signal-result contract. Direct process signals are eligible command failures except observations already classified as timeout, abort, or spawn error. It does not add a streaming buffer, change `BashOperations` exit-code normalization, or require an upstream Pi release. Normal success stays successful; timeout, abort, spawn, preparation, and finalization failures retain their existing behavior. A signal that does not have structured evidence and does not match the fallback remains a tool error without guidance. Preparation and finalization rejections occur before a completed outcome exists and bypass recovery and guidance. The helper does not replace Pi's Bash tool, duplicate retained output, or aggregate unrelated lifecycle failures.

Runtime preparation or finish failure is rethrown without denial guidance. It does not automatically run local Bash or mutate the extension's global sandbox lifecycle state as part of this feature.

## Existing write-recovery flow

The initial attempt is fully closed and drained before Pi runs `extractBlockedWritePath` and the existing write resolver. The resolver inspects the caught error message rather than a fabricated successful result.

- `allow`: publish the current effective configuration and run one new attributed attempt.
- `granted`: persist the approved allowance through the existing choice logic, publish the resulting configuration, and run one new attributed attempt.
- `deny`: do not retry; attempt A remains the final failure and may receive cautious guidance.
- `abort`: do not retry and suppress escalation guidance because the user just declined or cancelled the narrower write workflow.

Attempt B is always a new runtime attempt. Evidence from attempt A is discarded before B runs. A successful B returns normally; a failed B is classified using only B's observation and denial summaries. The recovery path never opens a second write prompt.

If configuration publication fails, Pi does not run attempt B and reports the publication error without denial guidance. It does not reset the runtime or fall back to local Bash.

## Denial decision

Only a final attributed command failure is eligible: an ordinary nonzero exit or a direct signal observation. Success, timeout, abort, spawn error, runtime preparation error, attempt-finalization error, policy-publication error, and a declined/cancelled write prompt receive no guidance.

For an eligible failure:

1. If the final attempt returned one or more supported denial summaries, treat it as execution-attributed evidence and do not run the heuristic.
2. Otherwise apply the fallback to the final attempt's observation and original Pi error message.
3. If neither matches, rethrow the original error unchanged.

Structured evidence is diagnostic, not authorization. The guidance says the failure “appears” sandbox-related and still requires a new explicit request plus human approval.

## Codex-compatible fallback

The fallback follows Codex's predicate while using Pi's already retained final error text rather than adding a second streaming-output buffer:

1. Return false when `sandboxBackend === "none"`.
2. Return false when the command succeeded.
3. Return true when the case-folded original error message contains any of:
   - `operation not permitted`
   - `permission denied`
   - `read-only file system`
   - `seccomp`
   - `sandbox`
   - `landlock`
   - `failed to write file`
4. Without a keyword match, return false for exit codes 2, 126, and 127.
5. Return true when the actual backend is `linux-seccomp` and either the recorded signal is `SIGSYS` or the existing exit code is `128 + SIGSYS`.
6. Otherwise return false.

The classifier does not inspect command text, generated footer text beyond the original Pi error, host platform, monitor health, or earlier attempts. Signal information is used directly for the SIGSYS branch; this feature does not change Pi's process exit-code normalization.

## Model-facing guidance

Guidance is appended only when:

- The final attributed attempt is an eligible command failure.
- Structured evidence or the fallback matches.
- `ctx.mode === "tui"`.
- `ctx.hasUI === true`.
- The sandbox remains enabled and initialized when the error is formatted.

Other modes retain and clean attempt state but receive the original error because the current escalation flow is unavailable there.

The thrown error message is the untouched original message followed once by this bounded block:

```text
--- pi-sandbox guidance ---
This sandboxed attempt appears to have failed because of a sandbox restriction and was not run outside pi-sandbox. If the command is still needed to complete the user's current request, make one new Bash tool call with `sandbox_permissions: "require_escalated"` and a concise user-facing `justification`. Do not wait for the user to request escalation separately; the approval prompt is where the user decides whether to allow it. If that escalation request is declined, cancelled, times out, or is unavailable, stop and do not request escalation again unless the user later explicitly asks.
```

Append suppression is deliberately narrow: suppress only when the original message already ends with the exact complete block above at the expected `\n\n` boundary. A stray `--- pi-sandbox guidance ---` elsewhere in the original text receives a complete trailing block. Reapplying the formatter is idempotent and the original message stays the exact prefix.

The result remains a tool error. Pi does not return an `AgentToolResult` for a failure, expose raw monitor data or credentials, claim certainty, suggest a broader command, or open an approval prompt. The current `Operation not permitted` conversion to a normal result is removed.

## Compatibility boundaries

- `createEscalatingBashToolDefinition`, `EscalationPrompt`, approval tracking, and elevated local execution are unchanged.
- The extension's existing sandbox enable/disable/shutdown booleans and routing remain unchanged.
- `user_bash` continues to use the existing handleless runtime wrapper, session proxy credential, SSH behavior, and cleanup path. It receives no model-facing guidance.
- Existing Git and ordinary SSH routing remains unchanged. Denials on unattributed legacy SSH traffic can still match the output heuristic.
- Existing external proxy behavior remains unchanged and produces no structured runtime evidence.
- No runtime API is removed, so unrelated Pi call sites do not migrate.

## Testing

### Classifier and formatting

- Match every keyword case-insensitively in the final error message.
- Never match a successful command.
- Reject exit codes 2, 126, and 127 without a keyword.
- Match `SIGSYS` only for an actual `linux-seccomp` descriptor.
- Reject unrelated failures and a `SIGSYS` observation under `linux-bwrap`.
- Prove structured evidence bypasses the fallback.
- Preserve the original error prefix and append exactly one guidance block.
- Do not suppress guidance merely because its header appears earlier in an error; suppress only an exact complete trailing block at the expected blank-line boundary.
- Preserve tool-error rather than normal-result semantics.

### Attempt and recovery flow

- Prepare and finish a distinct attempt for every spawned model Bash process.
- Keep concurrent identical commands isolated.
- Finish and drain attempt A before deciding whether to recover.
- Publish configuration with `updateConfig` and never reset for an ordinary grant.
- Use only attempt B's evidence when recovery runs.
- Add no guidance when B succeeds or when the user aborts the write prompt.
- Allow a configured `denyWrite` final failure to use the ordinary cautious decision.
- Finalize success, command failure, timeout, abort, and spawn-error attempts after existing cleanup.
- Treat Pi's `{ exitCode: null }` result after a direct signal as a local tool error built from Pi's retained output and `Command terminated by signal <SIGNAL>`.
- Treat preparation and finish failures as runtime errors without guidance or local fallback.
- Handle an already-aborted signal after preparation without spawning.
- Keep one unrelated active attempt attributable while another call publishes configuration and retries.
- Hold unrelated attempt X open while A completes, configuration is published, and B completes; then finish or abort X and prove X, A, and B have only their own handle-scoped summaries and publication never calls `SandboxManager.reset()`.

### Integration and compatibility

- Pass `true` through the existing runtime monitor-enable argument.
- Spawn the exact attributed descriptor argv and environment with `shell: false`.
- Preserve the descriptor's actual backend in the observation.
- Preserve streaming callbacks and existing timeout/abort behavior.
- Through `createBashToolDefinition`, prove that a signal-closing descriptor streams output and resolves Pi's installed `{ exitCode: null }` result, then the local adapter rejects with retained output, signal status, and exactly one guidance block for `linux-seccomp`/`SIGSYS`; prove a signal/backend case without evidence or fallback has no guidance.
- Use a real descriptor that exits 23 to prove retained output, `{ termination: "exit", exitCode: 23 }`, cleanup before finish, attempt finalization, and Pi rejection containing `Command exited with code 23`.
- Advance the network callback snapshot only after successful synchronous `updateConfig`.
- Leave `user_bash`, SSH routing, unauthenticated-SOCKS configuration, and explicit escalation approval unchanged.
- Show guidance only in TUI mode with UI while the sandbox is still active.
- Leave RPC, print, JSON, TUI without UI, and unrelated failures unchanged.

## Release sequencing

After the matching additive runtime API is published, install and pin its exact published version in both `package.json` and `pnpm-lock.yaml`; do not use `@latest` or invent an unpublished version number. No runtime API removal or broad Pi migration is part of this feature.

## Acceptance criteria

- Only the final process attempt can add escalation guidance.
- Concurrent identical commands and sequential recovery attempts cannot consume one another's evidence.
- Structured final-attempt evidence takes precedence over the fallback.
- The fallback uses only the final attempt's actual backend, exit/signal observation, and original error message.
- Permission recovery updates future macOS/Linux attempts without resetting runtime services or disrupting unrelated attribution.
- Final actionable failures remain tool errors with their original message plus one bounded block.
- Direct signal closures are correctly adapted from Pi's installed successful-null-exit result without changing Pi's process API.
- Success, timeout, abort, spawn, runtime, publication, finalization, prompt-abort, and unrelated failures receive no guidance.
- Existing explicit escalation approval, `user_bash`, SSH, cleanup, and session-lifecycle behavior remains intact.
- No reviewer-model or automatic escalation behavior is introduced.
