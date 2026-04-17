---
name: sudo-password-handling
description: Cross-platform sudo password handling in TUI applications — macOS and Linux pitfalls, input handling, and proven patterns.
---

# Sudo Password Handling in TUI Apps

## Proven Approach

**Run first, detect failure, show TUI dialog.** Do NOT pre-check with `sudo -n true` — it's unreliable and can hang.

```
sudo command → executeShellCommand("sudo <cmd>")  // no -S, no password
  → fails on both platforms
  → isSudoAuthFailure(result) detects the failure
  → show TUI password dialog
  → user enters password
  → validateSudoPassword (sudo -k true with piped password)
  → runCommandBlock(block, password) with sudo -S
```

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

### 4. Pass password to command execution, don't rely on sudo cache

After `validateSudoPassword` (which runs `sudo -k true`), the sudo credential is cached. But:
- Don't clear `sessionSudoPassword` before running the command
- Pass `password` to `runCommandBlock(block, password)` so it uses `sudo -S`
- Without `-S`, sudo falls back to native prompt on cache expiry

### 5. Remove native OS prompt fallback for consistent UX

`stdin: 'inherit'` hands control to the OS native prompt (GUI dialog on macOS, terminal prompt on Linux). For TUI apps, always use piped password with `sudo -S`.

## Code Locations

- `src/shell.ts`: `executeCommand` — handles `sudo -S` transformation and password piping
- `src/ui/approval.ts`: `isSudoAuthFailure` — failure detection, `runCommandBlockWithSudoRetry` — retry flow
- `src/app.ts`: sudo password dialog keyboard handler (lines ~770-790)
