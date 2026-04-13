/**
 * MCP modal management for TUIApp.
 *
 * Encapsulates all MCP modal state, rendering, and actions.
 */

import { stringToStyledText, StyledText, fg } from "@opentui/core";
import type { MCPManager, MCPServerState } from "../mcp";
import type { MCPTool } from "../mcp/client";
import type { Config } from "../config";
import {
  formatElapsedSeconds,
  mcpDetailsModalHeight,
  mcpDetailsVisibleLineCount,
  mcpDetailsFooterLineCount,
} from "../input-utils";
import type { MutableBoxNode, MutableTextNode, MutableInputNode } from "./tui-types";

// ── State ────────────────────────────────────────────────────────────────────

export interface McpState {
  mcpModalOpen: boolean;
  mcpDetailsOpen: boolean;
  mcpServerIndex: number;
  mcpDetailsScrollOffset: number;
  mcpFocus: 'server';
  mcpLifecycleRefreshTimer: ReturnType<typeof setInterval> | null;
}

export function createMcpState(): McpState {
  return {
    mcpModalOpen: false,
    mcpDetailsOpen: false,
    mcpServerIndex: 0,
    mcpDetailsScrollOffset: 0,
    mcpFocus: 'server',
    mcpLifecycleRefreshTimer: null,
  };
}

// ── Host interface ───────────────────────────────────────────────────────────

export interface IMcpHost {
  state: McpState;
  mcpManager: MCPManager | undefined;
  config: Config;
  providerTools: MCPTool[];
  setProviderTools(tools: MCPTool[]): void;
  runtime: {
    getMcpServerStates(): MCPServerState[];
    refreshProviderTools(): Promise<void>;
    persistConfig(): Promise<void>;
    getProviderTools(): MCPTool[];
  };
  addMsg(text: string, color: string): void;

  // UI nodes
  mcpModalNode: MutableBoxNode;
  mcpModalTextNode: MutableTextNode;
  mcpDetailsModalNode: MutableBoxNode;
  mcpDetailsHeaderBox: MutableBoxNode;
  mcpDetailsHeaderText: MutableTextNode;
  mcpDetailsScrollBox: MutableBoxNode;
  mcpDetailsModalTextNode: MutableTextNode;
  mcpDetailsFooterBox: MutableBoxNode;
  mcpDetailsModalFooterTextNode: MutableTextNode;
  inputNode: MutableInputNode;
  root: { requestRender(): void };
}

// ── Helper functions ─────────────────────────────────────────────────────────

function hasActiveMcpLifecycle(states: MCPServerState[]): boolean {
  return states.some(state =>
    state.lifecycle === 'connecting'
    || state.lifecycle === 'disconnecting'
    || state.lifecycle === 'refreshing'
  );
}

function getMcpDetailsContentLines(selectedState?: MCPServerState): string[] {
  if (!selectedState) {
    return ['No server selected.'];
  }

  const wrapLines = (text: string, width = 58, indent = ''): string[] => {
    if (!text) {
      return [''];
    }

    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if ((indent + candidate).length > width && current) {
        lines.push(`${indent}${current}`);
        current = word;
      } else {
        current = candidate;
      }
    }

    if (current) {
      lines.push(`${indent}${current}`);
    }

    return lines.length > 0 ? lines : [''];
  };

  const infoLines = [
    ...wrapLines(`Transport: ${selectedState.transport}`),
    ...wrapLines(`Target: ${selectedState.target || 'n/a'}`),
    ...wrapLines(`Status: ${selectedState.connected ? 'connected' : 'disconnected'}`),
    ...wrapLines(`Connect on startup: ${selectedState.autoConnect ? 'yes' : 'no'}`),
    ...wrapLines(`Tools: ${selectedState.toolCount}`),
    ...(selectedState.lastError ? wrapLines(`Last error: ${selectedState.lastError}`) : []),
  ];

  const toolLines = selectedState.tools.length > 0
    ? selectedState.tools.flatMap(tool => {
      const lines = wrapLines(`- ${tool.name}`);
      if (tool.description) {
        lines.push(...wrapLines(tool.description, 58, '  '));
      }
      return lines;
    })
    : ['- No tools discovered'];

  return [
    `${selectedState.name} Details`,
    '',
    ...infoLines,
    '',
    'Provided Tools',
    ...toolLines,
    '',
    'Recent stderr',
    ...(selectedState.recentStderr.length > 0
      ? selectedState.recentStderr.flatMap(line => wrapLines(line, 58, '  '))
      : ['- No recent stderr output']),
  ];
}

// ── Manager class ────────────────────────────────────────────────────────────

export class McpManager {
  constructor(private host: IMcpHost) {}

  // ── State accessors ──────────────────────────────────────────────────────

  get mcpModalOpen(): boolean { return this.host.state.mcpModalOpen; }
  get mcpDetailsOpen(): boolean { return this.host.state.mcpDetailsOpen; }
  get mcpServerIndex(): number { return this.host.state.mcpServerIndex; }
  get mcpDetailsScrollOffset(): number { return this.host.state.mcpDetailsScrollOffset; }
  get mcpFocus(): 'server' { return this.host.state.mcpFocus; }

  set mcpModalOpen(v: boolean) { this.host.state.mcpModalOpen = v; }
  set mcpDetailsOpen(v: boolean) { this.host.state.mcpDetailsOpen = v; }
  set mcpServerIndex(v: number) { this.host.state.mcpServerIndex = v; }
  set mcpDetailsScrollOffset(v: number) { this.host.state.mcpDetailsScrollOffset = v; }
  set mcpFocus(v: 'server') { this.host.state.mcpFocus = v; }

  // ── Close modals ─────────────────────────────────────────────────────────

  closeMcpModal(): void {
    this.closeMcpDetailsModal();
    this.host.state.mcpModalOpen = false;
    this.host.mcpModalNode.visible = false;
    this.host.mcpModalTextNode.content = stringToStyledText('');
    this.syncMcpLifecycleRefreshTimer();
    this.host.root.requestRender();
    this.host.inputNode.focus();
  }

  closeMcpDetailsModal(): void {
    this.host.state.mcpDetailsOpen = false;
    this.host.state.mcpDetailsScrollOffset = 0;
    this.host.mcpDetailsModalNode.visible = false;
    this.host.mcpDetailsHeaderText.content = stringToStyledText('');
    this.host.mcpDetailsModalTextNode.content = stringToStyledText('');
    this.host.mcpDetailsModalFooterTextNode.content = stringToStyledText('');
    this.syncMcpLifecycleRefreshTimer();
    this.host.root.requestRender();
    if (!this.host.state.mcpModalOpen) {
      this.host.inputNode.focus();
    }
  }

  // ── Open modal ───────────────────────────────────────────────────────────

  openMcpDetailsModal(): void {
    this.host.state.mcpDetailsOpen = true;
    this.host.state.mcpDetailsScrollOffset = 0;
    this.renderMcpDetailsModal();
    this.syncMcpLifecycleRefreshTimer();
  }

  // ── Render modals ────────────────────────────────────────────────────────

  renderMcpModal(): void {
    if (!this.host.state.mcpModalOpen) {
      this.closeMcpModal();
      return;
    }

    const states = this.host.runtime.getMcpServerStates();
    if (states.length === 0) {
      this.host.mcpModalTextNode.content = stringToStyledText('MCP\n\nNo MCP servers configured.\n\nesc/q close');
      this.host.mcpModalNode.visible = true;
      this.host.root.requestRender();
      return;
    }

    const s = this.host.state;
    s.mcpServerIndex = Math.max(0, Math.min(s.mcpServerIndex, states.length - 1));
    const selectedState = states[s.mcpServerIndex];
    const selectedLifecycle = selectedState.lifecycle === 'error' && selectedState.lastError
      ? 'failed'
      : selectedState.lifecycle;
    const selectedElapsed = formatElapsedSeconds(selectedState.operationStartedAt);
    const summaryLines = [
      `Selected: ${selectedState.name}`,
      `${selectedState.transport} \u2022 ${selectedLifecycle}${selectedElapsed ? ` (${selectedElapsed})` : ''}`,
      `Target: ${selectedState.target || 'n/a'}`,
      `Connect on startup: ${selectedState.autoConnect ? 'yes' : 'no'}`,
      `Tools: ${selectedState.toolCount}`,
      selectedState.lastError ? `Last error: ${selectedState.lastError}` : '',
      '',
    ].filter(Boolean).join('\n');

    const header = stringToStyledText('MCP Servers\n\n');
    const serverChunks = states.flatMap((server, index) => {
      const marker = index === s.mcpServerIndex ? '>' : ' ';
      const lifecycle = server.lifecycle === 'error' && server.lastError ? 'failed' : server.lifecycle;
      const paddedStatus = lifecycle.length >= 13 ? lifecycle.slice(0, 13) : lifecycle.padEnd(13);
      const line = `${marker} ${server.name.padEnd(16)} ${paddedStatus} ${String(server.toolCount).padStart(2)} tools`;
      const isFocused = s.mcpFocus === 'server' && index === s.mcpServerIndex;
      const chunk = isFocused ? fg('#00d4ff')(line) : fg('#a8a8a8')(line);
      return index < states.length - 1 ? [chunk, fg('#a8a8a8')('\n')] : [chunk];
    });
    const rest = stringToStyledText([
      '',
      '',
      'Summary',
      summaryLines,
      '',
      '\u2191/\u2193 select server   c connect/disconnect   space toggle auto-connect   enter details   esc/q close',
    ].join('\n'));
    this.host.mcpModalTextNode.content = new StyledText([
      ...header.chunks,
      ...serverChunks,
      ...rest.chunks,
    ]);
    this.syncMcpLifecycleRefreshTimer();
    this.host.mcpModalNode.visible = true;
    if (this.host.inputNode.blur) {
      this.host.inputNode.blur();
    }
    this.host.root.requestRender();
  }

  renderMcpDetailsModal(): void {
    if (!this.host.state.mcpDetailsOpen) {
      this.closeMcpDetailsModal();
      return;
    }

    const states = this.host.runtime.getMcpServerStates();
    const selectedState = states[this.host.state.mcpServerIndex];
    if (!selectedState) {
      this.closeMcpDetailsModal();
      return;
    }

    const allLines = getMcpDetailsContentLines(selectedState);
    const headerText = `  ${selectedState.name} — ${selectedState.connected ? 'Connected' : 'Disconnected'} ${selectedState.lifecycle === 'connecting' || selectedState.lifecycle === 'disconnecting' || selectedState.lifecycle === 'refreshing' ? `(${selectedState.lifecycle})` : ''}`;
    this.host.mcpDetailsHeaderText.content = stringToStyledText(headerText);

    const footerHeight = 2;
    const headerHeight = 1;
    const scrollableHeight = mcpDetailsModalHeight - headerHeight - footerHeight;
    const visibleLineCount = Math.max(1, scrollableHeight);
    const maxOffset = Math.max(0, allLines.length - visibleLineCount);
    const s = this.host.state;
    s.mcpDetailsScrollOffset = Math.max(0, Math.min(s.mcpDetailsScrollOffset, maxOffset));
    const visibleLines = allLines.slice(s.mcpDetailsScrollOffset, s.mcpDetailsScrollOffset + visibleLineCount);
    this.host.mcpDetailsModalTextNode.content = stringToStyledText(visibleLines.join('\n'));
    this.host.mcpDetailsModalFooterTextNode.content = stringToStyledText([
      `Scroll ${s.mcpDetailsScrollOffset + 1}-${Math.min(s.mcpDetailsScrollOffset + visibleLines.length, allLines.length)} / ${allLines.length}`,
      '\u2191/\u2193 scroll   esc/q close',
    ].join('\n'));
    this.syncMcpLifecycleRefreshTimer();
    this.host.mcpDetailsModalNode.visible = true;
    if (this.host.inputNode.blur) {
      this.host.inputNode.blur();
    }
    this.host.root.requestRender();
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  async runMcpModalConnectionAction(): Promise<void> {
    if (!this.host.mcpManager) {
      this.closeMcpModal();
      return;
    }

    const states = this.host.runtime.getMcpServerStates();
    const selectedState = states[this.host.state.mcpServerIndex];
    if (!selectedState || this.host.state.mcpFocus !== 'server') {
      return;
    }
    if (selectedState.lifecycle === 'connecting' || selectedState.lifecycle === 'disconnecting' || selectedState.lifecycle === 'refreshing') {
      return;
    }

    try {
      if (selectedState.connected) {
        const disconnectPromise = this.host.mcpManager.disconnectServer(selectedState.name);
        this.renderMcpModal();
        if (this.host.state.mcpDetailsOpen) {
          this.renderMcpDetailsModal();
        }
        await disconnectPromise;
      } else {
        const connectPromise = this.host.mcpManager.connectServer(selectedState.name);
        this.renderMcpModal();
        if (this.host.state.mcpDetailsOpen) {
          this.renderMcpDetailsModal();
        }
        await connectPromise;
      }
      await this.host.runtime.refreshProviderTools();
      this.host.setProviderTools(this.host.runtime.getProviderTools());
    } catch (error) {
      this.host.addMsg(`MCP error: ${error instanceof Error ? error.message : 'Unknown error'}`, '#ff4444');
    }

    this.renderMcpModal();
  }

  async toggleMcpServerAutoConnect(): Promise<void> {
    const states = this.host.runtime.getMcpServerStates();
    const selectedState = states[this.host.state.mcpServerIndex];
    if (!selectedState) {
      return;
    }

    const serverConfig = this.host.config.mcpServers?.[selectedState.name];
    if (!serverConfig) {
      return;
    }

    serverConfig.autoConnect = !serverConfig.autoConnect;
    await this.host.runtime.persistConfig();
    this.renderMcpModal();
    if (this.host.state.mcpDetailsOpen) {
      this.renderMcpDetailsModal();
    }
  }

  // ── Lifecycle refresh timer ──────────────────────────────────────────────

  syncMcpLifecycleRefreshTimer(): void {
    const states = this.host.runtime.getMcpServerStates();
    const shouldRun = (this.host.state.mcpModalOpen || this.host.state.mcpDetailsOpen) && hasActiveMcpLifecycle(states);
    if (shouldRun) {
      if (!this.host.state.mcpLifecycleRefreshTimer) {
        this.host.state.mcpLifecycleRefreshTimer = setInterval(() => {
          if (this.host.state.mcpModalOpen) {
            this.renderMcpModal();
          }
          if (this.host.state.mcpDetailsOpen) {
            this.renderMcpDetailsModal();
          }
          if (!(this.host.state.mcpModalOpen || this.host.state.mcpDetailsOpen) || !hasActiveMcpLifecycle(this.host.runtime.getMcpServerStates())) {
            this.syncMcpLifecycleRefreshTimer();
          }
        }, 120);
      }
      return;
    }

    if (this.host.state.mcpLifecycleRefreshTimer) {
      clearInterval(this.host.state.mcpLifecycleRefreshTimer);
      this.host.state.mcpLifecycleRefreshTimer = null;
    }
  }
}
