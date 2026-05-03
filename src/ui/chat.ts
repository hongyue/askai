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
}

export function createChatState(messages: Message[], session: SessionStorage): ChatState {
  return {
    messages,
    currentSession: session,
    isProcessing: false,
    activeTurn: null,
    nextTurnId: 1,
    expandedThinking: new Set(),  // By default, all thinking is collapsed
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

  clearAllMessages(): void {
    this.lastThinkingNodeId = null;  // Reset thinking node tracking
    while (this.host.chatNodeIds.length > 0) {
      const nodeId = this.host.chatNodeIds.pop();
      if (nodeId) {
        this.host.chatNode.remove(nodeId);
      }
    }
    this.host.root.requestRender();
  }

  // Toggle thinking display - re-render all messages with new showThinking value
  toggleThinkingDisplay(): void {
    // Clear all messages
    this.lastThinkingNodeId = null;
    const messagesToReAdd: Array<{role: string; content: string | null; thinking?: string}> = [];
    
    // Collect all messages (skip system)
    for (const msg of this.host.state.messages) {
      if (msg.role === 'system') continue;
      messagesToReAdd.push(msg);
    }
    
    // Clear the display
    while (this.host.chatNodeIds.length > 0) {
      const nodeId = this.host.chatNodeIds.pop();
      if (nodeId) {
        this.host.chatNode.remove(nodeId);
      }
    }
    
    // Re-add messages with new showThinking setting
    for (const msg of messagesToReAdd) {
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
        this.addMsg(`[tool] ${msg.content}`, '#888888');
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
        
        // Throttle final response updates to reduce flickering
        // Match thinking's smoothness by updating less frequently
        let contentChunkCount = 0;
        const CONTENT_UPDATE_INTERVAL = 15;  // Update every N chunks (increased from 8)
        let lastContentUpdateTime = 0;
        const CONTENT_UPDATE_TIME_MS = 250;  // Or every 250ms (increased from 150ms)
        
        const response = await getAssistantResponse(
          this.host.runtime.getProvider(),
          this.host.state.messages,
          this.host.runtime.getProviderTools(),
          { signal: controller.signal },
          // Callback for streaming display - both thinking and content stream in real-time
          (thinkingDelta, contentDelta) => {
            const now = Date.now();
            
            if (thinkingDelta && this.host.showThinking) {
              accumulatedThinking += thinkingDelta;
              // Update thinking in real-time (use update to avoid duplication)
              if (lastMessageType === 'thinking') {
                this.updateLastThinkingMsg(accumulatedThinking, true);
              } else {
                this.addThinkingMsg(accumulatedThinking, true);  // isStreaming = true
              }
              lastMessageType = 'thinking';
            }
            if (contentDelta) {
              accumulatedContent += contentDelta;
              contentChunkCount++;
              
              // Throttle content updates: every N chunks OR every 250ms
              const shouldUpdate = contentChunkCount >= CONTENT_UPDATE_INTERVAL || (now - lastContentUpdateTime > CONTENT_UPDATE_TIME_MS);
              
              if (shouldUpdate) {
                if (lastMessageType === 'content') {
                  this.removeLastMsg();
                }
                this.addMsg(accumulatedContent as string, '#ffffff', true);
                lastMessageType = 'content';
                contentChunkCount = 0;
                lastContentUpdateTime = now;
              }
            }
          },
        );
        
        // Final flush: ensure any remaining content is displayed
        if (accumulatedContent && lastMessageType !== 'content') {
          this.addMsg(accumulatedContent as string, '#ffffff', true);
        } else if (accumulatedContent && lastMessageType === 'content') {
          this.removeLastMsg();
          this.addMsg(accumulatedContent as string, '#ffffff', true);
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
