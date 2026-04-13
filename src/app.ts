import {
  createCliRenderer,
  Box, Text, ScrollBox, StyledText,
  TextareaRenderable, fg, h, white, bgWhite, black,
  stringToStyledText,
  type KeyEvent,
  BoxRenderable,
  MarkdownRenderable,
  SyntaxStyle
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
  normalizeModels,
  type ProviderConfig,
  type ProviderType,
  type ResolvedProviderConfig,
  type Config,
} from './config';
import { MCPManager } from './mcp';
import { createInitialState, createCommands, Command } from './commands';
import { Message } from './providers/base';
import { createProviderFromConfig } from './providers';
import { MCPTool } from './mcp/client';
import {
  handleProviderModalKey,
  handleModelModalKey,
  type ModalKeyboardContext,
} from './ui/modal-keyboard';
import {
  renderProviderModal as renderProviderModalExtracted,
  renderModelModal as renderModelModalExtracted,
  renderSessionsModal as renderSessionsModalExtracted,
  type ModalRenderContext,
} from './ui/modals';
import {
  createSession,
  addMessage,
  getMessages,
  getSession,
  listSessions,
  renameSession,
  deleteSession,
  deleteEmptySessions,
  recordSessionUsage,
  type SessionStorage,
  type SessionSummary,
} from './session';
import {
  initializeRuntime,
  getAssistantResponse,
  type RunAppOptions,
} from './app-runtime';
import { runOneShotApp } from './oneshot';
export { runOneShotApp };
import {
  formatNumberCompact,
  formatTokenSpeed,
  formatStatusStats,
  formatElapsedSeconds,
  isEnter,
  isEscape,
  isArrowUp,
  isArrowDown,
  isArrowLeft,
  isArrowRight,
  isTab,
  isShiftTab,
  isBackspace,
  isCtrlC,
  isCtrlA,
  isCtrlE,
  isCtrlU,
  isCtrlR,
  isCtrlD,
  getChar,
  isChar,
  isCharIgnoreCase,
  isEscapeKey,
  clampScrollOffset,
  getRandomOneShotFeedbackPrompt,
  oneShotFeedbackPrompts,
  oneShotFeedbackColor,
  ansiReset,
  mcpDetailsModalHeight,
  mcpDetailsVisibleLineCount,
  mcpDetailsFooterLineCount,
  sessionsVisibleLineCount,
  statusSpinnerFrames,
  enableModifyOtherKeys,
  resetModifyOtherKeys,
  shiftEnterSequences,
  approvalActions,
  type ApprovalActionKey,
  presetProviderMeta,
  promptAccentBorderChars,
} from './input-utils';
import { PaletteManager, type IPaletteHost } from './ui/palette';
import { McpManager, type IMcpHost, createMcpState, type McpState } from './ui/mcp';
import { ApprovalManager, type IApprovalHost, createApprovalState, type ApprovalState, type ActiveShellCommand } from './ui/approval';
import { ChatManager, type IChatHost, createChatState, type ChatState } from './ui/chat';
import { ModalsStateManager, type IModalsHost, createModalsState, type ModalsState, formatRelativeTime, ProviderSlot, getVisibleProviderFormFields } from './ui/modals-state';
import type { MutableBoxNode, MutableTextNode, MutableInputNode } from './ui/tui-types';

interface PaletteState {
  open: boolean;
  query: string;
  selectedIndex: number;
  matches: Command[];
}

export { type RunAppOptions } from './app-runtime';

// Re-export for backward compatibility
export { handleProviderModalKey, handleModelModalKey } from './ui/modal-keyboard';
export type { ModalKeyboardContext as ModalHandlerContext } from './ui/modal-keyboard';
export type { ModalRenderContext } from './ui/modals';

// ── TUIApp class ────────────────────────────────────────────────────────────

export class TUIApp {
  // Runtime
  private runtime!: Awaited<ReturnType<typeof initializeRuntime>>;
  private config!: Config;
  private systemPrompt!: string;
  private state!: ReturnType<typeof createInitialState>;

  // Provider/state
  private provider!: Awaited<ReturnType<typeof createProviderFromConfig>>;
  private resolvedProvider!: ResolvedProviderConfig;
  private providerTools: MCPTool[] = [];

  // State objects
  private mcpState: McpState = createMcpState();
  private approvalState: ApprovalState = createApprovalState();
  private modalsState: ModalsState = createModalsState();
  private chatState!: ChatState;

  // Managers
  private paletteManager!: PaletteManager;
  private mcpUI!: McpManager;
  private approvalManager!: ApprovalManager;
  private chatManager!: ChatManager;
  private modalsManager!: ModalsStateManager;

  // Processing
  private inputBuffer = '';
  private statusSpinnerIndex = 0;
  private palette: PaletteState = { open: false, query: '', selectedIndex: 0, matches: [] };
  private activeShellCommand: ActiveShellCommand | null = null;

  // UI nodes
  private chatNode!: MutableBoxNode;
  private chatNodeIds: string[] = [];
  private cmdListBoxNode!: MutableBoxNode;
  private cmdListTextNode!: MutableTextNode;
  private statusBarTextNode!: MutableTextNode;
  private statusBarStatsNode!: MutableTextNode;
  private headerTextNode!: MutableTextNode;
  private inputNode!: MutableInputNode;
  private approvalDialogNode!: MutableBoxNode;
  private approvalDialogTextNode!: MutableTextNode;
  private mcpModalNode!: MutableBoxNode;
  private mcpModalTextNode!: MutableTextNode;
  private mcpDetailsModalNode!: MutableBoxNode;
  private mcpDetailsHeaderBox!: MutableBoxNode;
  private mcpDetailsHeaderText!: MutableTextNode;
  private mcpDetailsScrollBox!: MutableBoxNode;
  private mcpDetailsModalTextNode!: MutableTextNode;
  private mcpDetailsFooterBox!: MutableBoxNode;
  private mcpDetailsModalFooterTextNode!: MutableTextNode;
  private providerModalNode!: MutableBoxNode;
  private providerModalTextNode!: MutableTextNode;
  private modelModalNode!: MutableBoxNode;
  private modelModalTitleTextNode!: MutableTextNode;
  private modelModalProvidersTextNode!: MutableTextNode;
  private modelModalFilterTextNode!: MutableTextNode;
  private modelModalModelsTextNode!: MutableTextNode;
  private sessionsModalNode!: MutableBoxNode;
  private sessionsModalTextNode!: MutableTextNode;
  private root!: BoxRenderable;
  private renderer!: Awaited<ReturnType<typeof createCliRenderer>>;

  private constructor() {}

  static async create(options: RunAppOptions): Promise<TUIApp> {
    const app = new TUIApp();
    await app.init(options);
    return app;
  }

  private async init(options: RunAppOptions): Promise<void> {
    this.runtime = await initializeRuntime(options);
    this.config = this.runtime.config;
    this.systemPrompt = this.runtime.systemPrompt;
    this.state = this.runtime.state;
    this.provider = this.runtime.getProvider();
    this.resolvedProvider = this.runtime.getResolvedProvider();
    this.providerTools = this.runtime.getProviderTools();

    const messages: Message[] = this.runtime.messages;
    const session = this.runtime.session;
    this.chatState = createChatState(messages, session);

    const commands = createCommands(
      this.state,
      () => {
        void this.runtime.refreshProviderTools().then(() => {
          this.providerTools = this.runtime.getProviderTools();
        });
      },
      () => {
        while (this.chatNodeIds.length > 0) {
          const nodeId = this.chatNodeIds.pop();
          if (nodeId) this.chatNode.remove(nodeId);
        }
        this.root.requestRender();
      },
      () => { this.openMcpModal(); },
      async (args) => this.modalsManager.handleProviderCommand(args),
      async (args) => this.modalsManager.handleModelCommand(args),
      async () => {
        this.chatState.currentSession = this.runtime.startNewSession();
        this.chatManager.clearAllMessages();
        this.renderHeader();
        this.renderStatusBar();
        this.root.requestRender();
        return 'Started new session';
      },
      () => { this.openSessionsModal(); },
    );
    this.commands = commands;
    this.palette.matches = [...commands];

    // Build renderer and UI
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      screenMode: 'alternate-screen',
      useKittyKeyboard: process.env.TERM_PROGRAM === 'iTerm.app' ? null : {
        disambiguate: true,
        allKeysAsEscapes: true,
        reportText: true,
      },
    });
    process.stdout.write(enableModifyOtherKeys);
    this.renderer = renderer;

    this.buildUITree(renderer);
    this.resolveLiveNodes(renderer);

    // Create managers (need UI nodes to be resolved first)
    this.paletteManager = new PaletteManager(this.buildPaletteHost());
    this.mcpUI = new McpManager(this.buildMcpHost());
    this.approvalManager = new ApprovalManager(this.buildApprovalHost());
    this.chatManager = new ChatManager(this.buildChatHost());
    this.modalsManager = new ModalsStateManager(this.buildModalsHost());

    this.wireEventHandlers();
  }

  async run(): Promise<void> {
    return new Promise<void>(() => {});
  }

  // ── Host builders ──────────────────────────────────────────────────────

  private buildPaletteHost(): IPaletteHost {
    return {
      getPalette: () => this.palette,
      setPalette: (state) => { this.palette = state; },
      commands: this.commands,
      cmdListBoxNode: this.cmdListBoxNode,
      cmdListTextNode: this.cmdListTextNode,
      inputNode: this.inputNode,
      inputBuffer: this.inputBuffer,
      setInputBuffer: (v) => { this.inputBuffer = v; },
      updateFooterLayout: () => this.updateFooterLayout(),
      root: this.root,
    };
  }

  private buildMcpHost(): IMcpHost {
    return {
      state: this.mcpState,
      mcpManager: this.runtime.mcpManager,
      config: this.config,
      providerTools: this.providerTools,
      setProviderTools: (tools) => { this.providerTools = tools; },
      runtime: {
        getMcpServerStates: () => this.runtime.getMcpServerStates(),
        refreshProviderTools: () => this.runtime.refreshProviderTools(),
        persistConfig: () => this.runtime.persistConfig(),
        getProviderTools: () => this.runtime.getProviderTools(),
      },
      addMsg: (text, color) => this.chatManager.addMsg(text, color),
      mcpModalNode: this.mcpModalNode,
      mcpModalTextNode: this.mcpModalTextNode,
      mcpDetailsModalNode: this.mcpDetailsModalNode,
      mcpDetailsHeaderBox: this.mcpDetailsHeaderBox,
      mcpDetailsHeaderText: this.mcpDetailsHeaderText,
      mcpDetailsScrollBox: this.mcpDetailsScrollBox,
      mcpDetailsModalTextNode: this.mcpDetailsModalTextNode,
      mcpDetailsFooterBox: this.mcpDetailsFooterBox,
      mcpDetailsModalFooterTextNode: this.mcpDetailsModalFooterTextNode,
      inputNode: this.inputNode,
      root: this.root,
    };
  }

  private buildApprovalHost(): IApprovalHost {
    return {
      state: this.approvalState,
      activeShellCommand: this.activeShellCommand,
      setActiveShellCommand: (cmd) => { this.activeShellCommand = cmd; },
      inputBuffer: this.inputBuffer,
      setInputBuffer: (v) => { this.inputBuffer = v; },
      addMsg: (text, color) => this.chatManager.addMsg(text, color),
      renderStatusBar: () => this.renderStatusBar(),
      approvalDialogNode: this.approvalDialogNode,
      approvalDialogTextNode: this.approvalDialogTextNode,
      inputNode: this.inputNode,
      root: this.root,
    };
  }

  private buildChatHost(): IChatHost {
    return {
      state: this.chatState,
      provider: this.provider,
      providerTools: this.providerTools,
      mcpManager: this.runtime.mcpManager,
      resolvedProvider: this.resolvedProvider,
      systemPrompt: this.systemPrompt,
      runtime: {
        getProvider: () => this.runtime.getProvider(),
        getResolvedProvider: () => this.runtime.getResolvedProvider(),
        getProviderTools: () => this.runtime.getProviderTools(),
        refreshProviderTools: () => this.runtime.refreshProviderTools(),
        startNewSession: () => this.runtime.startNewSession(),
        loadPersistedSession: (id) => this.runtime.loadPersistedSession(id),
        persistConfig: () => this.runtime.persistConfig(),
      },
      addMsg: (text, color, md) => this.chatManager.addMsg(text, color, md),
      addUserMsg: (text) => this.chatManager.addUserMsg(text),
      removeLastMsg: () => this.chatManager.removeLastMsg(),
      renderHeader: () => this.renderHeader(),
      renderStatusBar: () => this.renderStatusBar(),
      onCommandExecution: (response) => {
        this.approvalManager.maybeQueueCommandExecution(response, this.state.allowExecute);
      },
      chatNode: this.chatNode,
      chatNodeIds: this.chatNodeIds,
      root: this.root,
    };
  }

  private buildModalsHost(): IModalsHost {
    return {
      state: this.modalsState,
      config: this.config,
      resolvedProvider: this.resolvedProvider,
      runtime: {
        switchProvider: (id, p) => this.runtime.switchProvider(id, p),
        switchModel: (m, p) => this.runtime.switchModel(m, p),
        persistConfig: () => this.runtime.persistConfig(),
        getProvider: () => this.runtime.getProvider(),
        getResolvedProvider: () => this.runtime.getResolvedProvider(),
        getProviderTools: () => this.runtime.getProviderTools(),
        refreshProviderTools: () => this.runtime.refreshProviderTools(),
      },
      renderProviderModal: () => this.renderProviderModal(),
      renderModelModal: () => this.renderModelModal(),
      renderSessionsModal: () => this.renderSessionsModal(),
      refreshActiveProviderView: () => this.refreshActiveProviderView(),
      closeSessionsModal: () => this.closeSessionsModal(),
      closeProviderModal: () => this.closeProviderModal(),
      closeModelModal: () => this.closeModelModal(),
      listSessions: () => this.listSessions(),
      renameSession: (id, title) => this.renameSession(id, title),
      deleteSession: (id) => this.deleteSession(id),
      startNewSession: () => this.runtime.startNewSession(),
      getCurrentSession: () => this.chatState.currentSession,
      getMessages: () => this.chatState.messages,
    };
  }

  // ── UI tree building ───────────────────────────────────────────────────

  private buildUITree(renderer: Awaited<ReturnType<typeof createCliRenderer>>): void {
    const root = Box({ width: '100%', height: '100%', flexDirection: 'column' });
    root.add(Box(
      { id: 'header-box', width: '100%', minHeight: 1, flexShrink: 0, marginBottom: 1, border: false, flexDirection: 'row' },
      Text({ id: 'header-text', content: ` Welcome to askai! (${this.provider.label} / ${this.provider.model})`, fg: '#00d4ff' }),
    ));

    const chat = ScrollBox({
      id: 'chat-box', width: '100%', flexGrow: 1, minHeight: 0, paddingX: 0, marginBottom: 1,
      scrollY: true, stickyScroll: true, stickyStart: 'bottom',
    });
    root.add(chat);

    const cmdListBox = Box({ id: 'cmd-list-box', width: '100%', height: 'auto', maxHeight: 8, flexDirection: 'column', visible: false, paddingLeft: 1 });
    const cmdListText = Text({ id: 'command-palette', content: stringToStyledText(''), fg: '#888888' });
    cmdListBox.add(cmdListText);

    const statusBar = Box({ id: 'status-bar', width: '100%', height: 1, flexShrink: 0, flexDirection: 'row', backgroundColor: '#1f1f1f', marginTop: 1, paddingLeft: 0, paddingRight: 1 });
    const statusBarText = Text({ id: 'status-bar-text', content: stringToStyledText(' Ready'), fg: '#7a7a7a' });
    const statusBarStats = Text({ id: 'status-bar-stats', content: stringToStyledText(this.formatStatusStats(this.chatState.currentSession)), fg: '#7a7a7a' });
    statusBar.add(statusBarText);
    statusBar.add(Box({ id: 'status-bar-spacer', flexGrow: 1, height: 1 }));
    statusBar.add(statusBarStats);

    const approvalDialog = Box({
      id: 'approval-dialog', position: 'absolute', width: '70%', left: '15%', top: '35%', height: 'auto',
      flexDirection: 'column', visible: false, backgroundColor: '#1b1b1b', padding: 1, border: true, borderColor: '#ffaa00',
    });
    const approvalDialogText = Text({ id: 'approval-dialog-text', content: stringToStyledText(''), fg: '#ffaa00' });
    approvalDialog.add(approvalDialogText);

    const mcpModal = Box({
      id: 'mcp-modal', position: 'absolute', width: '78%', left: '11%', top: '18%', height: 'auto',
      flexDirection: 'column', visible: false, backgroundColor: '#161616', padding: 1, border: true, borderColor: '#3f6d8f',
    });
    const mcpModalText = Text({ id: 'mcp-modal-text', content: stringToStyledText(''), fg: '#cfcfcf' });
    mcpModal.add(mcpModalText);

    const mcpDetailsModal = Box({
      id: 'mcp-details-modal', position: 'absolute', width: '74%', left: '13%', top: '22%', height: mcpDetailsModalHeight,
      flexDirection: 'column', visible: false, backgroundColor: '#1a1a1a', padding: 0, border: true, borderColor: '#3f6d8f',
    });

    // Header
    const mcpDetailsHeaderBox = Box({ id: 'mcp-details-header', width: '100%', height: 1, flexShrink: 0, flexDirection: 'row', paddingLeft: 1, paddingRight: 1, backgroundColor: '#1a1a1a' });
    const mcpDetailsHeaderText = Text({ id: 'mcp-details-header-text', content: stringToStyledText(''), fg: '#00d4ff' });
    mcpDetailsHeaderBox.add(mcpDetailsHeaderText);
    mcpDetailsModal.add(mcpDetailsHeaderBox);

    // Body (scrollable)
    const mcpDetailsScrollBox = ScrollBox({ id: 'mcp-details-body', width: '100%', flexGrow: 1, scrollY: true, stickyScroll: true, marginY: 1, paddingX: 1 });
    const mcpDetailsModalText = Text({ id: 'mcp-details-modal-text', content: stringToStyledText(''), fg: '#d8d8d8' });
    mcpDetailsScrollBox.add(mcpDetailsModalText);
    mcpDetailsModal.add(mcpDetailsScrollBox);

    // Footer
    const mcpDetailsFooterBox = Box({ id: 'mcp-details-footer', width: '100%', height: 2, flexShrink: 0, flexDirection: 'column', paddingLeft: 1, paddingRight: 1, backgroundColor: '#1a1a1a' });
    const mcpDetailsModalFooterText = Text({ id: 'mcp-details-modal-footer-text', content: stringToStyledText(''), fg: '#8f8f8f' });
    mcpDetailsFooterBox.add(mcpDetailsModalFooterText);
    mcpDetailsModal.add(mcpDetailsFooterBox);

    const providerModal = Box({
      id: 'provider-modal', position: 'absolute', width: '82%', left: '9%', top: '14%', height: 'auto',
      flexDirection: 'column', visible: false, backgroundColor: '#141414', padding: 1, border: true, borderColor: '#ff9e3d',
    });
    const providerModalText = Text({ id: 'provider-modal-text', content: stringToStyledText(''), fg: '#d8d8d8' });
    providerModal.add(providerModalText);

    const modelModal = Box({
      id: 'model-modal', position: 'absolute', width: '82%', left: '9%', top: '14%', height: 'auto',
      flexDirection: 'column', visible: false, backgroundColor: '#141414', padding: 1, border: true, borderColor: '#ff9e3d',
    });
    const modelModalTitleText = Text({ id: 'model-modal-title-text', content: stringToStyledText(''), fg: '#d8d8d8' });
    modelModal.add(modelModalTitleText);

    const modelModalContentRow = Box({ id: 'model-modal-content-row', width: '100%', height: 'auto', flexDirection: 'row' });
    const modelModalLeftColumn = Box({ id: 'model-modal-left', width: '35%', height: 'auto', flexDirection: 'column', paddingRight: 1, border: ['right'], borderColor: '#444444' });
    const modelModalProvidersText = Text({ id: 'model-modal-providers-text', content: stringToStyledText(''), fg: '#d8d8d8' });
    modelModalLeftColumn.add(modelModalProvidersText);
    const modelModalRightColumn = Box({ id: 'model-modal-right', flexGrow: 1, height: 'auto', flexDirection: 'column', paddingLeft: 1 });
    const modelModalFilterText = Text({ id: 'model-modal-filter-text', content: stringToStyledText(''), fg: '#d8d8d8' });
    const modelModalModelsText = Text({ id: 'model-modal-models-text', content: stringToStyledText(''), fg: '#d8d8d8' });
    modelModalRightColumn.add(modelModalFilterText);
    modelModalRightColumn.add(modelModalModelsText);
    modelModalContentRow.add(modelModalLeftColumn);
    modelModalContentRow.add(modelModalRightColumn);
    modelModal.add(modelModalContentRow);

    const sessionsModal = Box({
      id: 'sessions-modal', position: 'absolute', width: '78%', left: '11%', top: '12%', height: 'auto',
      flexDirection: 'column', visible: false, backgroundColor: '#141414', padding: 1, border: true, borderColor: '#6d8f5b',
    });
    const sessionsModalText = Text({ id: 'sessions-modal-text', content: stringToStyledText(''), fg: '#d8d8d8' });
    sessionsModal.add(sessionsModalText);

    const inputRow = Box({ id: 'input-row', width: '100%', height: 'auto', flexShrink: 0, flexDirection: 'row', backgroundColor: '#1f1f1f', paddingLeft: 0, paddingRight: 1 });
    inputRow.add(Box({ width: 2, height: '100%', flexDirection: 'column', backgroundColor: '#1f1f1f', border: false }).add(Text({ content: '>', fg: '#00d4ff' })));
    const input = h(TextareaRenderable, {
      id: 'main-input', flexGrow: 1, height: 'auto', minHeight: 1, maxHeight: 20,
      placeholder: 'Type / for commands...', textColor: '#ffffff', backgroundColor: '#1f1f1f',
      cursorColor: '#00d4ff', wrapMode: 'word',
      keyBindings: [{ name: 'return', action: 'submit' }, { name: 'return', shift: true, action: 'newline' }],
    });
    inputRow.add(input);

    const footerBox = Box({
      id: 'footer-box', width: '100%', height: 'auto', paddingTop: 1, flexShrink: 0, flexDirection: 'column',
      backgroundColor: '#1f1f1f', border: ['left'], borderColor: '#ff9e3d', customBorderChars: promptAccentBorderChars,
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
  }

  private resolveLiveNodes(renderer: Awaited<ReturnType<typeof createCliRenderer>>): void {
    const find = (id: string) => renderer.root.findDescendantById(id);

    this.cmdListBoxNode = find('cmd-list-box') as unknown as MutableBoxNode;
    this.cmdListTextNode = find('command-palette') as unknown as MutableTextNode;
    this.statusBarTextNode = find('status-bar-text') as unknown as MutableTextNode;
    this.statusBarStatsNode = find('status-bar-stats') as unknown as MutableTextNode;
    this.headerTextNode = find('header-text') as unknown as MutableTextNode;
    this.inputNode = find('main-input') as unknown as MutableInputNode;
    this.chatNode = find('chat-box') as unknown as MutableBoxNode;
    this.approvalDialogNode = find('approval-dialog') as unknown as MutableBoxNode;
    this.approvalDialogTextNode = find('approval-dialog-text') as unknown as MutableTextNode;
    this.mcpModalNode = find('mcp-modal') as unknown as MutableBoxNode;
    this.mcpModalTextNode = find('mcp-modal-text') as unknown as MutableTextNode;
    this.mcpDetailsModalNode = find('mcp-details-modal') as unknown as MutableBoxNode;
    this.mcpDetailsHeaderBox = find('mcp-details-header') as unknown as MutableBoxNode;
    this.mcpDetailsHeaderText = find('mcp-details-header-text') as unknown as MutableTextNode;
    this.mcpDetailsScrollBox = find('mcp-details-body') as unknown as MutableBoxNode;
    this.mcpDetailsModalTextNode = find('mcp-details-modal-text') as unknown as MutableTextNode;
    this.mcpDetailsFooterBox = find('mcp-details-footer') as unknown as MutableBoxNode;
    this.mcpDetailsModalFooterTextNode = find('mcp-details-modal-footer-text') as unknown as MutableTextNode;
    this.providerModalNode = find('provider-modal') as unknown as MutableBoxNode;
    this.providerModalTextNode = find('provider-modal-text') as unknown as MutableTextNode;
    this.modelModalNode = find('model-modal') as unknown as MutableBoxNode;
    this.modelModalTitleTextNode = find('model-modal-title-text') as unknown as MutableTextNode;
    this.modelModalProvidersTextNode = find('model-modal-providers-text') as unknown as MutableTextNode;
    this.modelModalFilterTextNode = find('model-modal-filter-text') as unknown as MutableTextNode;
    this.modelModalModelsTextNode = find('model-modal-models-text') as unknown as MutableTextNode;
    this.sessionsModalNode = find('sessions-modal') as unknown as MutableBoxNode;
    this.sessionsModalTextNode = find('sessions-modal-text') as unknown as MutableTextNode;
    this.root = this.renderer.root as unknown as BoxRenderable;

    // Validate
    if (!this.cmdListBoxNode || !this.cmdListTextNode || !this.statusBarTextNode || !this.statusBarStatsNode ||
        !this.headerTextNode || !this.inputNode || !this.chatNode || !this.approvalDialogNode || !this.approvalDialogTextNode ||
        !this.mcpModalNode || !this.mcpModalTextNode || !this.mcpDetailsModalNode || !this.mcpDetailsHeaderBox || !this.mcpDetailsHeaderText || !this.mcpDetailsScrollBox || !this.mcpDetailsModalTextNode || !this.mcpDetailsFooterBox || !this.mcpDetailsModalFooterTextNode ||
        !this.providerModalNode || !this.providerModalTextNode || !this.modelModalNode || !this.modelModalTitleTextNode ||
        !this.modelModalProvidersTextNode || !this.modelModalFilterTextNode || !this.modelModalModelsTextNode ||
        !this.sessionsModalNode || !this.sessionsModalTextNode) {
      throw new Error('Failed to initialize TUI render tree');
    }

    // Wire mouse handlers
    this.providerModalNode.onMouseDown = (event) => {
      if (this.modalsState.providerModalOpen && this.modalsState.providerFormState) {
        this.modalsManager.placeProviderFormCursorFromMouse(event.x, event.y, this.providerModalNode);
      }
    };
    this.providerModalNode.onMouseScroll = (event) => {
      if (!this.modalsState.providerModalOpen || this.modalsState.providerFormState) return;
      const direction = event.scroll?.direction;
      if (direction === 'up' || direction === 'down') {
        const providers = this.modalsManager.getProviderSlots();
        if (providers.length > 0) {
          this.modalsState.providerModalProviderIndex = direction === 'up'
            ? (this.modalsState.providerModalProviderIndex + providers.length - 1) % providers.length
            : (this.modalsState.providerModalProviderIndex + 1) % providers.length;
          this.modalsManager.syncProviderModalSelections(providers[this.modalsState.providerModalProviderIndex].id);
          this.renderProviderModal();
        }
      }
    };
    this.modelModalNode.onMouseScroll = (event) => {
      if (!this.modalsState.modelModalOpen) return;
      const direction = event.scroll?.direction;
      if (direction !== 'up' && direction !== 'down') return;

      if (this.modalsState.modelModalFocus === 'providers') {
        const providers = this.modalsManager.getProviderSlots();
        if (providers.length === 0) return;
        this.modalsState.modelModalProviderIndex = direction === 'up'
          ? (this.modalsState.modelModalProviderIndex + providers.length - 1) % providers.length
          : (this.modalsState.modelModalProviderIndex + 1) % providers.length;
        this.modalsManager.syncModelModalSelection(providers[this.modalsState.modelModalProviderIndex].id);
      } else if (this.modalsState.modelModalFocus === 'models') {
        const models = this.modalsManager.getModelModalModels(this.modalsManager.getSelectedModelModalProvider());
        if (models.length === 0) return;
        this.modalsState.modelModalModelIndex = direction === 'up'
          ? (this.modalsState.modelModalModelIndex + models.length - 1) % models.length
          : (this.modalsState.modelModalModelIndex + 1) % models.length;
        this.modalsState.modelModalModelScrollOffset = clampScrollOffset(
          this.modalsState.modelModalModelIndex, this.modalsState.modelModalModelScrollOffset, 8, models.length);
      }
      this.renderModelModal();
    };
    this.mcpDetailsModalNode.onMouseScroll = (event) => {
      if (!this.mcpState.mcpDetailsOpen) return;
      const states = this.runtime.getMcpServerStates();
      const selectedState = states[this.mcpState.mcpServerIndex];
      // Simplified scroll handling - full details lines would need getMcpDetailsContentLines
      const delta = Math.max(1, event.scroll?.delta ?? 1);
      if (event.scroll?.direction === 'up') {
        this.mcpState.mcpDetailsScrollOffset = Math.max(0, this.mcpState.mcpDetailsScrollOffset - delta);
        this.mcpUI.renderMcpDetailsModal();
      } else if (event.scroll?.direction === 'down') {
        this.mcpState.mcpDetailsScrollOffset = Math.max(0, this.mcpState.mcpDetailsScrollOffset + delta);
        this.mcpUI.renderMcpDetailsModal();
      }
    };
  }

  private wireEventHandlers(): void {
    const renderer = this.renderer;

    renderer.prependInputHandler((sequence: string) => {
      // Model modal (higher z-order, checked first)
      if (this.modalsState.modelModalOpen) {
        if (isCtrlC(sequence)) return false;
        void this.handleModelModalSequence(sequence);
        return true;
      }

      // Provider modal sequences
      if (this.modalsState.providerModalOpen) {
        if (isCtrlC(sequence)) return false;
        void this.handleProviderModalSequence(sequence);
        return true;
      }

      // MCP details
      if (this.mcpState.mcpDetailsOpen) {
        if (isCtrlC(sequence)) return false;
        if (isEscape(sequence) || isCharIgnoreCase(sequence, 'q')) { this.closeMcpDetailsModal(); return true; }
        if (isArrowUp(sequence)) { this.mcpState.mcpDetailsScrollOffset = Math.max(0, this.mcpState.mcpDetailsScrollOffset - 1); this.mcpUI.renderMcpDetailsModal(); return true; }
        if (isArrowDown(sequence)) { this.mcpState.mcpDetailsScrollOffset = Math.max(0, this.mcpState.mcpDetailsScrollOffset + 1); this.mcpUI.renderMcpDetailsModal(); return true; }
        if (sequence === '\x1b[5~') { this.mcpState.mcpDetailsScrollOffset = Math.max(0, this.mcpState.mcpDetailsScrollOffset - 8); this.mcpUI.renderMcpDetailsModal(); return true; }
        if (sequence === '\x1b[6~') { this.mcpState.mcpDetailsScrollOffset = Math.max(0, this.mcpState.mcpDetailsScrollOffset + 8); this.mcpUI.renderMcpDetailsModal(); return true; }
        return true;
      }

      // MCP modal
      if (this.mcpState.mcpModalOpen) {
        if (isCtrlC(sequence)) return false;
        if (isEscape(sequence) || isCharIgnoreCase(sequence, 'q')) { this.closeMcpModal(); return true; }
        if (isArrowUp(sequence)) {
          const states = this.runtime.getMcpServerStates();
          if (states.length > 0) { this.mcpState.mcpServerIndex = (this.mcpState.mcpServerIndex + states.length - 1) % states.length; this.mcpUI.renderMcpModal(); }
          return true;
        }
        if (isArrowDown(sequence)) {
          const states = this.runtime.getMcpServerStates();
          if (states.length > 0) { this.mcpState.mcpServerIndex = (this.mcpState.mcpServerIndex + 1) % states.length; this.mcpUI.renderMcpModal(); }
          return true;
        }
        if (isCharIgnoreCase(sequence, 'c')) { void this.mcpUI.runMcpModalConnectionAction(); return true; }
        if (sequence === ' ') { void this.mcpUI.toggleMcpServerAutoConnect(); return true; }
        if (isEnter(sequence)) { if (this.mcpState.mcpFocus === 'server') { this.mcpUI.openMcpDetailsModal(); } return true; }
        return true;
      }

      // Sessions modal
      if (this.modalsState.sessionsModalOpen) {
        if (isCtrlC(sequence)) return false;
        if (this.handleSessionsModalSequence(sequence)) return true;
        return true;
      }

      // Approval dialog
      if (!this.approvalState.pendingExecution) return false;
      if (isCtrlC(sequence)) return false;
      const char = getChar(sequence);
      if (char && (char.toLowerCase() === 'y' || char.toLowerCase() === 'n' || char.toLowerCase() === 'a' || char.toLowerCase() === 'x')) {
        void this.approvalManager.handleExecutionApproval(char.toLowerCase() as ApprovalActionKey);
        return true;
      }
      if (isArrowLeft(sequence)) { this.approvalState.approvalSelectionIndex = (this.approvalState.approvalSelectionIndex + approvalActions.length - 1) % approvalActions.length; this.approvalManager.renderApprovalDialog(); return true; }
      if (isArrowRight(sequence)) { this.approvalState.approvalSelectionIndex = (this.approvalState.approvalSelectionIndex + 1) % approvalActions.length; this.approvalManager.renderApprovalDialog(); return true; }
      if (isEnter(sequence)) { void this.approvalManager.handleExecutionApproval(approvalActions[this.approvalState.approvalSelectionIndex].key); return true; }
      return true;
    });

    // Input handlers
    this.inputNode.onContentChange = () => {
      if (this.mcpState.mcpModalOpen || this.modalsState.providerModalOpen || this.modalsState.modelModalOpen || this.modalsState.sessionsModalOpen) return;
      if (this.approvalState.pendingExecution) {
        if (this.inputNode.plainText !== this.approvalState.approvalDraftText) {
          this.inputNode.setText(this.approvalState.approvalDraftText);
        }
        this.inputBuffer = this.approvalState.approvalDraftText;
        return;
      }
      this.syncCommandPalette(this.inputNode.plainText);
    };

    this.inputNode.onSubmit = async () => {
      if (this.mcpState.mcpModalOpen || this.modalsState.providerModalOpen || this.modalsState.modelModalOpen || this.modalsState.sessionsModalOpen) return;
      if (this.approvalState.pendingExecution) return;
      await this.submitCurrentInput();
    };

    renderer.prependInputHandler((sequence: string) => {
      if (this.mcpState.mcpModalOpen || this.mcpState.mcpDetailsOpen || this.approvalState.pendingExecution || this.modalsState.providerModalOpen || this.modalsState.modelModalOpen || this.modalsState.sessionsModalOpen) return false;
      if (shiftEnterSequences.has(sequence)) { this.insertInputNewline(); return true; }
      if (sequence.length > 0 && !sequence.includes('\x1b') && this.inputNode) {
        const hasNonAscii = [...sequence].some(c => c.charCodeAt(0) > 127);
        if (hasNonAscii) { this.inputNode.insertText(sequence); this.inputBuffer = this.inputNode.plainText; return true; }
        if (process.env.TERM_PROGRAM === 'iTerm.app') return false;
      }
      return false;
    });

    // Global keyboard
    this.renderer.keyInput.on('keypress', async (key: KeyEvent) => {
      if (key.sequence && key.sequence.length > 0 && !key.sequence.includes('\x1b')) {
        const hasNonAscii = [...key.sequence].some(c => c.charCodeAt(0) > 127);
        const isMultiCharText = key.sequence.length > 1;
        if (hasNonAscii || isMultiCharText) {
          if (this.modalsState.providerModalOpen && this.modalsState.providerFormState) {
            this.modalsManager.insertProviderFormText(key.sequence);
            this.renderProviderModal();
            return;
          }
          if (this.modalsState.modelModalOpen && this.modalsState.modelModalFocus === 'filter') {
            this.modalsManager.insertModelFilterText(key.sequence);
            this.renderModelModal();
            return;
          }
          if (this.inputNode && !this.mcpState.mcpModalOpen && !this.approvalState.pendingExecution && !this.modalsState.sessionsModalOpen) {
            this.inputNode.insertText(key.sequence);
            this.inputBuffer = this.inputNode.plainText;
          }
          return;
        }
      }

      if (key.ctrl && key.name === 'c') {
        if (await this.handleInterruptSignal()) return;
        this.deleteEmptySessions();
        if (this.runtime.mcpManager) await this.runtime.mcpManager.disconnectAll();
        process.stdout.write(resetModifyOtherKeys);
        this.renderer.destroy();
        process.exit(0);
      }

      if (this.mcpState.mcpDetailsOpen && isEscapeKey(key)) { this.closeMcpDetailsModal(); return; }
      if (this.mcpState.mcpModalOpen && isEscapeKey(key)) { this.closeMcpModal(); return; }
      if (this.modalsState.providerModalOpen && isEscapeKey(key)) { this.closeProviderModal(); return; }
      if (this.modalsState.modelModalOpen && isEscapeKey(key)) { this.closeModelModal(); return; }
      if (this.modalsState.sessionsModalOpen && isEscapeKey(key)) {
        // If in a sub-state (renaming, delete confirm), cancel that instead of closing modal
        if (this.modalsState.sessionsRenaming) {
          this.modalsState.sessionsRenaming = null;
          this.renderSessionsModal();
          return;
        }
        if (this.modalsState.deleteSessionConfirm) {
          this.modalsState.deleteSessionConfirm = null;
          this.renderSessionsModal();
          return;
        }
        this.closeSessionsModal();
        return;
      }

      if (this.modalsState.providerModalOpen && this.modalsState.providerFormState && (key.sequence === '\x13' || (key.ctrl && key.name === 's'))) {
        await this.modalsManager.saveProviderForm();
        return;
      }

      if ((this.modalsState.providerModalOpen || this.modalsState.modelModalOpen) && !key.ctrl && !key.meta) return;
      if (this.mcpState.mcpModalOpen && !key.ctrl && !key.meta) return;
      if (this.modalsState.sessionsModalOpen && !key.ctrl && !key.meta) return;
      if (this.approvalState.pendingExecution && !key.ctrl && !key.meta) return;

      this.applyKeyToBuffer(key);

      if (this.palette.open && key.name === 'escape') { this.clearCommandInput(); return; }
      if (this.palette.open && (key.name === 'return' || key.name === 'linefeed')) {
        await this.submitCurrentInput();
        return;
      }
      if (this.palette.open && key.name === 'tab') {
        this.completeSelectedCommand();
        return;
      }
      if (this.palette.open) {
        if (key.name === 'up') { this.palette = { ...this.palette, selectedIndex: Math.max(0, this.palette.selectedIndex - 1) }; this.paletteManager.render(); return; }
        if (key.name === 'down') { this.palette = { ...this.palette, selectedIndex: Math.min(this.palette.matches.length - 1, this.palette.selectedIndex + 1) }; this.paletteManager.render(); return; }
      }

      if (!key.ctrl && !key.meta) {
        const typedSlash = key.name === '/' || key.name === 'slash' || key.sequence === '/';
        if (typedSlash && !this.palette.open && this.inputBuffer === '') { this.openPalette(''); }
      }
    });

    // Paste handler
    this.renderer.keyInput.on('paste', (event) => {
      if (!this.modalsState.providerModalOpen && !this.modalsState.modelModalOpen && !this.mcpState.mcpModalOpen && !this.approvalState.pendingExecution && !this.modalsState.sessionsModalOpen) {
        event.preventDefault();
        const text = new TextDecoder().decode(event.bytes);
        if (text && this.inputNode) { this.inputNode.insertText(text); this.inputBuffer = this.inputNode.plainText; }
        return;
      }
      if (this.modalsState.providerModalOpen && this.modalsState.providerFormState) {
        event.preventDefault();
        const text = new TextDecoder().decode(event.bytes);
        this.modalsManager.insertProviderFormPaste(text);
        return;
      }
      if (this.modalsState.providerModalOpen && this.modalsState.addProviderNameInput) {
        event.preventDefault();
        const text = new TextDecoder().decode(event.bytes);
        const normalizedText = text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\n/g, ' ');
        if (normalizedText) {
          this.modalsState.addProviderNameInput.value = this.modalsState.addProviderNameInput.value.slice(0, this.modalsState.addProviderNameInput.cursorOffset) + normalizedText + this.modalsState.addProviderNameInput.value.slice(this.modalsState.addProviderNameInput.cursorOffset);
          this.modalsState.addProviderNameInput.cursorOffset += normalizedText.length;
          this.modalsState.providerModalNotice = null;
          this.renderProviderModal();
        }
        return;
      }
      if (this.modalsState.modelModalOpen && this.modalsState.modelModalFocus === 'filter') {
        event.preventDefault();
        const text = new TextDecoder().decode(event.bytes);
        this.modalsManager.insertModelFilterPaste(text);
        this.renderModelModal();
        return;
      }
      if (this.modalsState.addModelInput) {
        event.preventDefault();
        const text = new TextDecoder().decode(event.bytes);
        this.modalsManager.insertAddModelPaste(text);
        this.renderModelModal();
        return;
      }
      if (this.modalsState.sessionsModalOpen && this.modalsState.sessionsRenaming) {
        event.preventDefault();
        const text = new TextDecoder().decode(event.bytes);
        const normalizedText = text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\n/g, ' ');
        if (normalizedText) {
          this.modalsState.sessionsRenaming.value = this.modalsState.sessionsRenaming.value.slice(0, this.modalsState.sessionsRenaming.cursorOffset) + normalizedText + this.modalsState.sessionsRenaming.value.slice(this.modalsState.sessionsRenaming.cursorOffset);
          this.modalsState.sessionsRenaming.cursorOffset += normalizedText.length;
          this.renderSessionsModal();
        }
        return;
      }
      if (this.modalsState.sessionsModalOpen && !this.modalsState.deleteSessionConfirm && !this.modalsState.sessionsRenaming) {
        event.preventDefault();
        const text = new TextDecoder().decode(event.bytes);
        const normalizedText = text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\n/g, ' ');
        if (normalizedText) {
          this.modalsState.sessionsFilter.value = this.modalsState.sessionsFilter.value.slice(0, this.modalsState.sessionsFilter.cursorOffset) + normalizedText + this.modalsState.sessionsFilter.value.slice(this.modalsState.sessionsFilter.cursorOffset);
          this.modalsState.sessionsFilter.cursorOffset += normalizedText.length;
          this.clampSelectionToFiltered();
          this.renderSessionsModal();
        }
        return;
      }
    });

    // SIGINT handler
    const sigintHandler = async () => {
      if (await this.handleInterruptSignal()) return;
      if (this.mcpState.mcpLifecycleRefreshTimer) {
        clearInterval(this.mcpState.mcpLifecycleRefreshTimer);
        this.mcpState.mcpLifecycleRefreshTimer = null;
      }
      this.deleteEmptySessions();
      if (this.runtime.mcpManager) await this.runtime.mcpManager.disconnectAll();
      process.stdout.write(resetModifyOtherKeys);
      this.renderer.destroy();
      process.exit(0);
    };
    process.on('SIGINT', sigintHandler);

    // Status spinner
    setInterval(() => {
      this.statusSpinnerIndex = (this.statusSpinnerIndex + 1) % statusSpinnerFrames.length;
      if (this.activeShellCommand || (this.chatState.isProcessing && this.chatState.activeTurn)) {
        this.renderStatusBar();
      }
    }, 120);

    this.updateFooterLayout();
    this.renderStatusBar();
    this.inputNode.focus();
  }

  // ── Interrupt handling ─────────────────────────────────────────────────

  private async handleInterruptSignal(): Promise<boolean> {
    if (await this.chatManager.handleInterruptSignal()) return true;
    if (await this.approvalManager.handleInterruptShellCommand()) return true;
    return false;
  }

  // ── Modal open/close ───────────────────────────────────────────────────

  private openMcpModal(): void {
    this.mcpState.mcpModalOpen = true;
    this.mcpState.mcpFocus = 'server';
    this.mcpUI.renderMcpModal();
  }

  private closeMcpModal(): void {
    this.mcpUI.closeMcpModal();
  }

  private closeMcpDetailsModal(): void {
    this.mcpUI.closeMcpDetailsModal();
  }

  private openSessionsModal(): void {
    this.modalsManager.updateSessionsList();
    const cs = this.chatState.currentSession;
    // If the active session is saved, select it; otherwise leave nothing selected
    if (cs.id) {
      const currentIndex = this.modalsState.sessionsList.findIndex(s => s.id === cs.id);
      this.modalsState.sessionsSelectedIndex = currentIndex >= 0 ? currentIndex : -1;
    } else {
      this.modalsState.sessionsSelectedIndex = -1;
    }
    this.modalsState.sessionsModalOpen = true;
    this.modalsState.sessionsFilter = { value: '', cursorOffset: 0 };
    this.modalsState.sessionsScrollOffset = 0;
    this.renderSessionsModal();
  }

  private closeSessionsModal(): void {
    this.modalsState.sessionsModalOpen = false;
    this.modalsState.sessionsRenaming = null;
    this.modalsState.sessionsFilter = { value: '', cursorOffset: 0 };
    this.modalsState.sessionsScrollOffset = 0;
    this.sessionsModalNode.visible = false;
    this.sessionsModalTextNode.content = stringToStyledText('');
    this.root.requestRender();
    this.inputNode.focus();
  }

  private closeProviderModal(): void {
    this.modalsState.providerModalOpen = false;
    this.modalsState.providerFormState = null;
    this.modalsState.addProviderNameInput = null;
    this.modalsState.deleteProviderConfirm = null;
    this.providerModalNode.visible = false;
    this.providerModalTextNode.content = stringToStyledText('');
    this.root.requestRender();
    this.inputNode.focus();
  }

  private closeModelModal(): void {
    this.modalsState.modelModalOpen = false;
    this.modelModalNode.visible = false;
    this.modelModalTitleTextNode.content = stringToStyledText('');
    this.modelModalProvidersTextNode.content = stringToStyledText('');
    this.modelModalFilterTextNode.content = stringToStyledText('');
    this.modelModalModelsTextNode.content = stringToStyledText('');
    this.root.requestRender();
    // If provider modal is still open, keep focus there instead of main input
    if (!this.modalsState.providerModalOpen) {
      this.inputNode.focus();
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private renderStatusBar(): void {
    const session = this.chatState.currentSession;
    this.statusBarStatsNode.content = stringToStyledText(this.formatStatusStats(session));

    if (this.activeShellCommand) {
      const spinner = statusSpinnerFrames[this.statusSpinnerIndex % statusSpinnerFrames.length];
      this.statusBarTextNode.content = new StyledText([
        fg('#ffaa00')(` ${spinner} `),
        fg('#d8d8d8')('Working... Ctrl+C to interrupt'),
      ]);
      this.root.requestRender();
      return;
    }

    if (this.chatState.isProcessing && this.chatState.activeTurn) {
      const spinner = statusSpinnerFrames[this.statusSpinnerIndex % statusSpinnerFrames.length];
      this.statusBarTextNode.content = new StyledText([
        fg('#00d4ff')(` ${spinner} `),
        fg('#d8d8d8')('Working... Ctrl+C to interrupt'),
      ]);
      this.root.requestRender();
      return;
    }

    this.statusBarTextNode.content = new StyledText([fg('#7a7a7a')(' Ready')]);
    this.root.requestRender();
  }

  private renderHeader(): void {
    this.headerTextNode.content = stringToStyledText(` Welcome to askai! (${this.provider.label} / ${this.provider.model})`);
    this.root.requestRender();
  }

  private async refreshActiveProviderView(): Promise<void> {
    this.provider = this.runtime.getProvider();
    this.resolvedProvider = this.runtime.getResolvedProvider();
    this.providerTools = this.runtime.getProviderTools();
    this.renderHeader();
    this.renderStatusBar();
  }

  private renderProviderModal(): void {
    renderProviderModalExtracted(this.buildModalRenderContext());
  }

  private renderModelModal(): void {
    renderModelModalExtracted(this.buildModalRenderContext());
  }

  private renderSessionsModal(): void {
    renderSessionsModalExtracted(this.buildModalRenderContext());
  }

  private buildModalRenderContext(): ModalRenderContext {
    return {
      providerModalNode: this.providerModalNode,
      providerModalTextNode: this.providerModalTextNode,
      modelModalNode: this.modelModalNode,
      modelModalTitleTextNode: this.modelModalTitleTextNode,
      modelModalProvidersTextNode: this.modelModalProvidersTextNode,
      modelModalFilterTextNode: this.modelModalFilterTextNode,
      modelModalModelsTextNode: this.modelModalModelsTextNode,
      sessionsModalNode: this.sessionsModalNode,
      sessionsModalTextNode: this.sessionsModalTextNode,
      inputNode: this.inputNode,
      root: this.root,
      getProviderSlots: () => this.modalsManager.getProviderSlots(),
      getSelectedProviderSlot: () => this.modalsManager.getSelectedProviderSlot(),
      getSelectedModelModalProvider: () => this.modalsManager.getSelectedModelModalProvider(),
      getModelModalModels: (p) => this.modalsManager.getModelModalModels(p),
      isCustomProviderId: (id) => isPresetProviderId(id) === false,
      getVisibleProviderFormFields,
      getProviderFormConfig: (id, vals, prev) => {
        return prev || { kind: 'custom' as const };
      },
      createProviderFormState: (slot) => this.modalsManager.createProviderFormState(slot),
      providerModalOpen: this.modalsState.providerModalOpen,
      providerModalProviderIndex: this.modalsState.providerModalProviderIndex,
      providerModalProviderScrollOffset: this.modalsState.providerModalProviderScrollOffset,
      providerFormState: this.modalsState.providerFormState,
      providerModalNotice: this.modalsState.providerModalNotice,
      addProviderNameInput: this.modalsState.addProviderNameInput,
      deleteProviderConfirm: this.modalsState.deleteProviderConfirm,
      modelModalOpen: this.modalsState.modelModalOpen,
      modelModalFocus: this.modalsState.modelModalFocus,
      modelModalProviderIndex: this.modalsState.modelModalProviderIndex,
      modelModalModelIndex: this.modalsState.modelModalModelIndex,
      modelModalProviderScrollOffset: this.modalsState.modelModalProviderScrollOffset,
      modelModalModelScrollOffset: this.modalsState.modelModalModelScrollOffset,
      modelModalFilter: this.modalsState.modelModalFilter,
      addModelInput: this.modalsState.addModelInput,
      addModelInputProviderName: this.modalsState.addModelInputProviderName,
      modelModalNotice: this.modalsState.modelModalNotice,
      sessionsModalOpen: this.modalsState.sessionsModalOpen,
      sessionsList: this.modalsState.sessionsList,
      sessionsSelectedIndex: this.modalsState.sessionsSelectedIndex,
      sessionsScrollOffset: this.modalsState.sessionsScrollOffset,
      sessionsRenaming: this.modalsState.sessionsRenaming,
      deleteSessionConfirm: this.modalsState.deleteSessionConfirm,
      sessionsFilter: this.modalsState.sessionsFilter,
      sessionsFilterFocus: this.modalsState.sessionsFilterFocus,
      deleteModelConfirm: this.modalsState.deleteModelConfirm,
      currentSession: {
        id: this.chatState.currentSession.id,
        title: this.chatState.currentSession.title,
        provider: this.chatState.currentSession.provider,
        model: this.chatState.currentSession.model,
      },
      messages: this.chatState.messages.map(m => ({ role: m.role })),
      formatRelativeTime,
      clampScrollOffset,
    };
  }

  // ── Modal keyboard sequences ───────────────────────────────────────────

  private async handleProviderModalSequence(sequence: string): Promise<boolean> {
    return handleProviderModalKey(this.buildModalKeyboardContext(), sequence);
  }

  private async handleModelModalSequence(sequence: string): Promise<boolean> {
    return handleModelModalKey(this.buildModalKeyboardContext(), sequence);
  }

  private buildModalKeyboardContext(): ModalKeyboardContext {
    const mm = this.modalsManager;
    return {
      providerModalOpen: this.modalsState.providerModalOpen,
      modelModalOpen: this.modalsState.modelModalOpen,
      getProviderFormState: () => this.modalsState.providerFormState,
      setProviderFormState: (s) => { this.modalsState.providerFormState = s; },
      getAddProviderNameInput: () => this.modalsState.addProviderNameInput,
      setAddProviderNameInput: (s) => { this.modalsState.addProviderNameInput = s; },
      getDeleteProviderConfirm: () => this.modalsState.deleteProviderConfirm,
      setDeleteProviderConfirm: (s) => { this.modalsState.deleteProviderConfirm = s; },
      getProviderModalProviderIndex: () => this.modalsState.providerModalProviderIndex,
      setProviderModalProviderIndex: (i) => { this.modalsState.providerModalProviderIndex = i; },
      providerModalNotice: this.modalsState.providerModalNotice,
      getModelModalFocus: () => this.modalsState.modelModalFocus,
      setModelModalFocus: (f) => { this.modalsState.modelModalFocus = f; },
      getAddModelInput: () => this.modalsState.addModelInput,
      setAddModelInput: (s) => { this.modalsState.addModelInput = s; },
      getModelModalFilter: () => this.modalsState.modelModalFilter,
      setModelModalFilter: (s) => { this.modalsState.modelModalFilter = s; },
      getModelModalProviderIndex: () => this.modalsState.modelModalProviderIndex,
      setModelModalProviderIndex: (i) => { this.modalsState.modelModalProviderIndex = i; },
      getModelModalModelIndex: () => this.modalsState.modelModalModelIndex,
      setModelModalModelIndex: (i) => { this.modalsState.modelModalModelIndex = i; },
      getModelModalModelScrollOffset: () => this.modalsState.modelModalModelScrollOffset,
      setModelModalModelScrollOffset: (o) => { this.modalsState.modelModalModelScrollOffset = o; },
      renderProviderModal: () => this.renderProviderModal(),
      renderModelModal: () => this.renderModelModal(),
      closeProviderModal: () => this.closeProviderModal(),
      closeModelModal: () => this.closeModelModal(),
      openModelModal: (id) => this.modalsManager.openModelModal(id),
      getProviderSlots: () => mm.getProviderSlots(),
      getSelectedProviderSlot: () => mm.getSelectedProviderSlot(),
      getSelectedModelModalProvider: () => mm.getSelectedModelModalProvider() as { id: string } | undefined,
      getModelModalModels: (p) => mm.getModelModalModels(p as ProviderSlot | undefined),
      syncProviderModalSelections: (id) => mm.syncProviderModalSelections(id),
      syncModelModalSelection: (id, m) => mm.syncModelModalSelection(id, m),
      isCustomProviderId: (id) => isPresetProviderId(id) === false,
      startProviderForm: (id) => mm.startProviderForm(id),
      startAddProvider: () => mm.startAddProvider(),
      showDeleteProviderConfirmation: (id) => mm.showDeleteProviderConfirmation(id),
      deleteCustomProvider: (id) => mm.deleteCustomProvider(id),
      addCustomProvider: (n) => mm.addCustomProvider(n),
      startAddModelInput: () => mm.startAddModelInput(),
      cancelAddModelInput: () => mm.cancelAddModelInput(),
      confirmAddModelInput: () => mm.confirmAddModelInput(),
      deleteSelectedCustomModel: () => mm.deleteSelectedCustomModel(),
      applyModelSelection: () => mm.applyModelSelection(),
      showDeleteModelConfirmation: (m, p) => mm.showDeleteModelConfirmation(m, p),
      setDeleteModelConfirm: (s) => { this.modalsState.deleteModelConfirm = s; },
      deleteModelConfirm: this.modalsState.deleteModelConfirm,
      onModelDeleteConfirmed: async (m, p) => {
        this.deleteModelConfirmAction(m, p);
      },
      moveProviderFormField: (d) => mm.moveProviderFormField(d),
      moveProviderFormCursor: (d) => mm.moveProviderFormCursor(d),
      saveProviderForm: () => mm.saveProviderForm(),
      insertProviderFormText: (t) => mm.insertProviderFormText(t),
      deleteProviderFormText: () => mm.deleteProviderFormText(),
      getVisibleProviderFormFields,
      moveAddModelCursor: (d) => mm.moveAddModelCursor(d),
      deleteAddModelChar: () => mm.deleteAddModelChar(),
      insertAddModelChar: (c) => mm.insertAddModelChar(c),
      moveModelFilterCursor: (d) => mm.moveModelFilterCursor(d),
      deleteModelFilterText: () => mm.deleteModelFilterText(),
      insertModelFilterText: (t) => mm.insertModelFilterText(t),
    };
  }

  private handleSessionsModalSequence(sequence: string): boolean {
    const ms = this.modalsState;

    // Esc always handled first — cancels sub-states or closes modal
    if (isEscape(sequence)) {
      if (ms.deleteSessionConfirm) {
        ms.deleteSessionConfirm = null;
        this.renderSessionsModal();
        return true;
      }
      if (ms.sessionsRenaming) {
        ms.sessionsRenaming = null;
        this.renderSessionsModal();
        return true;
      }
      this.closeSessionsModal();
      return true;
    }

    // Delete session confirmation
    if (ms.deleteSessionConfirm) {
      if (isEnter(sequence)) {
        const wasActive = ms.deleteSessionConfirm.id === this.chatState.currentSession.id;
        this.deleteSession(ms.deleteSessionConfirm.id);
        if (wasActive) {
          this.chatState.currentSession = this.runtime.startNewSession();
          this.chatManager.clearAllMessages();
          this.renderHeader();
          this.renderStatusBar();
        }
        ms.deleteSessionConfirm = null;
        ms.sessionsList = this.listSessions();
        ms.sessionsSelectedIndex = Math.min(ms.sessionsSelectedIndex, Math.max(0, ms.sessionsList.length - 1));
        this.renderSessionsModal();
        return true;
      }
      return true;
    }

    // Rename session input
    if (ms.sessionsRenaming) {
      if (isEnter(sequence)) {
        const newTitle = ms.sessionsRenaming.value.trim();
        if (newTitle) {
          this.renameSession(ms.sessionsRenaming.id, newTitle);
          ms.sessionsList = this.listSessions();
          if (ms.sessionsRenaming.id === this.chatState.currentSession.id) {
            this.chatState.currentSession = { ...this.chatState.currentSession, title: newTitle };
            this.renderHeader();
            this.renderStatusBar();
          }
        }
        ms.sessionsRenaming = null;
        this.renderSessionsModal();
        return true;
      }
      if (isCtrlA(sequence)) { ms.sessionsRenaming.cursorOffset = 0; this.renderSessionsModal(); return true; }
      if (isCtrlE(sequence)) { ms.sessionsRenaming.cursorOffset = ms.sessionsRenaming.value.length; this.renderSessionsModal(); return true; }
      if (isCtrlU(sequence)) { ms.sessionsRenaming.value = ms.sessionsRenaming.value.slice(ms.sessionsRenaming.cursorOffset); ms.sessionsRenaming.cursorOffset = 0; this.renderSessionsModal(); return true; }
      if (isArrowLeft(sequence)) { ms.sessionsRenaming.cursorOffset = Math.max(0, ms.sessionsRenaming.cursorOffset - 1); this.renderSessionsModal(); return true; }
      if (isArrowRight(sequence)) { ms.sessionsRenaming.cursorOffset = Math.min(ms.sessionsRenaming.value.length, ms.sessionsRenaming.cursorOffset + 1); this.renderSessionsModal(); return true; }
      if (isBackspace(sequence)) {
        if (ms.sessionsRenaming.cursorOffset > 0) {
          ms.sessionsRenaming.value = ms.sessionsRenaming.value.slice(0, ms.sessionsRenaming.cursorOffset - 1) + ms.sessionsRenaming.value.slice(ms.sessionsRenaming.cursorOffset);
          ms.sessionsRenaming.cursorOffset--;
          this.renderSessionsModal();
        }
        return true;
      }
      {
        const char = getChar(sequence);
        if (char !== null && char.charCodeAt(0) >= 32) {
          ms.sessionsRenaming.value = ms.sessionsRenaming.value.slice(0, ms.sessionsRenaming.cursorOffset) + char + ms.sessionsRenaming.value.slice(ms.sessionsRenaming.cursorOffset);
          ms.sessionsRenaming.cursorOffset++;
          this.renderSessionsModal();
          return true;
        }
      }
      if (sequence.length > 1 && !sequence.includes('\x1b')) {
        const normalizedText = sequence.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\n/g, ' ');
        if (normalizedText) {
          ms.sessionsRenaming.value = ms.sessionsRenaming.value.slice(0, ms.sessionsRenaming.cursorOffset) + normalizedText + ms.sessionsRenaming.value.slice(ms.sessionsRenaming.cursorOffset);
          ms.sessionsRenaming.cursorOffset += normalizedText.length;
          this.renderSessionsModal();
        }
        return true;
      }
      return true;
    }

    // Shortcuts (checked before text input so they don't get captured by filter)
    if (isCtrlR(sequence)) {
      const filtered = this.getFilteredSessions();
      if (ms.sessionsSelectedIndex >= 0 && filtered.length > 0) {
        const selected = filtered[ms.sessionsSelectedIndex];
        if (selected) {
          ms.sessionsRenaming = { id: selected.id, value: selected.title, cursorOffset: selected.title.length };
          this.renderSessionsModal();
        }
      }
      return true;
    }
    if (isCtrlD(sequence)) {
      const filtered = this.getFilteredSessions();
      if (ms.sessionsSelectedIndex >= 0 && filtered.length > 0) {
        const selected = filtered[ms.sessionsSelectedIndex];
        if (selected) {
          this.modalsManager.showDeleteSessionConfirmation(selected.id);
        }
      }
      return true;
    }

    // Navigation
    if (isArrowUp(sequence)) {
      const filteredLen = this.getFilteredSessionsLength();
      if (filteredLen > 0) {
        if (ms.sessionsSelectedIndex <= 0) {
          ms.sessionsSelectedIndex = filteredLen - 1;
        } else {
          ms.sessionsSelectedIndex = ms.sessionsSelectedIndex - 1;
        }
        this.renderSessionsModal();
      }
      return true;
    }
    if (isArrowDown(sequence)) {
      const filteredLen = this.getFilteredSessionsLength();
      if (filteredLen > 0) {
        if (ms.sessionsSelectedIndex < 0) {
          ms.sessionsSelectedIndex = 0;
        } else {
          ms.sessionsSelectedIndex = Math.min(filteredLen - 1, ms.sessionsSelectedIndex + 1);
        }
        this.renderSessionsModal();
      }
      return true;
    }
    if (sequence === '\x1b[5~') {
      const filteredLen = this.getFilteredSessionsLength();
      if (filteredLen > 0) {
        ms.sessionsSelectedIndex = Math.max(0, ms.sessionsSelectedIndex - sessionsVisibleLineCount);
        this.renderSessionsModal();
      }
      return true;
    }
    if (sequence === '\x1b[6~') {
      const filteredLen = this.getFilteredSessionsLength();
      if (filteredLen > 0) {
        if (ms.sessionsSelectedIndex < 0) {
          ms.sessionsSelectedIndex = 0;
        } else {
          ms.sessionsSelectedIndex = Math.min(filteredLen - 1, ms.sessionsSelectedIndex + sessionsVisibleLineCount);
        }
        this.renderSessionsModal();
      }
      return true;
    }
    if (isEnter(sequence)) {
      if (ms.sessionsSelectedIndex >= 0) {
        const filtered = this.getFilteredSessions();
        const selected = filtered[ms.sessionsSelectedIndex];
        if (selected) {
          this.runtime.loadPersistedSession(selected.id);
          this.chatState.currentSession = this.getSession(selected.id)!;
          this.chatManager.clearAllMessages();
          for (const msg of this.chatState.messages) {
            if (msg.role === 'system') continue;
            if (msg.role === 'user') this.chatManager.addUserMsg(msg.content as string);
            else if (msg.role === 'assistant' && msg.content) this.chatManager.addMsg(msg.content as string, '#ffffff', true);
            else if (msg.role === 'tool') this.chatManager.addMsg(`[tool] ${msg.content}`, '#888888');
          }
          this.closeSessionsModal();
          this.renderHeader();
          this.renderStatusBar();
          this.root.requestRender();
        }
      }
      return true;
    }

    // Filter text input (everything else goes into the filter)
    if (isArrowLeft(sequence)) {
      ms.sessionsFilter.cursorOffset = Math.max(0, ms.sessionsFilter.cursorOffset - 1);
      this.renderSessionsModal();
      return true;
    }
    if (isArrowRight(sequence)) {
      ms.sessionsFilter.cursorOffset = Math.min(ms.sessionsFilter.value.length, ms.sessionsFilter.cursorOffset + 1);
      this.renderSessionsModal();
      return true;
    }
    if (isCtrlA(sequence)) {
      ms.sessionsFilter.cursorOffset = 0;
      this.renderSessionsModal();
      return true;
    }
    if (isCtrlE(sequence)) {
      ms.sessionsFilter.cursorOffset = ms.sessionsFilter.value.length;
      this.renderSessionsModal();
      return true;
    }
    if (isCtrlU(sequence)) {
      ms.sessionsFilter.value = ms.sessionsFilter.value.slice(ms.sessionsFilter.cursorOffset);
      ms.sessionsFilter.cursorOffset = 0;
      this.renderSessionsModal();
      return true;
    }
    if (isBackspace(sequence)) {
      if (ms.sessionsFilter.cursorOffset > 0) {
        ms.sessionsFilter.value = ms.sessionsFilter.value.slice(0, ms.sessionsFilter.cursorOffset - 1) + ms.sessionsFilter.value.slice(ms.sessionsFilter.cursorOffset);
        ms.sessionsFilter.cursorOffset--;
        this.renderSessionsModal();
      }
      return true;
    }
    {
      const char = getChar(sequence);
      if (char !== null && char.charCodeAt(0) >= 32) {
        ms.sessionsFilter.value = ms.sessionsFilter.value.slice(0, ms.sessionsFilter.cursorOffset) + char + ms.sessionsFilter.value.slice(ms.sessionsFilter.cursorOffset);
        ms.sessionsFilter.cursorOffset++;
        this.clampSelectionToFiltered();
        this.renderSessionsModal();
        return true;
      }
    }
    if (sequence.length > 1 && !sequence.includes('\x1b')) {
      const normalizedText = sequence.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\n/g, ' ');
      if (normalizedText) {
        ms.sessionsFilter.value = ms.sessionsFilter.value.slice(0, ms.sessionsFilter.cursorOffset) + normalizedText + ms.sessionsFilter.value.slice(ms.sessionsFilter.cursorOffset);
        ms.sessionsFilter.cursorOffset += normalizedText.length;
        this.clampSelectionToFiltered();
        this.renderSessionsModal();
      }
      return true;
    }
    return true;
  }

  private clampSelectionToFiltered(): void {
    const filteredLen = this.getFilteredSessionsLength();
    if (this.modalsState.sessionsSelectedIndex >= filteredLen) {
      this.modalsState.sessionsSelectedIndex = Math.max(-1, filteredLen - 1);
    }
  }

  private getFilteredSessions(): typeof this.modalsState.sessionsList {
    const ms = this.modalsState;
    const normalizedFilter = ms.sessionsFilter.value.trim().toLowerCase();
    return normalizedFilter
      ? ms.sessionsList.filter(s => s.title.toLowerCase().includes(normalizedFilter))
      : ms.sessionsList;
  }

  private getFilteredSessionsLength(): number {
    return this.getFilteredSessions().length;
  }

  private async deleteModelConfirmAction(model: string, providerId: string): Promise<void> {
    const provider = this.config.providers[providerId];
    if (!provider) return;

    removeProviderModel(this.config, providerId, model);
    if (this.chatState.currentSession.provider === providerId && this.chatState.currentSession.model === model) {
      this.chatState.currentSession.model = '';
      this.renderStatusBar();
    }
    this.modalsState.deleteModelConfirm = null;
    this.modalsState.modelModalNotice = `Deleted model ${model} from ${providerId}.`;
    this.modalsManager.syncModelModalSelection(providerId, undefined);
    this.renderModelModal();
  }

  // ── Input helpers ──────────────────────────────────────────────────────

  private insertInputNewline(): void {
    const currentText = this.inputNode.plainText;
    const cursorOffset = typeof this.inputNode.cursorOffset === 'number' ? this.inputNode.cursorOffset : currentText.length;
    const nextText = `${currentText.slice(0, cursorOffset)}\n${currentText.slice(cursorOffset)}`;
    this.inputNode.setText(nextText);
    if (typeof this.inputNode.cursorOffset === 'number') {
      this.inputNode.cursorOffset = cursorOffset + 1;
    }
    this.inputBuffer = nextText;
  }

  private clearCommandInput(): void {
    this.inputNode.setText('');
    this.inputBuffer = '';
    this.paletteManager.close();
    this.inputNode.focus();
  }

  private resetInput() {
    this.inputNode.setText('');
    this.inputBuffer = '';
    this.paletteManager.close();
    this.inputNode.focus();
  }

  private openPalette(query: string): void {
    this.paletteManager.open(query);
  }

  private syncCommandPalette(value: string) {
    this.inputBuffer = value;
    if (value === '' || !value.startsWith('/')) { this.paletteManager.close(); return; }
    if (value === '/') { this.openPalette(''); return; }
    this.openPalette(value.slice(1));
  }

  private completeSelectedCommand(): void {
    if (!this.palette.open || this.palette.matches.length === 0) return;
    const cmd = this.palette.matches[this.palette.selectedIndex];
    // Replace command prefix with the selected command name, preserving any typed args
    const text = this.inputNode.plainText;
    const trimmed = text.slice(1).trim();
    const parts = trimmed.split(/\s+/);
    const remainingArgs = parts.slice(1).filter(Boolean);
    const completedText = `/${cmd.name}${remainingArgs.length > 0 ? ' ' + remainingArgs.join(' ') : ''}`;
    this.inputNode.setText(completedText);
    if (typeof this.inputNode.cursorOffset === 'number') {
      this.inputNode.cursorOffset = completedText.length;
    }
    this.inputBuffer = completedText;
    // Re-open palette with the completed command (should narrow to just this one)
    this.syncCommandPalette(completedText);
    this.inputNode.focus();
  }

  private applyKeyToBuffer(key: KeyEvent): void {
    if (key.ctrl && key.name === 'u') { this.inputBuffer = ''; this.paletteManager.close(); return; }
    if (key.ctrl || key.meta) return;
    if (key.name === 'backspace' || key.name === 'delete') {
      const nextValue = this.inputBuffer.length > 0 ? this.inputBuffer.slice(0, -1) : '';
      this.syncCommandPalette(nextValue);
      return;
    }
    if (key.name === 'escape' || key.name === 'return' || key.name === 'linefeed' || key.name === 'up' || key.name === 'down') return;
    if (key.sequence && key.sequence.length > 0) {
      const isPrintable = key.sequence.split('').every(c => { const code = c.charCodeAt(0); return code >= 32 || code > 127; });
      if (isPrintable) {
        const nextValue = this.inputBuffer + key.sequence;
        const startsCommandMode = this.inputBuffer === '' && key.sequence === '/';
        const continuesCommandMode = this.inputBuffer.startsWith('/');
        if (startsCommandMode || continuesCommandMode) { this.syncCommandPalette(nextValue); }
        else { this.inputBuffer = nextValue; this.paletteManager.close(); }
      }
    }
  }

  private submitting = false;

  private async submitCurrentInput() {
    if (this.submitting) return; // prevent double-submit from textarea onSubmit + key handler
    if (this.approvalState.pendingExecution) return;
    this.submitting = true;
    try {
      const text = this.inputNode.plainText;

      // Check for command input (starts with /)
      if (text.startsWith('/')) {
        const trimmed = text.slice(1).trim();

        // If palette is open and has matches, prefer the selected command
        if (this.palette.open && this.palette.matches.length > 0) {
          const cmd = this.palette.matches[this.palette.selectedIndex];
          const args = trimmed.split(/\s+/).slice(1).filter(Boolean);
          this.resetInput();
          await this.executeCommand(cmd, args, text);
          return;
        }

        // Otherwise do raw lookup (no palette visible)
        if (trimmed.length > 0) {
          const parts = trimmed.split(/\s+/);
          const cmdName = parts[0];
          const args = parts.slice(1).filter(Boolean);
          const cmd = this.commands.find(c => c.name.startsWith(cmdName));
          if (cmd) {
            this.resetInput();
            await this.executeCommand(cmd, args, text);
            return;
          }
        }
        // No matching command — fall through to send as message
      }

      // Close modals on new user input
      this.closeProviderModal();
      this.closeModelModal();
      this.closeSessionsModal();
      this.closeMcpModal();
      this.closeMcpDetailsModal();
      
      this.resetInput();
      await this.chatManager.handleInput(text);
    } finally {
      this.submitting = false;
    }
  }

  private async executeCommand(cmd: Command, args: string[] = [], rawInput?: string) {
    // this.chatManager.addUserMsg(rawInput || `/${cmd.name}`);
    if (cmd.name === 'exit' || cmd.name === 'quit') {
      this.deleteEmptySessions();
      if (this.runtime.mcpManager) await this.runtime.mcpManager.disconnectAll();
      this.renderer.destroy();
      process.exit(0);
    }
    try {
      const result = await cmd.action(args);
      if (result) { 
        switch (cmd.name) {
          case 'command-execute':
            this.chatManager.addMsg(result, '#888888');
            break;
        }
      }
      // else { this.chatManager.addMsg(`Executed /${cmd.name}`, '#888888'); }
    } catch (error) {
      this.chatManager.addMsg(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, '#ff4444');
    }
    this.root.requestRender();
  }

  private updateFooterLayout() {
    this.root.requestRender();
  }

  // ── Proxy accessors ────────────────────────────────────────────────────

  private getSession = getSession;
  private listSessions = listSessions;
  private renameSession = renameSession;
  private deleteSession = deleteSession;
  private deleteEmptySessions = deleteEmptySessions;
  private isPresetProviderId = isPresetProviderId;
  private isProviderIdUnique = isProviderIdUnique;
  private renameProvider = renameProvider;
  private upsertProvider = upsertProvider;
  private setProviderModel = setProviderModel;
  private removeProviderModel = removeProviderModel;
  private normalizeModels = normalizeModels;
  private formatStatusStats = formatStatusStats;
  private formatElapsedSeconds = formatElapsedSeconds;
  private commands = [] as Command[];
  private markdownSyntaxStyle = SyntaxStyle.create();
  private approvalActions = approvalActions;
}

export async function runOpenTUIApp(options: RunAppOptions): Promise<void> {
  const app = await TUIApp.create(options);
  await app.run();
}
