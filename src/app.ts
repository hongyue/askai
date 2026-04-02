import {
  createCliRenderer,
  Box, Text, ScrollBox, StyledText,
  TextareaRenderable, fg, h, white, bgWhite, black,
  stringToStyledText,
  type KeyEvent,
  BoxRenderable
} from "@opentui/core"
import {
  findProviderByNormalizedId,
  getProviderLabel,
  isPresetProviderId,
  isProviderIdUnique,
  loadConfig,
  presetProviderIds,
  removeProviderModel,
  renameProvider,
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
import {
  createSession,
  addMessage,
  getMessages,
  getSession,
  autoGenerateTitle,
  listSessions,
  renameSession,
  deleteSession,
  deleteEmptySessions,
  type SessionStorage,
  type SessionSummary,
} from './session';

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
  insertText(text: string): void;
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
const sessionsVisibleLineCount = 15;
const statusSpinnerFrames = ['|', '/', '-', '\\'] as const;
const enableModifyOtherKeys = '\x1b[>4;2m';
const resetModifyOtherKeys = '\x1b[>4m';
const shiftEnterSequences = new Set([
  '\x1b[13;2u',
  '\x1b[27;2;13~',
  '\x1b[13;2~',
]);

// Helper functions for matching keyboard sequences (supports both traditional and Kitty protocol)
function isEnter(sequence: string): boolean {
  return sequence === '\r' || sequence === '\n' || sequence === '\x1b[13u' || sequence === '\x1b[13;1u';
}

function isEscape(sequence: string): boolean {
  return sequence === '\x1b' || sequence === '\x1b\x1b' || sequence === '\x1b[27u' || sequence === '\x1b[27;1u';
}

function isArrowUp(sequence: string): boolean {
  return sequence === '\x1b[A' || sequence === '\x1b[Au' || sequence === '\x1b[57352u';
}

function isArrowDown(sequence: string): boolean {
  return sequence === '\x1b[B' || sequence === '\x1b[Bu' || sequence === '\x1b[57353u';
}

function isArrowLeft(sequence: string): boolean {
  return sequence === '\x1b[D' || sequence === '\x1b[Du' || sequence === '\x1b[57350u';
}

function isArrowRight(sequence: string): boolean {
  return sequence === '\x1b[C' || sequence === '\x1b[Cu' || sequence === '\x1b[57351u';
}

function isTab(sequence: string): boolean {
  return sequence === '\t' || sequence === '\x1b[Iu' || sequence === '\x1b[9u';
}

function isShiftTab(sequence: string): boolean {
  return sequence === '\x1b[Z' || sequence === '\x1b[I;2u' || sequence === '\x1b[9;2u';
}

function isBackspace(sequence: string): boolean {
  return sequence === '\x7f' || sequence === '\x1b[127u' || sequence === '\b';
}

// Helper to get character from sequence (handles both plain and Kitty protocol)
function getChar(sequence: string): string | null {
  // Plain character
  if (sequence.length === 1) {
    return sequence;
  }
  // Kitty protocol: \x1b{code}u or \x1b{code};{mods}u
  const kittyMatch = sequence.match(/^\x1b\[(\d+)(?:;\d+)?u$/);
  if (kittyMatch) {
    return String.fromCharCode(parseInt(kittyMatch[1], 10));
  }
  return null;
}

// Helper to check if sequence matches a specific character
function isChar(sequence: string, char: string): boolean {
  const c = getChar(sequence);
  return c !== null && c === char;
}

// Helper to check if sequence matches a character (case-insensitive)
function isCharIgnoreCase(sequence: string, char: string): boolean {
  const c = getChar(sequence);
  return c !== null && c.toLowerCase() === char.toLowerCase();
}
const approvalActions = [
  { key: 'y', label: 'Yes' },
  { key: 'n', label: 'No' },
  { key: 'a', label: 'All' },
  { key: 'x', label: 'None' },
] as const;
const providerModalVisibleItems = 8;
const providerModalVisibleModels = 8;
const providerFormFields: ProviderFormField[] = [
  { key: 'id', label: 'Provider Name', kind: 'text' },
  { key: 'api_key', label: 'API Key', kind: 'text' },
  { key: 'base_url', label: 'Base URL', kind: 'text' },
  { key: 'model', label: 'Model Name', kind: 'text' },
];
type ApprovalActionKey = typeof approvalActions[number]['key'];
const presetProviderMeta = [
  { id: 'openai', displayName: 'OpenAI', kind: 'openai' as const, baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  { id: 'anthropic', displayName: 'Anthropic', kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'openrouter', displayName: 'OpenRouter', kind: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini' },
  { id: 'ollama', displayName: 'Ollama', kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3' },
  { id: 'llama.cpp', displayName: 'Llama.cpp', kind: 'custom' as const, baseUrl: 'http://localhost:8080/v1', defaultModel: 'llama3' },
  { id: 'vllm', displayName: 'vLLM', kind: 'custom' as const, baseUrl: 'http://localhost:8000/v1', defaultModel: 'llama3' },
  { id: 'sglang', displayName: 'SGLang', kind: 'custom' as const, baseUrl: 'http://localhost:8080/v1', defaultModel: 'llama3' },
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
  session: SessionStorage;
  startNewSession: () => SessionStorage;
  loadPersistedSession: (id: string) => void;
}> {
  const configPath = resolveConfigPath(options.configPath);
  const config = await loadConfig(configPath);
  if (options.providerName) {
    const providerId = findProviderByNormalizedId(config, options.providerName);
    if (!providerId) {
      throw new Error(`Provider "${options.providerName}" not found`);
    }
    setActiveProvider(config, providerId);
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

  let session: SessionStorage = { id: '', title: 'New Session', provider: resolvedProvider.id, model: resolvedProvider.model };

  const startNewSession = (): SessionStorage => {
    messages.length = 0;
    messages.push({ role: 'system', content: systemPrompt });
    return { id: '', title: 'New Session', provider: resolvedProvider.id, model: resolvedProvider.model };
  };

  const loadPersistedSession = (id: string): void => {
    const stored = getSession(id);
    if (!stored) throw new Error(`Session "${id}" not found`);
    const loaded = getMessages(id);
    messages.length = 0;
    messages.push(...loaded);
    session = stored;
  };

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
    session,
    startNewSession,
    loadPersistedSession,
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
  nextValues.id = nextValues.id || '';
  nextValues.api_key = nextValues.api_key || '';
  nextValues.base_url = nextValues.base_url || '';
  nextValues.model = nextValues.model || '';
  return nextValues;
}

function formatProviderFormTextValue(value: string, cursorOffset: number, focused: boolean): any[] {
  const clampedOffset = Math.max(0, Math.min(cursorOffset, value.length));
  // Use bright background with black text for highly visible cursor
  // Only show cursor when field is focused
  if (focused && clampedOffset < value.length) {
    const char = value[clampedOffset];
    return [
      white(value.slice(0, clampedOffset)),
      bgWhite(black(char)),
      white(value.slice(clampedOffset + 1)),
    ];
  }
  if (focused) {
    // Cursor at end - show as space with bright background
    return [white(value), bgWhite(black(' '))];
  }
  // Not focused - no cursor
  return [white(value)];
}

function formatFilterValue(value: string, cursorOffset: number, active: boolean): any[] {
  if (!active && value.length === 0) {
    return [white('(type to filter)')];
  }

  if (!active) {
    return [white(value)];
  }

  const clampedOffset = Math.max(0, Math.min(cursorOffset, value.length));
  // Use bright background with black text for highly visible cursor
  if (clampedOffset < value.length) {
    const char = value[clampedOffset];
    return [
      white(value.slice(0, clampedOffset)),
      bgWhite(black(char)),
      white(value.slice(clampedOffset + 1)),
    ];
  }
  // Cursor at end - show as space with bright background
  return [white(value), bgWhite(black(' '))];
}

function filterModels(models: string[], filterValue: string): string[] {
  const normalizedFilter = filterValue.trim().toLowerCase();
  if (!normalizedFilter) {
    return models;
  }

  return models.filter(model => model.toLowerCase().includes(normalizedFilter));
}

function getVisibleProviderFormFields(providerId: string): ProviderFormField[] {
  const preset = getPresetProviderMeta(providerId);
  const isCustomLike = !preset || preset.kind === 'custom';
  const isCustomProvider = !preset;  // Only true custom providers (not presets)

  return providerFormFields.filter(field => {
    if (field.key === 'id') {
      return isCustomProvider;  // Only show for custom providers
    }
    if (field.key === 'base_url') {
      return isCustomLike;
    }
    if (field.key === 'model') {
      return isCustomLike;
    }
    return field.key === 'api_key';
  });
}

function isCustomProviderId(providerId: string): boolean {
  // A provider is custom only if it's NOT a preset
  return !isPresetProviderId(providerId);
}

function getPresetProviderMeta(providerId: string) {
  const normalizedId = providerId.toLowerCase();
  return presetProviderMeta.find(item => item.id.toLowerCase() === normalizedId);
}

function getProviderPlaceholderLabel(providerId: string): string {
  const preset = getPresetProviderMeta(providerId);
  if (preset) {
    return preset.displayName;
  }
  return providerId;
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

  // One-shot always has a question - create session immediately
  const title = autoGenerateTitle(options.question);
  const session = createSession(title, runtime.getResolvedProvider().id, runtime.getResolvedProvider().model);
  addMessage(session.id, 'system', runtime.systemPrompt);

  messages.push({ role: 'user', content: options.question });
  addMessage(session.id, 'user', options.question);

  try {
    while (true) {
      console.log(`${oneShotFeedbackColor}${getRandomOneShotFeedbackPrompt()}${ansiReset}`);
      const response = await getAssistantResponse(provider, messages, state.mcpEnabled, providerTools);

      if (response.content) {
        console.log(response.content);
      }

      messages.push(response);
      addMessage(session.id, 'assistant', response.content, response.tool_calls);

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
          addMessage(session.id, 'tool', content || (result.isError ? 'Tool returned an error.' : 'Tool completed successfully.'), undefined, toolCall.id);
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
  const { mcpManager, state, messages, config, systemPrompt } = runtime;
  let provider = runtime.getProvider();
  let resolvedProvider = runtime.getResolvedProvider();
  let providerTools = runtime.getProviderTools();
  let currentSession = runtime.session;
  let sessionsModalOpen = false;
  let sessionsList: SessionSummary[] = [];
  let sessionsSelectedIndex = 0;
  let sessionsScrollOffset = 0;
  let sessionsRenaming: { id: string; value: string; cursorOffset: number } | null = null;
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
  let addProviderNameInput: { value: string; cursorOffset: number } | null = null;
  let deleteProviderConfirm: { providerId: string } | null = null;
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
    async () => {
      currentSession = runtime.startNewSession();
      while (chatNodeIds.length > 0) {
        const nodeId = chatNodeIds.pop();
        if (nodeId) chatNode.remove(nodeId);
      }
      renderHeader();
      renderStatusBar();
      root.requestRender();
      return 'Started new session';
    },
    () => {
      sessionsList = listSessions();
      sessionsSelectedIndex = 0;
      sessionsModalOpen = true;
      renderSessionsModal();
    },
  );

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: 'alternate-screen',
    // Disable Kitty keyboard protocol in iTerm2 due to IME input issues
    // iTerm2 has known problems with Kitty protocol and IME (Chinese/Japanese/Korean input)
    useKittyKeyboard: process.env.TERM_PROGRAM === 'iTerm.app' ? null : {
      disambiguate: true,
      allKeysAsEscapes: true,
      reportText: true,  // Required for IME (Chinese/Japanese/Korean) input
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

      if (isEscape(sequence) || isCharIgnoreCase(sequence, 'q')) {
        closeMcpDetailsModal();
        return true;
      }
      if (isArrowUp(sequence)) {
        mcpDetailsScrollOffset = Math.max(0, mcpDetailsScrollOffset - 1);
        renderMcpDetailsModal();
        return true;
      }
      if (isArrowDown(sequence)) {
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
      if (isEscape(sequence) || isCharIgnoreCase(sequence, 'q')) {
        closeMcpModal();
        return true;
      }
      if (isArrowUp(sequence)) {
        const states = runtime.getMcpServerStates();
        if (states.length > 0) {
          mcpServerIndex = (mcpServerIndex + states.length - 1) % states.length;
          renderMcpModal();
        }
        return true;
      }
      if (isArrowDown(sequence)) {
        const states = runtime.getMcpServerStates();
        if (states.length > 0) {
          mcpServerIndex = (mcpServerIndex + 1) % states.length;
          renderMcpModal();
        }
        return true;
      }
      if (isTab(sequence)) {
        mcpFocus = mcpFocus === 'server' ? 'global' : 'server';
        renderMcpModal();
        return true;
      }
      if (sequence === ' ') {
        void runMcpModalToggle();
        return true;
      }
      if (isEnter(sequence)) {
        if (mcpFocus === 'server') {
          openMcpDetailsModal();
        }
        return true;
      }
      if (sequence.length > 0) {
        return true;
      }
    }

    if (sessionsModalOpen) {
      if (sessionsRenaming) {
        if (isEscape(sequence)) {
          sessionsRenaming = null;
          renderSessionsModal();
          return true;
        }
        if (isEnter(sequence)) {
          const newTitle = sessionsRenaming.value.trim();
          if (newTitle) {
            renameSession(sessionsRenaming.id, newTitle);
            if (sessionsRenaming.id === currentSession.id) {
              currentSession = { ...currentSession, title: newTitle };
              renderHeader();
            }
          }
          sessionsRenaming = null;
          renderSessionsModal();
          return true;
        }
        if (isArrowLeft(sequence)) {
          sessionsRenaming.cursorOffset = Math.max(0, sessionsRenaming.cursorOffset - 1);
          renderSessionsModal();
          return true;
        }
        if (isArrowRight(sequence)) {
          sessionsRenaming.cursorOffset = Math.min(sessionsRenaming.value.length, sessionsRenaming.cursorOffset + 1);
          renderSessionsModal();
          return true;
        }
        if (isBackspace(sequence)) {
          if (sessionsRenaming.cursorOffset > 0) {
            sessionsRenaming.value = sessionsRenaming.value.slice(0, sessionsRenaming.cursorOffset - 1) + sessionsRenaming.value.slice(sessionsRenaming.cursorOffset);
            sessionsRenaming.cursorOffset--;
            renderSessionsModal();
          }
          return true;
        }
        {
          const char = getChar(sequence);
          if (char !== null && char.charCodeAt(0) >= 32) {
            sessionsRenaming.value = sessionsRenaming.value.slice(0, sessionsRenaming.cursorOffset) + char + sessionsRenaming.value.slice(sessionsRenaming.cursorOffset);
            sessionsRenaming.cursorOffset++;
            renderSessionsModal();
            return true;
          }
        }
        if (sequence.length > 1 && !sequence.includes('\x1b')) {
          const normalizedText = sequence.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\n/g, ' ');
          if (normalizedText) {
            sessionsRenaming.value = sessionsRenaming.value.slice(0, sessionsRenaming.cursorOffset) + normalizedText + sessionsRenaming.value.slice(sessionsRenaming.cursorOffset);
            sessionsRenaming.cursorOffset += normalizedText.length;
            renderSessionsModal();
          }
          return true;
        }
        return true;
      }

      if (isEscape(sequence) || isCharIgnoreCase(sequence, 'q')) {
        closeSessionsModal();
        return true;
      }
      if (isArrowUp(sequence)) {
        if (sessionsList.length > 0) {
          sessionsSelectedIndex = Math.max(0, sessionsSelectedIndex - 1);
          renderSessionsModal();
        }
        return true;
      }
      if (isArrowDown(sequence)) {
        if (sessionsList.length > 0) {
          sessionsSelectedIndex = Math.min(sessionsList.length - 1, sessionsSelectedIndex + 1);
          renderSessionsModal();
        }
        return true;
      }
      if (sequence === '\x1b[5~') {
        if (sessionsList.length > 0) {
          sessionsSelectedIndex = Math.max(0, sessionsSelectedIndex - sessionsVisibleLineCount);
          renderSessionsModal();
        }
        return true;
      }
      if (sequence === '\x1b[6~') {
        if (sessionsList.length > 0) {
          sessionsSelectedIndex = Math.min(sessionsList.length - 1, sessionsSelectedIndex + sessionsVisibleLineCount);
          renderSessionsModal();
        }
        return true;
      }
      if (isEnter(sequence)) {
        if (sessionsList.length > 0) {
          const selected = sessionsList[sessionsSelectedIndex];
          if (selected) {
            runtime.loadPersistedSession(selected.id);
            currentSession = getSession(selected.id)!;
            while (chatNodeIds.length > 0) {
              const nodeId = chatNodeIds.pop();
              if (nodeId) chatNode.remove(nodeId);
            }
            for (const msg of messages) {
              if (msg.role === 'system') continue;
              if (msg.role === 'user') addMsg(`> ${msg.content}`, '#00ff88');
              else if (msg.role === 'assistant' && msg.content) addMsg(msg.content);
              else if (msg.role === 'tool') addMsg(`[tool] ${msg.content}`, '#888888');
            }
            closeSessionsModal();
            renderHeader();
            root.requestRender();
          }
        }
        return true;
      }
      if (isCharIgnoreCase(sequence, 'n')) {
        currentSession = runtime.startNewSession();
        while (chatNodeIds.length > 0) {
          const nodeId = chatNodeIds.pop();
          if (nodeId) chatNode.remove(nodeId);
        }
        closeSessionsModal();
        renderHeader();
        renderStatusBar();
        root.requestRender();
        return true;
      }
      if (isCharIgnoreCase(sequence, 'r')) {
        if (sessionsList.length > 0) {
          const selected = sessionsList[sessionsSelectedIndex];
          if (selected) {
            sessionsRenaming = { id: selected.id, value: selected.title, cursorOffset: selected.title.length };
            renderSessionsModal();
          }
        }
        return true;
      }
      if (isCharIgnoreCase(sequence, 'd')) {
        if (sessionsList.length > 0) {
          const selected = sessionsList[sessionsSelectedIndex];
          if (selected) {
            const wasActive = selected.id === currentSession.id;
            deleteSession(selected.id);
            if (wasActive) {
              currentSession = runtime.startNewSession();
              while (chatNodeIds.length > 0) {
                const nodeId = chatNodeIds.pop();
                if (nodeId) chatNode.remove(nodeId);
              }
              renderHeader();
            }
            sessionsList = listSessions();
            sessionsSelectedIndex = Math.min(sessionsSelectedIndex, Math.max(0, sessionsList.length - 1));
            renderSessionsModal();
          }
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

    const char = getChar(sequence);
    if (char && (char.toLowerCase() === 'y' || char.toLowerCase() === 'n' || char.toLowerCase() === 'a' || char.toLowerCase() === 'x')) {
      void handleExecutionApproval(char.toLowerCase() as ApprovalActionKey);
      return true;
    }
    if (isArrowLeft(sequence)) {
      approvalSelectionIndex = (approvalSelectionIndex + approvalActions.length - 1) % approvalActions.length;
      renderApprovalDialog();
      return true;
    }
    if (isArrowRight(sequence)) {
      approvalSelectionIndex = (approvalSelectionIndex + 1) % approvalActions.length;
      renderApprovalDialog();
      return true;
    }
    if (isEnter(sequence)) {
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
  // root.add(Text({ 
  //   id: 'header-text', 
  //   content: ` Welcome to askai! (${provider.label} / ${provider.model})`, 
  //   fg: '#00d4ff',
  // }));
  root.add(Box(
    {
      id: 'header-box',
      width: '100%',
      minHeight: 1,
      flexShrink: 0,
      marginBottom: 1,
      border: false,
      flexDirection: 'row',
    },
    Text({
      id: 'header-text',
      content: ` Welcome to askai! (${provider.label} / ${provider.model})`,
      fg: '#00d4ff',
    }),
  ));

  const chat = ScrollBox({
    id: 'chat-box',
    width: '100%',
    flexGrow: 1,
    minHeight: 0,
    paddingX: 1,
    marginBottom: 1,
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
    backgroundColor: '#1f1f1f',
    marginTop: 1,
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
  const modelModalTitleText = Text({
    id: 'model-modal-title-text',
    content: stringToStyledText(''),
    fg: '#d8d8d8',
  });
  modelModal.add(modelModalTitleText);

  const modelModalContentRow = Box({
    id: 'model-modal-content-row',
    width: '100%',
    height: 'auto',
    flexDirection: 'row',
  });

  const modelModalLeftColumn = Box({
    id: 'model-modal-left',
    width: '35%',
    height: 'auto',
    flexDirection: 'column',
    paddingRight: 1,
    border: ['right'],
    borderColor: '#444444',
  });
  const modelModalProvidersText = Text({
    id: 'model-modal-providers-text',
    content: stringToStyledText(''),
    fg: '#d8d8d8',
  });
  modelModalLeftColumn.add(modelModalProvidersText);

  const modelModalRightColumn = Box({
    id: 'model-modal-right',
    flexGrow: 1,
    height: 'auto',
    flexDirection: 'column',
    paddingLeft: 1,
  });
  const modelModalFilterText = Text({
    id: 'model-modal-filter-text',
    content: stringToStyledText(''),
    fg: '#d8d8d8',
  });
  const modelModalModelsText = Text({
    id: 'model-modal-models-text',
    content: stringToStyledText(''),
    fg: '#d8d8d8',
  });
  modelModalRightColumn.add(modelModalFilterText);
  modelModalRightColumn.add(modelModalModelsText);

  modelModalContentRow.add(modelModalLeftColumn);
  modelModalContentRow.add(modelModalRightColumn);
  modelModal.add(modelModalContentRow);

  const sessionsModal = Box({
    id: 'sessions-modal',
    position: 'absolute',
    width: '78%',
    left: '11%',
    top: '12%',
    height: 'auto',
    flexDirection: 'column',
    visible: false,
    backgroundColor: '#141414',
    padding: 1,
  });
  const sessionsModalText = Text({
    id: 'sessions-modal-text',
    content: stringToStyledText(''),
    fg: '#d8d8d8',
  });
  sessionsModal.add(sessionsModalText);

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
  }).add(Text({ content: '>', fg: '#00d4ff' })));

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
    ],
  });
  inputRow.add(input);

  const footerBox = Box({
    id: 'footer-box',
    width: '100%',
    height: 'auto',
    paddingTop: 1,
    flexShrink: 0,
    flexDirection: 'column',
    backgroundColor: '#1f1f1f',
    border: ['left'],
    borderColor: '#ff9e3d',
    customBorderChars: promptAccentBorderChars,
  });
  footerBox.add(inputRow);
  footerBox.add(cmdListBox);
  footerBox.add(statusBar);
  root.add(footerBox);
  root.add(approvalDialog);
  root.add(mcpModal);
  root.add(mcpDetailsModal);
  root.add(providerModal);
  root.add(modelModal);
  root.add(sessionsModal);
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
  const liveModelModalTitleText = renderer.root.findDescendantById('model-modal-title-text') as MutableTextNode | undefined;
  const liveModelModalProvidersText = renderer.root.findDescendantById('model-modal-providers-text') as MutableTextNode | undefined;
  const liveModelModalFilterText = renderer.root.findDescendantById('model-modal-filter-text') as MutableTextNode | undefined;
  const liveModelModalModelsText = renderer.root.findDescendantById('model-modal-models-text') as MutableTextNode | undefined;
  const liveSessionsModal = renderer.root.findDescendantById('sessions-modal') as MutableBoxNode | undefined;
  const liveSessionsModalText = renderer.root.findDescendantById('sessions-modal-text') as MutableTextNode | undefined;

  if (!liveCmdListBox || !liveCmdListText || !liveStatusBarText || !liveHeaderText || !liveInput || !liveChat || !liveApprovalDialog || !liveApprovalDialogText || !liveMcpModal || !liveMcpModalText || !liveMcpDetailsModal || !liveMcpDetailsModalText || !liveProviderModal || !liveProviderModalText || !liveModelModal || !liveModelModalTitleText || !liveModelModalProvidersText || !liveModelModalFilterText || !liveModelModalModelsText || !liveSessionsModal || !liveSessionsModalText) {
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
  const modelModalTitleTextNode = liveModelModalTitleText;
  const modelModalProvidersTextNode = liveModelModalProvidersText;
  const modelModalFilterTextNode = liveModelModalFilterText;
  const modelModalModelsTextNode = liveModelModalModelsText;
  const sessionsModalNode = liveSessionsModal;
  const sessionsModalTextNode = liveSessionsModalText;

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
    const paletteHeight = palette.open ? Math.min(palette.matches.length, 8) : 0;
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
    const slots: ProviderSlot[] = [];
    const addedNormalizedIds = new Set<string>();

    // First add all preset providers
    for (const preset of presetProviderMeta) {
      // Find actual config key (case-insensitive) to preserve original case
      const configKey = Object.keys(config.providers).find(
        k => k.toLowerCase() === preset.id.toLowerCase()
      );
      const providerId = configKey || preset.id;
      addedNormalizedIds.add(providerId.toLowerCase());

      const storedProvider = config.providers[providerId];
      if (storedProvider) {
        const resolvedConfig = resolveProviderConfig(config, providerId);
        slots.push({
          id: providerId,
          displayName: getProviderLabel(resolvedConfig),
          kind: resolvedConfig.kind,
          configured: true,
          apiKeyConfigured: Boolean(resolvedConfig.api_key),
          baseUrl: resolvedConfig.base_url,
          model: resolvedConfig.model,
          models: Array.from(new Set((resolvedConfig.models && resolvedConfig.models.length > 0 ? resolvedConfig.models : [resolvedConfig.model]).filter(Boolean))),
          resolved: resolvedConfig,
        });
      } else {
        slots.push({
          id: providerId,
          displayName: preset.displayName,
          kind: preset.kind,
          configured: false,
          apiKeyConfigured: false,
          baseUrl: preset.baseUrl,
          model: preset.defaultModel,
          models: [],
        });
      }
    }

    // Then add custom providers from config (not presets)
    for (const [providerId, providerConfig] of Object.entries(config.providers)) {
      if (addedNormalizedIds.has(providerId.toLowerCase())) continue;

      const resolvedConfig = resolveProviderConfig(config, providerId);
      slots.push({
        id: providerId,
        displayName: getProviderLabel(resolvedConfig),
        kind: resolvedConfig.kind,
        configured: true,
        apiKeyConfigured: Boolean(resolvedConfig.api_key),
        baseUrl: resolvedConfig.base_url,
        model: resolvedConfig.model,
        models: Array.from(new Set((resolvedConfig.models && resolvedConfig.models.length > 0 ? resolvedConfig.models : [resolvedConfig.model]).filter(Boolean))),
        resolved: resolvedConfig,
      });
    }

    return slots;
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
      id: providerSlot.id,
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
      // For preset providers with kind 'custom' (like Ollama, Llama.cpp), use form values
      if (preset.kind === 'custom') {
        const nextModel = values.model.trim() || preset.defaultModel;
        const nextModels = Array.from(new Set([
          nextModel,
          ...(previousProvider?.models || []),
          previousProvider?.model || '',
        ].map(item => item.trim()).filter(Boolean)));

        return {
          kind: preset.kind,
          api_key: values.api_key.trim() || undefined,
          base_url: values.base_url.trim() || preset.baseUrl,
          model: nextModel,
          models: nextModels.length > 0 ? nextModels : undefined,
        };
      }
      // For cloud presets (OpenAI, Anthropic, OpenRouter), use preset values
      return {
        kind: preset.kind,
        api_key: values.api_key.trim() || undefined,
        base_url: preset.baseUrl,
        model: previousProvider?.model || preset.defaultModel,
        models: previousProvider?.models,
      };
    }

    const nextModel = values.model.trim();
    if (!values.id.trim()) {
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
      api_key: values.api_key.trim() || undefined,
      base_url: values.base_url.trim(),
      model: nextModel,
      models: nextModels.length > 0 ? nextModels : undefined,
    };
  }

  function closeProviderModal(): void {
    providerModalOpen = false;
    providerFormState = null;
    addProviderNameInput = null;
    deleteProviderConfirm = null;
    providerModalNode.visible = false;
    providerModalTextNode.content = stringToStyledText('');
    root.requestRender();
    inputNode.focus();
  }

  function startAddProvider(): void {
    addProviderNameInput = { value: '', cursorOffset: 0 };
    providerModalNotice = null;
    renderProviderModal();
  }

  function showDeleteProviderConfirmation(providerId: string): void {
    deleteProviderConfirm = { providerId };
    providerModalNotice = null;
    renderProviderModal();
  }

  async function deleteCustomProvider(providerId: string): Promise<void> {
    if (!isCustomProviderId(providerId)) {
      return;
    }

    delete config.providers[providerId];

    if (config.provider === providerId) {
      const remaining = Object.keys(config.providers);
      if (remaining.length > 0) {
        config.provider = remaining[0];
        await runtime.switchProvider(config.provider, false);
      } else {
        config.provider = '';
      }
    }

    await runtime.persistConfig();
    providerModalNotice = `Deleted provider ${providerId}.`;
    deleteProviderConfirm = null;
    syncProviderModalSelections(config.provider);
    await refreshActiveProviderView();
    renderProviderModal();
  }

  async function addCustomProvider(name: string): Promise<void> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      providerModalNotice = 'Provider name cannot be empty.';
      renderProviderModal();
      return;
    }

    if (!isProviderIdUnique(config, trimmedName)) {
      providerModalNotice = `Provider "${trimmedName}" already exists. Please use a unique name.`;
      renderProviderModal();
      return;
    }

    if (isPresetProviderId(trimmedName)) {
      providerModalNotice = 'Cannot use a preset provider name.';
      renderProviderModal();
      return;
    }

    config.providers[trimmedName] = {
      kind: 'custom',
      api_key: '',
      base_url: 'http://localhost:8080/v1',
      model: 'llama3',
    };

    await runtime.persistConfig();
    addProviderNameInput = null;
    providerModalNotice = `Created provider "${trimmedName}".`;
    syncProviderModalSelections(trimmedName);
    await refreshActiveProviderView();
    startProviderForm(trimmedName);
  }

  function closeModelModal(): void {
    modelModalOpen = false;
    modelModalNode.visible = false;
    modelModalTitleTextNode.content = stringToStyledText('');
    modelModalProvidersTextNode.content = stringToStyledText('');
    modelModalFilterTextNode.content = stringToStyledText('');
    modelModalModelsTextNode.content = stringToStyledText('');
    root.requestRender();
    inputNode.focus();
  }

  function closeSessionsModal(): void {
    sessionsModalOpen = false;
    sessionsRenaming = null;
    sessionsScrollOffset = 0;
    sessionsModalNode.visible = false;
    sessionsModalTextNode.content = stringToStyledText('');
    root.requestRender();
    inputNode.focus();
  }

  function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function renderSessionsModal(): void {
    if (!sessionsModalOpen) {
      closeSessionsModal();
      return;
    }

    sessionsList = listSessions();

    if (sessionsRenaming) {
      const val = sessionsRenaming.value;
      const cursor = Math.max(0, Math.min(sessionsRenaming.cursorOffset, val.length));
      let cursorChunks: any[];
      if (cursor < val.length) {
        const char = val[cursor];
        cursorChunks = [
          white(val.slice(0, cursor)),
          bgWhite(black(char)),
          white(val.slice(cursor + 1)),
        ];
      } else {
        cursorChunks = [white(val), bgWhite(black(' '))];
      }
      const header = stringToStyledText('Sessions\n\nRename session: ');
      const footer = stringToStyledText('\n\nEnter confirm   Esc cancel   ←/→ move cursor');
      sessionsModalTextNode.content = new StyledText([
        ...header.chunks,
        ...cursorChunks,
        ...footer.chunks,
      ]);
      sessionsModalNode.visible = true;
      if (inputNode.blur) inputNode.blur();
      root.requestRender();
      return;
    }

    if (sessionsList.length === 0) {
      sessionsModalTextNode.content = stringToStyledText(
        'Sessions\n\nNo sessions yet.\n\nn new session   Esc/q close'
      );
      sessionsModalNode.visible = true;
      if (inputNode.blur) inputNode.blur();
      root.requestRender();
      return;
    }

    sessionsSelectedIndex = Math.max(0, Math.min(sessionsSelectedIndex, sessionsList.length - 1));
    const totalSessions = sessionsList.length;
    const maxOffset = Math.max(0, totalSessions - sessionsVisibleLineCount);
    sessionsScrollOffset = Math.max(0, Math.min(sessionsScrollOffset, maxOffset));
    if (sessionsSelectedIndex < sessionsScrollOffset) {
      sessionsScrollOffset = sessionsSelectedIndex;
    } else if (sessionsSelectedIndex >= sessionsScrollOffset + sessionsVisibleLineCount) {
      sessionsScrollOffset = sessionsSelectedIndex - sessionsVisibleLineCount + 1;
    }
    sessionsScrollOffset = Math.max(0, Math.min(sessionsScrollOffset, maxOffset));

    const visibleSessions = sessionsList.slice(sessionsScrollOffset, sessionsScrollOffset + sessionsVisibleLineCount);
    const lines: string[] = ['Sessions', ''];
    for (let i = 0; i < visibleSessions.length; i++) {
      const s = visibleSessions[i];
      const actualIndex = sessionsScrollOffset + i;
      const marker = actualIndex === sessionsSelectedIndex ? '>' : ' ';
      const isActive = s.id === currentSession.id;
      const activeTag = isActive ? ' *' : '';
      const time = formatRelativeTime(s.updated_at);
      const msgs = `${s.message_count} msgs`;
      lines.push(`${marker} ${s.title.slice(0, 45).padEnd(45)} ${time.padStart(10)} ${msgs.padStart(10)}${activeTag}`);
    }
    if (totalSessions > sessionsVisibleLineCount) {
      lines.push('');
      lines.push(`Scroll ${sessionsScrollOffset + 1}-${Math.min(sessionsScrollOffset + visibleSessions.length, totalSessions)} / ${totalSessions}`);
    }
    lines.push('');
    lines.push('↑/↓ select   Enter resume   n new   r rename   d delete   PgUp/PgDn scroll   Esc/q close');

    sessionsModalTextNode.content = stringToStyledText(lines.join('\n'));
    sessionsModalNode.visible = true;
    if (inputNode.blur) inputNode.blur();
    root.requestRender();
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

    // Handle provider form edit state
    if (providerFormState) {
      const formState = providerFormState;
      const visibleFields = getVisibleProviderFormFields(formState.providerId);
      const chunks: any[] = [];

      // Title
      chunks.push(white(`Edit ${getProviderPlaceholderLabel(formState.providerId)}`));
      chunks.push(white('\n'));
      chunks.push(white('\n'));

      // Fields
      visibleFields.forEach((field, index) => {
        const rawValue = formState.values[field.key] || '';
        const marker = index === formState.activeFieldIndex ? '> ' : '  ';
        const label = field.label.padEnd(14);
        const isFocused = index === formState.activeFieldIndex;
        const valueChunks = formatProviderFormTextValue(rawValue, formState.cursorOffset, isFocused);

        chunks.push(white(marker));
        chunks.push(white(label));
        chunks.push(white(' '));
        chunks.push(...valueChunks);
        chunks.push(white('\n'));
      });

      chunks.push(white('\n'));

      if (formState.error) {
        chunks.push(white(`Error: ${formState.error}`));
        chunks.push(white('\n'));
        chunks.push(white('\n'));
      }

      chunks.push(white('Tab/↑/↓ move   ←/→ cursor   Enter save   Esc cancel'));
      providerModalTextNode.content = new StyledText(chunks);
      providerModalNode.visible = true;
      if (inputNode.blur) {
        inputNode.blur();
      }
      root.requestRender();
      return;
    }

    // Handle add provider name input state
    if (addProviderNameInput) {
      const nameInput = addProviderNameInput;
      const valueChunks = formatProviderFormTextValue(nameInput.value, nameInput.cursorOffset, true);
      const chunks: any[] = [
        white('Add new provider'),
        white('\n\n'),
        white('Provider name: '),
        ...valueChunks,
        white('\n\n'),
      ];

      if (providerModalNotice) {
        chunks.push(white(`Error: ${providerModalNotice}`));
        chunks.push(white('\n\n'));
      }

      chunks.push(white('Enter confirm   Esc cancel'));
      providerModalTextNode.content = new StyledText(chunks);
      providerModalNode.visible = true;
      if (inputNode.blur) {
        inputNode.blur();
      }
      root.requestRender();
      return;
    }

    // Handle delete provider confirmation state
    if (deleteProviderConfirm) {
      const lines = [
        'Delete provider',
        '',
        `Delete "${deleteProviderConfirm.providerId}"? This will remove the provider and all its models.`,
        '',
        'y confirm   n/Esc cancel',
      ];
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
      return `${prefix} ${item.displayName}`;
    });

    const summaryLines = selectedProvider ? [
      `Provider: ${selectedProvider.displayName}`,
      `Current model: ${selectedProvider.model || 'not set'}`,
      `Base URL: ${selectedProvider.baseUrl || 'n/a'}`,
    ] : ['No provider selected.'];

    const canDelete = selectedProvider && isCustomProviderId(selectedProvider.id);
    const helpText = canDelete
      ? '↑/↓ move   Enter edit   +/a add   d delete   m models   Esc/q close'
      : '↑/↓ move   Enter edit   +/a add   m models   Esc/q close';

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
      helpText,
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

    const titleContent = ['Select a model to use', ''];

    const providerContent = [
      'Providers',
      ...(modelModalProviderScrollOffset > 0 ? ['  ^ more'] : []),
      ...(providerLines.length > 0 ? providerLines : ['  No providers configured']),
      ...(modelModalProviderScrollOffset + providerModalVisibleItems < providers.length ? ['  v more'] : []),
    ];

    const filterContent = [
      white('Filter  '),
    ];
    const filterValueChunks = formatFilterValue(modelModalFilter.value, modelModalFilter.cursorOffset, modelModalFocus === 'filter');
    filterContent.push(...filterValueChunks);

    const modelContent = [
      `Models${selectedProvider ? ` (${selectedProvider.displayName})` : ''}`,
      ...(modelModalModelScrollOffset > 0 ? ['  ^ more'] : []),
      ...(modelLines.length > 0 ? modelLines : ['  No models available']),
      ...(modelModalModelScrollOffset + providerModalVisibleModels < models.length ? ['  v more'] : []),
    ];

    if (modelModalNotice) {
      modelContent.push('', `Notice: ${modelModalNotice}`);
    }

    const canDelete = selectedProvider ? models.length > 1 : false;
    modelContent.push('', canDelete
      ? 'Tab switch list   ↑/↓ move   Enter use model   d delete model   Esc/q close'
      : 'Tab switch list   ↑/↓ move   Enter use model   Esc/q close');

    modelModalTitleTextNode.content = stringToStyledText(titleContent.join('\n'));
    modelModalProvidersTextNode.content = stringToStyledText(providerContent.join('\n'));
    modelModalFilterTextNode.content = new StyledText(filterContent);
    modelModalModelsTextNode.content = stringToStyledText(modelContent.join('\n'));
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
      const originalId = formState.providerId;
      const newId = formState.values.id?.trim() || originalId;
      const previousProviderConfig = config.providers[originalId];
      const nextConfig = getProviderFormConfig(originalId, formState.values, previousProviderConfig);

      if (!isCustomProviderId(originalId) && !nextConfig.api_key) {
        throw new Error('API key is required for preset providers.');
      }

      // Handle rename for custom providers
      if (isCustomProviderId(originalId) && newId !== originalId) {
        renameProvider(config, originalId, newId);
      }

      upsertProvider(config, newId, nextConfig);

      providerModalNotice = null;
      if (resolvedProvider.id === newId) {
        await runtime.switchProvider(newId, false);
      }

      if (!isCustomProviderId(newId)) {
        try {
          const fetchedModels = await fetchAvailableModels(resolveProviderConfig(config, newId));
          if (fetchedModels.length > 0) {
            const currentModel = config.providers[newId].model;
            const orderedModels = currentModel && fetchedModels.includes(currentModel)
              ? [currentModel, ...fetchedModels.filter(model => model !== currentModel)]
              : fetchedModels;
            config.providers[newId].models = orderedModels;
            config.providers[newId].model = orderedModels[0];
            providerModalNotice = `Fetched ${fetchedModels.length} models for ${getProviderLabel(resolveProviderConfig(config, newId))}.`;
          } else {
            providerModalNotice = `Saved provider. No models were returned for ${getProviderPlaceholderLabel(newId)}.`;
          }
        } catch (error) {
          providerModalNotice = `Saved provider. Failed to refresh models: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      } else {
        providerModalNotice = `Saved ${newId}.`;
      }

      await runtime.persistConfig();
      providerFormState = null;
      syncProviderModalSelections(newId);
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
    if (!selectedProvider) {
      return;
    }
    const models = getModelModalModels(selectedProvider);
    if (models.length <= 1) {
      modelModalNotice = 'Cannot delete the only model for this provider.';
      renderModelModal();
      return;
    }
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

    // Handle provider form edit state
    if (providerFormState) {
      if (isEscape(sequence)) {
        providerFormState = null;
        renderProviderModal();
        return true;
      }
      if (isTab(sequence) || isArrowDown(sequence)) {
        moveProviderFormField(1);
        return true;
      }
      if (isShiftTab(sequence) || isArrowUp(sequence)) {
        moveProviderFormField(-1);
        return true;
      }
      if (sequence === '\x13') {
        await saveProviderForm();
        return true;
      }
      if (isArrowLeft(sequence)) {
        moveProviderFormCursor(-1);
        return true;
      }
      if (isArrowRight(sequence) || sequence === ' ') {
        if (sequence === ' ') {
          insertProviderFormText(' ');
          renderProviderModal();
        } else {
          moveProviderFormCursor(1);
        }
        return true;
      }
      if (isEnter(sequence)) {
        await saveProviderForm();
        return true;
      }
      if (isBackspace(sequence)) {
        deleteProviderFormText();
        renderProviderModal();
        return true;
      }
      {
        const char = getChar(sequence);
        if (char !== null && char.charCodeAt(0) >= 32) {
          insertProviderFormText(char);
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

    // Handle add provider name input state
    if (addProviderNameInput) {
      if (isEscape(sequence)) {
        addProviderNameInput = null;
        providerModalNotice = null;
        renderProviderModal();
        return true;
      }
      if (isEnter(sequence)) {
        await addCustomProvider(addProviderNameInput.value);
        return true;
      }
      if (isArrowLeft(sequence)) {
        addProviderNameInput.cursorOffset = Math.max(0, addProviderNameInput.cursorOffset - 1);
        renderProviderModal();
        return true;
      }
      if (isArrowRight(sequence)) {
        addProviderNameInput.cursorOffset = Math.min(addProviderNameInput.value.length, addProviderNameInput.cursorOffset + 1);
        renderProviderModal();
        return true;
      }
      if (isBackspace(sequence)) {
        const input = addProviderNameInput;
        if (input.cursorOffset > 0) {
          input.value = input.value.slice(0, input.cursorOffset - 1) + input.value.slice(input.cursorOffset);
          input.cursorOffset--;
          renderProviderModal();
        }
        return true;
      }
      {
        const char = getChar(sequence);
        if (char !== null && char.charCodeAt(0) >= 32) {
          const input = addProviderNameInput;
          input.value = input.value.slice(0, input.cursorOffset) + char + input.value.slice(input.cursorOffset);
          input.cursorOffset++;
          providerModalNotice = null;
          renderProviderModal();
          return true;
        }
      }
      if (sequence.length > 1 && !sequence.includes('\x1b')) {
        const normalizedText = sequence.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\n/g, ' ');
        if (normalizedText) {
          const input = addProviderNameInput;
          input.value = input.value.slice(0, input.cursorOffset) + normalizedText + input.value.slice(input.cursorOffset);
          input.cursorOffset += normalizedText.length;
          providerModalNotice = null;
          renderProviderModal();
        }
        return true;
      }
      return true;
    }

    // Handle delete provider confirmation state
    if (deleteProviderConfirm) {
      if (isCharIgnoreCase(sequence, 'y')) {
        await deleteCustomProvider(deleteProviderConfirm.providerId);
        return true;
      }
      if (isEscape(sequence) || isCharIgnoreCase(sequence, 'n')) {
        deleteProviderConfirm = null;
        renderProviderModal();
        return true;
      }
      return true;
    }

    if (isEscape(sequence) || isCharIgnoreCase(sequence, 'q')) {
      closeProviderModal();
      return true;
    }
    if (isArrowUp(sequence)) {
      const providers = getProviderSlots();
      if (providers.length > 0) {
        providerModalProviderIndex = (providerModalProviderIndex + providers.length - 1) % providers.length;
        syncProviderModalSelections(providers[providerModalProviderIndex].id);
      }
      renderProviderModal();
      return true;
    }
    if (isArrowDown(sequence)) {
      const providers = getProviderSlots();
      if (providers.length > 0) {
        providerModalProviderIndex = (providerModalProviderIndex + 1) % providers.length;
        syncProviderModalSelections(providers[providerModalProviderIndex].id);
      }
      renderProviderModal();
      return true;
    }
    if (isCharIgnoreCase(sequence, 'm')) {
      openModelModal(getSelectedProviderSlot()?.id);
      return true;
    }
    if (isEnter(sequence)) {
      const selectedProvider = getSelectedProviderSlot();
      if (selectedProvider) {
        startProviderForm(selectedProvider.id);
      }
      return true;
    }
    if (isChar(sequence, '+') || isCharIgnoreCase(sequence, 'a')) {
      startAddProvider();
      return true;
    }
    if (isCharIgnoreCase(sequence, 'd')) {
      const selectedProvider = getSelectedProviderSlot();
      if (selectedProvider && isCustomProviderId(selectedProvider.id)) {
        showDeleteProviderConfirmation(selectedProvider.id);
      }
      return true;
    }

    return sequence.length > 0;
  }

  async function handleModelModalSequence(sequence: string): Promise<boolean> {
    if (!modelModalOpen) {
      return false;
    }

    if (isTab(sequence)) {
      modelModalFocus = modelModalFocus === 'providers'
        ? 'filter'
        : modelModalFocus === 'filter'
          ? 'models'
          : 'providers';
      renderModelModal();
      return true;
    }
    if (modelModalFocus === 'filter') {
      if (isArrowLeft(sequence)) {
        moveModelFilterCursor(-1);
        renderModelModal();
        return true;
      }
      if (isArrowRight(sequence)) {
        moveModelFilterCursor(1);
        renderModelModal();
        return true;
      }
      if (isBackspace(sequence)) {
        deleteModelFilterText();
        renderModelModal();
        return true;
      }
      if (isEnter(sequence)) {
        modelModalFocus = 'models';
        renderModelModal();
        return true;
      }
      {
        const char = getChar(sequence);
        if (char !== null && char.charCodeAt(0) >= 32) {
          insertModelFilterText(char);
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
    if (isEscape(sequence) || isCharIgnoreCase(sequence, 'q')) {
      closeModelModal();
      return true;
    }
    if (isArrowUp(sequence)) {
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
    if (isArrowDown(sequence)) {
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
    if (isCharIgnoreCase(sequence, 'd')) {
      await deleteSelectedCustomModel();
      return true;
    }
    if (isEnter(sequence)) {
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
    if (mcpModalOpen || mcpDetailsOpen || pendingExecution || providerModalOpen || modelModalOpen || sessionsModalOpen) {
      return false;
    }

    if (shiftEnterSequences.has(sequence)) {
      insertInputNewline();
      return true;
    }

    // Handle IME text input directly by inserting into TextareaRenderable
    // IME input comes as multi-byte UTF-8 sequences without escape codes
    if (sequence.length > 0 && !sequence.includes('\x1b') && inputNode) {
      const hasNonAscii = [...sequence].some(c => c.charCodeAt(0) > 127);
      if (hasNonAscii) {
        // This is IME/composed text - use insertText for proper cursor handling
        inputNode.insertText(sequence);
        inputBuffer = inputNode.plainText;
        return true;
      }
      // For ASCII text in non-Kitty mode (iTerm2), let it pass through to TextareaRenderable
      if (process.env.TERM_PROGRAM === 'iTerm.app') {
        return false;
      }
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

    const maxVisible = 8;
    const totalMatches = palette.matches.length;
    const startOffset = Math.max(0, Math.min(palette.selectedIndex - Math.floor(maxVisible / 2), totalMatches - maxVisible));
    const visibleMatches = palette.matches.slice(startOffset, startOffset + maxVisible);
    const chunks = visibleMatches.flatMap((command, i) => {
      const actualIndex = startOffset + i;
      const line = `${actualIndex === palette.selectedIndex ? '❯ ' : '  '}/${command.name} - ${command.description}`;
      const chunk = actualIndex === palette.selectedIndex ? fg('#00d4ff')(line) : fg('#888888')(line);
      return i < visibleMatches.length - 1 ? [chunk, fg('#888888')('\n')] : [chunk];
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

      const args = toolCall.arguments ? JSON.parse(toolCall.arguments) as Record<string, unknown> as any : {};
      addMsg(`Using tool: ${toolCall.name}`, '#ffaa00');

      try {
        const result = await mcpManager.callTool(toolCall.name, args);
        const content = formatToolContent(result.content);
        if (content) {
          for (const line of content.split('\n')) {
            addMsg(line, result.isError ? '#ff4444' : '#888888');
          }
        }
        const toolContent = content || (result.isError ? 'Tool returned an error.' : 'Tool completed successfully.');
        messages.push({
          role: 'tool',
          content: toolContent,
          tool_call_id: toolCall.id,
        });
        addMessage(currentSession.id, 'tool', toolContent, undefined, toolCall.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown tool error';
        addMsg(`Tool error (${toolCall.name}): ${message}`, '#ff4444');
        messages.push({
          role: 'tool',
          content: `Error: ${message}`,
          tool_call_id: toolCall.id,
        });
        addMessage(currentSession.id, 'tool', `Error: ${message}`, undefined, toolCall.id);
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

    const userMsgCount = messages.filter(m => m.role === 'user').length;
    if (userMsgCount === 1) {
      const title = autoGenerateTitle(text);
      if (!currentSession.id) {
        // First message in a new session - persist to DB
        currentSession = createSession(title, resolvedProvider.id, resolvedProvider.model);
        addMessage(currentSession.id, 'system', systemPrompt);
      } else {
        // Resumed session - update title
        renameSession(currentSession.id, title);
        currentSession = { ...currentSession, title };
      }
      renderHeader();
    }
    addMessage(currentSession.id, 'user', text);

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
        addMessage(currentSession.id, 'assistant', response.content, response.tool_calls);

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
      deleteEmptySessions();
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

    // Handle text input - including multi-character IME input (Chinese/Japanese/Korean)
    if (key.sequence && key.sequence.length > 0) {
      // Check if this is printable text (not a control sequence)
      const isPrintable = key.sequence.split('').every(c => {
        const code = c.charCodeAt(0);
        return code >= 32 || code > 127; // Allow ASCII printable and non-ASCII (IME) chars
      });

      if (isPrintable) {
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
    if (mcpModalOpen || providerModalOpen || modelModalOpen || sessionsModalOpen) {
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
    if (mcpModalOpen || providerModalOpen || modelModalOpen || sessionsModalOpen) {
      return;
    }
    if (pendingExecution) {
      return;
    }
    await submitCurrentInput();
  };

  // Handle global keyboard
  renderer.keyInput.on('keypress', async (key: KeyEvent) => {
    // Handle IME/composed text input (Chinese/Japanese/Korean)
    // IME text comes as non-ASCII or multi-character sequences without escape codes
    if (key.sequence && key.sequence.length > 0 && !key.sequence.includes('\x1b')) {
      const hasNonAscii = [...key.sequence].some(c => c.charCodeAt(0) > 127);
      const isMultiCharText = key.sequence.length > 1;

      if (hasNonAscii || isMultiCharText) {
        // This is likely IME/composed text input
        if (providerModalOpen && providerFormState) {
          insertProviderFormText(key.sequence);
          renderProviderModal();
          return;
        }
        if (modelModalOpen && modelModalFocus === 'filter') {
          insertModelFilterText(key.sequence);
          renderModelModal();
          return;
        }
        if (inputNode && !mcpModalOpen && !pendingExecution && !sessionsModalOpen) {
          // Use insertText for proper cursor handling
          inputNode.insertText(key.sequence);
          inputBuffer = inputNode.plainText;
        }
        return;
      }
    }

    if (key.ctrl && key.name === 'c') {
      if (await handleInterruptSignal()) {
        return;
      }
      deleteEmptySessions();
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

    if (sessionsModalOpen && isEscapeKey(key)) {
      closeSessionsModal();
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

    if (sessionsModalOpen && !key.ctrl && !key.meta) {
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
    // Handle IME/composed text input for main text area
    if (!providerModalOpen && !modelModalOpen && !mcpModalOpen && !pendingExecution && !sessionsModalOpen) {
      event.preventDefault();
      const text = new TextDecoder().decode(event.bytes);
      if (text && inputNode) {
        // Use insertText for proper cursor handling
        inputNode.insertText(text);
        inputBuffer = inputNode.plainText;
      }
      return;
    }

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
    deleteEmptySessions();
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
