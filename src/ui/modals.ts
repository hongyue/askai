/**
 * Modal rendering helpers for TUIApp.
 *
 * This module provides standalone modal rendering functions that can be
 * composed into TUIApp. Each function takes a context object with the
 * state and UI nodes it needs.
 */

import {
  white, bgWhite, black, fg,
  stringToStyledText, StyledText,
} from "@opentui/core";
import {
  sessionsVisibleLineCount,
} from "../input-utils";
import type { MutableBoxNode, MutableTextNode, MutableInputNode } from "./tui-types";
import type {
  ProviderFormState,
  ProviderFormField,
  FilterState,
  ProviderSlot,
  SessionSummary,
  ModelModalFocus,
} from "./modals-state";

const providerModalVisibleItems = 8;
const providerModalVisibleModels = 8;

// ── Context interfaces ──────────────────────────────────────────────────────

export interface ModalRenderContext {
  // UI Nodes
  providerModalNode: MutableBoxNode;
  providerModalTextNode: MutableTextNode;
  modelModalNode: MutableBoxNode;
  modelModalTitleTextNode: MutableTextNode;
  modelModalProvidersTextNode: MutableTextNode;
  modelModalFilterTextNode: MutableTextNode;
  modelModalModelsTextNode: MutableTextNode;
  sessionsModalNode: MutableBoxNode;
  sessionsModalHeaderTextNode: MutableTextNode;
  sessionsModalScrollBox: MutableBoxNode;
  sessionsModalBodyTextNode: MutableTextNode;
  sessionsModalFooterTextNode: MutableTextNode;
  inputNode: MutableInputNode;
  root: { requestRender(): void };

  // State getters
  getProviderSlots(): ProviderSlot[];
  getSelectedProviderSlot(): ProviderSlot | undefined;
  getSelectedModelModalProvider(): ProviderSlot | undefined;
  getModelModalModels(providerSlot: ProviderSlot | undefined): string[];
  isCustomProviderId(providerId: string): boolean;
  getVisibleProviderFormFields(providerId: string): ProviderFormField[];
  getProviderFormConfig(providerId: string, values: Record<string, string>, previousProvider?: any): any;
  createProviderFormState(providerSlot: ProviderSlot): ProviderFormState;

  // State values
  providerModalOpen: boolean;
  providerModalProviderIndex: number;
  providerModalProviderScrollOffset: number;
  providerFormState: ProviderFormState | null;
  providerModalNotice: string | null;
  addProviderNameInput: { value: string; cursorOffset: number } | null;
  deleteProviderConfirm: { providerId: string } | null;
  modelModalOpen: boolean;
  modelModalFocus: ModelModalFocus;
  modelModalProviderIndex: number;
  modelModalModelIndex: number;
  modelModalProviderScrollOffset: number;
  modelModalModelScrollOffset: number;
  modelModalFilter: FilterState;
  addModelInput: { value: string; cursorOffset: number } | null;
  addModelInputProviderName: string;
  modelModalNotice: string | null;
  sessionsModalOpen: boolean;
  sessionsList: SessionSummary[];
  sessionsSelectedIndex: number;
  sessionsScrollOffset: number;
  setSessionsScrollOffset(offset: number): void;
  sessionsRenaming: { id: string; value: string; cursorOffset: number } | null;
  deleteSessionConfirm: { id: string } | null;
  sessionsFilter: FilterState;
  sessionsFilterFocus: boolean;
  deleteModelConfirm: { model: string; providerId: string } | null;
  currentSession: { id: string; title: string; provider: string; model: string };
  messages: Array<{ role: string }>;
  activeProviderId: string;
  activeModel: string;

  // Helpers
  formatRelativeTime(timestamp: number): string;
  clampScrollOffset(index: number, offset: number, visible: number, total: number): number;
}

// ── Provider form formatting ────────────────────────────────────────────────

export function formatProviderFormTextValue(value: string, cursorOffset: number, focused: boolean): any[] {
  const clampedOffset = Math.max(0, Math.min(cursorOffset, value.length));
  if (focused && clampedOffset < value.length) {
    const char = value[clampedOffset];
    return [
      white(value.slice(0, clampedOffset)),
      bgWhite(black(char)),
      white(value.slice(clampedOffset + 1)),
    ];
  }
  if (focused) {
    return [white(value), bgWhite(black(' '))];
  }
  return [white(value)];
}

const providerTypeOptions: string[] = ['openai-compatible', 'anthropic-compatible'];

export function formatProviderFormSelectValue(value: string, focused: boolean): any[] {
  const chunks: any[] = [];
  providerTypeOptions.forEach((option, i) => {
    if (i > 0) chunks.push(white(' | '));
    const isActive = focused && value === option;
    if (isActive) {
      chunks.push(bgWhite(black(` ${option} `)));
    } else {
      chunks.push(value === option ? white(`[${option}]`) : white(option));
    }
  });
  return chunks;
}

export function formatFilterValue(value: string, cursorOffset: number, active: boolean, placeholder = '(type to filter)'): any[] {
  if (!active && value.length === 0) {
    return [white(placeholder)];
  }
  if (!active) {
    return [white(value)];
  }
  const clampedOffset = Math.max(0, Math.min(cursorOffset, value.length));
  if (clampedOffset < value.length) {
    const char = value[clampedOffset];
    return [
      white(value.slice(0, clampedOffset)),
      bgWhite(black(char)),
      white(value.slice(clampedOffset + 1)),
    ];
  }
  return [white(value), bgWhite(black(' '))];
}

// ── Session grouping helpers ────────────────────────────────────────────────

const sessionDayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const sessionMonthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatSessionGroupDate(ts: number): string {
  const d = new Date(ts);
  return `${sessionDayNames[d.getDay()]}, ${sessionMonthNames[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

interface SessionGroup {
  dateLabel: string;
  sessions: SessionSummary[];
}

export function groupSessionsByDate(sessions: SessionSummary[]): SessionGroup[] {
  const groups: Map<string, SessionSummary[]> = new Map();

  for (const s of sessions) {
    const dateLabel = formatSessionGroupDate(s.updated_at);
    if (!groups.has(dateLabel)) {
      groups.set(dateLabel, []);
    }
    groups.get(dateLabel)!.push(s);
  }

  // Preserve chronological order of keys as they appear (sessions are already sorted by updated_at DESC)
  const orderedGroups: SessionGroup[] = [];
  for (const [dateLabel, groupSessions] of groups) {
    orderedGroups.push({ dateLabel, sessions: groupSessions });
  }
  return orderedGroups;
}

// ── Provider modal rendering ────────────────────────────────────────────────

export function renderProviderModal(ctx: ModalRenderContext): void {
  if (!ctx.providerModalOpen) return;

  const providers = ctx.getProviderSlots();
  const selectedProvider = ctx.getSelectedProviderSlot();

  // Handle provider form edit state
  if (ctx.providerFormState) {
    const formState = ctx.providerFormState;
    const visibleFields = ctx.getVisibleProviderFormFields(formState.providerId);
    const chunks: any[] = [];

    chunks.push(white(`Edit ${formState.providerId}`));
    chunks.push(white('\n'));
    chunks.push(white('\n'));

    visibleFields.forEach((field, index) => {
      const rawValue = formState.values[field.key] || '';
      const marker = index === formState.activeFieldIndex ? '> ' : '  ';
      const label = field.label.padEnd(14);
      const isFocused = index === formState.activeFieldIndex;
      const valueChunks = field.kind === 'select'
        ? formatProviderFormSelectValue(rawValue, isFocused)
        : formatProviderFormTextValue(rawValue, formState.cursorOffset, isFocused);

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

    chunks.push(white('tab/↑/↓ move   enter save   esc cancel'));
    ctx.providerModalTextNode.content = new StyledText(chunks);
    ctx.providerModalNode.visible = true;
    if (ctx.inputNode.blur) ctx.inputNode.blur();
    ctx.root.requestRender();
    return;
  }

  // Handle add provider name input state
  if (ctx.addProviderNameInput) {
    const nameInput = ctx.addProviderNameInput;
    const valueChunks = formatProviderFormTextValue(nameInput.value, nameInput.cursorOffset, true);
    const chunks: any[] = [
      white('Add new provider'),
      white('\n\n'),
      white('Provider name: '),
      ...valueChunks,
      white('\n\n'),
    ];

    if (ctx.providerModalNotice) {
      chunks.push(white(`Error: ${ctx.providerModalNotice}`));
      chunks.push(white('\n\n'));
    }

    chunks.push(white('enter confirm   esc cancel'));
    ctx.providerModalTextNode.content = new StyledText(chunks);
    ctx.providerModalNode.visible = true;
    if (ctx.inputNode.blur) ctx.inputNode.blur();
    ctx.root.requestRender();
    return;
  }

  // Handle delete provider confirmation state
  if (ctx.deleteProviderConfirm) {
    const lines = [
      'Delete provider',
      '',
      `Delete "${ctx.deleteProviderConfirm.providerId}"? This will remove the provider and all its models.`,
      '',
      'y confirm   n/esc cancel',
    ];
    ctx.providerModalTextNode.content = stringToStyledText(lines.join('\n'));
    ctx.providerModalNode.visible = true;
    if (ctx.inputNode.blur) ctx.inputNode.blur();
    ctx.root.requestRender();
    return;
  }

  // Normal provider list view
  const scrollOffset = ctx.clampScrollOffset(
    ctx.providerModalProviderIndex,
    ctx.providerModalProviderScrollOffset,
    providerModalVisibleItems,
    providers.length,
  );

  const visibleProviders = providers.slice(scrollOffset, scrollOffset + providerModalVisibleItems);
  const providerLines = visibleProviders.map((item, visibleIndex) => {
    const index = scrollOffset + visibleIndex;
    const marker = index === ctx.providerModalProviderIndex ? '>' : ' ';
    const active = item.id === ctx.activeProviderId ? ' *' : '';
    const prefix = index === ctx.providerModalProviderIndex ? `[${marker}]` : ` ${marker} `;
    return `${prefix} ${item.displayName}${active}`;
  });

  const summaryLines = selectedProvider ? [
    `Provider: ${selectedProvider.displayName}`,
    `Current model: ${selectedProvider.model || 'not set'}`,
    `Base URL: ${selectedProvider.baseUrl || 'n/a'}`,
  ] : ['No provider selected.'];

  const canDelete = selectedProvider && ctx.isCustomProviderId(selectedProvider.id);
  const helpText = canDelete
    ? '↑/↓ move   enter edit   +/a add   d delete   m models   esc/q close'
    : '↑/↓ move   enter edit   +/a add   m models   esc/q close';

  const lines = [
    'Configure providers',
    '',
    'Providers',
    ...(scrollOffset > 0 ? ['  ^ more'] : []),
    ...(providerLines.length > 0 ? providerLines : ['  No providers configured']),
    ...(scrollOffset + providerModalVisibleItems < providers.length ? ['  v more'] : []),
    '',
    'Summary',
    ...summaryLines,
    '',
    ...(ctx.providerModalNotice ? [`Notice: ${ctx.providerModalNotice}`, ''] : []),
    helpText,
  ];

  ctx.providerModalTextNode.content = stringToStyledText(lines.join('\n'));
  ctx.providerModalNode.visible = true;
  if (ctx.inputNode.blur) ctx.inputNode.blur();
  ctx.root.requestRender();
}

// ── Model modal rendering ───────────────────────────────────────────────────

export function renderModelModal(ctx: ModalRenderContext): void {
  if (!ctx.modelModalOpen) return;

  const providers = ctx.getProviderSlots();
  const selectedProvider = ctx.getSelectedModelModalProvider();
  const models = ctx.getModelModalModels(selectedProvider);

  const providerScrollOffset = ctx.clampScrollOffset(
    ctx.modelModalProviderIndex,
    ctx.modelModalProviderScrollOffset,
    providerModalVisibleItems,
    providers.length,
  );
  const modelScrollOffset = ctx.clampScrollOffset(
    ctx.modelModalModelIndex,
    ctx.modelModalModelScrollOffset,
    providerModalVisibleModels,
    models.length,
  );

  const visibleProviders = providers.slice(providerScrollOffset, providerScrollOffset + providerModalVisibleItems);
  const providerLines = visibleProviders.map((item, visibleIndex) => {
    const index = providerScrollOffset + visibleIndex;
    const marker = index === ctx.modelModalProviderIndex ? '>' : ' ';
    const active = item.id === ctx.activeProviderId ? ' *' : '';
    const prefix = ctx.modelModalFocus === 'providers' && index === ctx.modelModalProviderIndex ? `[${marker}]` : ` ${marker} `;
    return `${prefix} ${item.displayName}${active}`;
  });

  const visibleModels = models.slice(modelScrollOffset, modelScrollOffset + providerModalVisibleModels);
  const modelLines = visibleModels.map((model, visibleIndex) => {
    const index = modelScrollOffset + visibleIndex;
    const marker = index === ctx.modelModalModelIndex ? '>' : ' ';
    const active = selectedProvider && selectedProvider.id === ctx.activeProviderId && model === ctx.activeModel ? ' *' : '';
    const prefix = ctx.modelModalFocus === 'models' && index === ctx.modelModalModelIndex ? `[${marker}]` : ` ${marker} `;
    return `${prefix} ${model}${active}`;
  });

  // Handle delete model confirmation
  if (ctx.deleteModelConfirm) {
    const lines = [
      'Delete model',
      '',
      `Delete "${ctx.deleteModelConfirm.model}" from ${ctx.deleteModelConfirm.providerId}?`,
      '',
      'y confirm   n/esc cancel',
    ];
    ctx.modelModalTitleTextNode.content = stringToStyledText('Confirm delete\n');
    ctx.modelModalProvidersTextNode.content = stringToStyledText('');
    ctx.modelModalFilterTextNode.content = stringToStyledText('');
    ctx.modelModalModelsTextNode.content = stringToStyledText(lines.join('\n'));
    ctx.modelModalNode.visible = true;
    if (ctx.inputNode.blur) ctx.inputNode.blur();
    ctx.root.requestRender();
    return;
  }

  // Handle add model input state
  if (ctx.addModelInput) {
    const val = ctx.addModelInput.value;
    const cursor = Math.max(0, Math.min(ctx.addModelInput.cursorOffset, val.length));
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
    const chunks: any[] = [
      white(`Add model to ${ctx.addModelInputProviderName}`),
      white('\n\n'),
      white('Model name: '),
      ...cursorChunks,
    ];
    if (ctx.modelModalNotice) {
      chunks.push(white('\n\n'));
      chunks.push(fg('#ff4444')(`Error: ${ctx.modelModalNotice}`));
    }
    chunks.push(white('\n\n'));
    chunks.push(white('enter confirm   esc cancel'));

    ctx.modelModalTitleTextNode.content = stringToStyledText('Select a model to use\n');
    ctx.modelModalProvidersTextNode.content = stringToStyledText(
      ['Providers',
        ...(providerScrollOffset > 0 ? ['  ^ more'] : []),
        ...(providerLines.length > 0 ? providerLines : ['  No providers configured']),
        ...(providerScrollOffset + providerModalVisibleItems < providers.length ? ['  v more'] : []),
      ].join('\n')
    );
    ctx.modelModalFilterTextNode.content = stringToStyledText('');
    ctx.modelModalModelsTextNode.content = new StyledText(chunks);
    ctx.modelModalNode.visible = true;
    if (ctx.inputNode.blur) ctx.inputNode.blur();
    ctx.root.requestRender();
    return;
  }

  const titleContent = ['Select a model to use', ''];

  const providerContent = [
    'Providers',
    ...(providerScrollOffset > 0 ? ['  ^ more'] : []),
    ...(providerLines.length > 0 ? providerLines : ['  No providers configured']),
    ...(providerScrollOffset + providerModalVisibleItems < providers.length ? ['  v more'] : []),
  ];

  const filterContent = [white('Filter  ')];
  const filterValueChunks = formatFilterValue(ctx.modelModalFilter.value, ctx.modelModalFilter.cursorOffset, ctx.modelModalFocus === 'filter');
  filterContent.push(...filterValueChunks);

  const modelContent = [
    `Models${selectedProvider ? ` (${selectedProvider.displayName})` : ''}`,
    ...(modelScrollOffset > 0 ? ['  ^ more'] : []),
    ...(modelLines.length > 0 ? modelLines : ['  No models available']),
    ...(modelScrollOffset + providerModalVisibleModels < models.length ? ['  v more'] : []),
  ];

  if (ctx.modelModalNotice) {
    modelContent.push('', `Notice: ${ctx.modelModalNotice}`);
  }

  const canDelete = selectedProvider ? models.length > 1 : false;
  const helpParts = [];
  helpParts.push('tab switch list');
  helpParts.push('↑/↓ move');
  helpParts.push('enter use model');
  if (canDelete) helpParts.push('d delete model');
  helpParts.push('+/a add model');
  helpParts.push('esc/q close');
  modelContent.push('', helpParts.join('   '));

  ctx.modelModalTitleTextNode.content = stringToStyledText(titleContent.join('\n'));
  ctx.modelModalProvidersTextNode.content = stringToStyledText(providerContent.join('\n'));
  ctx.modelModalFilterTextNode.content = new StyledText(filterContent);
  ctx.modelModalModelsTextNode.content = stringToStyledText(modelContent.join('\n'));
  ctx.modelModalNode.visible = true;
  if (ctx.inputNode.blur) ctx.inputNode.blur();
  ctx.root.requestRender();
}

// ── Sessions modal rendering ────────────────────────────────────────────────

export function renderSessionsModal(ctx: ModalRenderContext): void {
  if (!ctx.sessionsModalOpen) {
    ctx.sessionsModalNode.visible = false;
    ctx.sessionsModalHeaderTextNode.content = stringToStyledText('');
    ctx.sessionsModalBodyTextNode.content = stringToStyledText('');
    ctx.sessionsModalFooterTextNode.content = stringToStyledText('');
    ctx.root.requestRender();
    ctx.inputNode.focus();
    return;
  }

  if (ctx.deleteSessionConfirm) {
    const session = ctx.sessionsList.find(s => s.id === ctx.deleteSessionConfirm!.id);
    const title = session ? `"${session.title}"` : 'this session';
    ctx.sessionsModalHeaderTextNode.content = stringToStyledText('Sessions');
    ctx.sessionsModalBodyTextNode.content = stringToStyledText([
      'Delete session',
      '',
      `Delete ${title}? This cannot be undone.`,
    ].join('\n'));
    ctx.sessionsModalFooterTextNode.content = stringToStyledText('enter confirm   esc cancel');
    ctx.sessionsModalNode.visible = true;
    if (ctx.inputNode.blur) ctx.inputNode.blur();
    ctx.sessionsModalScrollBox.scrollTo?.({ x: 0, y: 0 });
    ctx.root.requestRender();
    return;
  }

  if (ctx.sessionsRenaming) {
    const val = ctx.sessionsRenaming.value;
    const cursor = Math.max(0, Math.min(ctx.sessionsRenaming.cursorOffset, val.length));
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
    ctx.sessionsModalHeaderTextNode.content = stringToStyledText('Sessions');
    ctx.sessionsModalBodyTextNode.content = new StyledText([
      ...stringToStyledText('Rename session: ').chunks,
      ...cursorChunks,
    ]);
    ctx.sessionsModalFooterTextNode.content = stringToStyledText('enter confirm   esc cancel');
    ctx.sessionsModalNode.visible = true;
    if (ctx.inputNode.blur) ctx.inputNode.blur();
    ctx.sessionsModalScrollBox.scrollTo?.({ x: 0, y: 0 });
    ctx.root.requestRender();
    return;
  }

  const headerChunks: any[] = [];
  headerChunks.push(white('Filter  '));
  const filterValueChunks = formatFilterValue(ctx.sessionsFilter.value, ctx.sessionsFilter.cursorOffset, ctx.sessionsFilterFocus);
  headerChunks.push(...filterValueChunks);
  ctx.sessionsModalHeaderTextNode.content = new StyledText([
    ...stringToStyledText('Sessions\n').chunks,
    ...headerChunks,
  ]);

  // Apply filter
  const normalizedFilter = ctx.sessionsFilter.value.trim().toLowerCase();
  const filteredSessions = normalizedFilter
    ? ctx.sessionsList.filter(s => s.title.toLowerCase().includes(normalizedFilter))
    : ctx.sessionsList;

  if (filteredSessions.length === 0) {
    const noResults = normalizedFilter ? 'No matching sessions' : 'No saved sessions yet';
    ctx.sessionsModalBodyTextNode.content = stringToStyledText(noResults);
    ctx.sessionsModalFooterTextNode.content = stringToStyledText('esc close');
    ctx.sessionsModalNode.visible = true;
    if (ctx.inputNode.blur) ctx.inputNode.blur();
    ctx.sessionsModalScrollBox.scrollTo?.({ x: 0, y: 0 });
    ctx.root.requestRender();
    return;
  }

  // Group sessions by date
  const groups = groupSessionsByDate(filteredSessions);

  // Build a flat index of all sessions across groups for selection
  const flatIndexToSession: { groupIdx: number; sessionIdx: number }[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    for (let si = 0; si < groups[gi].sessions.length; si++) {
      flatIndexToSession.push({ groupIdx: gi, sessionIdx: si });
    }
  }

  // Clamp selection
  const totalSessions = flatIndexToSession.length;
  let selectedIndex = ctx.sessionsSelectedIndex;
  if (selectedIndex < -1) selectedIndex = -1;
  if (selectedIndex >= totalSessions) selectedIndex = totalSessions - 1;

  const lineChunks: any[] = [];
  let lineNumber = 0;
  let selectedLine = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (gi > 0) {
      lineChunks.push(white('\n'));
      lineNumber += 1;
    }

    lineChunks.push(fg('#b088f9')(`  ${group.dateLabel}`));
    lineChunks.push(white('\n\n'));
    lineNumber += 2;

    for (let si = 0; si < group.sessions.length; si++) {
      const s = group.sessions[si];
      const globalFlatIdx = flatIndexToSession.findIndex(item => item.groupIdx === gi && item.sessionIdx === si);
      const isSel = globalFlatIdx === selectedIndex;
      const marker = isSel ? '> ' : '  ';
      const isActive = s.id === ctx.currentSession.id;
      const activeTag = isActive ? ' *' : '';
      const time = ctx.formatRelativeTime(s.updated_at);
      const msgs = `${s.message_count} msgs`;
      const title = s.title.slice(0, 45).padEnd(45);

      if (isSel) {
        selectedLine = lineNumber;
      }

      lineChunks.push(white(marker));
      lineChunks.push(white(`${title} ${time.padStart(10)} ${msgs.padStart(10)}${activeTag}`));
      lineChunks.push(white('\n'));
      lineNumber += 1;
    }
  }

  ctx.sessionsModalBodyTextNode.content = new StyledText(lineChunks);
  ctx.sessionsModalFooterTextNode.content = stringToStyledText('↑/↓ select   enter resume   ctrl+r rename   ctrl+d delete');
  ctx.sessionsModalNode.visible = true;
  if (ctx.inputNode.blur) ctx.inputNode.blur();
  const visibleLineCount = Math.max(1, ctx.sessionsModalScrollBox.viewport?.height ?? sessionsVisibleLineCount);
  const maxOffset = Math.max(0, lineNumber - visibleLineCount);
  let scrollOffset = Math.max(0, Math.min(ctx.sessionsScrollOffset, maxOffset));
  if (selectedIndex >= 0 && selectedLine < scrollOffset) {
    scrollOffset = selectedLine;
  } else if (selectedIndex >= 0 && selectedLine >= scrollOffset + visibleLineCount) {
    scrollOffset = selectedLine - visibleLineCount + 1;
  }
  ctx.setSessionsScrollOffset(scrollOffset);
  ctx.sessionsModalScrollBox.scrollTo?.({ x: 0, y: scrollOffset });
  ctx.root.requestRender();
  return;
}
