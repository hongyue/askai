import { createCliRenderer, Box, Text, ScrollBox, StyledText, TextareaRenderable, fg, h, stringToStyledText, type KeyEvent } from "@opentui/core"
import { loadConfig } from './config';
import { MCPManager } from './mcp';
import { createInitialState, createCommands, Command } from './commands';
import { Message, ToolCall } from './providers/base';
import { createProviderFromConfig } from './providers';
import { MCPTool } from './mcp/client';
import { convertToOpenAITools, convertToAnthropicTools } from './mcp/tools';
import {
  detectCodeBlocks,
  executeCommand as executeShellCommand,
  formatCommandBlock,
  formatCommandResult,
  type CommandBlock,
} from './shell';

interface MutableTextNode {
  content: ReturnType<typeof stringToStyledText>;
}

interface MutableBoxNode {
  height: number | 'auto' | `${number}%`;
  visible: boolean;
  add(obj: unknown, index?: number): number;
  remove(id: string): void;
}

interface MutableInputNode {
  plainText: string;
  setText(text: string): void;
  focus(): void;
  onContentChange?: (() => void) | undefined;
  onSubmit?: (() => void) | undefined;
}

interface PaletteState {
  open: boolean;
  query: string;
  selectedIndex: number;
  matches: Command[];
}

interface PendingExecution {
  blocks: CommandBlock[];
  index: number;
}

export async function runOpenTUIApp(options: {
  providerName?: string;
  modelName?: string;
  configPath?: string;
  allowExecute: boolean;
  mcpEnabled: boolean;
  question?: string;
}): Promise<void> {
  const config = await loadConfig(options.configPath);
  if (options.providerName) config.provider = options.providerName;
  if (options.modelName) config.providers[config.provider].model = options.modelName;
  
  let mcpManager: MCPManager | undefined;
  let mcpTools: MCPTool[] = [];
  
  if (options.mcpEnabled && config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    mcpManager = new MCPManager(config);
    await mcpManager.connectAll();
    mcpTools = await mcpManager.listAllTools();
  }
  
  const provider = await createProviderFromConfig(config);
  const systemPrompt = config.system_prompt || 'You are a helpful terminal assistant.';
  const state = createInitialState(options.allowExecute, options.mcpEnabled);
  
  function convertTools(tools: MCPTool[]): any[] {
    if (tools.length === 0) return [];
    switch (provider.name) {
      case 'openai': case 'llama': case 'ollama':
        return convertToOpenAITools(tools);
      case 'anthropic':
        return convertToAnthropicTools(tools);
      default:
        return [];
    }
  }
  
  let providerTools = convertTools(mcpTools);
  const commands = createCommands(state, () => {
    providerTools = state.mcpEnabled ? convertTools(mcpTools) : [];
  });
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];
  
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
  });
  
  let isProcessing = false;
  let inputBuffer = '';
  let palette: PaletteState = {
    open: false,
    query: '',
    selectedIndex: 0,
    matches: [...commands],
  };
  let pendingExecution: PendingExecution | null = null;
  
  const root = Box({ width: '100%', height: '100%', flexDirection: 'column' });
  root.add(Text({ content: ` Welcome to askai! (${provider.name} / ${provider.model})`, fg: '#00d4ff' }));
  
  const chat = ScrollBox({
    id: 'chat-box',
    width: '100%',
    flexGrow: 1,
    minHeight: 0,
    padding: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: 'bottom',
  });
  root.add(chat);
  const chatNodeIds: string[] = [];

  const cmdListBox = Box({
    id: 'cmd-list-box',
    width: '100%',
    height: 0,
    flexDirection: 'column',
    visible: false,
    paddingLeft: 3,
  });
  const cmdListText = Text({ id: 'command-palette', content: stringToStyledText(''), fg: '#888888' });
  cmdListBox.add(cmdListText);
  
  const inputRow = Box({
    id: 'input-row',
    width: '100%',
    height: 'auto',
    flexShrink: 0,
    flexDirection: 'row',
    backgroundColor: '#1f1f1f',
    paddingLeft: 1,
    paddingRight: 1,
  });
  inputRow.add(Text({ content: ' > ', fg: '#00d4ff' }));
  
  const input = h(TextareaRenderable, {
    id: 'main-input',
    flexGrow: 1,
    height: 'auto',
    minHeight: 1,
    maxHeight: 20,
    placeholder: 'Type / for commands...',
    textColor: '#ffffff',
    backgroundColor: '#1f1f1f',
    focusedBackgroundColor: '#262626',
    cursorColor: '#00d4ff',
    wrapMode: 'word',
    keyBindings: [
      { name: 'return', action: 'submit' },
    ],
  });
  inputRow.add(input);
  root.add(inputRow);
  root.add(cmdListBox);
  renderer.root.add(root);

  const liveCmdListBox = renderer.root.findDescendantById('cmd-list-box') as MutableBoxNode | undefined;
  const liveCmdListText = renderer.root.findDescendantById('command-palette') as MutableTextNode | undefined;
  const liveInput = renderer.root.findDescendantById('main-input') as MutableInputNode | undefined;
  const liveChat = renderer.root.findDescendantById('chat-box') as MutableBoxNode | undefined;

  if (!liveCmdListBox || !liveCmdListText || !liveInput || !liveChat) {
    throw new Error('Failed to initialize TUI render tree');
  }

  const cmdListBoxNode = liveCmdListBox;
  const cmdListTextNode = liveCmdListText;
  const inputNode = liveInput;
  const chatNode = liveChat;

  function updateFooterLayout() {
    const paletteHeight = palette.open ? Math.min(palette.matches.length, 5) : 0;
    cmdListBoxNode.height = paletteHeight;
    root.requestRender();
  }
  
  function addMsg(text: string, color = '#ffffff') {
    const nodeId = `chat-${chatNodeIds.length}-${Date.now()}`;
    const node = Text({ id: nodeId, content: text, fg: color });
    chatNodeIds.push(nodeId);
    chatNode.add(node);
    root.requestRender();
  }

  function removeLastMsg() {
    const nodeId = chatNodeIds.pop();
    if (nodeId) {
      chatNode.remove(nodeId);
    }
  }

  function renderPalette() {
    cmdListBoxNode.visible = palette.open;
    updateFooterLayout();
    if (!palette.open) {
      cmdListTextNode.content = stringToStyledText('');
      root.requestRender();
      return;
    }

    const visibleMatches = palette.matches.slice(0, 5);
    const chunks = visibleMatches.flatMap((command, index) => {
      const line = `${index === palette.selectedIndex ? '❯ ' : '  '}/${command.name} - ${command.description}`;
      const chunk = index === palette.selectedIndex ? fg('#00d4ff')(line) : fg('#888888')(line);
      return index < visibleMatches.length - 1 ? [chunk, fg('#888888')('\n')] : [chunk];
    });
    cmdListTextNode.content = new StyledText(chunks);
    root.requestRender();
  }

  function closePalette(): void {
    palette = {
      open: false,
      query: '',
      selectedIndex: 0,
      matches: [...commands],
    };
    renderPalette();
  }

  function openPalette(query: string): void {
    const normalized = query.toLowerCase();
    const matches = query
      ? commands.filter(command =>
          command.name.toLowerCase().includes(normalized)
        )
      : [...commands];

    if (matches.length === 0) {
      closePalette();
      return;
    }

    const selectedIndex = Math.min(palette.selectedIndex, matches.length - 1);
    palette = {
      open: true,
      query,
      selectedIndex: Math.max(0, selectedIndex),
      matches,
    };
    renderPalette();
  }

  function clearCommandInput(): void {
    inputNode.setText('');
    inputBuffer = '';
    closePalette();
    inputNode.focus();
  }

  function resetInput() {
    inputNode.setText('');
    inputBuffer = '';
    closePalette();
    inputNode.focus();
  }

  function isAffirmativeAnswer(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return ['y', 'yes'].includes(normalized);
  }

  function isNegativeAnswer(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return normalized === '' || ['n', 'no'].includes(normalized);
  }

  function promptPendingExecution(): void {
    if (!pendingExecution) {
      return;
    }

    const block = pendingExecution.blocks[pendingExecution.index];
    const ordinal = pendingExecution.blocks.length > 1
      ? ` (${pendingExecution.index + 1}/${pendingExecution.blocks.length})`
      : '';

    addMsg(`Shell command detected${ordinal}:`, '#ffaa00');
    for (const line of formatCommandBlock(block).split('\n')) {
      addMsg(line, '#ffaa00');
    }
    addMsg('Allow execution? [y/N]', '#ffaa00');
  }

  async function handleExecutionApproval(text: string): Promise<void> {
    if (!pendingExecution) {
      return;
    }

    const block = pendingExecution.blocks[pendingExecution.index];
    if (isAffirmativeAnswer(text)) {
      addMsg(`$ ${block.code}`, '#00ff88');
      const result = await executeShellCommand(block.code);
      for (const line of formatCommandResult(result).split('\n')) {
        addMsg(line, result.exitCode === 0 ? '#888888' : '#ff4444');
      }
    } else if (isNegativeAnswer(text)) {
      addMsg('Skipped command execution.', '#888888');
    } else {
      addMsg('Reply with y/yes to allow, or n/no to skip.', '#ffaa00');
      promptPendingExecution();
      return;
    }

    pendingExecution = pendingExecution.index + 1 < pendingExecution.blocks.length
      ? { ...pendingExecution, index: pendingExecution.index + 1 }
      : null;

    if (pendingExecution) {
      promptPendingExecution();
    }
  }

  async function maybeQueueCommandExecution(response: string): Promise<void> {
    if (!state.allowExecute) {
      return;
    }

    const blocks = detectCodeBlocks(response);
    if (blocks.length === 0) {
      return;
    }

    pendingExecution = {
      blocks,
      index: 0,
    };
    promptPendingExecution();
  }

  function formatToolContent(content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>): string {
    return content
      .map(item => {
        if (item.type === 'text' && item.text) {
          return item.text;
        }
        if (item.data) {
          return item.data;
        }
        return `[${item.type}${item.mimeType ? `: ${item.mimeType}` : ''}]`;
      })
      .join('\n')
      .trim();
  }

  async function handleToolCalls(toolCalls: ToolCall[]): Promise<void> {
    if (!mcpManager || toolCalls.length === 0) {
      return;
    }

    for (const toolCall of toolCalls) {
      const args = toolCall.arguments ? JSON.parse(toolCall.arguments) as Record<string, unknown> : {};
      addMsg(`Using tool: ${toolCall.name}`, '#ffaa00');

      try {
        const result = await mcpManager.callTool(toolCall.name, args);
        const content = formatToolContent(result.content);
        if (content) {
          for (const line of content.split('\n')) {
            addMsg(line, result.isError ? '#ff4444' : '#888888');
          }
        }
        messages.push({
          role: 'tool',
          content: content || (result.isError ? 'Tool returned an error.' : 'Tool completed successfully.'),
          tool_call_id: toolCall.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown tool error';
        addMsg(`Tool error (${toolCall.name}): ${message}`, '#ff4444');
        messages.push({
          role: 'tool',
          content: `Error: ${message}`,
          tool_call_id: toolCall.id,
        });
      }
    }
  }

  async function getAssistantResponse(): Promise<Message> {
    if (state.mcpEnabled && providerTools.length > 0) {
      return await provider.chatComplete(messages, providerTools);
    }

    let fullResponse = '';
    for await (const chunk of provider.chat(messages, state.mcpEnabled ? providerTools : [])) {
      if (chunk.content) fullResponse += chunk.content;
      if (chunk.done) {
        return {
          role: 'assistant',
          content: fullResponse,
          tool_calls: chunk.tool_calls,
        };
      }
    }

    return {
      role: 'assistant',
      content: fullResponse,
    };
  }
  
  async function handleInput(text: string) {
    if (isProcessing || !text.trim()) return;

    if (pendingExecution) {
      await handleExecutionApproval(text);
      return;
    }
    
    if (text.startsWith('/')) {
      const commandName = text.slice(1).trim();
      const cmd = commands.find(c => c.name === commandName);
      if (cmd) {
        await executeCommand(cmd);
        return;
      }
    }
    
    isProcessing = true;
    addMsg(`> ${text}`, '#00ff88');
    addMsg('Thinking...', '#888888');
    messages.push({ role: 'user', content: text });
    
    try {
      while (true) {
        const response = await getAssistantResponse();
        removeLastMsg();

        if (response.content) {
          for (const line of response.content.split('\n')) {
            addMsg(line);
          }
        }

        messages.push(response);

        if (response.tool_calls && response.tool_calls.length > 0) {
          await handleToolCalls(response.tool_calls);
          addMsg('Thinking...', '#888888');
          continue;
        }

        break;
      }
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === 'assistant' && lastMessage.content) {
        await maybeQueueCommandExecution(lastMessage.content);
      }
    } catch (error) {
      removeLastMsg();
      addMsg(`Error: ${error instanceof Error ? error.message : 'Unknown'}`, '#ff4444');
    }
    isProcessing = false;
  }
  
  async function executeCommand(cmd: Command) {
    addMsg(`> /${cmd.name}`, '#00ff88');
    if (cmd.name === 'exit') {
      if (mcpManager) await mcpManager.disconnectAll();
      renderer.destroy();
      process.exit(0);
    }
    const result = cmd.action();
    if (result) {
      addMsg(result, '#888888');
    } else {
      addMsg(`Executed /${cmd.name}`, '#888888');
    }
    root.requestRender();
  }

  async function submitCurrentInput() {
    if (palette.open) {
      if (palette.matches.length === 0) {
        return;
      }

      const cmd = palette.matches[palette.selectedIndex];
      resetInput();
      await executeCommand(cmd);
      return;
    }

    const text = inputBuffer;
    resetInput();
    await handleInput(text);
  }
  
  function syncCommandPalette(value: string) {
    inputBuffer = value;
    if (value === '' || !value.startsWith('/')) {
      closePalette();
      return;
    }

    if (value === '/') {
      openPalette('');
      return;
    }

    openPalette(value.slice(1));
  }

  function applyKeyToBuffer(key: KeyEvent): void {
    if (key.ctrl && key.name === 'u') {
      inputBuffer = '';
      closePalette();
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    if (key.name === 'backspace' || key.name === 'delete') {
      const nextValue = inputBuffer.length > 0 ? inputBuffer.slice(0, -1) : '';
      syncCommandPalette(nextValue);
      return;
    }

    if (key.name === 'escape' || key.name === 'return' || key.name === 'linefeed' || key.name === 'up' || key.name === 'down') {
      return;
    }

    if (key.sequence && key.sequence.length === 1) {
      const charCode = key.sequence.charCodeAt(0);
      if (charCode >= 32) {
        const nextValue = inputBuffer + key.sequence;
        const startsCommandMode = inputBuffer === '' && key.sequence === '/';
        const continuesCommandMode = inputBuffer.startsWith('/');

        if (startsCommandMode || continuesCommandMode) {
          syncCommandPalette(nextValue);
        } else {
          inputBuffer = nextValue;
          closePalette();
        }
      }
    }
  }

  inputNode.onContentChange = () => {
    syncCommandPalette(inputNode.plainText);
  };

  inputNode.onSubmit = async () => {
    await submitCurrentInput();
  };
  
  // Handle global keyboard
  renderer.keyInput.on('keypress', async (key: KeyEvent) => {
    if (key.ctrl && key.name === 'c') {
      if (mcpManager) await mcpManager.disconnectAll();
      renderer.destroy();
      process.exit(0);
    }

    applyKeyToBuffer(key);
    
    if (palette.open && key.name === 'escape') {
      clearCommandInput();
      return;
    }

    if (palette.open && (key.name === 'return' || key.name === 'linefeed' || key.name === 'tab')) {
      await submitCurrentInput();
      return;
    }

    if (palette.open) {
      if (key.name === 'up') {
        palette = {
          ...palette,
          selectedIndex: Math.max(0, palette.selectedIndex - 1),
        };
        renderPalette();
        return;
      }
      if (key.name === 'down') {
        palette = {
          ...palette,
          selectedIndex: Math.min(palette.matches.length - 1, palette.selectedIndex + 1),
        };
        renderPalette();
        return;
      }
    }

    if (!key.ctrl && !key.meta) {
      const typedSlash = key.name === '/' || key.name === 'slash' || key.sequence === '/';
      if (typedSlash && !palette.open && inputBuffer === '') {
        openPalette('');
      }
    }
  });
  
  updateFooterLayout();
  inputNode.focus();

  if (options.question) {
    await handleInput(options.question);
  }
}
