/**
 * Chat loop and messaging for TUIApp.
 *
 * Encapsulates message display, chat loop, and tool call handling.
 */

import { Box, Text, h } from "@opentui/core";
import { MarkdownRenderable, SyntaxStyle, StyledText, fg } from "@opentui/core";
import type { Message, ToolCall } from "../providers/base";
import type { MCPManager } from "../mcp";
import type { MCPTool } from "../mcp/client";
import { formatToolContent, getAssistantResponse } from "../app-runtime";
import {
  addMessage,
  autoGenerateTitle,
  createSession as createSessionUtil,
  recordSessionUsage,
  renameSession as renameSessionUtil,
  type SessionStorage,
} from "../session";
import { createEmptySession as createEmptySessionUtil } from "../input-utils";
import { promptAccentBorderChars, calculateTokenSpeed } from "../input-utils";
import type { MutableBoxNode } from "./tui-types";

// ── State ────────────────────────────────────────────────────────────────────

export interface ActiveTurn {
  id: number;
  controller: AbortController;
  interrupted: boolean;
}

export interface ChatState {
  messages: Message[];
  currentSession: SessionStorage;
  isProcessing: boolean;
  activeTurn: ActiveTurn | null;
  nextTurnId: number;
}

export function createChatState(messages: Message[], session: SessionStorage): ChatState {
  return {
    messages,
    currentSession: session,
    isProcessing: false,
    activeTurn: null,
    nextTurnId: 1,
  };
}

// ── Host interface ───────────────────────────────────────────────────────────

type Provider = Awaited<ReturnType<typeof import("../providers").createProviderFromConfig>>;

export interface IChatHost {
  state: ChatState;
  provider: Provider;
  providerTools: MCPTool[];
  mcpManager: MCPManager | undefined;
  resolvedProvider: { id: string; model: string };
  systemPrompt: string;
  runtime: {
    getProvider(): Provider;
    getResolvedProvider(): { id: string; model: string };
    getProviderTools(): MCPTool[];
    refreshProviderTools(): Promise<void>;
    startNewSession(): SessionStorage;
    loadPersistedSession(id: string): void;
    persistConfig(): Promise<void>;
  };

  addMsg(text: string, color: string, isMarkdown?: boolean): void;
  addUserMsg(text: string): void;
  removeLastMsg(): void;
  renderHeader(): void;
  renderStatusBar(): void;

  // Hook called when an assistant response is complete (for command execution queuing)
  onCommandExecution?(response: string): void;

  // UI nodes
  chatNode: MutableBoxNode;
  chatNodeIds: string[];
  root: { requestRender(): void };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'AbortError' || error.message.toLowerCase().includes('abort'));
}

// ── Manager class ────────────────────────────────────────────────────────────

export class ChatManager {
  private markdownSyntaxStyle = SyntaxStyle.create();

  constructor(private host: IChatHost) {}

  // ── State accessors ──────────────────────────────────────────────────────

  get messages(): Message[] { return this.host.state.messages; }
  get currentSession(): SessionStorage { return this.host.state.currentSession; }
  set currentSession(v: SessionStorage) { this.host.state.currentSession = v; }
  get isProcessing(): boolean { return this.host.state.isProcessing; }
  set isProcessing(v: boolean) { this.host.state.isProcessing = v; }
  get activeTurn(): ActiveTurn | null { return this.host.state.activeTurn; }
  get nextTurnId(): number { return this.host.state.nextTurnId; }

  // ── Message display ──────────────────────────────────────────────────────

  addMsg(text: string, color = '#ffffff', isMarkdown = false): void {
    const nodeId = `chat-${this.host.chatNodeIds.length}-${Date.now()}`;
    let node;
    if (isMarkdown) {
      node = h(MarkdownRenderable, {
        id: nodeId,
        content: text,
        syntaxStyle: this.markdownSyntaxStyle,
        fg: color,
        conceal: true,
        paddingX: 1,
      });
    } else {
      node = Text({ id: nodeId, content: text, fg: color, marginX: 1 });
    }
    this.host.chatNodeIds.push(nodeId);
    this.host.chatNode.add(node);
    this.host.root.requestRender();
  }

  addUserMsg(text: string): void {
    const nodeId = `chat-${this.host.chatNodeIds.length}-${Date.now()}`;
    const boxNode = Box({
      id: nodeId,
      width: '100%',
      height: 'auto',
      flexDirection: 'column',
      backgroundColor: '#1f1f1f',
      border: ['left'],
      borderColor: '#ff9e3d',
      customBorderChars: promptAccentBorderChars,
      paddingY: 1,
      marginY: 1,
      paddingLeft: 1,
    });
    const styledContent = new StyledText([
      fg('#00d4ff')('> '),
      fg('#ffffff')(text),
    ]);
    boxNode.add(Text({ content: styledContent }));
    this.host.chatNodeIds.push(nodeId);
    this.host.chatNode.add(boxNode);
    this.host.root.requestRender();
  }

  removeLastMsg(): void {
    const nodeId = this.host.chatNodeIds.pop();
    if (nodeId) {
      this.host.chatNode.remove(nodeId);
    }
  }

  clearAllMessages(): void {
    while (this.host.chatNodeIds.length > 0) {
      const nodeId = this.host.chatNodeIds.pop();
      if (nodeId) {
        this.host.chatNode.remove(nodeId);
      }
    }
    this.host.root.requestRender();
  }

  // ── Tool call handling ───────────────────────────────────────────────────

  async handleToolCalls(toolCalls: ToolCall[], turnId?: number): Promise<void> {
    if (!this.host.mcpManager || toolCalls.length === 0) {
      return;
    }

    for (const toolCall of toolCalls) {
      if (turnId !== undefined) {
        this.ensureActiveTurn(turnId);
      }

      const args = toolCall.arguments ? JSON.parse(toolCall.arguments) as Record<string, unknown> : {};
      this.addMsg(`Using tool: ${toolCall.name}`, '#ffaa00');

      try {
        const result = await this.host.mcpManager.callTool(toolCall.name, args);
        const content = formatToolContent(result.content);
        if (content) {
          for (const line of content.split('\n')) {
            this.addMsg(line, result.isError ? '#ff4444' : '#888888');
          }
        }
        const toolContent = content || (result.isError ? 'Tool returned an error.' : 'Tool completed successfully.');
        this.host.state.messages.push({
          role: 'tool',
          content: toolContent,
          tool_call_id: toolCall.id,
        });
        addMessage(this.host.state.currentSession.id, 'tool', toolContent, undefined, toolCall.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown tool error';
        this.addMsg(`Tool error (${toolCall.name}): ${message}`, '#ff4444');
        this.host.state.messages.push({
          role: 'tool',
          content: `Error: ${message}`,
          tool_call_id: toolCall.id,
        });
        addMessage(this.host.state.currentSession.id, 'tool', `Error: ${message}`, undefined, toolCall.id);
      }
    }
  }

  // ── Chat loop ────────────────────────────────────────────────────────────

  async handleInput(text: string): Promise<void> {
    if (this.host.state.isProcessing) return;
    if (!text.trim()) return;

    this.host.state.isProcessing = true;
    const turnId = this.host.state.nextTurnId++;
    const controller = new AbortController();
    this.host.state.activeTurn = {
      id: turnId,
      controller,
      interrupted: false,
    };

    this.addUserMsg(text);
    this.addMsg('Thinking...', '#888888');
    this.host.renderStatusBar();
    this.host.state.messages.push({ role: 'user', content: text });

    const userMsgCount = this.host.state.messages.filter(m => m.role === 'user').length;
    if (userMsgCount === 1) {
      const title = autoGenerateTitle(text);
      if (!this.host.state.currentSession.id) {
        this.host.state.currentSession = createSessionUtil(
          title || 'New Session',
          this.host.resolvedProvider.id,
          this.host.resolvedProvider.model,
        );
        addMessage(this.host.state.currentSession.id, 'system', this.host.systemPrompt);
      } else {
        this.renameSession(this.host.state.currentSession.id, title);
        this.host.state.currentSession = { ...this.host.state.currentSession, title };
      }
      this.host.renderHeader();
    }
    addMessage(this.host.state.currentSession.id, 'user', text);

    try {
      while (true) {
        this.ensureActiveTurn(turnId);
        const responseStartedAt = Date.now();
        const response = await getAssistantResponse(
          this.host.runtime.getProvider(),
          this.host.state.messages,
          this.host.runtime.getProviderTools(),
          { signal: controller.signal },
        );
        this.ensureActiveTurn(turnId);
        const tokenSpeed = calculateTokenSpeed(response.usage, responseStartedAt);
        this.removeLastMsg();

        if (response.content) {
          this.addMsg(response.content as string, '#ffffff', true);
        }

        this.host.state.messages.push(response);
        addMessage(this.host.state.currentSession.id, 'assistant', response.content, response.tool_calls);
        if (this.host.state.currentSession.id) {
          const updatedSession = recordSessionUsage(this.host.state.currentSession.id, response.usage, tokenSpeed);
          if (updatedSession) {
            this.host.state.currentSession = updatedSession;
          }
        }
        if (tokenSpeed !== undefined) {
          response.tokenSpeed = tokenSpeed;
        }
        this.host.renderStatusBar();

        if (response.tool_calls && response.tool_calls.length > 0) {
          await this.handleToolCalls(response.tool_calls, turnId);
          this.ensureActiveTurn(turnId);
          this.addMsg('Thinking...', '#888888');
          continue;
        }

        break;
      }

      const lastMessage = this.host.state.messages[this.host.state.messages.length - 1];
      if (lastMessage?.role === 'assistant' && lastMessage.content) {
        this.host.onCommandExecution?.(lastMessage.content);
      }
    } catch (error) {
      this.removeLastMsg();
      if (this.isAbortError(error) || (error instanceof Error && error.message === 'Turn interrupted')) {
        this.addMsg('Interrupted.', '#ffaa00');
      } else {
        this.addMsg(`Error: ${error instanceof Error ? error.message : 'Unknown'}`, '#ff4444');
      }
    }

    this.host.state.isProcessing = false;
    if (this.host.state.activeTurn?.id === turnId) {
      this.host.state.activeTurn = null;
    }
    this.host.renderStatusBar();
  }

  // ── Interrupt handling ───────────────────────────────────────────────────

  /**
   * Handle interrupt for the active LLM turn only.
   * Returns true if the interrupt was consumed.
   */
  async handleInterruptSignal(): Promise<boolean> {
    if (this.host.state.isProcessing && this.host.state.activeTurn) {
      this.host.state.activeTurn.interrupted = true;
      this.host.state.activeTurn.controller.abort();
      return true;
    }
    return false;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private isAbortError(error: unknown): boolean {
    return isAbortError(error);
  }

  private ensureActiveTurn(turnId: number): void {
    if (!this.host.state.activeTurn || this.host.state.activeTurn.id !== turnId || this.host.state.activeTurn.controller.signal.aborted) {
      throw new Error('Turn interrupted');
    }
  }

  private renameSession(id: string, title: string): void {
    renameSessionUtil(id, title);
  }
}
