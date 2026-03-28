import { createCliRenderer, Box, Text, Input, type KeyEvent } from "@opentui/core"
import { loadConfig } from './config';
import { createProviderFromConfig } from './chat';
import { MCPManager } from './mcp';
import { createInitialState, createCommands, Command } from './commands';
import { Message, ToolCall } from './providers/base';
import { MCPTool } from './mcp/client';
import { convertToOpenAITools, convertToAnthropicTools, formatToolResult } from './mcp/tools';

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
  const commands = createCommands(state, () => {});
  
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
  
  const providerTools = convertTools(mcpTools);
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];
  
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
  });
  
  let isProcessing = false;
  let inputBuffer = '';
  let cmdMode = false;
  let cmdIndex = 0;
  let filteredCommands: Command[] = [...commands];
  
  const root = Box({ width: '100%', height: '100%', flexDirection: 'column' });
  root.add(Text({ content: ` askai | ${provider.name}/${provider.model} | Ctrl+C exit`, fg: '#00d4ff' }));
  
  const chat = Box({ width: '100%', flexGrow: 1, flexDirection: 'column', padding: 1 });
  root.add(chat);
  
  const cmdListBox = Box({ width: '100%', height: 0, flexDirection: 'column' });
  root.add(cmdListBox);
  
  const inputRow = Box({ width: '100%', height: 3, flexDirection: 'row' });
  inputRow.add(Text({ content: ' > ', fg: '#00d4ff' }));
  
  const input = Input({
    id: 'main-input',
    flexGrow: 1,
    placeholder: 'Type / for commands...',
    textColor: '#ffffff',
    cursorColor: '#00d4ff',
  });
  inputRow.add(input);
  root.add(inputRow);
  renderer.root.add(root);
  
  function addMsg(text: string, color = '#ffffff') {
    chat.add(Text({ content: text, fg: color }));
  }
  
  function updateCmdList() {
    while (cmdListBox.children.length > 0) cmdListBox.remove(cmdListBox.children[0]);
    for (let i = 0; i < filteredCommands.length; i++) {
      const selected = i === cmdIndex;
      cmdListBox.add(Text({
        content: `${selected ? '❯ ' : '  '}/${filteredCommands[i].name} - ${filteredCommands[i].description}`,
        fg: selected ? '#00d4ff' : '#888888',
      }));
    }
    cmdListBox.height = Math.min(filteredCommands.length, 5);
  }
  
  function showCmdList() {
    cmdMode = true;
    cmdIndex = 0;
    filteredCommands = [...commands];
    updateCmdList();
  }
  
  function hideCmdList() {
    cmdMode = false;
    while (cmdListBox.children.length > 0) cmdListBox.remove(cmdListBox.children[0]);
    cmdListBox.height = 0;
  }
  
  function filterCmdList(filter: string) {
    if (!filter) {
      filteredCommands = [...commands];
    } else {
      filteredCommands = commands.filter(c => 
        c.name.includes(filter) || c.description.includes(filter)
      );
    }
    if (cmdIndex >= filteredCommands.length) {
      cmdIndex = Math.max(0, filteredCommands.length - 1);
    }
    updateCmdList();
  }
  
  async function handleInput(text: string) {
    if (isProcessing || !text.trim()) return;
    
    if (text.startsWith('/')) {
      const cmd = commands.find(c => c.name === text.slice(1));
      if (cmd) {
        if (cmd.name === 'exit') {
          if (mcpManager) await mcpManager.disconnectAll();
          renderer.destroy();
          process.exit(0);
        }
        const result = cmd.action();
        if (result) addMsg(result, '#888888');
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
      if (chat.children.length > 0) chat.remove(chat.children[chat.children.length - 1]);
      if (fullResponse) {
        for (const line of fullResponse.split('\n')) {
          addMsg(line);
        }
        messages.push({ role: 'assistant', content: fullResponse });
      }
    } catch (error) {
      if (chat.children.length > 0) chat.remove(chat.children[chat.children.length - 1]);
      addMsg(`Error: ${error instanceof Error ? error.message : 'Unknown'}`, '#ff4444');
    }
    isProcessing = false;
  }
  
  async function executeCommand(cmd: Command) {
    if (cmd.name === 'exit') {
      if (mcpManager) await mcpManager.disconnectAll();
      renderer.destroy();
      process.exit(0);
    }
    const result = cmd.action();
    if (result) addMsg(result, '#888888');
  }
  
  // Track input changes
  input.on('input', (value: string) => {
    inputBuffer = value;
    if (value.startsWith('/')) {
      filterCmdList(value.slice(1));
      if (!cmdMode) showCmdList();
    } else if (cmdMode) {
      hideCmdList();
    }
  });
  
  // Handle global keyboard
  renderer.keyInput.on('keypress', async (key: KeyEvent) => {
    if (key.ctrl && key.name === 'c') {
      if (mcpManager) await mcpManager.disconnectAll();
      renderer.destroy();
      process.exit(0);
    }
    
    if (key.name === 'return') {
      if (cmdMode && filteredCommands.length > 0) {
        const cmd = filteredCommands[cmdIndex];
        hideCmdList();
        input.value = '';
        inputBuffer = '';
        await executeCommand(cmd);
        input.focus();
      } else {
        const text = inputBuffer;
        input.value = '';
        inputBuffer = '';
        hideCmdList();
        await handleInput(text);
        input.focus();
      }
      return;
    }
    
    if (key.name === 'escape' && cmdMode) {
      hideCmdList();
      input.value = '';
      inputBuffer = '';
      input.focus();
      return;
    }
    
    if (cmdMode) {
      if (key.name === 'up') {
        cmdIndex = Math.max(0, cmdIndex - 1);
        updateCmdList();
        return;
      }
      if (key.name === 'down') {
        cmdIndex = Math.min(filteredCommands.length - 1, cmdIndex + 1);
        updateCmdList();
        return;
      }
    }
  });
  
  addMsg(`Welcome to askai! (${provider.name} / ${provider.model})`, '#00d4ff');
  addMsg('Type your question. Use / for commands. Ctrl+C to exit.', '#888888');
  input.focus();
}
