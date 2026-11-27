# pi-sandbox

Sandbox for [pi](https://pi.dev/).

Sandboxes pi like this:
- read/write/edit: direct control using allow/deny lists
- bash: uses [`@carderne/sandbox-runtime`](https://www.npmjs.com/package/@carderne/sandbox-runtime) to control network and file system access

Blocked read/write/edit tool calls and detected network requests prompt for
temporary or permanent permission. Bash filesystem failures are returned without
automatically granting permissions or retrying the command.

![demo](./demo/demo.gif)

## Notes
There is an example config at [sandbox.json](./sandbox.json). It was quite a few things added to get this extension to work with [agent-browser](https://agent-browser.dev/) and other common tools.

These open significant security loopholes, so shouldn't be used in a sensitive context or when you don't need browser support.

You may need to trial and error to find additional things you need to allow.

## Quickstart

#### Prerequisites

`pi-sandbox` delegates the OS-level bash sandbox to
[`@carderne/sandbox-runtime`](https://www.npmjs.com/package/@carderne/sandbox-runtime),
published from the fork at <https://github.com/carderne/sandbox-runtime>,
which is forked from Anthropic's
[`anthropic-experimental/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).
The sandbox runtime checks for [`ripgrep`](https://github.com/BurntSushi/ripgrep) (the
`rg` binary) on **both macOS and Linux** at sandbox-init time. If `rg`
is not on the `PATH` that pi was launched with, sandbox initialization
fails with:

```
Sandbox initialization failed: Sandbox dependencies not available: ripgrep (rg) not found
```

Install ripgrep before enabling the extension:

| Platform | Install |
|---|---|
| macOS (Homebrew) | `brew install ripgrep` |
| macOS (MacPorts) | `sudo port install ripgrep` |
| Linux (Debian/Ubuntu) | `sudo apt install ripgrep` |
| Linux (Fedora/RHEL) | `sudo dnf install ripgrep` |
| Linux (Arch) | `sudo pacman -S ripgrep` |
| From source / other | <https://github.com/BurntSushi/ripgrep#installation> |

Experimental Android/Termux support uses the Linux backend and requires `ripgrep`,
`which`, `socat`, and a [compatible `bwrap`](https://gist.github.com/spurreiter/caa34d367b7ebbd82806a640bf41157a).
Support depends on the device's kernel and isolation capabilities.

If `which rg` succeeds in your shell but pi still reports `rg not
found`, pi is being launched from a parent process whose `PATH` does
not include the directory containing `rg` (common when GUI launchers
inherit a minimal non-login `PATH`). On macOS, `/opt/homebrew/bin` and
`/usr/local/bin` are the usual culprits — make sure your launcher's
environment includes whichever one your install uses.

#### Install
```bash
pi install npm:pi-sandbox
```

#### Configure
Add a config like this either to Pi's global agent directory (by default, `~/.pi/agent/sandbox.json`; respects `PI_CODING_AGENT_DIR`) or to `.pi/sandbox.json` (local).
The local config is loaded only when Pi trusts the project. Scalar settings in the local config take precedence over global settings. The
path and domain arrays from both files are combined and deduplicated, so a
project can add permissions without repeating the global configuration. Built-in
defaults are used for an array only when neither file configures it.

On Linux, glob patterns (`*`, `?`, `[...]`) in `allowWrite`/`denyWrite` cannot be
enforced for bash commands (bubblewrap binds concrete paths only), so they are
silently ignored there; use literal paths. A one-time warning is shown if your own
config adds such globs (built-in defaults are excluded). Direct read/write/edit
tools still honor globs on all platforms.

Note below that the order of precedence for filesystem read and write are opposite.

```json
{
  "enabled": true,
  "enableAccessRequestTool": false, // Enable sandbox_status and sandbox_request_access
  "sandboxUserShell": false,       // Sandbox commands entered with `!`. Defaults to true
  "permissionPromptTimeoutSeconds": 600, // Defaults to 10 minutes; 0 waits indefinitely
  "allowBrowserProcess": true,     // If you want to use agent-browser or similar Chrome setup
  "network": {
    "allowLocalBinding": true,     // ditto
    "allowAllUnixSockets": true,   // ditto
    "allowUnauthenticatedSocksProxy": true, // Enables Git-over-SSH on macOS
    "disabled": false,             // Set true for direct network access (no proxy/--unshare-net) while keeping filesystem sandboxing
    "allowSSHAgentSocket": true, // Allow the current SSH agent socket (macOS SSH commit signing)
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    // For READS:
    // - ANY read is prompted unless the path is in allowRead or allowWrite
    // - Granting a prompt adds to allowRead, which overrides denyRead
    // - denyRead is not a hard-block; it just marks regions as denied by default
    "denyRead": ["/Users", "/home"],
    "allowRead": [".", "~/.config", "~/.local", "Library"],

    // For WRITES:
    // - allowWrite also grants read access to the same paths
    // - empty ALLOW means no write access at all
    // - DENY takes precedence and is never prompted
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

#### Usage

```
pi --no-sandbox                  disable sandboxing for the session
Alt+S                            toggle sandboxing on/off for the session
/sandbox                         show current configuration and session allowances
/sandbox-enable                  enable the sandbox for this session
/sandbox-disable                 disable the sandbox for this session
/sandbox-allow domain <url>      prompt to add a domain to allowedDomains
/sandbox-allow read <path>       prompt to add a path to allowRead
/sandbox-allow write <path>      prompt to add a path to allowWrite
```

With `enableAccessRequestTool: true`, the agent can use `sandbox_status` to inspect
current rules, including session-only grants, and `sandbox_request_access` to ask
for additional access with a reason. Already-allowed requests do not prompt.
Approvals return the actual rule and scope to the agent, including any edits you
make in the permission prompt.

## What it does

**Bash commands** are wrapped with `sandbox-exec` (macOS) or `bubblewrap`
(Linux) to enforce network and filesystem restrictions at the OS level. Commands
entered with `!` are sandboxed by default; set `sandboxUserShell` to `false` to
leave those commands unsandboxed.

**Read, write, and edit tool calls** are intercepted before execution and
checked against the same filesystem policy. The OS-level sandbox cannot cover
these tools because they run directly in the Node.js process rather than in a
subprocess.

When a block is triggered, a permission widget appears above the input editor with
four options. Concurrent requests are queued per extension instance. The widget
accepts input while the main Pi editor (including `CustomEditor` subclasses) has
focus; other dialogs keep their own keyboard input, and permission selection
resumes when they close. Operation cancellation, sandbox disable, and session
shutdown abort pending requests without granting access. The input draft is left
untouched.

Focus inspection uses Pi's `getFocusedComponent()` when available and the
`focusedComponent` instance field on Pi 0.80. If neither is available, the request
fails rather than intercepting input without knowing which dialog owns it.

Permission prompts automatically select **Abort (keep blocked)** after 10 minutes
by default. Set
`permissionPromptTimeoutSeconds` to a positive number to use a different timeout,
or set it to `0` to wait indefinitely. A timeout never grants permission.

- Abort (keep blocked)
- Allow for this session only
- Allow for this project — written to `.pi/sandbox.json`
- Allow for all projects — written to Pi's global agent directory (by default, `~/.pi/agent/sandbox.json`; respects `PI_CODING_AGENT_DIR`)

**Session allowances** are held in memory only. They are never written to disk
and the agent has no way to read or modify them. They are reset when the
extension reloads or pi restarts. Parent agents and subagents have separate
sandbox managers and session allowances; shutting down one does not affect another.

Saved project or global permission changes are not broadcast to other running
sessions' sandbox managers. Restart affected sessions to apply grants or revocations
consistently.

### What is prompted vs. hard-blocked

| Rule | Behaviour |
|------|-----------|
| Domain not in `allowedDomains` | Prompted (bash and `!cmd`, unless `sandboxUserShell` is disabled) |
| Path not in `allowRead` or `allowWrite` | Prompted (read tool); granting adds to `allowRead` |
| Path not in `allowWrite` | Prompted (write/edit tools) |
| Path in `denyWrite` | Hard-blocked, no prompt |
| Domain in `deniedDomains` | Hard-blocked at OS level, no prompt |

Bash filesystem errors do not identify whether a read, write, or execution was
blocked. In particular, `Operation not permitted` does not imply a write failure,
and `command not found` can mean an executable is unreadable inside the sandbox.
Use `/sandbox-allow read <path>` or `/sandbox-allow write <path>` after identifying
the required access, then rerun the command explicitly. Retrying automatically
could repeat side effects from commands that partially completed.

If a path is added to `allowWrite` via a prompt but is also present in
`denyWrite`, it remains blocked. A warning is shown explaining which config
files to check.

`allowedDomains` supports `*.example.com` wildcards. It also supports `"*"` to
allow all domains; pi-sandbox shows a warning when this is configured because it
removes per-domain prompts and can be easy to add accidentally. `allowWrite` uses prefix
matching, so `.` covers the entire current working directory. Write access also
implies read access; paths do not need to be repeated in `allowRead`.

`allowUnauthenticatedSocksProxy` is enabled by default on macOS so Git-over-SSH
works with the built-in `nc`. Domain filtering still applies, but another local process
that discovers the temporary proxy port can use it while the sandbox is running.

`network.disabled` turns off network sandboxing entirely: no `--unshare-net` and
no proxy, so the sandboxed process gets direct network access via the host's
routing, DNS, and VPN. Filesystem sandboxing is unaffected. This is useful for
tools that don't honour `HTTP(S)_PROXY`/`ALL_PROXY`, mTLS/gRPC/WebSocket edge
cases, or local-network access. It is opt-in and reduces protection — `allowedDomains`
filtering no longer applies when set.

`allowSSHAgentSocket` is disabled by default. When enabled, pi-sandbox resolves
`SSH_AUTH_SOCK` to a real path when the sandbox is built and adds that path to
`allowUnixSockets` only if it is an existing Unix socket. This is intended for the
macOS system ssh-agent, whose path changes every boot and whose `/var` location is
a symlink to `/private/var`. Existing `allowUnixSockets` entries are kept. Prefer
this over allowing `/private/var/run` or setting `allowAllUnixSockets`. The option
has no effect when `SSH_AUTH_SOCK` is unset, missing, or not a socket. On Linux,
this setting alone does not make the SSH agent usable.

> **⚠️ Read and write have different precedence rules:**
>
> - **Read:** Every read is prompted unless the path is in `allowRead` or `allowWrite`.
>   `denyRead` is not a hard-block — it marks regions as denied by default, but
>   granting a prompt adds the path to `allowRead`, overriding `denyRead`.
> - **Write:** `denyWrite` takes precedence over `allowWrite` and is never
>   prompted. A path in `denyWrite` is always blocked, even if it matches
>   `allowWrite`.

If neither file configures an array, its built-in defaults apply (see above for
the defaults). Once an array is configured, only its combined global and local
entries are used, so an explicit empty array disables that default.

The footer shows a lock indicator while the sandbox is active.

## Ackowledgements
Based on code from
[badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
by Mario Zechner, used under the
[MIT License](https://github.com/badlogic/pi-mono/blob/main/LICENSE).
