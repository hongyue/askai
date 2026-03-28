import { createCliRenderer, Box, Text, ScrollBox, StyledText, TextareaRenderable, fg, h, stringToStyledText, type KeyEvent } from "@opentui/core"
import { loadConfig } from './config';
import { createProviderFromConfig } from './chat';
import { MCPManager } from './mcp';
import { createInitialState, createCommands, Command } from './commands';
import { Message } from './providers/base';
import { MCPTool } from './mcp/client';
import { convertToOpenAITools, convertToAnthropicTools } from './mcp/tools';

interface MutableTextNode {
  content: ReturnType<typeof stringToStyledText>;
}

interface MutableBoxNode {
  height: number | 'auto' | `${number}%`;
  visible: boolean;
  paddingBottom?: number | `${number}%`;
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

export async function runOpenTUIApp(options: {
  providerName?: string;
  modelName?: string;
  configPath?: string;
  allowExecute: boolean;
  mcpEnabled: boolean;
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
  
  const root = Box({ width: '100%', height: '100%', flexDirection: 'column' });
  root.add(Text({ content: ` Welcome to askai! (${provider.name} / ${provider.model})`, fg: '#00d4ff' }));
  
  const chat = ScrollBox({
    id: 'chat-box',
    width: '100%',
    flexGrow: 1,
    padding: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: 'bottom',
  });
  root.add(chat);
  const chatNodeIds: string[] = [];
  
  const footer = Box({
    id: 'tui-footer',
    width: '100%',
    flexDirection: 'column',
  });

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
    height: 3,
    flexDirection: 'row',
  });
  inputRow.add(Text({ content: ' > ', fg: '#00d4ff' }));
  
  const input = h(TextareaRenderable, {
    id: 'main-input',
    flexGrow: 1,
    height: 3,
    placeholder: 'Type / for commands...',
    textColor: '#ffffff',
    cursorColor: '#00d4ff',
    wrapMode: 'word',
    keyBindings: [
      { name: 'return', action: 'submit' },
    ],
  });
  inputRow.add(input);
  footer.add(inputRow);
  footer.add(cmdListBox);
  root.add(footer);
  renderer.root.add(root);

  const liveFooter = renderer.root.findDescendantById('tui-footer') as MutableBoxNode | undefined;
  const liveCmdListBox = renderer.root.findDescendantById('cmd-list-box') as MutableBoxNode | undefined;
  const liveCmdListText = renderer.root.findDescendantById('command-palette') as MutableTextNode | undefined;
  const liveInput = renderer.root.findDescendantById('main-input') as MutableInputNode | undefined;
  const liveChat = renderer.root.findDescendantById('chat-box') as MutableBoxNode | undefined;

  if (!liveFooter || !liveCmdListBox || !liveCmdListText || !liveInput || !liveChat) {
    throw new Error('Failed to initialize TUI render tree');
  }

  const footerNode = liveFooter;
  const cmdListBoxNode = liveCmdListBox;
  const cmdListTextNode = liveCmdListText;
  const inputNode = liveInput;
  const chatNode = liveChat;

  function updateFooterLayout() {
    const paletteHeight = palette.open ? Math.min(palette.matches.length, 5) : 0;
    const footerHeight = paletteHeight + 3;
    cmdListBoxNode.height = paletteHeight;
    footerNode.height = footerHeight;
    chatNode.paddingBottom = footerHeight;
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
  
  async function handleInput(text: string) {
    if (isProcessing || !text.trim()) return;
    
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
      let fullResponse = '';
      for await (const chunk of provider.chat(messages, state.mcpEnabled ? providerTools : [])) {
        if (chunk.content) fullResponse += chunk.content;
        if (chunk.done) break;
      }
      removeLastMsg();
      if (fullResponse) {
        for (const line of fullResponse.split('\n')) {
          addMsg(line);
        }
        messages.push({ role: 'assistant', content: fullResponse });
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
}
