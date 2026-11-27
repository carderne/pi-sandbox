import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export function decideWritePolicy(
  path: string,
  allowWrite: string[],
  denyWrite: string[],
  baseCwd: string = process.cwd(),
) {
  if (matchesPattern(path, denyWrite, baseCwd)) return "deny";
  if (allowWrite.length === 0 || !matchesPattern(path, allowWrite, baseCwd)) return "prompt";
  return "allow";
}

/**
 * Read access follows the same precedence as the OS sandbox: the most specific
 * matching rule wins, and allowRead wins a tie. A denyRead entry inside an
 * allowed area (`.env` under `.`) is a hard deny; a broad one (`/Users`) only
 * means "not allowed", so paths outside every allow list are still prompted.
 */
export function decideReadPolicy(
  path: string,
  allowRead: string[],
  denyRead: string[],
  baseCwd: string = process.cwd(),
): "allow" | "deny" | "prompt" {
  const specificity = (patterns: string[]) =>
    Math.max(
      -1,
      ...patterns
        .filter((pattern) => matchesPattern(path, [pattern], baseCwd))
        .map((pattern) => patternSpecificity(pattern, baseCwd)),
    );
  const allow = specificity(allowRead);
  if (allow < 0) return "prompt";
  return specificity(denyRead) > allow ? "deny" : "allow";
}

/** Depth of a pattern's fixed part; a glob ranks above its own base directory. */
function patternSpecificity(pattern: string, baseCwd: string): number {
  const depth = (path: string) => path.split("/").filter(Boolean).length;
  if (!pattern.includes("*")) return 2 * depth(canonicalizePath(pattern, baseCwd));
  const segments = resolveGlobPattern(pattern, baseCwd).at(-1)!.split("/");
  const base = segments.slice(
    0,
    segments.findIndex((segment) => segment.includes("*")),
  );
  return 2 * depth(base.join("/")) + 1;
}

export async function resolveWritePermission({
  path,
  allowWrite,
  denyWrite,
  baseCwd,
  prompt,
}: {
  path: string;
  allowWrite: string[];
  denyWrite: string[];
  baseCwd?: string;
  /** Shows the prompt and saves any grant; "allowed" means an earlier grant covers the path. */
  prompt: (path: string) => Promise<{
    action: "abort" | "allowed" | "session" | "project" | "global";
    value: string;
  }>;
}) {
  const policy = decideWritePolicy(path, allowWrite, denyWrite, baseCwd);
  if (policy !== "prompt") return { action: policy };

  const choice = await prompt(path);
  if (choice.action === "abort") return { action: "abort", value: choice.value };
  if (choice.action === "allowed") return { action: "allow" };
  return { action: "granted", value: choice.value };
}

/**
 * Extract hosts from literal http(s) URLs in a command, skipping userinfo
 * (`user:pass@`) and lowercasing. Hosts built from shell expansions
 * (`https://$HOST/`), single-label names (`localhost`) and IPv6 literals are
 * skipped; the OS sandbox proxy still enforces whatever is connected to.
 */
export function extractDomainsFromCommand(command: string): string[] {
  // The host is the leading run of hostname characters, so trailing shell
  // punctuation (`,` `;` `&&` `)`) ends it. A host that runs into `$`, `{`, `%`
  // or `_` is being built by an expansion and its real value is unknown.
  const urlRegex = /https?:\/\/(?:[^\s/?#@]*@)?([a-z0-9.-]+)(?![\w$%{.-])/gi;
  const domains = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(command)) !== null) {
    const host = match[1]!.toLowerCase().replace(/\.+$/, "");
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) domains.add(host);
  }
  return [...domains];
}

export function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const host = domain.toLowerCase();
  const rule = pattern.toLowerCase();
  if (rule.startsWith("*.")) {
    const base = rule.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === rule;
}

export function allowsAllDomains(allowedDomains: string[] | undefined): boolean {
  return allowedDomains?.includes("*") ?? false;
}

export function domainIsAllowed(domain: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((pattern) => domainMatchesPattern(domain, pattern));
}

function expandPath(filePath: string, baseCwd: string = process.cwd()): string {
  // Relative entries resolve against the session cwd (baseCwd), not the pi
  // process cwd — these can differ when pi is embedded in a host process
  // (e.g. the pi-web UI) whose cwd is not the project directory.
  return resolve(baseCwd, filePath.replace(/^~(?=$|\/)/, homedir()));
}

export function canonicalizePath(filePath: string, baseCwd: string = process.cwd()): string {
  const absolutePath = expandPath(filePath, baseCwd);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    const tail: string[] = [];
    let probe = absolutePath;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return absolutePath;
      tail.unshift(basename(probe));
      probe = parent;
    }
    try {
      return resolve(realpathSync.native(probe), ...tail);
    } catch {
      return absolutePath;
    }
  }
}

// Resolve a glob pattern to absolute form without expanding it.
//
// A glob without a "/" matches at any depth below baseCwd, like .gitignore
// (`*.pem` becomes `<cwd>/**/*.pem`); other globs are anchored at baseCwd. The
// static prefix before the first glob segment is returned both as written and
// with symlinks resolved, since paths are compared in canonical form and
// `/tmp` and `/var` are symlinks into `/private` on macOS.
export function resolveGlobPattern(pattern: string, baseCwd: string = process.cwd()): string[] {
  const absolute = expandPath(pattern.includes("/") ? pattern : `**/${pattern}`, baseCwd);
  const segments = absolute.split("/");
  const firstGlob = segments.findIndex((segment) => segment.includes("*"));
  const prefix = segments.slice(0, firstGlob).join("/") || "/";
  const canonicalPrefix = canonicalizePath(prefix, baseCwd);
  const canonical = [canonicalPrefix.replace(/\/$/, ""), ...segments.slice(firstGlob)].join("/");
  return canonical === absolute ? [absolute] : [absolute, canonical];
}

const GLOB_REGEX: Record<string, string> = {
  "**/": "(.*/)?",
  "**": ".*",
  "*": "[^/]*",
  "?": "[^/]",
};

/** Mirrors the sandbox runtime's globToRegex: `*` stays within a segment, `**` crosses them. */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.^$+{}()|\\]/g, "\\$&")
    .replace(/\[([^\]]*?)$/g, "\\[$1")
    .replace(/\*\*\/|\*\*|\*|\?/g, (token) => GLOB_REGEX[token]!);
  return new RegExp(`^${source}$`);
}

export function matchesPattern(
  filePath: string,
  patterns: string[],
  baseCwd: string = process.cwd(),
): boolean {
  const absolutePath = canonicalizePath(filePath, baseCwd);
  return patterns.some((pattern) => {
    if (pattern.includes("*")) {
      return resolveGlobPattern(pattern, baseCwd).some((glob) =>
        globToRegExp(glob).test(absolutePath),
      );
    }
    const absolutePattern = canonicalizePath(pattern, baseCwd);
    const separator = absolutePattern.endsWith("/") ? "" : "/";
    return absolutePath === absolutePattern || absolutePath.startsWith(absolutePattern + separator);
  });
}
