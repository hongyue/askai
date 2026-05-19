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
import { createEmptySession as createEmptySessionUtil, selectionHighlight } from "../input-utils";
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
  expandedThinking: Set<string>;  // Track which thinking messages are expanded (by unique node ID)
  expandedToolCalls: Set<string>;  // Track which tool call results are expanded (by unique node ID)
}

export function createChatState(messages: Message[], session: SessionStorage): ChatState {
  return {
    messages,
    currentSession: session,
    isProcessing: false,
    activeTurn: null,
    nextTurnId: 1,
    expandedThinking: new Set(),  // By default, all thinking is collapsed
    expandedToolCalls: new Set(),  // By default, all tool calls are collapsed
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
  showThinking: boolean;  // Config option for displaying thinking content
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
  addThinkingMsg(text: string, isStreaming?: boolean): void;  // Display thinking content with distinct styling
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
  private lastThinkingNodeId: string | null = null;  // Track the thinking node ID separately
  private lastContentNodeId: string | null = null;  // Track the content node ID separately
  private isUpdatingThinking: boolean = false;  // Prevent duplicate updates
  private lastClickTime: Map<string, number> = new Map();  // Debounce clicks

  constructor(private host: IChatHost) {}

  // ── State accessors ──────────────────────────────────────────────────────

  get messages(): Message[] { return this.host.state.messages; }
  get currentSession(): SessionStorage { return this.host.state.currentSession; }
  set currentSession(v: SessionStorage) { this.host.state.currentSession = v; }
  get isProcessing(): boolean { return this.host.state.isProcessing; }
  set isProcessing(v: boolean) { this.host.state.isProcessing = v; }
  get activeTurn(): ActiveTurn | null { return this.host.state.activeTurn; }
  get nextTurnId(): number { return this.host.state.nextTurnId; }
  get showThinking(): boolean { return this.host.showThinking; }

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
      node = Text({ id: nodeId, content: text, fg: color, marginX: 1, selectionBg: selectionHighlight.bg, selectionFg: selectionHighlight.fg });
    }
    this.host.chatNodeIds.push(nodeId);
    this.host.chatNode.add(node);
    this.host.root.requestRender();
  }

  addThinkingMsg(text: string, isStreaming: boolean = false, existingNodeId?: string): void {
    // Display thinking content with distinct styling (dimmed gray, indented, with border)
    // Make it foldable - click header to expand/collapse (only when NOT streaming)
    const nodeId = existingNodeId || `chat-${this.host.chatNodeIds.length}-${Date.now()}`;
    this.lastThinkingNodeId = nodeId;  // Track this thinking node ID
    
    // During streaming, don't make it collapsible (just show the latest content)
    // After streaming completes, make it collapsible
    const isCollapsible = !isStreaming;
    const isExpanded = isCollapsible ? this.host.state.expandedThinking.has(nodeId) : false;
    
    const boxNode = Box({
      id: nodeId,
      width: '100%',
      height: 'auto',
      flexDirection: 'column',
      paddingLeft: 2,
      paddingRight: 1,
      marginY: 0,
      border: ['left', 'right'],
      borderColor: '#444444',
    });
    
    // Add click handler only when collapsible (not during streaming)
    if (isCollapsible) {
      boxNode.onMouseDown = (event) => {
        // Prevent text selection and event propagation
        event.preventDefault?.();
        event.stopPropagation?.();
        
        // Debounce: prevent rapid-fire clicks (200ms window)
        const now = Date.now();
        const lastClick = this.lastClickTime.get(nodeId) || 0;
        if (now - lastClick < 200) return;
        this.lastClickTime.set(nodeId, now);
        
        // Toggle expansion state
        if (this.host.state.expandedThinking.has(nodeId)) {
          this.host.state.expandedThinking.delete(nodeId);
        } else {
          this.host.state.expandedThinking.add(nodeId);
        }
        // Re-render this thinking message in place (don't remove response)
        // Update THIS specific thinking box, not just the last one
        this.updateThinkingMsgById(nodeId, text, false);
      };
      // Also prevent mouse up to stop copy functionality
      boxNode.onMouseUp = (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
      };
    }
    
    // Header with expand/collapse indicator
    const indicator = isExpanded ? '▼' : '▶';
    const headerText = isCollapsible 
      ? `${indicator} ⟳ Thinking... ${isExpanded ? '' : '(click to expand)'}`
      : '⟳ Thinking...';
    const headerNode = Text({
      content: headerText,
      fg: '#666666',
      selectionBg: selectionHighlight.bg,
      selectionFg: selectionHighlight.fg,
    });
    boxNode.add(headerNode);
    
    // Content (only show if expanded or during streaming)
    if (isExpanded || isStreaming) {
      const thinkingContent = text.split('\n').join('\n');
      const contentNode = Text({
        content: thinkingContent || '...',
        fg: '#888888',
        selectionBg: selectionHighlight.bg,
        selectionFg: selectionHighlight.fg,
      });
      boxNode.add(contentNode);
    }
    
    this.host.chatNodeIds.push(nodeId);
    this.host.chatNode.add(boxNode);
    this.host.root.requestRender();
  }

  // Add thinking message at a specific position (for updating in-place while preserving order)
  addThinkingMsgAtPosition(text: string, isStreaming: boolean = false, existingNodeId?: string, position?: number): void {
    const nodeId = existingNodeId || `chat-${this.host.chatNodeIds.length}-${Date.now()}`;
    this.lastThinkingNodeId = nodeId;
    
    const isCollapsible = !isStreaming;
    const isExpanded = isCollapsible ? this.host.state.expandedThinking.has(nodeId) : false;
    
    const boxNode = Box({
      id: nodeId,
      width: '100%',
      height: 'auto',
      flexDirection: 'column',
      paddingLeft: 2,
      paddingRight: 1,
      marginY: 0,
      border: ['left', 'right'],
      borderColor: '#444444',
    });
    
    if (isCollapsible) {
      boxNode.onMouseDown = (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();  // Prevent event bubbling
        
        // Debounce: prevent rapid-fire clicks (200ms window)
        const now = Date.now();
        const lastClick = this.lastClickTime.get(nodeId) || 0;
        if (now - lastClick < 200) return;
        this.lastClickTime.set(nodeId, now);
        
        if (this.host.state.expandedThinking.has(nodeId)) {
          this.host.state.expandedThinking.delete(nodeId);
        } else {
          this.host.state.expandedThinking.add(nodeId);
        }
        // Update THIS specific thinking box, not just the last one
        this.updateThinkingMsgById(nodeId, text, false);
      };
      // Also prevent mouse up to stop copy functionality
      boxNode.onMouseUp = (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
      };
    }
    
    const indicator = isExpanded ? '▼' : '▶';
    const headerText = isCollapsible 
      ? `${indicator} ⟳ Thinking... ${isExpanded ? '' : '(click to expand)'}`
      : '⟳ Thinking...';
    const headerNode = Text({
      content: headerText,
      fg: '#666666',
      selectionBg: selectionHighlight.bg,
      selectionFg: selectionHighlight.fg,
    });
    boxNode.add(headerNode);
    
    if (isExpanded || isStreaming) {
      const thinkingContent = text.split('\n').join('\n');
      const contentNode = Text({
        content: thinkingContent || '...',
        fg: '#888888',
        selectionBg: selectionHighlight.bg,
        selectionFg: selectionHighlight.fg,
      });
      boxNode.add(contentNode);
    }
    
    // Insert at the specified position (or at the end if not specified)
    if (position !== undefined) {
      this.host.chatNodeIds.splice(position, 0, nodeId);
      this.host.chatNode.add(boxNode, position);
    } else {
      this.host.chatNodeIds.push(nodeId);
      this.host.chatNode.add(boxNode);
    }
    this.host.root.requestRender();
  }

  addUserMsg(text: string): void {
    this.lastThinkingNodeId = null;  // Reset thinking node tracking
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
    boxNode.add(Text({ content: styledContent, selectionBg: selectionHighlight.bg, selectionFg: selectionHighlight.fg }));
    this.host.chatNodeIds.push(nodeId);
    this.host.chatNode.add(boxNode);
    this.host.root.requestRender();
  }

  addToolCallMsg(text: string, toolName: string, isError: boolean = false): string {
    const nodeId = `tool-${this.host.chatNodeIds.length}-${Date.now()}`;
    const isExpanded = this.host.state.expandedToolCalls.has(nodeId);

    const boxNode = Box({
      id: nodeId,
      width: '100%',
      height: 'auto',
      flexDirection: 'column',
      paddingLeft: 2,
      paddingRight: 1,
      marginY: 0,
      border: ['left', 'right'],
      borderColor: isError ? '#ff4444' : '#555555',
    });

    boxNode.onMouseDown = (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();

      const now = Date.now();
      const lastClick = this.lastClickTime.get(nodeId) || 0;
      if (now - lastClick < 200) return;
      this.lastClickTime.set(nodeId, now);

      if (this.host.state.expandedToolCalls.has(nodeId)) {
        this.host.state.expandedToolCalls.delete(nodeId);
      } else {
        this.host.state.expandedToolCalls.add(nodeId);
      }
      this.updateToolCallMsgById(nodeId, text, toolName, isError);
    };

    boxNode.onMouseUp = (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
    };

    const indicator = isExpanded ? '▼' : '▶';
    const headerNode = Text({
      content: `${indicator} ${toolName}`,
      fg: isError ? '#ff4444' : '#ffaa00',
      selectionBg: selectionHighlight.bg,
      selectionFg: selectionHighlight.fg,
    });
    boxNode.add(headerNode);

    if (isExpanded) {
      const contentNode = Text({
        content: text || '(no output)',
        fg: isError ? '#ff8888' : '#aaaaaa',
        selectionBg: selectionHighlight.bg,
        selectionFg: selectionHighlight.fg,
      });
      boxNode.add(contentNode);
    }

    this.host.chatNodeIds.push(nodeId);
    this.host.chatNode.add(boxNode);
    this.host.root.requestRender();
    return nodeId;
  }

  addToolMessage(msg: Message, allMessages: Message[], index: number): void {
    const toolName = msg.tool_name || this.findToolNameForMessage(allMessages, index);
    if (toolName) {
      const isError = msg.content ? msg.content.startsWith('Error: ') : false;
      this.addToolCallMsg(msg.content, toolName, isError);
    } else {
      this.addMsg(`[tool] ${msg.content}`, '#888888');
    }
  }

  removeLastMsg(): void {
    const nodeId = this.host.chatNodeIds.pop();
    if (nodeId) {
      this.host.chatNode.remove(nodeId);
    }
  }

  // Remove the last thinking message specifically (for toggle logic)
  removeLastThinkingMsg(): void {
    // Find and remove the last thinking box node
    // Thinking nodes have IDs starting with "chat-" and are in chatNodeIds
    const lastNodeId = this.host.chatNodeIds[this.host.chatNodeIds.length - 1];
    if (lastNodeId) {
      this.host.chatNode.remove(lastNodeId);
      this.host.chatNodeIds.pop();
    }
  }

  // Update the last thinking message in place (no flicker, preserves position and expansion state)
  updateLastThinkingMsg(text: string, isStreaming: boolean = false): void {
    // Prevent duplicate updates
    if (this.isUpdatingThinking) return;
    
    if (!this.lastThinkingNodeId) return;
    
    // Update the specific thinking message by ID
    this.updateThinkingMsgById(this.lastThinkingNodeId, text, isStreaming);
  }

  // Update a specific thinking message by its node ID (for when clicking on any thinking box)
  updateThinkingMsgById(nodeId: string, text: string, isStreaming: boolean = false): void {
    // Prevent duplicate updates
    if (this.isUpdatingThinking) return;
    
    if (!nodeId) return;
    
    // Find the position of the thinking node in chatNodeIds
    const idx = this.host.chatNodeIds.indexOf(nodeId);
    if (idx < 0) return;
    
    // Mark as updating to prevent recursive calls
    this.isUpdatingThinking = true;
    
    try {
      // Remove the old thinking node from the display
      this.host.chatNode.remove(nodeId);
      // Remove from array at the correct position
      this.host.chatNodeIds.splice(idx, 1);
      
      // Re-add with new content at the CORRECT POSITION (not at the end)
      // We'll add it at index `idx` to preserve the position
      this.addThinkingMsgAtPosition(text, isStreaming, nodeId, idx);
    } finally {
      // Reset the flag
      this.isUpdatingThinking = false;
    }
  }

  private updateToolCallMsgById(nodeId: string, text: string, toolName: string, isError: boolean): void {
    const idx = this.host.chatNodeIds.indexOf(nodeId);
    if (idx < 0) return;

    this.host.chatNode.remove(nodeId);
    this.host.chatNodeIds.splice(idx, 1);

    const isExpanded = this.host.state.expandedToolCalls.has(nodeId);

    const boxNode = Box({
      id: nodeId,
      width: '100%',
      height: 'auto',
      flexDirection: 'column',
      paddingLeft: 2,
      paddingRight: 1,
      marginY: 0,
      border: ['left', 'right'],
      borderColor: isError ? '#ff4444' : '#555555',
    });

    boxNode.onMouseDown = (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();

      const now = Date.now();
      const lastClick = this.lastClickTime.get(nodeId) || 0;
      if (now - lastClick < 200) return;
      this.lastClickTime.set(nodeId, now);

      if (this.host.state.expandedToolCalls.has(nodeId)) {
        this.host.state.expandedToolCalls.delete(nodeId);
      } else {
        this.host.state.expandedToolCalls.add(nodeId);
      }
      this.updateToolCallMsgById(nodeId, text, toolName, isError);
    };

    boxNode.onMouseUp = (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
    };

    const indicator = isExpanded ? '▼' : '▶';
    const headerNode = Text({
      content: `${indicator} ${toolName}`,
      fg: isError ? '#ff4444' : '#ffaa00',
      selectionBg: selectionHighlight.bg,
      selectionFg: selectionHighlight.fg,
    });
    boxNode.add(headerNode);

    if (isExpanded) {
      const contentNode = Text({
        content: text || '(no output)',
        fg: isError ? '#ff8888' : '#aaaaaa',
        selectionBg: selectionHighlight.bg,
        selectionFg: selectionHighlight.fg,
      });
      boxNode.add(contentNode);
    }

    this.host.chatNodeIds.splice(idx, 0, nodeId);
    this.host.chatNode.add(boxNode, idx);
    this.host.root.requestRender();
  }

  // Update the content message in place (no flicker — preserves position, no markdown re-parse)
  updateLastContentMsg(text: string, isMarkdown: boolean = false): void {
    if (!this.lastContentNodeId) return;

    const idx = this.host.chatNodeIds.indexOf(this.lastContentNodeId);
    if (idx < 0) return;

    // Remove the old content node
    this.host.chatNode.remove(this.lastContentNodeId);
    this.host.chatNodeIds.splice(idx, 1);

    // Re-create with the same node ID at the same position
    const nodeId = this.lastContentNodeId;
    let node;
    if (isMarkdown) {
      node = h(MarkdownRenderable, {
        id: nodeId,
        content: text,
        syntaxStyle: this.markdownSyntaxStyle,
        fg: '#ffffff',
        conceal: true,
        paddingX: 1,
      });
    } else {
      node = Text({ id: nodeId, content: text, fg: '#ffffff', marginX: 1, selectionBg: selectionHighlight.bg, selectionFg: selectionHighlight.fg });
    }
    this.host.chatNodeIds.splice(idx, 0, nodeId);
    this.host.chatNode.add(node, idx);
    this.host.root.requestRender();
  }

  clearAllMessages(): void {
    this.lastThinkingNodeId = null;  // Reset thinking node tracking
    this.lastContentNodeId = null;  // Reset content node tracking
    while (this.host.chatNodeIds.length > 0) {
      const nodeId = this.host.chatNodeIds.pop();
      if (nodeId) {
        this.host.chatNode.remove(nodeId);
      }
    }
    this.host.state.expandedToolCalls.clear();
    this.host.root.requestRender();
  }

  // Toggle thinking display - re-render all messages with new showThinking value
  toggleThinkingDisplay(): void {
    // Clear all messages
    this.lastThinkingNodeId = null;
    this.lastContentNodeId = null;
    
    const allMessages = this.host.state.messages;
    
    // Clear the display
    while (this.host.chatNodeIds.length > 0) {
      const nodeId = this.host.chatNodeIds.pop();
      if (nodeId) {
        this.host.chatNode.remove(nodeId);
      }
    }
    
    // Re-add messages with new showThinking setting
    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i];
      if (msg.role === 'system') continue;
      
      if (msg.role === 'user') {
        this.addUserMsg(msg.content as string);
      } else if (msg.role === 'assistant') {
        // Display thinking content first if available and showThinking is enabled
        if (msg.thinking && this.showThinking) {
          this.addThinkingMsg(msg.thinking, false);  // isStreaming = false (collapsible)
        }
        // Then display final response
        if (msg.content) {
          this.addMsg(msg.content as string, '#ffffff', true);
        }
      } else if (msg.role === 'tool') {
        const toolName = msg.tool_name || this.findToolNameForMessage(allMessages, i);
        if (toolName) {
          const isError = msg.content ? msg.content.startsWith('Error: ') : false;
          this.addToolCallMsg(msg.content, toolName, isError);
        } else {
          this.addMsg(`[tool] ${msg.content}`, '#888888');
        }
      }
    }
    
    this.host.root.requestRender();
  }

  private findToolNameForMessage(messages: Message[], currentIndex: number): string | undefined {
    const msg = messages[currentIndex];
    if (!msg.tool_call_id) return undefined;
    for (let i = currentIndex - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.id === msg.tool_call_id) {
            return tc.name;
          }
        }
      }
    }
    return undefined;
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

      try {
        const result = await this.host.mcpManager.callTool(toolCall.name, args);
        const content = formatToolContent(result.content);
        const toolContent = content || (result.isError ? 'Tool returned an error.' : 'Tool completed successfully.');
        this.addToolCallMsg(toolContent, toolCall.name, result.isError);
        this.host.state.messages.push({
          role: 'tool',
          content: toolContent,
          tool_call_id: toolCall.id,
          tool_name: toolCall.name,
        });
        addMessage(this.host.state.currentSession.id, 'tool', toolContent, undefined, toolCall.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown tool error';
        this.addToolCallMsg(`Error: ${message}`, toolCall.name, true);
        this.host.state.messages.push({
          role: 'tool',
          content: `Error: ${message}`,
          tool_call_id: toolCall.id,
          tool_name: toolCall.name,
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
    // Removed initial "Thinking..." - will show proper thinking box during streaming
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
        
        // Track accumulated thinking and content for streaming display
        let accumulatedThinking = '';
        let accumulatedContent = '';
        let lastMessageType: 'thinking' | 'content' | null = null;
        this.lastContentNodeId = null;

        const response = await getAssistantResponse(
          this.host.runtime.getProvider(),
          this.host.state.messages,
          this.host.runtime.getProviderTools(),
          { signal: controller.signal },
          // Callback for streaming display - both thinking and content stream in real-time
          (thinkingDelta, contentDelta) => {
            if (thinkingDelta && this.host.showThinking) {
              accumulatedThinking += thinkingDelta;
              if (lastMessageType === 'thinking') {
                this.updateLastThinkingMsg(accumulatedThinking, true);
              } else {
                this.addThinkingMsg(accumulatedThinking, true);
              }
              lastMessageType = 'thinking';
            }
            if (contentDelta) {
              accumulatedContent += contentDelta;
              // In-place: update as Text (no markdown parsing → no flicker)
              if (lastMessageType === 'content') {
                this.updateLastContentMsg(accumulatedContent, false);
              } else {
                this.addMsg(accumulatedContent, '#ffffff', false);
                this.lastContentNodeId = this.host.chatNodeIds[this.host.chatNodeIds.length - 1];
              }
              lastMessageType = 'content';
            }
          },
        );
        
        // Final flush: swap streaming Text node to final MarkdownRenderable
        if (accumulatedContent) {
          if (lastMessageType === 'content') {
            this.updateLastContentMsg(accumulatedContent, true);
          } else {
            this.addMsg(accumulatedContent, '#ffffff', true);
          }
        } else if (response.content) {
          // Response was not streamed (e.g. chatComplete path when tools are present)
          // Display it directly as markdown
          this.addMsg(response.content, '#ffffff', true);
          this.lastContentNodeId = this.host.chatNodeIds[this.host.chatNodeIds.length - 1];
        }
        
        // Finalize thinking: convert from streaming (non-collapsible) to final (collapsible)
        // Always finalize if there's thinking content, regardless of last message type
        if (accumulatedThinking) {
          this.updateLastThinkingMsg(accumulatedThinking, false);  // isStreaming = false (collapsible)
        }
        
        this.ensureActiveTurn(turnId);
        const tokenSpeed = calculateTokenSpeed(response.usage, responseStartedAt);

        // Already displayed during streaming, so just add to history
        this.host.state.messages.push(response);
        addMessage(this.host.state.currentSession.id, 'assistant', response.content, response.tool_calls, undefined, response.thinking);
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
          // Removed duplicate "Thinking..." - the streaming display already shows thinking
          continue;
        }

        break;
      }

      const lastMessage = this.host.state.messages[this.host.state.messages.length - 1];
      if (lastMessage?.role === 'assistant' && lastMessage.content) {
        this.host.onCommandExecution?.(lastMessage.content);
      }
    } catch (error) {
      // Remove the tracked content node (if any) instead of blindly removing last
      if (this.lastContentNodeId) {
        const idx = this.host.chatNodeIds.indexOf(this.lastContentNodeId);
        if (idx >= 0) {
          this.host.chatNode.remove(this.lastContentNodeId);
          this.host.chatNodeIds.splice(idx, 1);
        }
        this.lastContentNodeId = null;
      } else {
        this.removeLastMsg();
      }
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
