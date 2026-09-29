/**
 * Shell-escape an array of arguments into a single string that, when parsed
 * by a POSIX shell (`sh -c`, `bash -c`, `zsh -c`), yields exactly the
 * original argument list.
 *
 * This intentionally replaces the npm `shell-quote` package. Its quote()
 * switches to a double-quote + backslash strategy whenever an argument
 * contains a single quote, and in that mode it backslash-escapes `!` — a
 * guard against history expansion that only applies to *interactive*
 * shells. Every string this library produces is executed through a
 * non-interactive `<shell> -c`, where bash treats `\!` inside double quotes
 * as two literal characters (the backslash is NOT removed). The wrapped
 * user command almost always contains a single quote, so every `!` in it
 * reached the program corrupted to `\!`: heredoc-written source like
 * `if (!x)` became unparseable, and `jq 'a != b'`, `awk '!seen[$0]++'`,
 * and `find ! -name` filters were silently rewritten.
 *
 * Single-quoting never has that problem. Inside POSIX single quotes every
 * byte is literal, so nothing needs escaping; the only character that
 * needs handling is the single quote itself, emitted as the standard
 * `'"'"'` sequence (close the quote, a double-quoted `'`, reopen).
 *
 * @param args - The argument list to escape
 * @returns A single space-joined string safe to pass to `<shell> -c`
 */
export function quote(args: readonly string[]): string {
  return args
    .map(arg => {
      if (arg === '') {
        return "''"
      }
      // Bare fast path: nothing in this character set is special to a
      // POSIX shell (no whitespace, globs, expansions, quotes, or
      // operators), so the bare word re-parses to exactly itself. The one
      // position-sensitive case is a LEADING "=": zsh (a common binShell,
      // even non-interactive `zsh -c`) performs "equals expansion" on an
      // unquoted word starting with "=" (`=ls` becomes /bin/ls; an unknown
      // name aborts the whole command line), so such a word must be quoted.
      // "=" elsewhere in the word (NAME=value env assignments) is fine.
      if (/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(arg)) {
        return arg
      }
      return "'" + arg.replace(/'/g, `'"'"'`) + "'"
    })
    .join(' ')
}
