import { constants } from "node:os";

import {
  type SandboxBackend,
  type SandboxDenialSummary,
} from "@carderne/sandbox-runtime";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SandboxAttemptObservation {
  sandboxBackend: SandboxBackend;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  termination: "exit" | "signal" | "timeout" | "aborted" | "spawn-error";
}

export interface FinishedSandboxProcessAttempt {
  observation: SandboxAttemptObservation;
  denials: readonly SandboxDenialSummary[];
}

const DENIAL_KEYWORDS = [
  "operation not permitted",
  "permission denied",
  "read-only file system",
  "seccomp",
  "sandbox",
  "landlock",
  "failed to write file",
] as const;

export const PI_SANDBOX_GUIDANCE = `--- pi-sandbox guidance ---
This attempt appears to have failed because of a sandbox restriction. It was not retried outside the sandbox. If the command is necessary for the user's request, make a new Bash tool call with \`sandbox_permissions: "require_escalated"\` and a concise user-facing \`justification\`. Approval is still required.`;

export function isEligibleCommandFailure(observation: SandboxAttemptObservation): boolean {
  if (observation.termination === "exit") {
    return observation.exitCode !== null && observation.exitCode !== 0;
  }
  return observation.termination === "signal" && observation.signal !== null;
}

export function matchesSandboxDenialFallback(
  observation: SandboxAttemptObservation,
  originalErrorMessage: string,
): boolean {
  if (observation.sandboxBackend === "none") return false;
  if (!isEligibleCommandFailure(observation)) return false;
  const folded = originalErrorMessage.toLowerCase();
  if (DENIAL_KEYWORDS.some((keyword) => folded.includes(keyword))) return true;
  if (
    observation.exitCode === 2 ||
    observation.exitCode === 126 ||
    observation.exitCode === 127
  ) {
    return false;
  }
  return (
    observation.sandboxBackend === "linux-seccomp" &&
    (observation.signal === "SIGSYS" ||
      observation.exitCode === 128 + constants.signals.SIGSYS)
  );
}

export function hasSandboxDenialEvidence(
  observation: SandboxAttemptObservation,
  denials: readonly SandboxDenialSummary[],
  originalErrorMessage: string,
): boolean {
  if (!isEligibleCommandFailure(observation)) return false;
  if (denials.length > 0) return true;
  return matchesSandboxDenialFallback(observation, originalErrorMessage);
}

export function appendSandboxGuidance(original: Error): Error {
  if (original.message.endsWith(`\n\n${PI_SANDBOX_GUIDANCE}`)) return original;
  const guided = new Error(`${original.message}\n\n${PI_SANDBOX_GUIDANCE}`, { cause: original });
  guided.name = original.name;
  return guided;
}

export function shouldShowSandboxGuidance(
  mode: ExtensionContext["mode"],
  hasUI: boolean,
  sandboxActive: boolean,
): boolean {
  return mode === "tui" && hasUI && sandboxActive;
}
