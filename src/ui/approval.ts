/**
 * Approval dialog and shell command execution for TUIApp.
 *
 * Encapsulates approval dialog state, rendering, and shell command execution.
 */

import { stringToStyledText } from "@opentui/core";
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
}

export function createApprovalState(): ApprovalState {
  return {
    pendingExecution: null,
    approvalDraftText: '',
    approvalDraftCursorOffset: 0,
    approvalSelectionIndex: 0,
    approvalActionInFlight: false,
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
  get activeShellCommand(): ActiveShellCommand | null { return this.host.activeShellCommand; }
  set activeShellCommand(v: ActiveShellCommand | null) { this.host.setActiveShellCommand(v); }

  // ── Dialog visibility ────────────────────────────────────────────────────

  hideApprovalDialog(): void {
    this.host.approvalDialogNode.visible = false;
    this.host.approvalDialogTextNode.content = stringToStyledText('');
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
    if (this.host.inputNode.blur) {
      this.host.inputNode.blur();
    }
    this.host.root.requestRender();
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

  async runCommandBlock(block: CommandBlock): Promise<void> {
    this.host.addMsg(`$ ${block.code}`, '#00ff88');
    let shellCommandRef: ActiveShellCommand | undefined;
    const result = await executeShellCommand(block.code, {
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
    this.host.renderStatusBar();
    for (const line of formatCommandResult(result).split('\n')) {
      this.host.addMsg(line, result.exitCode === 0 ? '#888888' : '#ff4444');
    }
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
        this.hideApprovalDialog();
        this.host.addMsg('Executing remaining commands.', '#888888');
        while (this.host.state.pendingExecution) {
          const block = this.host.state.pendingExecution.blocks[this.host.state.pendingExecution.index];
          await this.runCommandBlock(block);
          this.advancePendingExecution();
        }
        this.restoreApprovalDraft();
        return;
      }

      if (action === 'x') {
        this.hideApprovalDialog();
        this.host.addMsg('Skipped remaining commands.', '#888888');
        this.host.state.pendingExecution = null;
        this.restoreApprovalDraft();
        return;
      }

      if (action === 'y') {
        this.hideApprovalDialog();
        const block = this.host.state.pendingExecution.blocks[this.host.state.pendingExecution.index];
        await this.runCommandBlock(block);
        this.advancePendingExecution();
        if (this.host.state.pendingExecution) {
          this.restoreApprovalDraft();
          this.promptPendingExecution();
        } else {
          this.restoreApprovalDraft();
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
        }
        return;
      }
    } finally {
      this.host.state.approvalActionInFlight = false;
      if (this.host.state.pendingExecution) {
        this.restoreApprovalDraft();
      }
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
