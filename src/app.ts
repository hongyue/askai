import { 
  createCliRenderer, 
  Box, Text, ScrollBox, StyledText, 
  TextareaRenderable, fg, h, 
  stringToStyledText, 
  type KeyEvent, 
  BoxRenderable 
} from "@opentui/core"
import {
  customProviderIds,
  fixedProviderIds,
  getProviderLabel,
  loadConfig,
  removeProviderModel,
  resolveConfigPath,
  resolveProviderConfig,
  saveConfig,
  setActiveProvider,
  setProviderModel,
  upsertProvider,
  type ProviderConfig,
  type ProviderType,
  type ResolvedProviderConfig,
} from './config';
import { MCPManager, MCPServerState } from './mcp';
import { createInitialState, createCommands, Command } from './commands';
import { ChatOptions, Message, ToolCall } from './providers/base';
import { createProviderFromConfig } from './providers';
import { fetchAvailableModels } from './providers/models';
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
  x?: number;
  y?: number;
  width?: number;
  height?: number | 'auto' | `${number}%`;
  visible: boolean;
  add(obj: unknown, index?: number): number;
  remove(id: string): void;
  onMouseDown?: ((event: { x: number; y: number }) => void) | undefined;
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

type ProviderModalFocus = 'providers';
type ModelModalFocus = 'providers' | 'filter' | 'models';

interface ProviderFormState {
  providerId: string;
  values: Record<string, string>;
  activeFieldIndex: number;
  cursorOffset: number;
  error?: string;
}

interface ProviderFormField {
  key: string;
  label: string;
  kind: 'text';
}

interface ProviderSlot {
  id: string;
  displayName: string;
  kind: 'openai' | 'anthropic' | 'openrouter' | 'custom';
  configured: boolean;
  apiKeyConfigured: boolean;
  baseUrl?: string;
  model?: string;
  models: string[];
  resolved?: ResolvedProviderConfig;
}

interface FilterState {
  value: string;
  cursorOffset: number;
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
const statusSpinnerFrames = ['|', '/', '-', '\\'] as const;
const enableModifyOtherKeys = '\x1b[>4;2m';
const resetModifyOtherKeys = '\x1b[>4m';
const shiftEnterSequences = new Set([
  '\x1b[13;2u',
  '\x1b[27;2;13~',
  '\x1b[13;2~',
]);
const approvalActions = [
  { key: 'y', label: 'Yes' },
  { key: 'n', label: 'No' },
  { key: 'a', label: 'All' },
  { key: 'x', label: 'None' },
] as const;
const providerModalVisibleItems = 8;
const providerModalVisibleModels = 8;
const providerFormFields: ProviderFormField[] = [
  { key: 'display_name', label: 'Display Name', kind: 'text' },
  { key: 'api_key', label: 'API Key', kind: 'text' },
  { key: 'base_url', label: 'Base URL', kind: 'text' },
  { key: 'model', label: 'Model Name', kind: 'text' },
];
type ApprovalActionKey = typeof approvalActions[number]['key'];
const presetProviderMeta = [
  { id: 'openai', displayName: 'OpenAI', kind: 'openai' as const, baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  { id: 'anthropic', displayName: 'Anthropic', kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'openrouter', displayName: 'OpenRouter', kind: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini' },
] as const;
const promptAccentBorderChars = {
  topLeft: '▌',
  topRight: ' ',
  bottomLeft: '▌',
  bottomRight: ' ',
  horizontal: ' ',
  vertical: '▌',
  topT: '▌',
  bottomT: '▌',
  leftT: '▌',
  rightT: ' ',
  cross: '▌',
} as const;

function clampScrollOffset(selectedIndex: number, currentOffset: number, visibleCount: number, totalCount: number): number {
  if (totalCount <= visibleCount) {
    return 0;
  }

  let nextOffset = currentOffset;
  if (selectedIndex < nextOffset) {
    nextOffset = selectedIndex;
  } else if (selectedIndex >= nextOffset + visibleCount) {
    nextOffset = selectedIndex - visibleCount + 1;
  }

  return Math.max(0, Math.min(nextOffset, totalCount - visibleCount));
}

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
  configPath: string;
  mcpManager: MCPManager | undefined;
  getProvider: () => Awaited<ReturnType<typeof createProviderFromConfig>>;
  getResolvedProvider: () => ResolvedProviderConfig;
  systemPrompt: string;
  state: ReturnType<typeof createInitialState>;
  getProviderTools: () => any[];
  refreshProviderTools: () => Promise<void>;
  switchProvider: (providerId: string, persist?: boolean) => Promise<Awaited<ReturnType<typeof createProviderFromConfig>>>;
  switchModel: (model: string, persist?: boolean) => Promise<Awaited<ReturnType<typeof createProviderFromConfig>>>;
  persistConfig: () => Promise<void>;
  getMcpServerStates: () => MCPServerState[];
  messages: Message[];
}> {
  const configPath = resolveConfigPath(options.configPath);
  const config = await loadConfig(configPath);
  if (options.providerName) {
    setActiveProvider(config, options.providerName);
  }
  if (options.modelName) {
    setProviderModel(config, config.provider, options.modelName);
  }

  let mcpManager: MCPManager | undefined;
  let mcpTools: MCPTool[] = [];

  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    mcpManager = new MCPManager(config);
    await mcpManager.connectAll();
    mcpTools = await mcpManager.listEnabledTools();
  }

  let resolvedProvider = resolveProviderConfig(config);
  let provider = await createProviderFromConfig(resolvedProvider);
  const systemPrompt = config.system_prompt || 'You are a helpful terminal assistant.';
  const state = createInitialState(options.allowExecute, options.mcpEnabled);

  function convertTools(providerType: ProviderType, tools: MCPTool[]): any[] {
    if (tools.length === 0) return [];
    switch (providerType) {
      case 'openai-compatible':
        return convertToOpenAITools(tools);
      case 'anthropic':
        return convertToAnthropicTools(tools);
      default:
        return [];
    }
  }

  let providerTools = convertTools(resolvedProvider.type, mcpTools);
  const refreshProviderTools = async () => {
    if (mcpManager) {
      await mcpManager.refreshTools();
      mcpTools = await mcpManager.listEnabledTools();
    } else {
      mcpTools = [];
    }
    providerTools = state.mcpEnabled ? convertTools(resolvedProvider.type, mcpTools) : [];
  };

  const persistConfig = async () => {
    await saveConfig(config, configPath);
  };

  const rebuildProvider = async (persist: boolean) => {
    resolvedProvider = resolveProviderConfig(config);
    provider = await createProviderFromConfig(resolvedProvider);
    await refreshProviderTools();
    if (persist) {
      await persistConfig();
    }
    return provider;
  };

  const switchProvider = async (providerId: string, persist = true) => {
    setActiveProvider(config, providerId);
    return rebuildProvider(persist);
  };

  const switchModel = async (model: string, persist = true) => {
    setProviderModel(config, config.provider, model);
    return rebuildProvider(persist);
  };

  const messages: Message[] = [{ role: 'system', content: systemPrompt }];

  return {
    config,
    configPath,
    mcpManager,
    getProvider: () => provider,
    getResolvedProvider: () => resolvedProvider,
    systemPrompt,
    state,
    getProviderTools: () => providerTools,
    refreshProviderTools,
    switchProvider,
    switchModel,
    persistConfig,
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

function getProviderSummary(provider: ResolvedProviderConfig): string {
  return `${getProviderLabel(provider)} • ${provider.type} • ${provider.model}`;
}

function normalizeProviderFormValues(values: Record<string, string>): Record<string, string> {
  const nextValues = { ...values };
  nextValues.display_name = nextValues.display_name || '';
  nextValues.api_key = nextValues.api_key || '';
  nextValues.base_url = nextValues.base_url || '';
  nextValues.model = nextValues.model || '';
  return nextValues;
}

function formatProviderFormTextValue(value: string, cursorOffset: number): string {
  const clampedOffset = Math.max(0, Math.min(cursorOffset, value.length));
  return `${value.slice(0, clampedOffset)}█${value.slice(clampedOffset)}` || '█';
}

function formatFilterValue(value: string, cursorOffset: number, active: boolean): string {
  if (!active && value.length === 0) {
    return '(type to filter)';
  }

  if (!active) {
    return value;
  }

  const clampedOffset = Math.max(0, Math.min(cursorOffset, value.length));
  return `${value.slice(0, clampedOffset)}█${value.slice(clampedOffset)}` || '█';
}

function filterModels(models: string[], filterValue: string): string[] {
  const normalizedFilter = filterValue.trim().toLowerCase();
  if (!normalizedFilter) {
    return models;
  }

  return models.filter(model => model.toLowerCase().includes(normalizedFilter));
}

function getVisibleProviderFormFields(providerId: string): ProviderFormField[] {
  const isCustomProvider = customProviderIds.includes(providerId as typeof customProviderIds[number]);
  return providerFormFields.filter(field => {
    if (field.key === 'display_name') {
      return isCustomProvider;
    }
    if (field.key === 'base_url') {
      return isCustomProvider;
    }
    if (field.key === 'model') {
      return isCustomProvider;
    }
    return field.key === 'api_key';
  });
}

function isCustomProviderId(providerId: string): boolean {
  return customProviderIds.includes(providerId as typeof customProviderIds[number]);
}

function getPresetProviderMeta(providerId: string) {
  return presetProviderMeta.find(item => item.id === providerId);
}

function getProviderPlaceholderLabel(providerId: string): string {
  const preset = getPresetProviderMeta(providerId);
  if (preset) {
    return preset.displayName;
  }
  const customIndex = customProviderIds.findIndex(id => id === providerId);
  return customIndex >= 0 ? `Custom ${customIndex + 1}` : providerId;
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
  const { state, mcpManager, messages } = runtime;
  const provider = runtime.getProvider();
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
  const { mcpManager, state, messages, config } = runtime;
  let provider = runtime.getProvider();
  let resolvedProvider = runtime.getResolvedProvider();
  let providerTools = runtime.getProviderTools();
  let mcpModalOpen = false;
  let mcpDetailsOpen = false;
  let mcpServerIndex = 0;
  let mcpDetailsScrollOffset = 0;
  let mcpFocus: 'server' | 'global' = 'server';
  let providerModalOpen = false;
  let providerModalProviderIndex = 0;
  let providerModalProviderScrollOffset = 0;
  let modelModalOpen = false;
  let modelModalFocus: ModelModalFocus = 'models';
  let modelModalProviderIndex = 0;
  let modelModalModelIndex = 0;
  let modelModalProviderScrollOffset = 0;
  let modelModalModelScrollOffset = 0;
  let modelModalFilter: FilterState = { value: '', cursorOffset: 0 };
  let providerFormState: ProviderFormState | null = null;
  let providerModalNotice: string | null = null;
  let modelModalNotice: string | null = null;
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
    async (args) => handleProviderCommand(args),
    async (args) => handleModelCommand(args),
  );
  
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: 'alternate-screen',
    useKittyKeyboard: {
      disambiguate: true,
      allKeysAsEscapes: true,
    },
  });
  process.stdout.write(enableModifyOtherKeys);

  renderer.prependInputHandler((sequence: string) => {
    if (providerModalOpen || modelModalOpen) {
      if (sequence === '\x03') {
        return false;
      }
      if (providerModalOpen) {
        void handleProviderModalSequence(sequence);
      } else {
        void handleModelModalSequence(sequence);
      }
      return true;
    }

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
  let statusSpinnerIndex = 0;

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
  root.add(Text({ id: 'header-text', content: ` Welcome to askai! (${provider.label} / ${provider.model})`, fg: '#00d4ff' }));
  
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
    paddingLeft: 1,
  });
  const cmdListText = Text({ id: 'command-palette', content: stringToStyledText(''), fg: '#888888' });
  cmdListBox.add(cmdListText);

  const statusBar = Box({
    id: 'status-bar',
    width: '100%',
    height: 1,
    flexShrink: 0,
    backgroundColor: '#181818',
    paddingLeft: 0,
    paddingRight: 1,
  });
  const statusBarText = Text({
    id: 'status-bar-text',
    content: stringToStyledText(' Ready'),
    fg: '#7a7a7a',
  });
  statusBar.add(statusBarText);

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

  const providerModal = Box({
    id: 'provider-modal',
    position: 'absolute',
    width: '82%',
    left: '9%',
    top: '14%',
    height: 'auto',
    flexDirection: 'column',
    visible: false,
    backgroundColor: '#141414',
    padding: 1,
  });
  const providerModalText = Text({
    id: 'provider-modal-text',
    content: stringToStyledText(''),
    fg: '#d8d8d8',
  });
  providerModal.add(providerModalText);

  const modelModal = Box({
    id: 'model-modal',
    position: 'absolute',
    width: '82%',
    left: '9%',
    top: '14%',
    height: 'auto',
    flexDirection: 'column',
    visible: false,
    backgroundColor: '#141414',
    padding: 1,
  });
  const modelModalText = Text({
    id: 'model-modal-text',
    content: stringToStyledText(''),
    fg: '#d8d8d8',
  });
  modelModal.add(modelModalText);
  
  const inputRow = Box({
    id: 'input-row',
    width: '100%',
    height: 'auto',
    flexShrink: 0,
    flexDirection: 'row',
    backgroundColor: '#1f1f1f',
    paddingLeft: 0,
    paddingRight: 1,
  });
  inputRow.add(Box({ 
    width: 2,
    height: '100%',
    flexDirection: 'column', 
    backgroundColor: '#1f1f1f',
    border: false,
  }).add(Text({ content: '>', fg: '#00d4ff'})));
  
  const input = h(TextareaRenderable, {
    id: 'main-input',
    flexGrow: 1,
    height: 'auto',
    minHeight: 1,
    maxHeight: 20,
    placeholder: 'Type / for commands...',
    textColor: '#ffffff',
    backgroundColor: '#1f1f1f',
    cursorColor: '#00d4ff',
    wrapMode: 'word',
    keyBindings: [
      { name: 'return', action: 'submit' },
      { name: 'return', shift: true, action: 'newline' },
      { name: 'j', shift: true, action: "newline" },
    ],
  });
  inputRow.add(input);

  const bottomBox = Box({
    id: 'bottom-box',
    width: '100%',
    height: 'auto',
    flexShrink: 0,
    flexDirection: 'row',
  });
  const inputBox = Box({
    id: 'input-box',
    width: '100%',
    height: 'auto',
    flexDirection: 'column',
    backgroundColor: '#1f1f1f',
    border: ['left'],
    borderColor: '#ff9e3d',
    customBorderChars: promptAccentBorderChars,
  });
  inputBox.add(inputRow);
  inputBox.add(cmdListBox);
  inputBox.add(statusBar);
  bottomBox.add(inputBox);
  root.add(bottomBox);
  root.add(approvalDialog);
  root.add(mcpModal);
  root.add(mcpDetailsModal);
  root.add(providerModal);
  root.add(modelModal);
  renderer.root.add(root);

  const liveCmdListBox = renderer.root.findDescendantById('cmd-list-box') as MutableBoxNode | undefined;
  const liveCmdListText = renderer.root.findDescendantById('command-palette') as MutableTextNode | undefined;
  const liveStatusBarText = renderer.root.findDescendantById('status-bar-text') as MutableTextNode | undefined;
  const liveHeaderText = renderer.root.findDescendantById('header-text') as MutableTextNode | undefined;
  const liveInput = renderer.root.findDescendantById('main-input') as MutableInputNode | undefined;
  const liveChat = renderer.root.findDescendantById('chat-box') as MutableBoxNode | undefined;
  const liveApprovalDialog = renderer.root.findDescendantById('approval-dialog') as MutableBoxNode | undefined;
  const liveApprovalDialogText = renderer.root.findDescendantById('approval-dialog-text') as MutableTextNode | undefined;
  const liveMcpModal = renderer.root.findDescendantById('mcp-modal') as MutableBoxNode | undefined;
  const liveMcpModalText = renderer.root.findDescendantById('mcp-modal-text') as MutableTextNode | undefined;
  const liveMcpDetailsModal = renderer.root.findDescendantById('mcp-details-modal') as MutableBoxNode | undefined;
  const liveMcpDetailsModalText = renderer.root.findDescendantById('mcp-details-modal-text') as MutableTextNode | undefined;
  const liveProviderModal = renderer.root.findDescendantById('provider-modal') as MutableBoxNode | undefined;
  const liveProviderModalText = renderer.root.findDescendantById('provider-modal-text') as MutableTextNode | undefined;
  const liveModelModal = renderer.root.findDescendantById('model-modal') as MutableBoxNode | undefined;
  const liveModelModalText = renderer.root.findDescendantById('model-modal-text') as MutableTextNode | undefined;

  if (!liveCmdListBox || !liveCmdListText || !liveStatusBarText || !liveHeaderText || !liveInput || !liveChat || !liveApprovalDialog || !liveApprovalDialogText || !liveMcpModal || !liveMcpModalText || !liveMcpDetailsModal || !liveMcpDetailsModalText || !liveProviderModal || !liveProviderModalText || !liveModelModal || !liveModelModalText) {
    throw new Error('Failed to initialize TUI render tree');
  }

  const cmdListBoxNode = liveCmdListBox;
  const cmdListTextNode = liveCmdListText;
  const statusBarTextNode = liveStatusBarText;
  const headerTextNode = liveHeaderText;
  const inputNode = liveInput;
  const chatNode = liveChat;
  const approvalDialogNode = liveApprovalDialog;
  const approvalDialogTextNode = liveApprovalDialogText;
  const mcpModalNode = liveMcpModal;
  const mcpModalTextNode = liveMcpModalText;
  const mcpDetailsModalNode = liveMcpDetailsModal;
  const mcpDetailsModalTextNode = liveMcpDetailsModalText;
  const providerModalNode = liveProviderModal;
  const providerModalTextNode = liveProviderModalText;
  const modelModalNode = liveModelModal;
  const modelModalTextNode = liveModelModalText;

  providerModalNode.onMouseDown = (event) => {
    if (providerModalOpen && providerFormState) {
      placeProviderFormCursorFromMouse(event.x, event.y);
    }
  };
  providerModalNode.onMouseScroll = (event) => {
    if (!providerModalOpen || providerFormState) {
      return;
    }

    const direction = event.scroll?.direction;
    if (direction === 'up' || direction === 'down') {
      const providers = getProviderSlots();
      if (providers.length > 0) {
        providerModalProviderIndex = direction === 'up'
          ? (providerModalProviderIndex + providers.length - 1) % providers.length
          : (providerModalProviderIndex + 1) % providers.length;
        syncProviderModalSelections(providers[providerModalProviderIndex].id);
        renderProviderModal();
      }
    }
  };
  modelModalNode.onMouseScroll = (event) => {
    if (!modelModalOpen) {
      return;
    }

    const direction = event.scroll?.direction;
    if (direction !== 'up' && direction !== 'down') {
      return;
    }

    if (modelModalFocus === 'providers') {
      const providers = getProviderSlots();
      if (providers.length === 0) {
        return;
      }
      modelModalProviderIndex = direction === 'up'
        ? (modelModalProviderIndex + providers.length - 1) % providers.length
        : (modelModalProviderIndex + 1) % providers.length;
      syncModelModalSelection(providers[modelModalProviderIndex].id);
    } else if (modelModalFocus === 'models') {
      const models = getModelModalModels(getSelectedModelModalProvider());
      if (models.length === 0) {
        return;
      }
      modelModalModelIndex = direction === 'up'
        ? (modelModalModelIndex + models.length - 1) % models.length
        : (modelModalModelIndex + 1) % models.length;
      modelModalModelScrollOffset = clampScrollOffset(
        modelModalModelIndex,
        modelModalModelScrollOffset,
        providerModalVisibleModels,
        models.length,
      );
    } else {
      return;
    }

    renderModelModal();
  };

  function updateFooterLayout() {
    const paletteHeight = palette.open ? Math.min(palette.matches.length, 5) : 0;
    cmdListBoxNode.height = paletteHeight;
    root.requestRender();
  }

  function renderStatusBar(): void {
    if (activeShellCommand) {
      const spinner = statusSpinnerFrames[statusSpinnerIndex % statusSpinnerFrames.length];
      statusBarTextNode.content = new StyledText([
        fg('#ffaa00')(` ${spinner} `),
        fg('#d8d8d8')('Working... Ctrl+C to interrupt'),
      ]);
      root.requestRender();
      return;
    }

    if (isProcessing && activeTurn) {
      const spinner = statusSpinnerFrames[statusSpinnerIndex % statusSpinnerFrames.length];
      statusBarTextNode.content = new StyledText([
        fg('#00d4ff')(` ${spinner} `),
        fg('#d8d8d8')('Working... Ctrl+C to interrupt'),
      ]);
      root.requestRender();
      return;
    }

    statusBarTextNode.content = new StyledText([
      fg('#7a7a7a')(' Ready'),
    ]);
    root.requestRender();
  }

  function renderHeader(): void {
    headerTextNode.content = stringToStyledText(` Welcome to askai! (${provider.label} / ${provider.model})`);
    root.requestRender();
  }

  async function refreshActiveProviderView(): Promise<void> {
    provider = runtime.getProvider();
    resolvedProvider = runtime.getResolvedProvider();
    providerTools = runtime.getProviderTools();
    renderHeader();
    renderStatusBar();
  }

  function getProviderSlots(): ProviderSlot[] {
    return fixedProviderIds.map((providerId) => {
      const storedProvider = config.providers[providerId];
      if (storedProvider) {
        const resolvedConfig = resolveProviderConfig(config, providerId);
        return {
          id: providerId,
          displayName: getProviderLabel(resolvedConfig),
          kind: resolvedConfig.kind,
          configured: true,
          apiKeyConfigured: Boolean(resolvedConfig.api_key),
          baseUrl: resolvedConfig.base_url,
          model: resolvedConfig.model,
          models: Array.from(new Set((resolvedConfig.models && resolvedConfig.models.length > 0 ? resolvedConfig.models : [resolvedConfig.model]).filter(Boolean))),
          resolved: resolvedConfig,
        };
      }

      const preset = getPresetProviderMeta(providerId);
      return {
        id: providerId,
        displayName: getProviderPlaceholderLabel(providerId),
        kind: preset?.kind || 'custom',
        configured: false,
        apiKeyConfigured: false,
        baseUrl: preset?.baseUrl,
        model: preset?.defaultModel,
        models: [],
      };
    });
  }

  function getSelectedProviderSlot(): ProviderSlot | undefined {
    const providers = getProviderSlots();
    if (providers.length === 0) {
      return undefined;
    }
    providerModalProviderIndex = Math.max(0, Math.min(providerModalProviderIndex, providers.length - 1));
    return providers[providerModalProviderIndex];
  }

  function getProviderSlotModels(providerSlot: ProviderSlot | undefined): string[] {
    return providerSlot ? providerSlot.models : [];
  }

  function syncProviderModalSelections(targetProviderId?: string): void {
    const providers = getProviderSlots();
    if (providers.length === 0) {
      providerModalProviderIndex = 0;
      return;
    }

    const fallbackProviderId = providers[Math.max(0, Math.min(providerModalProviderIndex, providers.length - 1))]?.id || resolvedProvider.id;
    const nextProviderId = targetProviderId || fallbackProviderId;
    const nextProviderIndex = providers.findIndex(item => item.id === nextProviderId);
    providerModalProviderIndex = nextProviderIndex >= 0 ? nextProviderIndex : 0;
    providerModalProviderScrollOffset = clampScrollOffset(
      providerModalProviderIndex,
      providerModalProviderScrollOffset,
      providerModalVisibleItems,
      providers.length,
    );
  }

  function createProviderFormState(providerSlot: ProviderSlot): ProviderFormState {
    const values = normalizeProviderFormValues({
      display_name: providerSlot.kind === 'custom' ? providerSlot.displayName : getProviderPlaceholderLabel(providerSlot.id),
      api_key: providerSlot.resolved?.api_key || '',
      base_url: providerSlot.resolved?.base_url || providerSlot.baseUrl || '',
      model: providerSlot.resolved?.model || providerSlot.model || '',
    });

    return {
      providerId: providerSlot.id,
      activeFieldIndex: 0,
      cursorOffset: (values[getVisibleProviderFormFields(providerSlot.id)[0]?.key || 'api_key'] || '').length,
      values,
    };
  }

  function getProviderFormConfig(providerId: string, values: Record<string, string>, previousProvider?: ProviderConfig): ProviderConfig {
    const preset = getPresetProviderMeta(providerId);
    if (preset) {
      return {
        kind: preset.kind,
        type: preset.kind === 'anthropic' ? 'anthropic' : 'openai-compatible',
        deployment: 'hosted',
        display_name: preset.displayName,
        api_key: values.api_key.trim() || undefined,
        base_url: preset.baseUrl,
        model: previousProvider?.model || preset.defaultModel,
        models: previousProvider?.models,
      };
    }

    const nextModel = values.model.trim();
    if (!values.display_name.trim()) {
      throw new Error('Provider name is required for custom providers.');
    }
    if (!values.base_url.trim()) {
      throw new Error('Base URL is required for custom providers.');
    }
    if (!nextModel) {
      throw new Error('Model name is required for custom providers.');
    }

    const nextModels = Array.from(new Set([
      nextModel,
      ...(previousProvider?.models || []),
      previousProvider?.model || '',
    ].map(item => item.trim()).filter(Boolean)));

    return {
      kind: 'custom',
      type: 'openai-compatible',
      deployment: 'self-hosted',
      display_name: values.display_name.trim(),
      api_key: values.api_key.trim() || undefined,
      base_url: values.base_url.trim(),
      model: nextModel,
      models: nextModels.length > 0 ? nextModels : undefined,
    };
  }

  function closeProviderModal(): void {
    providerModalOpen = false;
    providerFormState = null;
    providerModalNode.visible = false;
    providerModalTextNode.content = stringToStyledText('');
    root.requestRender();
    inputNode.focus();
  }

  function closeModelModal(): void {
    modelModalOpen = false;
    modelModalNode.visible = false;
    modelModalTextNode.content = stringToStyledText('');
    root.requestRender();
    inputNode.focus();
  }

  function openProviderModal(): void {
    providerModalOpen = true;
    providerFormState = null;
    providerModalNotice = null;
    modelModalOpen = false;
    modelModalNode.visible = false;
    syncProviderModalSelections(resolvedProvider.id);
    renderProviderModal();
  }

  function getSelectedModelModalProvider(): ProviderSlot | undefined {
    const providers = getProviderSlots();
    if (providers.length === 0) {
      return undefined;
    }
    modelModalProviderIndex = Math.max(0, Math.min(modelModalProviderIndex, providers.length - 1));
    return providers[modelModalProviderIndex];
  }

  function getModelModalModels(providerSlot: ProviderSlot | undefined): string[] {
    return filterModels(getProviderSlotModels(providerSlot), modelModalFilter.value);
  }

  function syncModelModalSelection(targetProviderId?: string, targetModel?: string): void {
    const providers = getProviderSlots();
    if (providers.length === 0) {
      modelModalProviderIndex = 0;
      modelModalModelIndex = 0;
      modelModalProviderScrollOffset = 0;
      modelModalModelScrollOffset = 0;
      return;
    }

    const nextProviderId = targetProviderId || resolvedProvider.id;
    const nextProviderIndex = providers.findIndex(provider => provider.id === nextProviderId);
    modelModalProviderIndex = Math.max(0, nextProviderIndex >= 0 ? nextProviderIndex : 0);
    modelModalFilter = { value: '', cursorOffset: 0 };

    const selectedProvider = providers[modelModalProviderIndex];
    const models = getModelModalModels(selectedProvider);
    const nextModel = targetModel || resolvedProvider.model;
    const nextModelIndex = models.findIndex(model => model === nextModel);
    modelModalModelIndex = Math.max(0, nextModelIndex >= 0 ? nextModelIndex : 0);

    modelModalProviderScrollOffset = clampScrollOffset(
      modelModalProviderIndex,
      modelModalProviderScrollOffset,
      providerModalVisibleItems,
      providers.length,
    );
    modelModalModelScrollOffset = clampScrollOffset(
      modelModalModelIndex,
      modelModalModelScrollOffset,
      providerModalVisibleModels,
      models.length,
    );
  }

  function openModelModal(providerId?: string): void {
    modelModalOpen = true;
    providerModalOpen = false;
    modelModalFocus = 'models';
    modelModalNotice = null;
    modelModalFilter = { value: '', cursorOffset: 0 };
    providerModalNode.visible = false;
    syncModelModalSelection(providerId || resolvedProvider.id, providerId === resolvedProvider.id ? resolvedProvider.model : undefined);
    renderModelModal();
  }

  function renderProviderModal(): void {
    if (!providerModalOpen) {
      return;
    }

    const providers = getProviderSlots();
    const selectedProvider = getSelectedProviderSlot();

    if (providerFormState) {
      const formState = providerFormState;
      const visibleFields = getVisibleProviderFormFields(formState.providerId);
      const lines = [
        `Edit ${getProviderPlaceholderLabel(formState.providerId)}`,
        '',
        ...visibleFields.map((field, index) => {
          const rawValue = formState.values[field.key] || '';
          const marker = index === formState.activeFieldIndex ? '>' : ' ';
          const value = formatProviderFormTextValue(rawValue, index === formState.activeFieldIndex ? formState.cursorOffset : rawValue.length);
          return `${marker} ${field.label.padEnd(14)} ${value || '(empty)'}`;
        }),
        '',
      ];

      if (formState.error) {
        lines.push(`Error: ${formState.error}`, '');
      }

      lines.push('Tab/↑/↓ move   ←/→ cursor   type/paste to edit   click to place cursor   Enter save   Esc cancel');
      providerModalTextNode.content = stringToStyledText(lines.join('\n'));
      providerModalNode.visible = true;
      if (inputNode.blur) {
        inputNode.blur();
      }
      root.requestRender();
      return;
    }

    providerModalProviderScrollOffset = clampScrollOffset(
      providerModalProviderIndex,
      providerModalProviderScrollOffset,
      providerModalVisibleItems,
      providers.length,
    );

    const visibleProviders = providers.slice(
      providerModalProviderScrollOffset,
      providerModalProviderScrollOffset + providerModalVisibleItems,
    );
    const providerLines = visibleProviders.map((item, visibleIndex) => {
      const index = providerModalProviderScrollOffset + visibleIndex;
      const marker = index === providerModalProviderIndex ? '>' : ' ';
      const active = item.id === resolvedProvider.id ? ' *' : '';
      const prefix = index === providerModalProviderIndex ? `[${marker}]` : ` ${marker} `;
      const status = item.configured ? (item.apiKeyConfigured || item.kind === 'custom' ? 'configured' : 'needs key') : 'empty';
      return `${prefix} ${item.displayName} • ${item.kind}${active} • ${status}`;
    });

    const summaryLines = selectedProvider ? [
      `Provider: ${selectedProvider.displayName}`,
      `Current model: ${selectedProvider.model || 'not set'}`,
      `Base URL: ${selectedProvider.baseUrl || 'n/a'}`,
      `API Key: ${selectedProvider.apiKeyConfigured ? 'configured' : 'missing'}`,
      `State: ${selectedProvider.configured ? 'saved' : 'not configured'}`,
    ] : ['No provider selected.'];

    const lines = [
      'Configure providers',
      '',
      'Providers',
      ...(providerModalProviderScrollOffset > 0 ? ['  ^ more'] : []),
      ...(providerLines.length > 0 ? providerLines : ['  No providers configured']),
      ...(providerModalProviderScrollOffset + providerModalVisibleItems < providers.length ? ['  v more'] : []),
      '',
      'Summary',
      ...summaryLines,
      '',
      ...(providerModalNotice ? [`Notice: ${providerModalNotice}`, ''] : []),
      '↑/↓ move   Enter edit provider   m select model   Esc/q close',
    ];

    providerModalTextNode.content = stringToStyledText(lines.join('\n'));
    providerModalNode.visible = true;
    if (inputNode.blur) {
      inputNode.blur();
    }
    root.requestRender();
  }

  function renderModelModal(): void {
    if (!modelModalOpen) {
      return;
    }

    const providers = getProviderSlots();
    const selectedProvider = getSelectedModelModalProvider();
    const models = getModelModalModels(selectedProvider);
    modelModalProviderScrollOffset = clampScrollOffset(
      modelModalProviderIndex,
      modelModalProviderScrollOffset,
      providerModalVisibleItems,
      providers.length,
    );
    modelModalModelScrollOffset = clampScrollOffset(
      modelModalModelIndex,
      modelModalModelScrollOffset,
      providerModalVisibleModels,
      models.length,
    );

    const visibleProviders = providers.slice(
      modelModalProviderScrollOffset,
      modelModalProviderScrollOffset + providerModalVisibleItems,
    );
    const providerLines = visibleProviders.map((item, visibleIndex) => {
      const index = modelModalProviderScrollOffset + visibleIndex;
      const marker = index === modelModalProviderIndex ? '>' : ' ';
      const active = item.id === resolvedProvider.id ? ' *' : '';
      const prefix = modelModalFocus === 'providers' && index === modelModalProviderIndex ? `[${marker}]` : ` ${marker} `;
      return `${prefix} ${item.displayName}${active}`;
    });

    const visibleModels = models.slice(
      modelModalModelScrollOffset,
      modelModalModelScrollOffset + providerModalVisibleModels,
    );
    const modelLines = visibleModels.map((model, visibleIndex) => {
      const index = modelModalModelScrollOffset + visibleIndex;
      const marker = index === modelModalModelIndex ? '>' : ' ';
      const active = selectedProvider && selectedProvider.id === resolvedProvider.id && model === resolvedProvider.model ? ' *' : '';
      const prefix = modelModalFocus === 'models' && index === modelModalModelIndex ? `[${marker}]` : ` ${marker} `;
      return `${prefix} ${model}${active}`;
    });

    const lines = [
      'Select a model to use',
      '',
      'Providers',
      ...(modelModalProviderScrollOffset > 0 ? ['  ^ more'] : []),
      ...(providerLines.length > 0 ? providerLines : ['  No providers configured']),
      ...(modelModalProviderScrollOffset + providerModalVisibleItems < providers.length ? ['  v more'] : []),
      '',
      `Filter  ${formatFilterValue(modelModalFilter.value, modelModalFilter.cursorOffset, modelModalFocus === 'filter')}`,
      '',
      `Models${selectedProvider ? ` (${selectedProvider.displayName})` : ''}`,
      ...(modelModalModelScrollOffset > 0 ? ['  ^ more'] : []),
      ...(modelLines.length > 0 ? modelLines : ['  No models available']),
      ...(modelModalModelScrollOffset + providerModalVisibleModels < models.length ? ['  v more'] : []),
      '',
    ];

    if (modelModalNotice) {
      lines.push(`Notice: ${modelModalNotice}`, '');
    }

    const canDelete = selectedProvider ? isCustomProviderId(selectedProvider.id) && models.length > 0 : false;
    lines.push(canDelete
      ? 'Tab switch list   ↑/↓ move   ←/→ cursor in filter   Enter use model   d delete model   Esc/q close'
      : 'Tab switch list   ↑/↓ move   ←/→ cursor in filter   Enter use model   Esc/q close');
    modelModalTextNode.content = stringToStyledText(lines.join('\n'));
    modelModalNode.visible = true;
    if (inputNode.blur) {
      inputNode.blur();
    }
    root.requestRender();
  }

  function startProviderForm(providerId: string): void {
    const providerSlot = getProviderSlots().find(item => item.id === providerId);
    if (!providerSlot) {
      return;
    }
    providerFormState = createProviderFormState(providerSlot);
    renderProviderModal();
  }

  async function saveProviderForm(): Promise<void> {
    if (!providerFormState) {
      return;
    }

    const formState = providerFormState;

    try {
      const providerId = formState.providerId;
      const previousProviderConfig = config.providers[providerId];
      const nextConfig = getProviderFormConfig(providerId, formState.values, previousProviderConfig);

      if (!isCustomProviderId(providerId) && !nextConfig.api_key) {
        throw new Error('API key is required for preset providers.');
      }

      upsertProvider(config, providerId, nextConfig);

      providerModalNotice = null;
      if (resolvedProvider.id === providerId) {
        await runtime.switchProvider(providerId, false);
      }

      if (!isCustomProviderId(providerId)) {
        try {
          const fetchedModels = await fetchAvailableModels(resolveProviderConfig(config, providerId));
          if (fetchedModels.length > 0) {
            const currentModel = config.providers[providerId].model;
            const orderedModels = currentModel && fetchedModels.includes(currentModel)
              ? [currentModel, ...fetchedModels.filter(model => model !== currentModel)]
              : fetchedModels;
            config.providers[providerId].models = orderedModels;
            config.providers[providerId].model = orderedModels[0];
            providerModalNotice = `Fetched ${fetchedModels.length} models for ${getProviderLabel(resolveProviderConfig(config, providerId))}.`;
          } else {
            providerModalNotice = `Saved provider. No models were returned for ${getProviderPlaceholderLabel(providerId)}.`;
          }
        } catch (error) {
          providerModalNotice = `Saved provider. Failed to refresh models: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      } else {
        providerModalNotice = `Saved ${formState.values.display_name.trim() || getProviderPlaceholderLabel(providerId)}.`;
      }

      await runtime.persistConfig();
      providerFormState = null;
      syncProviderModalSelections(providerId);
      await refreshActiveProviderView();
      renderProviderModal();
    } catch (error) {
      formState.error = error instanceof Error ? error.message : 'Unknown error';
      renderProviderModal();
    }
  }

  async function applyModelSelection(): Promise<void> {
    const selectedProvider = getSelectedModelModalProvider();
    if (!selectedProvider) {
      return;
    }
    const models = getModelModalModels(selectedProvider);
    const selectedModel = models[modelModalModelIndex];
    if (!selectedModel) {
      return;
    }

    if (resolvedProvider.id !== selectedProvider.id) {
      await runtime.switchProvider(selectedProvider.id, false);
    }
    if (config.providers[selectedProvider.id]?.model !== selectedModel) {
      setProviderModel(config, selectedProvider.id, selectedModel);
      if (config.provider === selectedProvider.id) {
        await runtime.switchModel(selectedModel, false);
      }
    }
    await runtime.persistConfig();
    syncModelModalSelection(selectedProvider.id, selectedModel);
    await refreshActiveProviderView();
    closeModelModal();
  }

  async function deleteSelectedCustomModel(): Promise<void> {
    const selectedProvider = getSelectedModelModalProvider();
    if (!selectedProvider || !isCustomProviderId(selectedProvider.id)) {
      return;
    }
    const models = getModelModalModels(selectedProvider);
    const selectedModel = models[modelModalModelIndex];
    if (!selectedModel) {
      return;
    }

    try {
      removeProviderModel(config, selectedProvider.id, selectedModel);
      if (resolvedProvider.id === selectedProvider.id) {
        await runtime.switchProvider(selectedProvider.id, false);
      }
      await runtime.persistConfig();
      syncModelModalSelection(selectedProvider.id);
      await refreshActiveProviderView();
      modelModalNotice = `Deleted model ${selectedModel} from ${selectedProvider.displayName}.`;
      renderModelModal();
    } catch (error) {
      modelModalNotice = error instanceof Error ? error.message : 'Unknown error';
      renderModelModal();
    }
  }

  function updateModelFilter(nextValue: string): void {
    modelModalFilter.value = nextValue;
    modelModalFilter.cursorOffset = Math.max(0, Math.min(modelModalFilter.cursorOffset, nextValue.length));
    const selectedProvider = getSelectedModelModalProvider();
    const filteredModels = getModelModalModels(selectedProvider);
    modelModalModelIndex = Math.max(0, Math.min(modelModalModelIndex, Math.max(0, filteredModels.length - 1)));
    modelModalModelScrollOffset = clampScrollOffset(
      modelModalModelIndex,
      modelModalModelScrollOffset,
      providerModalVisibleModels,
      filteredModels.length,
    );
  }

  function insertModelFilterText(text: string): void {
    const currentValue = modelModalFilter.value;
    const offset = Math.max(0, Math.min(modelModalFilter.cursorOffset, currentValue.length));
    updateModelFilter(`${currentValue.slice(0, offset)}${text}${currentValue.slice(offset)}`);
    modelModalFilter.cursorOffset = offset + text.length;
  }

  function deleteModelFilterText(): void {
    const currentValue = modelModalFilter.value;
    const offset = Math.max(0, Math.min(modelModalFilter.cursorOffset, currentValue.length));
    if (offset === 0) {
      return;
    }
    updateModelFilter(`${currentValue.slice(0, offset - 1)}${currentValue.slice(offset)}`);
    modelModalFilter.cursorOffset = offset - 1;
  }

  function moveModelFilterCursor(delta: number): void {
    modelModalFilter.cursorOffset = Math.max(0, Math.min(modelModalFilter.cursorOffset + delta, modelModalFilter.value.length));
  }

  function insertModelFilterPaste(text: string): void {
    const normalizedText = text
      .replace(/\r\n/g, '\n')
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
      .replace(/\n/g, ' ');
    if (!normalizedText) {
      return;
    }
    insertModelFilterText(normalizedText);
  }

  async function handleProviderCommand(_args: string[]): Promise<string | void> {
    openProviderModal();
    return 'Opened provider modal';
  }

  async function handleModelCommand(_args: string[]): Promise<string | void> {
    openModelModal();
    return 'Opened model modal';
  }

  function updateProviderFormFieldValue(nextValue: string): void {
    if (!providerFormState) {
      return;
    }

    const formState = providerFormState;
    const fields = getVisibleProviderFormFields(formState.providerId);
    const field = fields[formState.activeFieldIndex];
    formState.values[field.key] = nextValue;
    formState.values = normalizeProviderFormValues(formState.values);
    formState.cursorOffset = Math.max(0, Math.min(formState.cursorOffset, nextValue.length));
    formState.error = undefined;
  }

  function insertProviderFormText(text: string): void {
    if (!providerFormState) {
      return;
    }

    const formState = providerFormState;
    const fields = getVisibleProviderFormFields(formState.providerId);
    const field = fields[formState.activeFieldIndex];

    const currentValue = formState.values[field.key] || '';
    const clampedOffset = Math.max(0, Math.min(formState.cursorOffset, currentValue.length));
    const nextValue = `${currentValue.slice(0, clampedOffset)}${text}${currentValue.slice(clampedOffset)}`;
    formState.cursorOffset = clampedOffset + text.length;
    updateProviderFormFieldValue(nextValue);
  }

  function deleteProviderFormText(): void {
    if (!providerFormState) {
      return;
    }

    const formState = providerFormState;
    const fields = getVisibleProviderFormFields(formState.providerId);
    const field = fields[formState.activeFieldIndex];

    const currentValue = formState.values[field.key] || '';
    const clampedOffset = Math.max(0, Math.min(formState.cursorOffset, currentValue.length));
    if (clampedOffset === 0) {
      return;
    }

    const nextValue = `${currentValue.slice(0, clampedOffset - 1)}${currentValue.slice(clampedOffset)}`;
    formState.cursorOffset = clampedOffset - 1;
    updateProviderFormFieldValue(nextValue);
  }

  function moveProviderFormCursor(delta: number): void {
    if (!providerFormState) {
      return;
    }

    const formState = providerFormState;
    const fields = getVisibleProviderFormFields(formState.providerId);
    const field = fields[formState.activeFieldIndex];

    const currentValue = formState.values[field.key] || '';
    formState.cursorOffset = Math.max(0, Math.min(formState.cursorOffset + delta, currentValue.length));
    formState.error = undefined;
    renderProviderModal();
  }

  function moveProviderFormField(delta: number): void {
    if (!providerFormState) {
      return;
    }

    const formState = providerFormState;
    const fields = getVisibleProviderFormFields(formState.providerId);
    const nextIndex = formState.activeFieldIndex + delta;
    if (nextIndex < 0) {
      formState.activeFieldIndex = fields.length - 1;
    } else if (nextIndex >= fields.length) {
      formState.activeFieldIndex = 0;
    } else {
      formState.activeFieldIndex = nextIndex;
    }
    const nextField = fields[formState.activeFieldIndex];
    const nextValue = formState.values[nextField.key] || '';
    formState.cursorOffset = nextValue.length;
    formState.error = undefined;
    renderProviderModal();
  }

  function insertProviderFormPaste(text: string): void {
    const normalizedText = text
      .replace(/\r\n/g, '\n')
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
      .replace(/\n/g, ' ');

    if (!normalizedText) {
      return;
    }

    insertProviderFormText(normalizedText);
    renderProviderModal();
  }

  function placeProviderFormCursorFromMouse(mouseX: number, mouseY: number): void {
    if (!providerFormState || !providerModalNode.visible || typeof providerModalNode.x !== 'number' || typeof providerModalNode.y !== 'number') {
      return;
    }

    const visibleFields = getVisibleProviderFormFields(providerFormState.providerId);
    const contentX = providerModalNode.x + 1;
    const contentY = providerModalNode.y + 1;
    const fieldStartLine = contentY + 2;
    const clickedFieldIndex = mouseY - fieldStartLine;
    if (clickedFieldIndex < 0 || clickedFieldIndex >= visibleFields.length) {
      return;
    }

    providerFormState.activeFieldIndex = clickedFieldIndex;
    const field = visibleFields[clickedFieldIndex];
    const currentValue = providerFormState.values[field.key] || '';
    const valueColumnX = contentX + 17;
    providerFormState.cursorOffset = Math.max(0, Math.min(mouseX - valueColumnX, currentValue.length));
    providerFormState.error = undefined;
    renderProviderModal();
  }

  async function handleProviderModalSequence(sequence: string): Promise<boolean> {
    if (!providerModalOpen) {
      return false;
    }

    if (providerFormState) {
      if (sequence === '\x1b') {
        providerFormState = null;
        renderProviderModal();
        return true;
      }
      if (sequence === '\t' || sequence === '\x1b[B') {
        moveProviderFormField(1);
        return true;
      }
      if (sequence === '\x1b[Z' || sequence === '\x1b[A') {
        moveProviderFormField(-1);
        return true;
      }
      if (sequence === '\x13') {
        await saveProviderForm();
        return true;
      }
      if (sequence === '\x1b[D') {
        moveProviderFormCursor(-1);
        return true;
      }
      if (sequence === '\x1b[C' || sequence === ' ') {
        if (sequence === ' ') {
          insertProviderFormText(' ');
          renderProviderModal();
        } else {
          moveProviderFormCursor(1);
        }
        return true;
      }
      if (sequence === '\r' || sequence === '\n') {
        await saveProviderForm();
        return true;
      }
      if (sequence === '\x7f') {
        deleteProviderFormText();
        renderProviderModal();
        return true;
      }
      if (sequence.length === 1) {
        const charCode = sequence.charCodeAt(0);
        if (charCode >= 32) {
          insertProviderFormText(sequence);
          renderProviderModal();
          return true;
        }
      }
      if (sequence.length > 1 && !sequence.includes('\x1b')) {
        insertProviderFormPaste(sequence);
        return true;
      }
      return true;
    }

    if (sequence === '\x1b' || sequence.toLowerCase() === 'q') {
      closeProviderModal();
      return true;
    }
    if (sequence === '\x1b[A') {
      const providers = getProviderSlots();
      if (providers.length > 0) {
        providerModalProviderIndex = (providerModalProviderIndex + providers.length - 1) % providers.length;
        syncProviderModalSelections(providers[providerModalProviderIndex].id);
      }
      renderProviderModal();
      return true;
    }
    if (sequence === '\x1b[B') {
      const providers = getProviderSlots();
      if (providers.length > 0) {
        providerModalProviderIndex = (providerModalProviderIndex + 1) % providers.length;
        syncProviderModalSelections(providers[providerModalProviderIndex].id);
      }
      renderProviderModal();
      return true;
    }
    if (sequence.toLowerCase() === 'm') {
      openModelModal(getSelectedProviderSlot()?.id);
      return true;
    }
    if (sequence === '\r' || sequence === '\n') {
      const selectedProvider = getSelectedProviderSlot();
      if (selectedProvider) {
        startProviderForm(selectedProvider.id);
      }
      return true;
    }

    return sequence.length > 0;
  }

  async function handleModelModalSequence(sequence: string): Promise<boolean> {
    if (!modelModalOpen) {
      return false;
    }

    if (sequence === '\x1b' || sequence.toLowerCase() === 'q') {
      closeModelModal();
      return true;
    }
    if (sequence === '\t') {
      modelModalFocus = modelModalFocus === 'providers'
        ? 'filter'
        : modelModalFocus === 'filter'
          ? 'models'
          : 'providers';
      renderModelModal();
      return true;
    }
    if (modelModalFocus === 'filter') {
      if (sequence === '\x1b[D') {
        moveModelFilterCursor(-1);
        renderModelModal();
        return true;
      }
      if (sequence === '\x1b[C') {
        moveModelFilterCursor(1);
        renderModelModal();
        return true;
      }
      if (sequence === '\x7f') {
        deleteModelFilterText();
        renderModelModal();
        return true;
      }
      if (sequence === '\r' || sequence === '\n') {
        modelModalFocus = 'models';
        renderModelModal();
        return true;
      }
      if (sequence.length === 1) {
        const charCode = sequence.charCodeAt(0);
        if (charCode >= 32) {
          insertModelFilterText(sequence);
          renderModelModal();
          return true;
        }
      }
      if (sequence.length > 1 && !sequence.includes('\x1b')) {
        insertModelFilterPaste(sequence);
        renderModelModal();
        return true;
      }
      return true;
    }
    if (sequence === '\x1b[A') {
      if (modelModalFocus === 'providers') {
        const providers = getProviderSlots();
        if (providers.length > 0) {
          modelModalProviderIndex = (modelModalProviderIndex + providers.length - 1) % providers.length;
          syncModelModalSelection(providers[modelModalProviderIndex].id);
        }
      } else {
        const models = getModelModalModels(getSelectedModelModalProvider());
        if (models.length > 0) {
          modelModalModelIndex = (modelModalModelIndex + models.length - 1) % models.length;
          modelModalModelScrollOffset = clampScrollOffset(
            modelModalModelIndex,
            modelModalModelScrollOffset,
            providerModalVisibleModels,
            models.length,
          );
        }
      }
      renderModelModal();
      return true;
    }
    if (sequence === '\x1b[B') {
      if (modelModalFocus === 'providers') {
        const providers = getProviderSlots();
        if (providers.length > 0) {
          modelModalProviderIndex = (modelModalProviderIndex + 1) % providers.length;
          syncModelModalSelection(providers[modelModalProviderIndex].id);
        }
      } else {
        const models = getModelModalModels(getSelectedModelModalProvider());
        if (models.length > 0) {
          modelModalModelIndex = (modelModalModelIndex + 1) % models.length;
          modelModalModelScrollOffset = clampScrollOffset(
            modelModalModelIndex,
            modelModalModelScrollOffset,
            providerModalVisibleModels,
            models.length,
          );
        }
      }
      renderModelModal();
      return true;
    }
    if (sequence.toLowerCase() === 'd') {
      await deleteSelectedCustomModel();
      return true;
    }
    if (sequence === '\r' || sequence === '\n') {
      await applyModelSelection();
      return true;
    }

    return sequence.length > 0;
  }

  function insertInputNewline(): void {
    const currentText = inputNode.plainText;
    const cursorOffset = typeof inputNode.cursorOffset === 'number' ? inputNode.cursorOffset : currentText.length;
    const nextText = `${currentText.slice(0, cursorOffset)}\n${currentText.slice(cursorOffset)}`;
    inputNode.setText(nextText);
    if (typeof inputNode.cursorOffset === 'number') {
      inputNode.cursorOffset = cursorOffset + 1;
    }
    inputBuffer = nextText;
  }

  renderer.prependInputHandler((sequence: string) => {
    if (mcpModalOpen || mcpDetailsOpen || pendingExecution || providerModalOpen || modelModalOpen) {
      return false;
    }

    if (shiftEnterSequences.has(sequence)) {
      insertInputNewline();
      return true;
    }

    return false;
  });

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
        renderStatusBar();
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
    renderStatusBar();
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
      const parts = text.slice(1).trim().split(/\s+/).filter(Boolean);
      const commandName = parts[0];
      const cmd = commands.find(c => c.name === commandName);
      if (cmd) {
        await executeCommand(cmd, parts.slice(1), text.trim());
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
    renderStatusBar();
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
    renderStatusBar();
  }
  
  async function executeCommand(cmd: Command, args: string[] = [], rawInput?: string) {
    addMsg(`> ${rawInput || `/${cmd.name}`}`, '#00ff88');
    if (cmd.name === 'exit' || cmd.name === 'quit') {
      if (mcpManager) await mcpManager.disconnectAll();
      renderer.destroy();
      process.exit(0);
    }
    try {
      const result = await cmd.action(args);
      if (result) {
        addMsg(result, '#888888');
      } else {
        addMsg(`Executed /${cmd.name}`, '#888888');
      }
    } catch (error) {
      addMsg(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, '#ff4444');
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
    if (mcpModalOpen || providerModalOpen || modelModalOpen) {
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
    if (mcpModalOpen || providerModalOpen || modelModalOpen) {
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
      process.stdout.write(resetModifyOtherKeys);
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

    if (providerModalOpen && isEscapeKey(key)) {
      closeProviderModal();
      return;
    }

    if (modelModalOpen && isEscapeKey(key)) {
      closeModelModal();
      return;
    }

    if (providerModalOpen && providerFormState && (key.sequence === '\x13' || (key.ctrl && key.name === 's'))) {
      await saveProviderForm();
      return;
    }

    if ((providerModalOpen || modelModalOpen) && !key.ctrl && !key.meta) {
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

  renderer.keyInput.on('paste', (event) => {
    if (providerModalOpen && providerFormState) {
      event.preventDefault();
      const text = new TextDecoder().decode(event.bytes);
      insertProviderFormPaste(text);
      return;
    }
    if (modelModalOpen && modelModalFocus === 'filter') {
      event.preventDefault();
      const text = new TextDecoder().decode(event.bytes);
      insertModelFilterPaste(text);
      renderModelModal();
    }
  });

  const sigintHandler = async () => {
    if (await handleInterruptSignal()) {
      return;
    }
    if (mcpManager) {
      await mcpManager.disconnectAll();
    }
    process.stdout.write(resetModifyOtherKeys);
    renderer.destroy();
    process.exit(0);
  };

  process.on('SIGINT', sigintHandler);
  const statusSpinnerTimer = setInterval(() => {
    statusSpinnerIndex = (statusSpinnerIndex + 1) % statusSpinnerFrames.length;
    if (activeShellCommand || (isProcessing && activeTurn)) {
      renderStatusBar();
    }
  }, 120);
  
  updateFooterLayout();
  renderStatusBar();
  inputNode.focus();
}
