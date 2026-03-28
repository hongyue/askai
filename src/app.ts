import { createCliRenderer, Box, Text, ScrollBox, StyledText, TextareaRenderable, fg, h, stringToStyledText, type KeyEvent } from "@opentui/core"
import { loadConfig } from './config';
import { MCPManager, MCPServerState } from './mcp';
import { createInitialState, createCommands, Command } from './commands';
import { ChatOptions, Message, ToolCall } from './providers/base';
import { createProviderFromConfig } from './providers';
import { MCPTool } from './mcp/client';
import { convertToOpenAITools, convertToAnthropicTools } from './mcp/tools';
import {
  askForExecution,
  detectCodeBlocks,
  executeCommand as executeShellCommand,
  formatCommandBlock,
  formatCommandResult,
  type CommandBlock,
  type ExecutionDecision,
} from './shell';

interface MutableTextNode {
  content: ReturnType<typeof stringToStyledText>;
}

interface MutableBoxNode {
  height: number | 'auto' | `${number}%`;
  visible: boolean;
  add(obj: unknown, index?: number): number;
  remove(id: string): void;
  onMouseScroll?: ((event: { scroll?: { direction?: string; delta?: number } }) => void) | undefined;
}

interface MutableInputNode {
  plainText: string;
  cursorOffset?: number;
  setText(text: string): void;
  focus(): void;
  blur?: () => void;
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
  mode: 'ask' | 'allow-all' | 'reject-all';
}

interface RunAppOptions {
  providerName?: string;
  modelName?: string;
  configPath?: string;
  allowExecute: boolean;
  mcpEnabled: boolean;
  question?: string;
}

interface ActiveTurn {
  id: number;
  controller: AbortController;
  interrupted: boolean;
}

interface ActiveShellCommand {
  command: string;
  proc: ReturnType<typeof Bun.spawn>;
  interrupted: boolean;
  interruptStage: 0 | 1 | 2 | 3;
  escalationTimer?: ReturnType<typeof setTimeout>;
}

const oneShotFeedbackPrompts = [
  'Thinking...',
  'Working on it...',
  'Checking...',
  'Putting it together...',
  'One moment...',
];

const oneShotFeedbackColor = '\x1b[38;5;45m';
const ansiReset = '\x1b[0m';
const mcpDetailsModalHeight = 20;
const mcpDetailsVisibleLineCount = 15;
const approvalActions = [
  { key: 'y', label: 'Yes' },
  { key: 'n', label: 'No' },
  { key: 'a', label: 'All' },
  { key: 'x', label: 'None' },
] as const;
type ApprovalActionKey = typeof approvalActions[number]['key'];

function getRandomOneShotFeedbackPrompt(): string {
  const index = Math.floor(Math.random() * oneShotFeedbackPrompts.length);
  return oneShotFeedbackPrompts[index];
}

function isEscapeKey(key: KeyEvent): boolean {
  return key.name === 'escape'
    || key.name === 'esc'
    || key.sequence === '\x1b'
    || key.raw === '\x1b'
    || key.code === 'Escape'
    || key.baseCode === 27;
}

async function initializeRuntime(options: RunAppOptions): Promise<{
  config: Awaited<ReturnType<typeof loadConfig>>;
  mcpManager: MCPManager | undefined;
  provider: Awaited<ReturnType<typeof createProviderFromConfig>>;
  systemPrompt: string;
  state: ReturnType<typeof createInitialState>;
  getProviderTools: () => any[];
  refreshProviderTools: () => Promise<void>;
  getMcpServerStates: () => MCPServerState[];
  messages: Message[];
}> {
  const config = await loadConfig(options.configPath);
  if (options.providerName) config.provider = options.providerName;
  if (options.modelName) config.providers[config.provider].model = options.modelName;

  let mcpManager: MCPManager | undefined;
  let mcpTools: MCPTool[] = [];

  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    mcpManager = new MCPManager(config);
    await mcpManager.connectAll();
    mcpTools = await mcpManager.listEnabledTools();
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
  const refreshProviderTools = async () => {
    if (mcpManager) {
      await mcpManager.refreshTools();
      mcpTools = await mcpManager.listEnabledTools();
    } else {
      mcpTools = [];
    }
    providerTools = state.mcpEnabled ? convertTools(mcpTools) : [];
  };

  const messages: Message[] = [{ role: 'system', content: systemPrompt }];

  return {
    config,
    mcpManager,
    provider,
    systemPrompt,
    state,
    getProviderTools: () => providerTools,
    refreshProviderTools,
    getMcpServerStates: () => mcpManager ? mcpManager.listServerStates() : [],
    messages,
  };
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

function formatApprovalDialogCommand(block: CommandBlock): string {
  return block.code
    .split('\n')
    .map(line => `$ ${line}`)
    .join('\n');
}

async function getAssistantResponse(
  provider: Awaited<ReturnType<typeof createProviderFromConfig>>,
  messages: Message[],
  mcpEnabled: boolean,
  providerTools: any[],
  options?: ChatOptions,
): Promise<Message> {
  if (mcpEnabled && providerTools.length > 0) {
    return await provider.chatComplete(messages, providerTools, options);
  }

  let fullResponse = '';
  for await (const chunk of provider.chat(messages, mcpEnabled ? providerTools : [], options)) {
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

async function runDetectedCommandBlocks(response: string): Promise<void> {
  const blocks = detectCodeBlocks(response);
  let mode: PendingExecution['mode'] = 'ask';
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    let decision: ExecutionDecision;
    if (mode === 'allow-all') {
      decision = 'allow';
    } else {
      decision = await askForExecution(block);
    }

    if (decision === 'allow-all') {
      mode = 'allow-all';
      const remainingCount = blocks.length - index;
      console.log(`Executing ${remainingCount} command${remainingCount === 1 ? '' : 's'}.`);
      decision = 'allow';
    } else if (decision === 'reject-all') {
      const remainingCount = blocks.length - index;
      console.log(`Skipped ${remainingCount} command${remainingCount === 1 ? '' : 's'}.`);
      return;
    }

    if (decision !== 'allow') {
      console.log('Skipped command execution.');
      continue;
    }

    const result = await executeShellCommand(block.code);
    console.log(formatCommandResult(result));
  }
}

export async function runOneShotApp(options: RunAppOptions & { question: string }): Promise<void> {
  const runtime = await initializeRuntime(options);
  const { provider, state, mcpManager, messages } = runtime;
  let providerTools = runtime.getProviderTools();

  messages.push({ role: 'user', content: options.question });

  try {
    while (true) {
      console.log(`${oneShotFeedbackColor}${getRandomOneShotFeedbackPrompt()}${ansiReset}`);
      const response = await getAssistantResponse(provider, messages, state.mcpEnabled, providerTools);

      if (response.content) {
        console.log(response.content);
      }

      messages.push(response);

      if (response.tool_calls && response.tool_calls.length > 0 && mcpManager) {
        for (const toolCall of response.tool_calls) {
          const args = toolCall.arguments ? JSON.parse(toolCall.arguments) as Record<string, unknown> : {};
          const result = await mcpManager.callTool(toolCall.name, args);
          const content = formatToolContent(result.content);
          messages.push({
            role: 'tool',
            content: content || (result.isError ? 'Tool returned an error.' : 'Tool completed successfully.'),
            tool_call_id: toolCall.id,
          });
        }
        continue;
      }

      if (state.allowExecute && response.content) {
        await runDetectedCommandBlocks(response.content);
      }
      break;
    }
  } finally {
    if (mcpManager) {
      await mcpManager.disconnectAll();
    }
  }
}

export async function runOpenTUIApp(options: RunAppOptions): Promise<void> {
  const runtime = await initializeRuntime(options);
  const { provider, mcpManager, state, messages } = runtime;
  let providerTools = runtime.getProviderTools();
  let mcpModalOpen = false;
  let mcpDetailsOpen = false;
  let mcpServerIndex = 0;
  let mcpDetailsScrollOffset = 0;
  let mcpFocus: 'server' | 'global' = 'server';
  const commands = createCommands(
    state,
    () => {
      void runtime.refreshProviderTools().then(() => {
        providerTools = runtime.getProviderTools();
      });
      if (!state.mcpEnabled) {
        providerTools = [];
      }
    },
    () => {
      while (chatNodeIds.length > 0) {
        const nodeId = chatNodeIds.pop();
        if (nodeId) {
          chatNode.remove(nodeId);
        }
      }
      root.requestRender();
    },
    () => {
      mcpModalOpen = true;
      mcpFocus = 'server';
      renderMcpModal();
    },
  );
  
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
    useKittyKeyboard: {
      disambiguate: true,
    },
  });

  renderer.prependInputHandler((sequence: string) => {
    if (mcpDetailsOpen) {
      const states = runtime.getMcpServerStates();
      const selectedState = states[mcpServerIndex];
      const detailLineCount = getMcpDetailsContentLines(selectedState).length;
      const maxOffset = Math.max(0, detailLineCount - mcpDetailsVisibleLineCount);

      if (sequence === '\x1b' || sequence.toLowerCase() === 'q') {
        closeMcpDetailsModal();
        return true;
      }
      if (sequence === '\x1b[A') {
        mcpDetailsScrollOffset = Math.max(0, mcpDetailsScrollOffset - 1);
        renderMcpDetailsModal();
        return true;
      }
      if (sequence === '\x1b[B') {
        mcpDetailsScrollOffset = Math.min(maxOffset, mcpDetailsScrollOffset + 1);
        renderMcpDetailsModal();
        return true;
      }
      if (sequence === '\x1b[5~') {
        mcpDetailsScrollOffset = Math.max(0, mcpDetailsScrollOffset - 8);
        renderMcpDetailsModal();
        return true;
      }
      if (sequence === '\x1b[6~') {
        mcpDetailsScrollOffset = Math.min(maxOffset, mcpDetailsScrollOffset + 8);
        renderMcpDetailsModal();
        return true;
      }
      if (sequence.length > 0) {
        return true;
      }
    }

    if (mcpModalOpen) {
      if (sequence === '\x1b' || sequence.toLowerCase() === 'q') {
        closeMcpModal();
        return true;
      }
      if (sequence === '\x1b[A') {
        const states = runtime.getMcpServerStates();
        if (states.length > 0) {
          mcpServerIndex = (mcpServerIndex + states.length - 1) % states.length;
          renderMcpModal();
        }
        return true;
      }
      if (sequence === '\x1b[B') {
        const states = runtime.getMcpServerStates();
        if (states.length > 0) {
          mcpServerIndex = (mcpServerIndex + 1) % states.length;
          renderMcpModal();
        }
        return true;
      }
      if (sequence === '\t') {
        mcpFocus = mcpFocus === 'server' ? 'global' : 'server';
        renderMcpModal();
        return true;
      }
      if (sequence === ' ') {
        void runMcpModalToggle();
        return true;
      }
      if (sequence === '\r' || sequence === '\n') {
        if (mcpFocus === 'server') {
          openMcpDetailsModal();
        }
        return true;
      }
      if (sequence.length > 0) {
        return true;
      }
    }

    if (!pendingExecution) {
      return false;
    }

    if (sequence === '\x03') {
      return false;
    }

    const lower = sequence.toLowerCase();
    if (lower === 'y' || lower === 'n' || lower === 'a' || lower === 'x') {
      void handleExecutionApproval(lower as ApprovalActionKey);
      return true;
    }
    if (sequence === '\x1b[D') {
      approvalSelectionIndex = (approvalSelectionIndex + approvalActions.length - 1) % approvalActions.length;
      renderApprovalDialog();
      return true;
    }
    if (sequence === '\x1b[C') {
      approvalSelectionIndex = (approvalSelectionIndex + 1) % approvalActions.length;
      renderApprovalDialog();
      return true;
    }
    if (sequence === '\r' || sequence === '\n') {
      void handleExecutionApproval(approvalActions[approvalSelectionIndex].key);
      return true;
    }
    if (sequence.length > 0) {
      return true;
    }

    return false;
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
  let approvalDraftText = '';
  let approvalDraftCursorOffset = 0;
  let approvalSelectionIndex = 0;
  let approvalActionInFlight = false;
  let activeTurn: ActiveTurn | null = null;
  let nextTurnId = 1;
  let activeShellCommand: ActiveShellCommand | null = null;

  async function handleInterruptSignal(): Promise<boolean> {
    if (isProcessing && activeTurn) {
      activeTurn.interrupted = true;
      activeTurn.controller.abort();
      return true;
    }

    if (activeShellCommand) {
      activeShellCommand.interrupted = true;
      if (activeShellCommand.interruptStage === 0) {
        activeShellCommand.interruptStage = 1;
        try {
          process.kill(-activeShellCommand.proc.pid, 'SIGINT');
        } catch {
          activeShellCommand.proc.kill('SIGINT');
        }
        addMsg(`Interrupt requested for shell command: ${activeShellCommand.command}`, '#ffaa00');
        activeShellCommand.escalationTimer = setTimeout(() => {
          if (!activeShellCommand || activeShellCommand.proc.killed) {
            return;
          }
          activeShellCommand.interruptStage = 2;
          try {
            process.kill(-activeShellCommand.proc.pid, 'SIGTERM');
          } catch {
            activeShellCommand.proc.kill('SIGTERM');
          }
          addMsg(`Escalating shell command stop: ${activeShellCommand.command}`, '#ffaa00');
          activeShellCommand.escalationTimer = setTimeout(() => {
            if (!activeShellCommand || activeShellCommand.proc.killed) {
              return;
            }
            activeShellCommand.interruptStage = 3;
            try {
              process.kill(-activeShellCommand.proc.pid, 'SIGKILL');
            } catch {
              activeShellCommand.proc.kill('SIGKILL');
            }
            addMsg(`Force killed shell command: ${activeShellCommand.command}`, '#ff4444');
          }, 1500);
        }, 1500);
      } else if (activeShellCommand.interruptStage === 1) {
        try {
          process.kill(-activeShellCommand.proc.pid, 'SIGTERM');
        } catch {
          activeShellCommand.proc.kill('SIGTERM');
        }
        activeShellCommand.interruptStage = 2;
        addMsg(`Escalating shell command stop: ${activeShellCommand.command}`, '#ffaa00');
      } else if (activeShellCommand.interruptStage === 2) {
        try {
          process.kill(-activeShellCommand.proc.pid, 'SIGKILL');
        } catch {
          activeShellCommand.proc.kill('SIGKILL');
        }
        activeShellCommand.interruptStage = 3;
        addMsg(`Force killed shell command: ${activeShellCommand.command}`, '#ff4444');
      }
      return true;
    }

    return false;
  }
  
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

  const approvalDialog = Box({
    id: 'approval-dialog',
    position: 'absolute',
    width: '70%',
    left: '15%',
    top: '35%',
    height: 'auto',
    flexDirection: 'column',
    visible: false,
    backgroundColor: '#1b1b1b',
    padding: 1,
  });
  const approvalDialogText = Text({
    id: 'approval-dialog-text',
    content: stringToStyledText(''),
    fg: '#ffaa00',
  });
  approvalDialog.add(approvalDialogText);

  const mcpModal = Box({
    id: 'mcp-modal',
    position: 'absolute',
    width: '78%',
    left: '11%',
    top: '18%',
    height: 'auto',
    flexDirection: 'column',
    visible: false,
    backgroundColor: '#161616',
    padding: 1,
  });
  const mcpModalText = Text({
    id: 'mcp-modal-text',
    content: stringToStyledText(''),
    fg: '#cfcfcf',
  });
  mcpModal.add(mcpModalText);

  const mcpDetailsModal = Box({
    id: 'mcp-details-modal',
    position: 'absolute',
    width: '74%',
    left: '13%',
    top: '22%',
    height: mcpDetailsModalHeight,
    flexDirection: 'column',
    visible: false,
    backgroundColor: '#101010',
    padding: 1,
  });
  const mcpDetailsModalText = Text({
    id: 'mcp-details-modal-text',
    content: stringToStyledText(''),
    fg: '#d8d8d8',
  });
  mcpDetailsModal.add(mcpDetailsModalText);
  
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
  root.add(approvalDialog);
  root.add(mcpModal);
  root.add(mcpDetailsModal);
  renderer.root.add(root);

  const liveCmdListBox = renderer.root.findDescendantById('cmd-list-box') as MutableBoxNode | undefined;
  const liveCmdListText = renderer.root.findDescendantById('command-palette') as MutableTextNode | undefined;
  const liveInput = renderer.root.findDescendantById('main-input') as MutableInputNode | undefined;
  const liveChat = renderer.root.findDescendantById('chat-box') as MutableBoxNode | undefined;
  const liveApprovalDialog = renderer.root.findDescendantById('approval-dialog') as MutableBoxNode | undefined;
  const liveApprovalDialogText = renderer.root.findDescendantById('approval-dialog-text') as MutableTextNode | undefined;
  const liveMcpModal = renderer.root.findDescendantById('mcp-modal') as MutableBoxNode | undefined;
  const liveMcpModalText = renderer.root.findDescendantById('mcp-modal-text') as MutableTextNode | undefined;
  const liveMcpDetailsModal = renderer.root.findDescendantById('mcp-details-modal') as MutableBoxNode | undefined;
  const liveMcpDetailsModalText = renderer.root.findDescendantById('mcp-details-modal-text') as MutableTextNode | undefined;

  if (!liveCmdListBox || !liveCmdListText || !liveInput || !liveChat || !liveApprovalDialog || !liveApprovalDialogText || !liveMcpModal || !liveMcpModalText || !liveMcpDetailsModal || !liveMcpDetailsModalText) {
    throw new Error('Failed to initialize TUI render tree');
  }

  const cmdListBoxNode = liveCmdListBox;
  const cmdListTextNode = liveCmdListText;
  const inputNode = liveInput;
  const chatNode = liveChat;
  const approvalDialogNode = liveApprovalDialog;
  const approvalDialogTextNode = liveApprovalDialogText;
  const mcpModalNode = liveMcpModal;
  const mcpModalTextNode = liveMcpModalText;
  const mcpDetailsModalNode = liveMcpDetailsModal;
  const mcpDetailsModalTextNode = liveMcpDetailsModalText;

  function updateFooterLayout() {
    const paletteHeight = palette.open ? Math.min(palette.matches.length, 5) : 0;
    cmdListBoxNode.height = paletteHeight;
    root.requestRender();
  }

  function restoreApprovalDraft(): void {
    if (inputNode.plainText !== approvalDraftText) {
      inputNode.setText(approvalDraftText);
    }
    if (typeof inputNode.cursorOffset === 'number') {
      inputNode.cursorOffset = Math.max(0, Math.min(approvalDraftCursorOffset, approvalDraftText.length));
    }
    inputBuffer = approvalDraftText;
    inputNode.focus();
  }

  function hideApprovalDialog(): void {
    approvalDialogNode.visible = false;
    approvalDialogTextNode.content = stringToStyledText('');
    root.requestRender();
    inputNode.focus();
  }

  function closeMcpModal(): void {
    mcpModalOpen = false;
    closeMcpDetailsModal();
    mcpModalNode.visible = false;
    mcpModalTextNode.content = stringToStyledText('');
    root.requestRender();
    inputNode.focus();
  }

  function closeMcpDetailsModal(): void {
    mcpDetailsOpen = false;
    mcpDetailsScrollOffset = 0;
    mcpDetailsModalNode.visible = false;
    mcpDetailsModalTextNode.content = stringToStyledText('');
    root.requestRender();
    if (!mcpModalOpen) {
      inputNode.focus();
    }
  }

  function getMcpGlobalToggleLine(): string {
    const label = state.mcpEnabled ? 'MCP Servers Enabled' : 'MCP Servers Disabled';
    return mcpFocus === 'global' ? `[ ${label} ]` : `  ${label}  `;
  }

  function renderMcpModal(): void {
    if (!mcpModalOpen) {
      closeMcpModal();
      return;
    }

    const states = runtime.getMcpServerStates();
    if (states.length === 0) {
      mcpModalTextNode.content = stringToStyledText('MCP\n\nNo MCP servers configured.\n\nEsc/q close');
      mcpModalNode.visible = true;
      root.requestRender();
      return;
    }

    mcpServerIndex = Math.max(0, Math.min(mcpServerIndex, states.length - 1));
    const selectedState = states[mcpServerIndex];
    const summaryLines = [
      `Selected: ${selectedState.name}`,
      `${selectedState.transport} • ${selectedState.connected ? 'connected' : 'disconnected'} • ${selectedState.enabled ? 'enabled' : 'disabled'}`,
      `Target: ${selectedState.target || 'n/a'}`,
      `Tools: ${selectedState.toolCount}`,
      selectedState.lastError ? `Last error: ${selectedState.lastError}` : '',
      '',
      `Space: ${selectedState.enabled ? 'disable' : 'enable'} selected server`,
    ].filter(Boolean).join('\n');

    const header = stringToStyledText('MCP Servers\n\n');
    const serverChunks = states.flatMap((server, index) => {
      const marker = index === mcpServerIndex ? '>' : ' ';
      const enabled = server.enabled ? 'enabled ' : 'disabled';
      const connected = server.connected ? 'connected   ' : 'disconnected';
      const line = `${marker} ${server.name.padEnd(16)} ${connected} ${enabled} ${String(server.toolCount).padStart(2)} tools`;
      const isFocused = mcpFocus === 'server' && index === mcpServerIndex;
      const chunk = isFocused ? fg('#00d4ff')(line) : fg('#a8a8a8')(line);
      return index < states.length - 1 ? [chunk, fg('#a8a8a8')('\n')] : [chunk];
    });
    const rest = stringToStyledText([
      '',
      '',
      'Summary',
      summaryLines,
      '',
      getMcpGlobalToggleLine(),
      '',
      '↑/↓ select server   Tab switch focus   Space toggle   Enter details   Esc/q close',
    ].join('\n'));
    mcpModalTextNode.content = new StyledText([
      ...header.chunks,
      ...serverChunks,
      ...rest.chunks,
    ]);
    mcpModalNode.visible = true;
    if (inputNode.blur) {
      inputNode.blur();
    }
    root.requestRender();
  }

  function renderMcpDetailsModal(): void {
    if (!mcpDetailsOpen) {
      closeMcpDetailsModal();
      return;
    }

    const states = runtime.getMcpServerStates();
    const selectedState = states[mcpServerIndex];
    if (!selectedState) {
      closeMcpDetailsModal();
      return;
    }

    const allLines = getMcpDetailsContentLines(selectedState);
    const visibleLineCount = mcpDetailsVisibleLineCount;
    const maxOffset = Math.max(0, allLines.length - visibleLineCount);
    mcpDetailsScrollOffset = Math.max(0, Math.min(mcpDetailsScrollOffset, maxOffset));
    const visibleLines = allLines.slice(mcpDetailsScrollOffset, mcpDetailsScrollOffset + visibleLineCount);
    const content = [
      ...visibleLines,
      '',
      `Scroll ${mcpDetailsScrollOffset + 1}-${Math.min(mcpDetailsScrollOffset + visibleLines.length, allLines.length)} / ${allLines.length}`,
      '↑/↓ scroll   PgUp/PgDn jump   Esc/q close',
    ].join('\n');

    mcpDetailsModalTextNode.content = stringToStyledText(content);
    mcpDetailsModalNode.visible = true;
    if (inputNode.blur) {
      inputNode.blur();
    }
    root.requestRender();
  }

  function openMcpDetailsModal(): void {
    mcpDetailsOpen = true;
    mcpDetailsScrollOffset = 0;
    renderMcpDetailsModal();
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
      ...wrapLines(`Usage: ${selectedState.enabled ? 'enabled' : 'disabled'}`),
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
    ];
  }

  mcpDetailsModalNode.onMouseScroll = (event) => {
    if (!mcpDetailsOpen) {
      return;
    }

    const states = runtime.getMcpServerStates();
    const selectedState = states[mcpServerIndex];
    const allLines = getMcpDetailsContentLines(selectedState);
    const visibleLineCount = mcpDetailsVisibleLineCount;
    const maxOffset = Math.max(0, allLines.length - visibleLineCount);
    const delta = Math.max(1, event.scroll?.delta ?? 1);

    if (event.scroll?.direction === 'up') {
      mcpDetailsScrollOffset = Math.max(0, mcpDetailsScrollOffset - delta);
      renderMcpDetailsModal();
    } else if (event.scroll?.direction === 'down') {
      mcpDetailsScrollOffset = Math.min(maxOffset, mcpDetailsScrollOffset + delta);
      renderMcpDetailsModal();
    }
  };

  async function runMcpModalToggle(): Promise<void> {
    if (!mcpManager) {
      closeMcpModal();
      return;
    }

    const states = runtime.getMcpServerStates();
    const selectedState = states[mcpServerIndex];
    if (!selectedState) {
      return;
    }

    if (mcpFocus === 'server') {
      mcpManager.setServerEnabled(selectedState.name, !selectedState.enabled);
    } else {
      state.mcpEnabled = !state.mcpEnabled;
    }

    await runtime.refreshProviderTools();
    providerTools = runtime.getProviderTools();
    renderMcpModal();
  }

  function getApprovalActionsLine(): string {
    const line = approvalActions
      .map((action, index) => {
        const label = `${action.key.toUpperCase()}: ${action.label}`;
        return index === approvalSelectionIndex ? `[ ${label} ]` : `  ${label}  `;
      })
      .join('   ');
    const dialogWidth = 54;
    const padding = Math.max(0, Math.floor((dialogWidth - line.length) / 2));
    return `${' '.repeat(padding)}${line}`;
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

  function isAbortError(error: unknown): boolean {
    return error instanceof Error
      && (error.name === 'AbortError' || error.message.toLowerCase().includes('abort'));
  }

  function ensureActiveTurn(turnId: number): void {
    if (!activeTurn || activeTurn.id !== turnId || activeTurn.controller.signal.aborted) {
      throw new Error('Turn interrupted');
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

  function renderApprovalDialog(): void {
    if (!pendingExecution) {
      hideApprovalDialog();
      return;
    }

    const block = pendingExecution.blocks[pendingExecution.index];
    const ordinal = pendingExecution.blocks.length > 1
      ? ` (${pendingExecution.index + 1}/${pendingExecution.blocks.length})`
      : '';

    approvalDialogTextNode.content = stringToStyledText(
      `Shell command detected${ordinal}\n\n${formatApprovalDialogCommand(block)}\n\n${getApprovalActionsLine()}\n\nUse left/right to choose, Enter to confirm`
    );
    approvalDialogNode.visible = true;
    if (inputNode.blur) {
      inputNode.blur();
    }
    root.requestRender();
  }

  function promptPendingExecution(resetSelection = true): void {
    approvalDraftText = inputNode.plainText;
    approvalDraftCursorOffset = typeof inputNode.cursorOffset === 'number' ? inputNode.cursorOffset : approvalDraftText.length;
    if (resetSelection) {
      approvalSelectionIndex = 0;
    }
    renderApprovalDialog();
  }

  async function runCommandBlock(block: CommandBlock): Promise<void> {
    addMsg(`$ ${block.code}`, '#00ff88');
    let shellCommandRef: ActiveShellCommand | undefined;
    const result = await executeShellCommand(block.code, {
      onStart: (proc) => {
        shellCommandRef = {
          command: block.code,
          proc,
          interrupted: false,
          interruptStage: 0,
        };
        activeShellCommand = shellCommandRef;
      },
    });
    if (shellCommandRef?.escalationTimer) {
      clearTimeout(shellCommandRef.escalationTimer);
    }
    if (shellCommandRef && shellCommandRef.interrupted) {
      result.interrupted = true;
    }
    if (activeShellCommand?.command === block.code) {
      activeShellCommand = null;
    }
    for (const line of formatCommandResult(result).split('\n')) {
      addMsg(line, result.exitCode === 0 ? '#888888' : '#ff4444');
    }
  }

  function advancePendingExecution(): void {
    if (!pendingExecution) {
      return;
    }

    pendingExecution = pendingExecution.index + 1 < pendingExecution.blocks.length
      ? { ...pendingExecution, index: pendingExecution.index + 1 }
      : null;
  }

  async function handleExecutionApproval(action: ApprovalActionKey): Promise<void> {
    if (!pendingExecution || approvalActionInFlight) {
      return;
    }
    approvalActionInFlight = true;

    try {
      if (action === 'a') {
        hideApprovalDialog();
        addMsg('Executing remaining commands.', '#888888');
        while (pendingExecution) {
          const block = pendingExecution.blocks[pendingExecution.index];
          await runCommandBlock(block);
          advancePendingExecution();
        }
        restoreApprovalDraft();
        return;
      }

      if (action === 'x') {
        hideApprovalDialog();
        addMsg('Skipped remaining commands.', '#888888');
        pendingExecution = null;
        restoreApprovalDraft();
        return;
      }

      if (action === 'y') {
        hideApprovalDialog();
        const block = pendingExecution.blocks[pendingExecution.index];
        await runCommandBlock(block);
        advancePendingExecution();
        if (pendingExecution) {
          restoreApprovalDraft();
          promptPendingExecution();
        } else {
          restoreApprovalDraft();
        }
        return;
      }

      if (action === 'n') {
        hideApprovalDialog();
        addMsg('Skipped command execution.', '#888888');
        advancePendingExecution();
        if (pendingExecution) {
          restoreApprovalDraft();
          promptPendingExecution();
        } else {
          restoreApprovalDraft();
        }
        return;
      }
    } finally {
      approvalActionInFlight = false;
      if (pendingExecution) {
        restoreApprovalDraft();
      }
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
      mode: 'ask',
    };
    promptPendingExecution();
  }

  async function handleToolCalls(toolCalls: ToolCall[], turnId?: number): Promise<void> {
    if (!mcpManager || toolCalls.length === 0) {
      return;
    }

    for (const toolCall of toolCalls) {
      if (turnId !== undefined) {
        ensureActiveTurn(turnId);
      }

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

  async function handleInput(text: string) {
    if (isProcessing) return;

    if (pendingExecution) {
      return;
    }

    if (!text.trim()) return;
    
    if (text.startsWith('/')) {
      const commandName = text.slice(1).trim();
      const cmd = commands.find(c => c.name === commandName);
      if (cmd) {
        await executeCommand(cmd);
        return;
      }
    }
    
    isProcessing = true;
    const turnId = nextTurnId++;
    const controller = new AbortController();
    activeTurn = {
      id: turnId,
      controller,
      interrupted: false,
    };
    addMsg(`> ${text}`, '#00ff88');
    addMsg('Thinking...', '#888888');
    messages.push({ role: 'user', content: text });
    
    try {
      while (true) {
        ensureActiveTurn(turnId);
        const response = await getAssistantResponse(provider, messages, state.mcpEnabled, providerTools, {
          signal: controller.signal,
        });
        ensureActiveTurn(turnId);
        removeLastMsg();

        if (response.content) {
          for (const line of response.content.split('\n')) {
            addMsg(line);
          }
        }

        messages.push(response);

        if (response.tool_calls && response.tool_calls.length > 0) {
          await handleToolCalls(response.tool_calls, turnId);
          ensureActiveTurn(turnId);
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
      if (isAbortError(error) || (error instanceof Error && error.message === 'Turn interrupted')) {
        addMsg('Interrupted.', '#ffaa00');
      } else {
        addMsg(`Error: ${error instanceof Error ? error.message : 'Unknown'}`, '#ff4444');
      }
    }
    isProcessing = false;
    if (activeTurn?.id === turnId) {
      activeTurn = null;
    }
  }
  
  async function executeCommand(cmd: Command) {
    addMsg(`> /${cmd.name}`, '#00ff88');
    if (cmd.name === 'exit' || cmd.name === 'quit') {
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
    if (pendingExecution) {
      return;
    }

    if (palette.open) {
      if (palette.matches.length === 0) {
        return;
      }

      const cmd = palette.matches[palette.selectedIndex];
      resetInput();
      await executeCommand(cmd);
      return;
    }

    const text = inputNode.plainText;
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
    if (mcpModalOpen) {
      return;
    }
    if (pendingExecution) {
      if (inputNode.plainText !== approvalDraftText) {
        inputNode.setText(approvalDraftText);
      }
      inputBuffer = approvalDraftText;
      return;
    }
    syncCommandPalette(inputNode.plainText);
  };

  inputNode.onSubmit = async () => {
    if (mcpModalOpen) {
      return;
    }
    if (pendingExecution) {
      return;
    }
    await submitCurrentInput();
  };
  
  // Handle global keyboard
  renderer.keyInput.on('keypress', async (key: KeyEvent) => {
    if (key.ctrl && key.name === 'c') {
      if (await handleInterruptSignal()) {
        return;
      }
      if (mcpManager) await mcpManager.disconnectAll();
      renderer.destroy();
      process.exit(0);
    }

    if (mcpDetailsOpen && isEscapeKey(key)) {
      closeMcpDetailsModal();
      return;
    }

    if (mcpModalOpen && isEscapeKey(key)) {
      closeMcpModal();
      return;
    }

    if (mcpModalOpen && !key.ctrl && !key.meta) {
      return;
    }

    if (pendingExecution && !key.ctrl && !key.meta) {
      return;
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

  const sigintHandler = async () => {
    if (await handleInterruptSignal()) {
      return;
    }
    if (mcpManager) {
      await mcpManager.disconnectAll();
    }
    renderer.destroy();
    process.exit(0);
  };

  process.on('SIGINT', sigintHandler);
  
  updateFooterLayout();
  inputNode.focus();
}
