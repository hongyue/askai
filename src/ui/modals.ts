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
import type { ProviderType } from '../config';
import type { MutableBoxNode, MutableTextNode, MutableInputNode } from "./tui-types";

const providerModalVisibleItems = 8;
const providerModalVisibleModels = 8;

export interface ProviderFormField {
  key: string;
  label: string;
  kind: 'text' | 'select';
}

export interface ProviderFormState {
  providerId: string;
  values: Record<string, string>;
  activeFieldIndex: number;
  cursorOffset: number;
  error?: string;
}

export interface FilterState {
  value: string;
  cursorOffset: number;
}

export interface ProviderSlot {
  id: string;
  displayName: string;
  type: ProviderType;
  configured: boolean;
  apiKeyConfigured: boolean;
  baseUrl?: string;
  model?: string;
  models: string[];
}

export interface SessionSummary {
  id: string;
  title: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  last_token_speed: number | null;
  created_at: number;
  updated_at: number;
  message_count: number;
}

type ModelModalFocus = 'providers' | 'filter' | 'models';

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
  sessionsModalTextNode: MutableTextNode;
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
  sessionsRenaming: { id: string; value: string; cursorOffset: number } | null;
  currentSession: { id: string; title: string; provider: string; model: string };
  messages: Array<{ role: string }>;

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

export function formatFilterValue(value: string, cursorOffset: number, active: boolean): any[] {
  if (!active && value.length === 0) {
    return [white('(type to filter)')];
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

    chunks.push(white('Tab/↑/↓ move   Enter save   Esc cancel'));
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

    chunks.push(white('Enter confirm   Esc cancel'));
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
      'y confirm   n/Esc cancel',
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
    const active = item.id === (ctx.getSelectedProviderSlot()?.id) ? ' *' : '';
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
    ? '↑/↓ move   Enter edit   +/a add   d delete   m models   Esc/q close'
    : '↑/↓ move   Enter edit   +/a add   m models   Esc/q close';

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
    const active = item.id === (ctx.getSelectedProviderSlot()?.id) ? ' *' : '';
    const prefix = ctx.modelModalFocus === 'providers' && index === ctx.modelModalProviderIndex ? `[${marker}]` : ` ${marker} `;
    return `${prefix} ${item.displayName}${active}`;
  });

  const visibleModels = models.slice(modelScrollOffset, modelScrollOffset + providerModalVisibleModels);
  const modelLines = visibleModels.map((model, visibleIndex) => {
    const index = modelScrollOffset + visibleIndex;
    const marker = index === ctx.modelModalModelIndex ? '>' : ' ';
    const active = selectedProvider && selectedProvider.id === (ctx.getSelectedProviderSlot()?.id) && model === (selectedProvider.model) ? ' *' : '';
    const prefix = ctx.modelModalFocus === 'models' && index === ctx.modelModalModelIndex ? `[${marker}]` : ` ${marker} `;
    return `${prefix} ${model}${active}`;
  });

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
    chunks.push(white('Enter confirm   Esc cancel'));

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
  helpParts.push('Tab switch list');
  helpParts.push('↑/↓ move');
  helpParts.push('Enter use model');
  if (canDelete) helpParts.push('d delete model');
  helpParts.push('+/a add model');
  helpParts.push('Esc/q close');
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
    ctx.sessionsModalTextNode.content = stringToStyledText('');
    ctx.root.requestRender();
    ctx.inputNode.focus();
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
    const header = stringToStyledText('Sessions\n\nRename session: ');
    const footer = stringToStyledText('\n\nEnter confirm   Esc cancel');
    ctx.sessionsModalTextNode.content = new StyledText([
      ...header.chunks,
      ...cursorChunks,
      ...footer.chunks,
    ]);
    ctx.sessionsModalNode.visible = true;
    if (ctx.inputNode.blur) ctx.inputNode.blur();
    ctx.root.requestRender();
    return;
  }

  if (ctx.sessionsList.length === 0) {
    ctx.sessionsModalTextNode.content = stringToStyledText(
      'Sessions\n\nNo sessions yet.\n\nn new session   Esc/q close'
    );
    ctx.sessionsModalNode.visible = true;
    if (ctx.inputNode.blur) ctx.inputNode.blur();
    ctx.root.requestRender();
    return;
  }

  const totalSessions = ctx.sessionsList.length;
  const maxOffset = Math.max(0, totalSessions - sessionsVisibleLineCount);
  let scrollOffset = Math.max(0, Math.min(ctx.sessionsScrollOffset, maxOffset));
  if (ctx.sessionsSelectedIndex < scrollOffset) {
    scrollOffset = ctx.sessionsSelectedIndex;
  } else if (ctx.sessionsSelectedIndex >= scrollOffset + sessionsVisibleLineCount) {
    scrollOffset = ctx.sessionsSelectedIndex - sessionsVisibleLineCount + 1;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));

  const visibleSessions = ctx.sessionsList.slice(scrollOffset, scrollOffset + sessionsVisibleLineCount);
  const lines: string[] = ['Sessions', ''];
  for (let i = 0; i < visibleSessions.length; i++) {
    const s = visibleSessions[i];
    const actualIndex = scrollOffset + i;
    const marker = actualIndex === ctx.sessionsSelectedIndex ? '>' : ' ';
    const isActive = s.id === ctx.currentSession.id;
    const activeTag = isActive ? ' *' : '';
    const time = ctx.formatRelativeTime(s.updated_at);
    const msgs = `${s.message_count} msgs`;
    lines.push(`${marker} ${s.title.slice(0, 45).padEnd(45)} ${time.padStart(10)} ${msgs.padStart(10)}${activeTag}`);
  }
  if (totalSessions > sessionsVisibleLineCount) {
    lines.push('');
    lines.push(`Scroll ${scrollOffset + 1}-${Math.min(scrollOffset + visibleSessions.length, totalSessions)} / ${totalSessions}`);
  }
  lines.push('');
  lines.push('↑/↓ select   Enter resume   n new   r rename   d delete   PgUp/PgDn scroll   Esc/q close');

  ctx.sessionsModalTextNode.content = stringToStyledText(lines.join('\n'));
  ctx.sessionsModalNode.visible = true;
  if (ctx.inputNode.blur) ctx.inputNode.blur();
  ctx.root.requestRender();
}
