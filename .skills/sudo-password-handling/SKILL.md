---
name: sudo-password-handling
description: Cross-platform sudo password handling in TUI applications — macOS and Linux pitfalls, input handling, and proven patterns.
---

# Sudo Password Handling in TUI Apps

## Proven Approach

**Run first, detect failure, show TUI dialog.** Do NOT pre-check with `sudo -n true` — it's unreliable and can short-circuit the cache.

```
# First attempt: use cached sessionSudoPassword if available
runCommandBlockWithSudoRetry(block)
  → password = sessionSudoPassword ?? null
  → sudo -S -p '' <cmd>  (with piped password if set, else no stdin)
  → fails auth
    → sudoRetryCount++ (becomes 1)
    → show TUI dialog (NO "Incorrect password" message yet)
    → user enters password
    → runCommandBlockWithSudoRetry(block, password)  # isRetry=true
    → sudo -S -p '' <cmd> with piped password
    → fails auth again
      → sudoRetryCount++ (becomes 2)
      → show TUI dialog WITH "Incorrect password" message
      → user enters correct password
      → succeeds → sessionSudoPassword = password, sudoRetryCount = 0
    → succeeds → sessionSudoPassword = password, sudoRetryCount = 0
  → succeeds (no password needed or cached creds)
    → sessionSudoPassword stays null
```

**macOS**: native Touch ID/password dialog — run `sudo <cmd>` directly (no `-S`, no piped stdin). sudo uses its own credential cache.

**Linux**: TUI modal + `sudo -S` with piped stdin. `sudo -S` with piped stdin works reliably on Linux (unlike macOS where it hangs).

## Critical Pitfalls

### 1. `isSudoAuthFailure` must match platform-specific error messages

macOS and Linux produce DIFFERENT error messages when sudo can't read a password:

| Platform | Error message |
|----------|--------------|
| macOS | `sudo: a password is required` |
| Linux (requiretty) | `sudo: a terminal is required to read the password` |
| Wrong password | `Sorry, try again` / `incorrect password` |

If `isSudoAuthFailure` doesn't match, the failure is silently treated as success. Include ALL these patterns.

### 2. Never rely on `sudo -n true` to pre-check password requirements

- Can behave differently with `requiretty` configurations
- Spawns a subprocess that adds latency and failure modes
- Synchronous check (`!sessionSudoPassword`) is simpler and always correct

### 3. Linux Kitty keyboard protocol sends characters as escape sequences

The pattern `!sequence.includes('\x1b')` blocks ALL character input on Linux because Kitty protocol encodes regular characters as escape sequences (e.g., `\x1b[97u` for 'a').

**Fix**: Use `!isEscape(sequence)` instead — only blocks the actual Escape key.

## Cross-Response Caching

`sessionSudoPassword` must survive across LLM responses. Only clear it on:
- **Auth failure** (user entered wrong password — allow retry with correct one)
- **'x' action** (explicit skip — user chose not to proceed)
- **Session end**

NEVER clear `sessionSudoPassword` in:
- `maybeQueueCommandExecution` (fires on each new LLM response)
- 'y' or 'n' action handlers after a successful sudo

## Code Locations

- `src/ui/approval.ts`: `isSudoAuthFailure` — failure detection; `runCommandBlockWithSudoRetry` — retry flow with `sudo -S`; `handleSudoPasswordConfirm` — TUI password handler; `renderSudoPasswordDialog` — password dialog rendering; `sudoRetryCount` — retry counter (only > 1 shows "Incorrect password")
- `src/shell.ts`: `executeShellCommand` — runs sudo with `-S` and piped stdin
- `src/app.ts`: sudo keyboard handler and state management

## Platform Differences

- **macOS**: `sudo -S` hangs when stdin is a pipe (sudo tries to read from tty first). Run `sudo <cmd>` directly and let native auth dialog handle it.
- **Linux**: `sudo -S` with piped stdin works correctly. No native dialog — always use TUI modal.
- **Both**: `sudo -k` hangs when stdin is a pipe — do NOT use `sudo -k` for validation.
