export function shouldPromptForWrite(path: string, allowWrite: string[], matchesPattern: (path: string, patterns: string[]) => boolean): boolean {
  // Secure default: empty allowWrite means deny-all writes (prompt every path).
  return allowWrite.length === 0 || !matchesPattern(path, allowWrite);
}
