/**
 * Sessions modal keyboard handling for TUIApp.
 *
 * Encapsulates keyboard handling for the sessions modal, including navigation,
 * filtering, rename, and delete confirmation flows.
 */

import {
  isEnter, isEscape, isArrowUp, isArrowDown, isArrowLeft, isArrowRight,
  isBackspace, isCtrlA, isCtrlE, isCtrlU, isCtrlR, isCtrlD,
  getChar, sessionsVisibleLineCount,
} from '../input-utils';
import { type ModalsState, type SessionSummary } from './modals-state';
import type { ChatState } from './chat';
import type { ChatManager } from './chat';
import type { MutableBoxNode } from './tui-types';

type Runtime = {
  loadPersistedSession(id: string): void;
  startNewSession(): any;
};

export interface ISessionsHost {
  state: ModalsState;
  chatState: ChatState;
  runtime: Runtime;
  chatManager: ChatManager;

  // UI callbacks
  renderSessionsModal(): void;
  closeSessionsModal(): void;
  renderHeader(): void;
  renderStatusBar(): void;
  root: { requestRender(): void };

  // Session operations
  listSessions(): SessionSummary[];
  renameSession(id: string, title: string): void;
  deleteSession(id: string): void;
}

export class SessionsManager {
  constructor(private host: ISessionsHost) {}

  private get ms(): ModalsState {
    return this.host.state;
  }

  handleSequence(sequence: string): boolean {
    const ms = this.ms;

    // Esc always handled first — cancels sub-states or closes modal
    if (isEscape(sequence)) {
      if (ms.deleteSessionConfirm) {
        ms.deleteSessionConfirm = null;
        this.host.renderSessionsModal();
        return true;
      }
      if (ms.sessionsRenaming) {
        ms.sessionsRenaming = null;
        this.host.renderSessionsModal();
        return true;
      }
      this.host.closeSessionsModal();
      return true;
    }

    // Delete session confirmation
    if (ms.deleteSessionConfirm) {
      if (isEnter(sequence)) {
        const wasActive = ms.deleteSessionConfirm.id === this.host.chatState.currentSession.id;
        this.host.deleteSession(ms.deleteSessionConfirm.id);
        if (wasActive) {
          this.host.chatState.currentSession = this.host.runtime.startNewSession();
          this.host.chatManager.clearAllMessages();
          this.host.renderHeader();
          this.host.renderStatusBar();
        }
        ms.deleteSessionConfirm = null;
        ms.sessionsList = this.host.listSessions();
        ms.sessionsSelectedIndex = Math.min(ms.sessionsSelectedIndex, Math.max(0, ms.sessionsList.length - 1));
        this.host.renderSessionsModal();
        return true;
      }
      return true;
    }

    // Rename session input
    if (ms.sessionsRenaming) {
      if (isEnter(sequence)) {
        const newTitle = ms.sessionsRenaming.value.trim();
        if (newTitle) {
          this.host.renameSession(ms.sessionsRenaming.id, newTitle);
          ms.sessionsList = this.host.listSessions();
          if (ms.sessionsRenaming.id === this.host.chatState.currentSession.id) {
            this.host.chatState.currentSession = { ...this.host.chatState.currentSession, title: newTitle };
            this.host.renderHeader();
            this.host.renderStatusBar();
          }
        }
        ms.sessionsRenaming = null;
        this.host.renderSessionsModal();
        return true;
      }
      if (isCtrlA(sequence)) { ms.sessionsRenaming.cursorOffset = 0; this.host.renderSessionsModal(); return true; }
      if (isCtrlE(sequence)) { ms.sessionsRenaming.cursorOffset = ms.sessionsRenaming.value.length; this.host.renderSessionsModal(); return true; }
      if (isCtrlU(sequence)) { ms.sessionsRenaming.value = ms.sessionsRenaming.value.slice(ms.sessionsRenaming.cursorOffset); ms.sessionsRenaming.cursorOffset = 0; this.host.renderSessionsModal(); return true; }
      if (isArrowLeft(sequence)) { ms.sessionsRenaming.cursorOffset = Math.max(0, ms.sessionsRenaming.cursorOffset - 1); this.host.renderSessionsModal(); return true; }
      if (isArrowRight(sequence)) { ms.sessionsRenaming.cursorOffset = Math.min(ms.sessionsRenaming.value.length, ms.sessionsRenaming.cursorOffset + 1); this.host.renderSessionsModal(); return true; }
      if (isBackspace(sequence)) {
        if (ms.sessionsRenaming.cursorOffset > 0) {
          ms.sessionsRenaming.value = ms.sessionsRenaming.value.slice(0, ms.sessionsRenaming.cursorOffset - 1) + ms.sessionsRenaming.value.slice(ms.sessionsRenaming.cursorOffset);
          ms.sessionsRenaming.cursorOffset--;
          this.host.renderSessionsModal();
        }
        return true;
      }
      {
        const char = getChar(sequence);
        if (char !== null && char.charCodeAt(0) >= 32) {
          ms.sessionsRenaming.value = ms.sessionsRenaming.value.slice(0, ms.sessionsRenaming.cursorOffset) + char + ms.sessionsRenaming.value.slice(ms.sessionsRenaming.cursorOffset);
          ms.sessionsRenaming.cursorOffset++;
          this.host.renderSessionsModal();
          return true;
        }
      }
      if (sequence.length > 1 && !sequence.includes('\x1b')) {
        const normalizedText = sequence.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\n/g, ' ');
        if (normalizedText) {
          ms.sessionsRenaming.value = ms.sessionsRenaming.value.slice(0, ms.sessionsRenaming.cursorOffset) + normalizedText + ms.sessionsRenaming.value.slice(ms.sessionsRenaming.cursorOffset);
          ms.sessionsRenaming.cursorOffset += normalizedText.length;
          this.host.renderSessionsModal();
        }
        return true;
      }
      return true;
    }

    // Shortcuts (checked before text input so they don't get captured by filter)
    if (isCtrlR(sequence)) {
      const filtered = this.getFilteredSessions();
      if (ms.sessionsSelectedIndex >= 0 && filtered.length > 0) {
        const selected = filtered[ms.sessionsSelectedIndex];
        if (selected) {
          ms.sessionsRenaming = { id: selected.id, value: selected.title, cursorOffset: selected.title.length };
          this.host.renderSessionsModal();
        }
      }
      return true;
    }
    if (isCtrlD(sequence)) {
      const filtered = this.getFilteredSessions();
      if (ms.sessionsSelectedIndex >= 0 && filtered.length > 0) {
        const selected = filtered[ms.sessionsSelectedIndex];
        if (selected) {
          this.host.state.deleteSessionConfirm = { id: selected.id };
          this.host.renderSessionsModal();
        }
      }
      return true;
    }

    // Navigation
    if (isArrowUp(sequence)) {
      const filteredLen = this.getFilteredSessionsLength();
      if (filteredLen > 0) {
        if (ms.sessionsSelectedIndex <= 0) {
          ms.sessionsSelectedIndex = filteredLen - 1;
        } else {
          ms.sessionsSelectedIndex = ms.sessionsSelectedIndex - 1;
        }
        this.host.renderSessionsModal();
      }
      return true;
    }
    if (isArrowDown(sequence)) {
      const filteredLen = this.getFilteredSessionsLength();
      if (filteredLen > 0) {
        if (ms.sessionsSelectedIndex < 0) {
          ms.sessionsSelectedIndex = 0;
        } else {
          ms.sessionsSelectedIndex = Math.min(filteredLen - 1, ms.sessionsSelectedIndex + 1);
        }
        this.host.renderSessionsModal();
      }
      return true;
    }
    if (sequence === '\x1b[5~') {
      const filteredLen = this.getFilteredSessionsLength();
      if (filteredLen > 0) {
        ms.sessionsSelectedIndex = Math.max(0, ms.sessionsSelectedIndex - sessionsVisibleLineCount);
        this.host.renderSessionsModal();
      }
      return true;
    }
    if (sequence === '\x1b[6~') {
      const filteredLen = this.getFilteredSessionsLength();
      if (filteredLen > 0) {
        if (ms.sessionsSelectedIndex < 0) {
          ms.sessionsSelectedIndex = 0;
        } else {
          ms.sessionsSelectedIndex = Math.min(filteredLen - 1, ms.sessionsSelectedIndex + sessionsVisibleLineCount);
        }
        this.host.renderSessionsModal();
      }
      return true;
    }
    if (isEnter(sequence)) {
      if (ms.sessionsSelectedIndex >= 0) {
        const filtered = this.getFilteredSessions();
        const selected = filtered[ms.sessionsSelectedIndex];
        if (selected) {
          this.host.runtime.loadPersistedSession(selected.id);
          this.host.chatState.currentSession = this.getSession(selected.id)!;
          this.host.chatManager.clearAllMessages();
          for (const msg of this.host.chatState.messages) {
            if (msg.role === 'system') continue;
            if (msg.role === 'user') this.host.chatManager.addUserMsg(msg.content as string);
            else if (msg.role === 'assistant' && msg.content) this.host.chatManager.addMsg(msg.content as string, '#ffffff', true);
            else if (msg.role === 'tool') this.host.chatManager.addMsg(`[tool] ${msg.content}`, '#888888');
          }
          this.host.closeSessionsModal();
          this.host.renderHeader();
          this.host.renderStatusBar();
          this.host.root.requestRender();
        }
      }
      return true;
    }

    // Filter text input (everything else goes into the filter)
    if (isArrowLeft(sequence)) {
      ms.sessionsFilter.cursorOffset = Math.max(0, ms.sessionsFilter.cursorOffset - 1);
      this.host.renderSessionsModal();
      return true;
    }
    if (isArrowRight(sequence)) {
      ms.sessionsFilter.cursorOffset = Math.min(ms.sessionsFilter.value.length, ms.sessionsFilter.cursorOffset + 1);
      this.host.renderSessionsModal();
      return true;
    }
    if (isCtrlA(sequence)) {
      ms.sessionsFilter.cursorOffset = 0;
      this.host.renderSessionsModal();
      return true;
    }
    if (isCtrlE(sequence)) {
      ms.sessionsFilter.cursorOffset = ms.sessionsFilter.value.length;
      this.host.renderSessionsModal();
      return true;
    }
    if (isCtrlU(sequence)) {
      ms.sessionsFilter.value = ms.sessionsFilter.value.slice(ms.sessionsFilter.cursorOffset);
      ms.sessionsFilter.cursorOffset = 0;
      this.host.renderSessionsModal();
      return true;
    }
    if (isBackspace(sequence)) {
      if (ms.sessionsFilter.cursorOffset > 0) {
        ms.sessionsFilter.value = ms.sessionsFilter.value.slice(0, ms.sessionsFilter.cursorOffset - 1) + ms.sessionsFilter.value.slice(ms.sessionsFilter.cursorOffset);
        ms.sessionsFilter.cursorOffset--;
        this.host.renderSessionsModal();
      }
      return true;
    }
    {
      const char = getChar(sequence);
      if (char !== null && char.charCodeAt(0) >= 32) {
        ms.sessionsFilter.value = ms.sessionsFilter.value.slice(0, ms.sessionsFilter.cursorOffset) + char + ms.sessionsFilter.value.slice(ms.sessionsFilter.cursorOffset);
        ms.sessionsFilter.cursorOffset++;
        this.clampSelectionToFiltered();
        this.host.renderSessionsModal();
        return true;
      }
    }
    if (sequence.length > 1 && !sequence.includes('\x1b')) {
      const normalizedText = sequence.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\n/g, ' ');
      if (normalizedText) {
        ms.sessionsFilter.value = ms.sessionsFilter.value.slice(0, ms.sessionsFilter.cursorOffset) + normalizedText + ms.sessionsFilter.value.slice(ms.sessionsFilter.cursorOffset);
        ms.sessionsFilter.cursorOffset += normalizedText.length;
        this.clampSelectionToFiltered();
        this.host.renderSessionsModal();
      }
      return true;
    }
    return true;
  }

  private getFilteredSessions(): SessionSummary[] {
    const ms = this.ms;
    const normalizedFilter = ms.sessionsFilter.value.trim().toLowerCase();
    return normalizedFilter
      ? ms.sessionsList.filter(s => s.title.toLowerCase().includes(normalizedFilter))
      : ms.sessionsList;
  }

  private getFilteredSessionsLength(): number {
    return this.getFilteredSessions().length;
  }

  clampSelectionToFiltered(): void {
    const filteredLen = this.getFilteredSessionsLength();
    if (this.ms.sessionsSelectedIndex >= filteredLen) {
      this.ms.sessionsSelectedIndex = Math.max(-1, filteredLen - 1);
    }
  }

  private getSession(id: string): any {
    return this.host.listSessions().find(s => s.id === id);
  }
}
