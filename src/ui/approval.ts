/**
 * Approval dialog and shell command execution for TUIApp.
 *
 * Encapsulates approval dialog state, rendering, and shell command execution.
 */

import { stringToStyledText } from "@opentui/core";
import { platform } from "process";
import {
  detectCodeBlocks,
  executeCommand as executeShellCommand,
  formatCommandResult,
  type CommandBlock,
  type CommandResult,
} from "../shell";
import { approvalActions, type ApprovalActionKey } from "../input-utils";
import type { MutableBoxNode, MutableTextNode, MutableInputNode } from "./tui-types";

// ── State ────────────────────────────────────────────────────────────────────

export interface PendingExecution {
  blocks: CommandBlock[];
  index: number;
  mode: 'ask' | 'allow-all' | 'reject-all';
}

export interface ApprovalState {
  pendingExecution: PendingExecution | null;
  approvalDraftText: string;
  approvalDraftCursorOffset: number;
  approvalSelectionIndex: number;
  approvalActionInFlight: boolean;
  sudoPasswordInputText: string;
  sudoPasswordCursorOffset: number;
  /** Session-level cached sudo password for the current approval batch */
  sessionSudoPassword: string | null;
  /** Sudo password prompt state (password not yet collected) */
  sudoPasswordPrompt: { command: string; index: number } | null;
  /** Password retry attempt counter */
  sudoRetryCount: number;
  /** Last key character for debouncing duplicate events on Linux */
  sudoLastKeyChar: string;
  /** Timestamp of last key event for debouncing */
  sudoLastKeyAt: number;
}

export function createApprovalState(): ApprovalState {
  return {
    pendingExecution: null,
    approvalDraftText: '',
    approvalDraftCursorOffset: 0,
    approvalSelectionIndex: 0,
    approvalActionInFlight: false,
    sudoPasswordInputText: '',
    sudoPasswordCursorOffset: 0,
    sessionSudoPassword: null,
    sudoPasswordPrompt: null,
    sudoRetryCount: 0,
    sudoLastKeyChar: '',
    sudoLastKeyAt: 0,
  };
}

// ── Host interface ───────────────────────────────────────────────────────────

export interface ActiveShellCommand {
  command: string;
  proc: ReturnType<typeof Bun.spawn>;
  interrupted: boolean;
  interruptStage: 0 | 1 | 2 | 3;
  escalationTimer?: ReturnType<typeof setTimeout>;
}

export interface IApprovalHost {
  state: ApprovalState;
  activeShellCommand: ActiveShellCommand | null;
  setActiveShellCommand(cmd: ActiveShellCommand | null): void;
  inputBuffer: string;
  setInputBuffer(value: string): void;

  addMsg(text: string, color: string): void;
  renderStatusBar(): void;
  updateFooterLayout(): void;
  pauseRenderer(): void;
  resumeRenderer(): void;

  // UI nodes
  approvalDialogNode: MutableBoxNode;
  approvalDialogTextNode: MutableTextNode;
  inputNode: MutableInputNode;
  root: { requestRender(): void };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function formatApprovalDialogCommand(block: CommandBlock): string {
  return block.code
    .split('\n')
    .map(line => `$ ${line}`)
    .join('\n');
}

function isAffirmativeAnswer(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return ['y', 'yes'].includes(normalized);
}

function isNegativeAnswer(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return ['n', 'no'].includes(normalized);
}

function isAllowAllAnswer(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return ['a', 'all', 'yes-all', 'allow-all'].includes(normalized);
}

function isRejectAllAnswer(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return ['x', 'none', 'no-all', 'reject-all'].includes(normalized);
}

// ── Sudo helpers ─────────────────────────────────────────────────────────────

/** Returns true if the command starts with 'sudo ' (handles leading whitespace) */
export function isSudoCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.startsWith('sudo ') || trimmed.startsWith('sudo\t');
}

/**
 * Returns true if the result looks like a sudo authentication failure.
 * Matches common sudo password rejection patterns.
 */
export function isSudoAuthFailure(result: CommandResult): boolean {
  if (result.exitCode !== 1) return false;
  const combined = (result.stderr + '\n' + result.stdout).toLowerCase();
  return (
    combined.includes('incorrect password') ||
    combined.includes('sorry, try again') ||
    combined.includes('incorrect sudo password') ||
    combined.includes('password verification failed') ||
    combined.includes('authentication failure') ||
    combined.includes('a password is required') ||
    combined.includes('terminal is required')
  );
}

// ── Manager class ────────────────────────────────────────────────────────────

export class ApprovalManager {
  constructor(private host: IApprovalHost) {}

  // ── State accessors ──────────────────────────────────────────────────────

  get pendingExecution(): PendingExecution | null { return this.host.state.pendingExecution; }
  set pendingExecution(v: PendingExecution | null) { this.host.state.pendingExecution = v; }
  get approvalDraftText(): string { return this.host.state.approvalDraftText; }
  set approvalDraftText(v: string) { this.host.state.approvalDraftText = v; }
  get approvalDraftCursorOffset(): number { return this.host.state.approvalDraftCursorOffset; }
  set approvalDraftCursorOffset(v: number) { this.host.state.approvalDraftCursorOffset = v; }
  get approvalSelectionIndex(): number { return this.host.state.approvalSelectionIndex; }
  set approvalSelectionIndex(v: number) { this.host.state.approvalSelectionIndex = v; }
  get approvalActionInFlight(): boolean { return this.host.state.approvalActionInFlight; }
  set approvalActionInFlight(v: boolean) { this.host.state.approvalActionInFlight = v; }
  get sudoPasswordInputText(): string { return this.host.state.sudoPasswordInputText; }
  set sudoPasswordInputText(v: string) { this.host.state.sudoPasswordInputText = v; }
  get sudoPasswordCursorOffset(): number { return this.host.state.sudoPasswordCursorOffset; }
  set sudoPasswordCursorOffset(v: number) { this.host.state.sudoPasswordCursorOffset = v; }
  get sessionSudoPassword(): string | null { return this.host.state.sessionSudoPassword; }
  set sessionSudoPassword(v: string | null) { this.host.state.sessionSudoPassword = v; }
  get sudoPasswordPrompt(): { command: string; index: number } | null { return this.host.state.sudoPasswordPrompt; }
  set sudoPasswordPrompt(v: { command: string; index: number } | null) { this.host.state.sudoPasswordPrompt = v; }
  get sudoRetryCount(): number { return this.host.state.sudoRetryCount; }
  set sudoRetryCount(v: number) { this.host.state.sudoRetryCount = v; }
  get activeShellCommand(): ActiveShellCommand | null { return this.host.activeShellCommand; }
  set activeShellCommand(v: ActiveShellCommand | null) { this.host.setActiveShellCommand(v); }

  // ── Dialog visibility ────────────────────────────────────────────────────

  hideApprovalDialog(): void {
    this.host.approvalDialogNode.visible = false;
    this.host.approvalDialogTextNode.content = stringToStyledText('');
    this.host.updateFooterLayout();
    this.host.root.requestRender();
    this.host.inputNode.focus();
  }

  restoreApprovalDraft(): void {
    if (this.host.inputNode.plainText !== this.host.state.approvalDraftText) {
      this.host.inputNode.setText(this.host.state.approvalDraftText);
    }
    if (typeof this.host.inputNode.cursorOffset === 'number') {
      this.host.inputNode.cursorOffset = Math.max(0, Math.min(this.host.state.approvalDraftCursorOffset, this.host.state.approvalDraftText.length));
    }
    this.host.setInputBuffer(this.host.state.approvalDraftText);
    this.host.inputNode.focus();
  }

  clearSudoPasswordInput(): void {
    this.host.state.sudoPasswordInputText = '';
    this.host.state.sudoPasswordCursorOffset = 0;
    this.host.setInputBuffer('');
    this.host.inputNode.setText('');
    if (typeof this.host.inputNode.cursorOffset === 'number') {
      this.host.inputNode.cursorOffset = 0;
    }
  }

  getSudoPasswordMask(): string {
    const masked = '*'.repeat(this.host.state.sudoPasswordInputText.length);
    const cursor = Math.max(0, Math.min(this.host.state.sudoPasswordCursorOffset, masked.length));
    return `${masked.slice(0, cursor)}|${masked.slice(cursor)}`;
  }

  renderApprovalDialog(): void {
    if (!this.host.state.pendingExecution) {
      this.hideApprovalDialog();
      return;
    }

    const block = this.host.state.pendingExecution.blocks[this.host.state.pendingExecution.index];
    const ordinal = this.host.state.pendingExecution.blocks.length > 1
      ? ` (${this.host.state.pendingExecution.index + 1}/${this.host.state.pendingExecution.blocks.length})`
      : '';

    const actionsLine = approvalActions
      .map((action, index) => {
        const label = `${action.key.toUpperCase()}: ${action.label}`;
        return index === this.host.state.approvalSelectionIndex ? `[ ${label} ]` : `  ${label}  `;
      })
      .join('   ');
    const dialogWidth = 54;
    const padding = Math.max(0, Math.floor((dialogWidth - actionsLine.length) / 2));
    const paddedActions = `${' '.repeat(padding)}${actionsLine}`;

    this.host.approvalDialogTextNode.content = stringToStyledText(
      `Shell command detected${ordinal}\n\n${formatApprovalDialogCommand(block)}\n\n${paddedActions}\n\nUse left/right to choose, Enter to confirm`
    );
    this.host.approvalDialogNode.visible = true;
    this.host.updateFooterLayout();
    if (this.host.inputNode.blur) {
      this.host.inputNode.blur();
    }
    this.host.root.requestRender();
  }

  // ── Sudo password dialog ─────────────────────────────────────────────────

  /**
   * Prompt for sudo password using the approval dialog area.
   * The password is captured via the chat input (host.inputNode) and
   * never enters the chat message history.
   */
  renderSudoPasswordDialog(): void {
    if (!this.host.state.sudoPasswordPrompt) return;

    const { command, index } = this.host.state.sudoPasswordPrompt;
    const ordinal = this.host.state.pendingExecution &&
      this.host.state.pendingExecution.blocks.length > 1
      ? ` (${index + 1}/${this.host.state.pendingExecution.blocks.length})`
      : '';
    const retryHint = this.host.state.sudoRetryCount > 1
      ? `\nIncorrect password. Please try again.`  : '';
    const maskedPassword = this.getSudoPasswordMask();

    this.host.approvalDialogTextNode.content = stringToStyledText(
      `Sudo requires password${ordinal}${retryHint}\n\n${formatApprovalDialogCommand({ code: command, language: 'shell', fullMatch: command })}\n\nPassword: ${maskedPassword}\n\nPress Enter to continue\nEsc to cancel${retryHint}`
    );
    this.host.approvalDialogNode.visible = true;
    this.host.updateFooterLayout();
    if (this.host.inputNode.blur) {
      this.host.inputNode.blur();
    }
    this.host.root.requestRender();
  }

  promptPendingSudoExecution(): void {
    this.clearSudoPasswordInput();
    this.host.state.approvalSelectionIndex = 0;
    this.host.state.sudoLastKeyChar = '';
    this.host.state.sudoLastKeyAt = 0;
    this.renderSudoPasswordDialog();
  }

  promptPendingExecution(resetSelection = true): void {
    this.host.state.approvalDraftText = this.host.inputNode.plainText;
    this.host.state.approvalDraftCursorOffset = typeof this.host.inputNode.cursorOffset === 'number'
      ? this.host.inputNode.cursorOffset
      : this.host.state.approvalDraftText.length;
    if (resetSelection) {
      this.host.state.approvalSelectionIndex = 0;
    }
    this.renderApprovalDialog();
  }

  // ── Command execution ────────────────────────────────────────────────────

  async runCommandBlock(block: CommandBlock, password?: string, interactive = false): Promise<CommandResult> {
    this.host.addMsg(`$ ${block.code}`, '#00ff88');
    let shellCommandRef: ActiveShellCommand | undefined;
    let result: CommandResult;
    try {
      if (interactive) {
        this.host.pauseRenderer();
      }
      result = await executeShellCommand(block.code, {
        password,
        interactive,
        onStart: (proc) => {
          shellCommandRef = {
            command: block.code,
            proc,
            interrupted: false,
            interruptStage: 0,
          };
          this.host.setActiveShellCommand(shellCommandRef);
          this.host.renderStatusBar();
        },
      });
    } finally {
      if (interactive) {
        this.host.resumeRenderer();
      }
    }
    if (shellCommandRef?.escalationTimer) {
      clearTimeout(shellCommandRef.escalationTimer);
    }
    if (shellCommandRef && shellCommandRef.interrupted) {
      result.interrupted = true;
    }
    if (this.host.activeShellCommand?.command === block.code) {
      this.host.setActiveShellCommand(null);
    }
    for (const line of formatCommandResult(result).split('\n')) {
      this.host.addMsg(line, result.exitCode === 0 ? '#888888' : '#ff4444');
    }
    return result;
  }

  /**
   * Runs a sudo command with session-level password caching and
   * automatic retry on authentication failure.
   *
   * @param passwordForRetry - If provided, this is a re-run after the user entered
   *   a password in the TUI dialog. Run with -S and the piped password to verify it.
   *   If undefined, this is the first attempt — use sessionSudoPassword if cached
   *   from a prior sudo in the same batch. If sessionSudoPassword is also null/undefined,
   *   run without password; if sudo auth fails, isSudoAuthFailure shows the TUI dialog.
   */
  async runCommandBlockWithSudoRetry(block: CommandBlock, passwordForRetry?: string): Promise<boolean> {
    const isRetry = passwordForRetry !== undefined;
    // On retry (TUI dialog re-run): use the password the user just entered.
    // On first attempt: use sessionSudoPassword if cached from a prior sudo.
    // If sessionSudoPassword is null/undefined, run without password — if sudo
    // needs a password it'll fail and isSudoAuthFailure will prompt the TUI dialog.
    let password = isRetry ? passwordForRetry : this.host.state.sessionSudoPassword;

    let shellCommandRef: ActiveShellCommand | undefined;
    const result = await executeShellCommand(block.code, {
      password: password ?? undefined,
      onStart: (proc) => {
        shellCommandRef = {
          command: block.code,
          proc,
          interrupted: false,
          interruptStage: 0,
        };
        this.host.setActiveShellCommand(shellCommandRef);
        this.host.renderStatusBar();
      },
    });

    if (shellCommandRef?.escalationTimer) {
      clearTimeout(shellCommandRef.escalationTimer);
    }
    if (shellCommandRef && shellCommandRef.interrupted) {
      result.interrupted = true;
    }
    if (this.host.activeShellCommand?.command === block.code) {
      this.host.setActiveShellCommand(null);
    }

    if (!isSudoAuthFailure(result)) {
      // Command succeeded (correct password or no password needed).
      // Cache the password so subsequent sudo commands in the same batch use it.
      if (isRetry && passwordForRetry) {
        this.host.state.sessionSudoPassword = passwordForRetry;
      }
      // Format and display result normally
      for (const line of formatCommandResult(result).split('\n')) {
        this.host.addMsg(line, result.exitCode === 0 ? '#888888' : '#ff4444');
      }
      return true;
    }

    // Auth failure — prompt for new password
    this.host.state.sessionSudoPassword = null; // clear stale cache
    this.host.state.sudoRetryCount++;
    this.sudoPasswordPrompt = {
      command: block.code,
      index: this.host.state.pendingExecution?.index ?? 0,
    };
    this.host.renderStatusBar(); // update to reflect password prompt state
    this.promptPendingSudoExecution();
    return false;
  }

  async validateSudoPassword(password: string): Promise<boolean> {
    // Use `sudo -S true` to force sudo to read the password from stdin (-S flag).
    // On macOS with cached credentials, sudo -k would bust the cache but hangs when
    // stdin is a pipe (it tries to read a password). Instead, run `sudo -S true`
    // with the piped password — a wrong password causes sudo to immediately fail
    // reading from stdin (it doesn't fall back to cached credentials for -S).
    // A correct password succeeds. The command runs under bash -c with piped stdin.
    let shellCommandRef: ActiveShellCommand | undefined;
    const result = await executeShellCommand('sudo -S true', {
      password,
      onStart: (proc) => {
        shellCommandRef = {
          command: 'sudo -S true',
          proc,
          interrupted: false,
          interruptStage: 0,
        };
        this.host.setActiveShellCommand(shellCommandRef);
        this.host.renderStatusBar();
      },
    });

    if (shellCommandRef?.escalationTimer) {
      clearTimeout(shellCommandRef.escalationTimer);
    }
    if (shellCommandRef && shellCommandRef.interrupted) {
      result.interrupted = true;
    }
    if (this.host.activeShellCommand?.command === 'sudo -S true') {
      this.host.setActiveShellCommand(null);
    }

    return result.exitCode === 0;
  }

  advancePendingExecution(): void {
    if (!this.host.state.pendingExecution) {
      return;
    }

    this.host.state.pendingExecution = this.host.state.pendingExecution.index + 1 < this.host.state.pendingExecution.blocks.length
      ? { ...this.host.state.pendingExecution, index: this.host.state.pendingExecution.index + 1 }
      : null;
  }

  async handleExecutionApproval(action: ApprovalActionKey): Promise<void> {
    if (!this.host.state.pendingExecution || this.host.state.approvalActionInFlight) {
      return;
    }
    this.host.state.approvalActionInFlight = true;

    try {
      if (action === 'a') {
        this.host.state.pendingExecution.mode = 'allow-all';
        this.hideApprovalDialog();
        this.host.addMsg('Executing remaining commands.', '#888888');
        while (this.host.state.pendingExecution) {
          const block = this.host.state.pendingExecution.blocks[this.host.state.pendingExecution.index];
          if (isSudoCommand(block.code)) {
            if (platform === 'darwin') {
              // macOS: native dialog handles auth, no TUI modal
              await this.runCommandBlock(block);
            } else {
              // Linux: run-first pattern — execute without pre-check; if auth fails,
              // runCommandBlockWithSudoRetry shows the TUI password dialog.
              const ok = await this.runCommandBlockWithSudoRetry(block);
              if (!ok) return; // password dialog shown — wait for user input
            }
          } else {
            await this.runCommandBlock(block);
          }
          this.advancePendingExecution();
        }
        this.restoreApprovalDraft();
        this.host.renderStatusBar();
        return;
      }

      if (action === 'x') {
        this.hideApprovalDialog();
        this.host.addMsg('Skipped remaining commands.', '#888888');
        this.host.state.pendingExecution = null;
        this.host.state.sudoPasswordInputText = '';
        this.host.state.sudoPasswordCursorOffset = 0;
        this.host.state.sessionSudoPassword = null;
        this.host.state.sudoPasswordPrompt = null;
        this.restoreApprovalDraft();
        return;
      }

      if (action === 'y') {
        this.hideApprovalDialog();
        const block = this.host.state.pendingExecution!.blocks[this.host.state.pendingExecution!.index];
        this.host.state.pendingExecution.mode = 'ask';
        if (isSudoCommand(block.code)) {
          if (platform === 'darwin') {
            // On macOS: run sudo directly and let the native Touch ID/password dialog
            // handle authentication. No TUI modal needed. If the user cancels or enters
            // the wrong password, sudo returns exit 1 and we report the failure.
            await this.runCommandBlock(block);
            this.advancePendingExecution();
            if (this.host.state.pendingExecution) {
              this.restoreApprovalDraft();
              this.promptPendingExecution();
            } else {
              this.restoreApprovalDraft();
              this.host.renderStatusBar();
            }
            return;
          }
          // Linux: run-first pattern — execute without pre-check; if auth fails,
          // runCommandBlockWithSudoRetry shows the TUI password dialog.
          const ok = await this.runCommandBlockWithSudoRetry(block);
          if (!ok) return; // password dialog shown — wait for user input
          this.advancePendingExecution();
          if (this.host.state.pendingExecution) {
            this.restoreApprovalDraft();
            this.promptPendingExecution();
          } else {
            this.restoreApprovalDraft();
            this.host.renderStatusBar();
          }
          return;
        }
        // Non-sudo command — run directly.
        await this.runCommandBlock(block);
        this.advancePendingExecution();
        if (this.host.state.pendingExecution) {
          this.restoreApprovalDraft();
          this.promptPendingExecution();
        } else {
          this.restoreApprovalDraft();
          this.host.renderStatusBar();
        }
        return;
      }

      if (action === 'n') {
        this.hideApprovalDialog();
        this.host.addMsg('Skipped command execution.', '#888888');
        this.advancePendingExecution();
        if (this.host.state.pendingExecution) {
          this.restoreApprovalDraft();
          this.promptPendingExecution();
        } else {
          this.restoreApprovalDraft();
          this.host.renderStatusBar();
        }
        return;
      }
    } finally {
      this.host.state.approvalActionInFlight = false;
    }
  }

  /**
   * Called when the user presses Enter on the sudo password dialog.
   * Captures the password from the chat input, caches it, and re-enters
   * the execution flow for the current sudo command.
   */
  async handleSudoPasswordConfirm(password: string): Promise<void> {
    if (!this.host.state.sudoPasswordPrompt) return;
    if (this.host.state.approvalActionInFlight) return;
    if (!password) {
      this.host.state.sudoRetryCount = Math.max(1, this.host.state.sudoRetryCount);
      this.renderSudoPasswordDialog();
      return;
    }
    this.host.state.approvalActionInFlight = true;

    try {
      // The `password` parameter is what the user typed in the TUI dialog.
      // We use it directly — run the actual sudo command with the piped password
      // and let isSudoAuthFailure detect whether it was correct.
      const { command, index } = this.host.state.sudoPasswordPrompt!;
      this.host.state.sudoPasswordPrompt = null;

      this.clearSudoPasswordInput();
      this.hideApprovalDialog();

      // Linux-only: the password typed in the TUI dialog is piped to sudo -S.
      // If auth fails (wrong password), isSudoAuthFailure re-prompts with
      // sudoRetryCount already incremented (so the retry message shows).
      // If auth succeeds, we clear it below.
      this.host.state.pendingExecution = {
        blocks: this.host.state.pendingExecution?.blocks ?? [],
        index,
        mode: this.host.state.pendingExecution?.mode ?? 'ask',
      };

      const block: CommandBlock = { language: 'bash', code: command, fullMatch: command };
      const ok = await this.runCommandBlockWithSudoRetry(block, password ?? undefined);
      if (ok) {
        this.host.state.sudoRetryCount = 0; // only clear on success
      }
      this.advancePendingExecution();

      if (this.host.state.pendingExecution) {
        if (this.host.state.pendingExecution.mode === 'allow-all') {
          this.hideApprovalDialog();
          while (this.host.state.pendingExecution) {
            const nextBlock = this.host.state.pendingExecution.blocks[this.host.state.pendingExecution.index];
            if (isSudoCommand(nextBlock.code)) {
              // Use runCommandBlockWithSudoRetry so it reads sessionSudoPassword
              // and re-prompts (Linux) or runs directly (macOS) as appropriate.
              await this.runCommandBlockWithSudoRetry(nextBlock, this.host.state.sessionSudoPassword ?? undefined);
            } else {
              await this.runCommandBlock(nextBlock);
            }
            this.advancePendingExecution();
          }
          this.restoreApprovalDraft();
          this.host.renderStatusBar();
        } else {
          this.restoreApprovalDraft();
          this.promptPendingExecution();
        }
      } else {
        this.restoreApprovalDraft();
        this.host.renderStatusBar();
      }
    } finally {
      this.host.state.approvalActionInFlight = false;
    }
  }

  // ── Auto-queue commands from LLM response ────────────────────────────────

  maybeQueueCommandExecution(response: string, allowExecute: boolean): void {
    if (!allowExecute) {
      return;
    }

    const blocks = detectCodeBlocks(response);
    if (blocks.length === 0) {
      return;
    }

    // Reset per-batch UI state only. sessionSudoPassword is intentionally kept
    // across LLM responses — once the user enters it once, we reuse it for the
    // remainder of the session without re-prompting.
    this.host.state.sudoPasswordInputText = '';
    this.host.state.sudoPasswordCursorOffset = 0;
    this.host.state.sudoRetryCount = 0;

    this.host.state.pendingExecution = {
      blocks,
      index: 0,
      mode: 'ask',
    };
    this.promptPendingExecution();
  }

  // ── Pure answer detection helpers ────────────────────────────────────────

  static isAffirmativeAnswer(text: string): boolean { return isAffirmativeAnswer(text); }
  static isNegativeAnswer(text: string): boolean { return isNegativeAnswer(text); }
  static isAllowAllAnswer(text: string): boolean { return isAllowAllAnswer(text); }
  static isRejectAllAnswer(text: string): boolean { return isRejectAllAnswer(text); }

  // ── Shell command interrupt ──────────────────────────────────────────────

  /**
   * Handle interrupt for the active shell command.
   * Returns true if the interrupt was consumed.
   */
  async handleInterruptShellCommand(): Promise<boolean> {
    const shellCmd = this.host.activeShellCommand;
    if (!shellCmd) return false;

    shellCmd.interrupted = true;
    if (shellCmd.interruptStage === 0) {
      shellCmd.interruptStage = 1;
      try {
        process.kill(-shellCmd.proc.pid, 'SIGINT');
      } catch {
        shellCmd.proc.kill('SIGINT');
      }
      this.host.addMsg(`Interrupt requested for shell command: ${shellCmd.command}`, '#ffaa00');
      shellCmd.escalationTimer = setTimeout(() => {
        if (!this.host.activeShellCommand || this.host.activeShellCommand.proc.killed) return;
        this.host.activeShellCommand!.interruptStage = 2;
        try {
          process.kill(-this.host.activeShellCommand!.proc.pid, 'SIGTERM');
        } catch {
          this.host.activeShellCommand!.proc.kill('SIGTERM');
        }
        this.host.addMsg(`Escalating shell command stop: ${this.host.activeShellCommand!.command}`, '#ffaa00');
        this.host.activeShellCommand!.escalationTimer = setTimeout(() => {
          if (!this.host.activeShellCommand || this.host.activeShellCommand.proc.killed) return;
          this.host.activeShellCommand!.interruptStage = 3;
          try {
            process.kill(-this.host.activeShellCommand!.proc.pid, 'SIGKILL');
          } catch {
            this.host.activeShellCommand!.proc.kill('SIGKILL');
          }
          this.host.addMsg(`Force killed shell command: ${this.host.activeShellCommand!.command}`, '#ff4444');
        }, 1500);
      }, 1500);
    } else if (shellCmd.interruptStage === 1) {
      try {
        process.kill(-shellCmd.proc.pid, 'SIGTERM');
      } catch {
        shellCmd.proc.kill('SIGTERM');
      }
      shellCmd.interruptStage = 2;
      this.host.addMsg(`Escalating shell command stop: ${shellCmd.command}`, '#ffaa00');
    } else if (shellCmd.interruptStage === 2) {
      try {
        process.kill(-shellCmd.proc.pid, 'SIGKILL');
      } catch {
        shellCmd.proc.kill('SIGKILL');
      }
      shellCmd.interruptStage = 3;
      this.host.addMsg(`Force killed shell command: ${shellCmd.command}`, '#ff4444');
    }
    return true;
  }
}
