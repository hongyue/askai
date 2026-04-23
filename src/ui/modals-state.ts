/**
 * Modal state management for TUIApp.
 *
 * Encapsulates all provider, model, and sessions modal state and operations.
 */

import type { ProviderType } from '../config';
import {
  isPresetProviderId,
  isProviderIdUnique,
  renameProvider,
  upsertProvider,
  setProviderModel,
  removeProviderModel,
  normalizeModels,
  presetProviderIds,
  getProviderLabel,
  resolveProviderConfig,
  type Config,
  type ProviderConfig,
  type ResolvedProviderConfig,
} from "../config";
import { presetProviderMeta } from "../input-utils";
import { fetchAvailableModels } from "../providers/models";
import { clampScrollOffset } from "../input-utils";

// ── Constants ────────────────────────────────────────────────────────────────

const providerModalVisibleItems = 8;
const providerModalVisibleModels = 8;

const providerFormFields: Array<{ key: string; label: string; kind: 'text' | 'select' }> = [
  { key: 'id', label: 'Provider Name', kind: 'text' },
  { key: 'type', label: 'Type', kind: 'select' },
  { key: 'api_key', label: 'API Key', kind: 'text' },
  { key: 'base_url', label: 'Base URL', kind: 'text' },
  { key: 'model', label: 'Model Name', kind: 'text' },
];

// ── Types ────────────────────────────────────────────────────────────────────

export type ModelModalFocus = 'providers' | 'filter' | 'models';

export interface ProviderFormState {
  providerId: string;
  values: Record<string, string>;
  activeFieldIndex: number;
  cursorOffset: number;
  error?: string;
}

export interface ProviderFormField {
  key: string;
  label: string;
  kind: 'text' | 'select';
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
  resolved?: ResolvedProviderConfig;
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

// ── State ────────────────────────────────────────────────────────────────────

export interface ModalsState {
  // Provider modal
  providerModalOpen: boolean;
  providerModalProviderIndex: number;
  providerModalProviderScrollOffset: number;
  providerFormState: ProviderFormState | null;
  providerModalNotice: string | null;
  addProviderNameInput: { value: string; cursorOffset: number } | null;
  deleteProviderConfirm: { providerId: string } | null;

  // Model modal
  modelModalOpen: boolean;
  modelModalFocus: ModelModalFocus;
  modelModalProviderIndex: number;
  modelModalModelIndex: number;
  modelModalProviderScrollOffset: number;
  modelModalModelScrollOffset: number;
  modelModalFilter: FilterState;
  addModelInput: { value: string; cursorOffset: number } | null;
  addModelInputProviderId: string;
  addModelInputProviderName: string;
  modelModalNotice: string | null;
  deleteModelConfirm: { model: string; providerId: string } | null;

  // Sessions modal
  sessionsModalOpen: boolean;
  sessionsList: SessionSummary[];
  sessionsSelectedIndex: number;
  sessionsScrollOffset: number;
  sessionsRenaming: { id: string; value: string; cursorOffset: number } | null;
  deleteSessionConfirm: { id: string } | null;
  sessionsFilter: FilterState;
  sessionsFilterFocus: boolean;
}

export function createModalsState(): ModalsState {
  return {
    providerModalOpen: false,
    providerModalProviderIndex: 0,
    providerModalProviderScrollOffset: 0,
    providerFormState: null,
    providerModalNotice: null,
    addProviderNameInput: null,
    deleteProviderConfirm: null,
    modelModalOpen: false,
    modelModalFocus: 'models',
    modelModalProviderIndex: 0,
    modelModalModelIndex: 0,
    modelModalProviderScrollOffset: 0,
    modelModalModelScrollOffset: 0,
    modelModalFilter: { value: '', cursorOffset: 0 },
    addModelInput: null,
    addModelInputProviderId: '',
    addModelInputProviderName: '',
    modelModalNotice: null,
    deleteModelConfirm: null,
    sessionsModalOpen: false,
    sessionsList: [],
    sessionsSelectedIndex: 0,
    sessionsScrollOffset: 0,
    sessionsRenaming: null,
    deleteSessionConfirm: null,
    sessionsFilter: { value: '', cursorOffset: 0 },
    sessionsFilterFocus: false,
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function normalizeProviderFormValues(values: Record<string, string>): Record<string, string> {
  const nextValues = { ...values };
  nextValues.id = nextValues.id || '';
  nextValues.type = nextValues.type || 'openai-compatible';
  nextValues.api_key = nextValues.api_key || '';
  nextValues.base_url = nextValues.base_url || '';
  nextValues.model = nextValues.model || '';
  return nextValues;
}

export function filterModels(models: string[], filterValue: string): string[] {
  const normalizedFilter = filterValue.trim().toLowerCase();
  if (!normalizedFilter) {
    return models;
  }
  return models.filter(model => model.toLowerCase().includes(normalizedFilter));
}

export function getVisibleProviderFormFields(providerId: string): ProviderFormField[] {
  const preset = getPresetProviderMeta(providerId);
  const isCustomProvider = !preset;

  return providerFormFields.filter(field => {
    if (field.key === 'id' || field.key === 'type') return isCustomProvider;
    return true; // api_key, base_url, model always shown
  });
}

function getPresetProviderMeta(providerId: string) {
  const normalizedId = providerId.toLowerCase();
  return presetProviderMeta.find((item: typeof presetProviderMeta[number]) => item.id.toLowerCase() === normalizedId);
}

export function getProviderPlaceholderLabel(providerId: string): string {
  const preset = getPresetProviderMeta(providerId);
  if (preset) return preset.displayName;
  return providerId;
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Host interface ───────────────────────────────────────────────────────────

export interface IModalsHost {
  state: ModalsState;
  config: Config;
  runtime: {
    switchProvider(providerId: string, persist?: boolean): Promise<any>;
    switchModel(model: string, persist?: boolean): Promise<any>;
    persistConfig(): Promise<void>;
    getProvider(): any;
    getResolvedProvider(): ResolvedProviderConfig;
    getProviderTools(): any[];
    refreshProviderTools(): Promise<void>;
  };

  // Callbacks for rendering
  renderProviderModal(): void;
  renderModelModal(): void;
  renderSessionsModal(): void;
  refreshActiveProviderView(): Promise<void>;
  closeSessionsModal(): void;
  closeProviderModal(): void;
  closeModelModal(): void;

  // Session operations
  listSessions(): SessionSummary[];
  renameSession(id: string, title: string): void;
  deleteSession(id: string): void;
  startNewSession(): any;
  getCurrentSession(): any;
  getMessages(): Array<{ role: string }>;
}

// ── Manager class ────────────────────────────────────────────────────────────

export class ModalsStateManager {
  constructor(private host: IModalsHost) {}

  get state(): ModalsState { return this.host.state; }

  // ── Provider slots ─────────────────────────────────────────────────────

  getProviderSlots(): ProviderSlot[] {
    const slots: ProviderSlot[] = [];
    const addedNormalizedIds = new Set<string>();

    for (const preset of presetProviderMeta) {
      const configKey = Object.keys(this.host.config.providers).find(
        k => k.toLowerCase() === preset.id.toLowerCase()
      );
      const providerId = configKey || preset.id;
      addedNormalizedIds.add(providerId.toLowerCase());

      const storedProvider = this.host.config.providers[providerId];
      if (storedProvider) {
        const resolvedConfig = resolveProviderConfig(this.host.config, providerId);
        slots.push({
          id: providerId,
          displayName: getProviderLabel(resolvedConfig),
          type: resolvedConfig.type,
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
          type: preset.type,
          configured: false,
          apiKeyConfigured: false,
          baseUrl: preset.baseUrl,
          model: preset.defaultModel,
          models: [],
        });
      }
    }

    for (const [providerId, providerConfig] of Object.entries(this.host.config.providers)) {
      if (addedNormalizedIds.has(providerId.toLowerCase())) continue;

      const resolvedConfig = resolveProviderConfig(this.host.config, providerId);
      slots.push({
        id: providerId,
        displayName: getProviderLabel(resolvedConfig),
        type: resolvedConfig.type,
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

  getSelectedProviderSlot(): ProviderSlot | undefined {
    const providers = this.getProviderSlots();
    if (providers.length === 0) return undefined;
    this.host.state.providerModalProviderIndex = Math.max(0, Math.min(this.host.state.providerModalProviderIndex, providers.length - 1));
    return providers[this.host.state.providerModalProviderIndex];
  }

  getSelectedModelModalProvider(): ProviderSlot | undefined {
    const providers = this.getProviderSlots();
    if (providers.length === 0) return undefined;
    this.host.state.modelModalProviderIndex = Math.max(0, Math.min(this.host.state.modelModalProviderIndex, providers.length - 1));
    return providers[this.host.state.modelModalProviderIndex];
  }

  getProviderSlotModels(providerSlot: ProviderSlot | undefined): string[] {
    return providerSlot ? providerSlot.models : [];
  }

  getModelModalModels(providerSlot: ProviderSlot | undefined): string[] {
    return filterModels(this.getProviderSlotModels(providerSlot), this.host.state.modelModalFilter.value);
  }

  private syncSelectionsToResolvedProvider(): void {
    const resolvedProvider = this.host.runtime.getResolvedProvider();
    this.syncProviderModalSelections(resolvedProvider.id);
    this.syncModelModalSelection(resolvedProvider.id, resolvedProvider.model);
  }

  // ── Selection sync ─────────────────────────────────────────────────────

  syncProviderModalSelections(targetProviderId?: string): void {
    const providers = this.getProviderSlots();
    if (providers.length === 0) {
      this.host.state.providerModalProviderIndex = 0;
      return;
    }

    const resolvedProvider = this.host.runtime.getResolvedProvider();
    const fallbackProviderId = providers[Math.max(0, Math.min(this.host.state.providerModalProviderIndex, providers.length - 1))]?.id || resolvedProvider.id;
    const nextProviderId = targetProviderId || fallbackProviderId;
    const nextProviderIndex = providers.findIndex(item => item.id === nextProviderId);
    this.host.state.providerModalProviderIndex = nextProviderIndex >= 0 ? nextProviderIndex : 0;
    this.host.state.providerModalProviderScrollOffset = clampScrollOffset(
      this.host.state.providerModalProviderIndex,
      this.host.state.providerModalProviderScrollOffset,
      providerModalVisibleItems,
      providers.length,
    );
  }

  syncModelModalSelection(targetProviderId?: string, targetModel?: string): void {
    const providers = this.getProviderSlots();
    if (providers.length === 0) {
      this.host.state.modelModalProviderIndex = 0;
      this.host.state.modelModalModelIndex = 0;
      this.host.state.modelModalProviderScrollOffset = 0;
      this.host.state.modelModalModelScrollOffset = 0;
      return;
    }

    const resolvedProvider = this.host.runtime.getResolvedProvider();
    const nextProviderId = targetProviderId || resolvedProvider.id;
    const nextProviderIndex = providers.findIndex(provider => provider.id === nextProviderId);
    this.host.state.modelModalProviderIndex = Math.max(0, nextProviderIndex >= 0 ? nextProviderIndex : 0);
    this.host.state.modelModalFilter = { value: '', cursorOffset: 0 };

    const selectedProvider = providers[this.host.state.modelModalProviderIndex];
    const models = this.getModelModalModels(selectedProvider);
    const nextModel = targetModel || selectedProvider?.model || resolvedProvider.model;
    const nextModelIndex = models.findIndex(model => model === nextModel);
    this.host.state.modelModalModelIndex = Math.max(0, nextModelIndex >= 0 ? nextModelIndex : 0);

    this.host.state.modelModalProviderScrollOffset = clampScrollOffset(
      this.host.state.modelModalProviderIndex,
      this.host.state.modelModalProviderScrollOffset,
      providerModalVisibleItems,
      providers.length,
    );
    this.host.state.modelModalModelScrollOffset = clampScrollOffset(
      this.host.state.modelModalModelIndex,
      this.host.state.modelModalModelScrollOffset,
      providerModalVisibleModels,
      models.length,
    );
  }

  // ── Provider form ──────────────────────────────────────────────────────

  createProviderFormState(providerSlot: ProviderSlot): ProviderFormState {
    const values = normalizeProviderFormValues({
      id: providerSlot.id,
      type: providerSlot.type,
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

  private getProviderFormConfig(providerId: string, values: Record<string, string>, previousProvider?: ProviderConfig): ProviderConfig {
    const preset = getPresetProviderMeta(providerId);
    if (preset) {
      // Preset provider: type is fixed, base_url is preset default (editable)
      const nextModel = values.model.trim() || previousProvider?.model || preset.defaultModel;
      const nextModels = Array.from(new Set([
        nextModel,
        ...(previousProvider?.models || []),
      ].map(item => item.trim()).filter(Boolean)));

      return {
        type: preset.type,
        api_key: values.api_key.trim() || undefined,
        base_url: values.base_url.trim() || preset.baseUrl,
        model: nextModel,
        models: nextModels.length > 0 ? nextModels : undefined,
      };
    }

    // Custom provider
    const nextModel = values.model.trim();
    if (!values.id.trim()) {
      throw new Error('Provider name is required for custom providers.');
    }
    if (!values.type || (values.type !== 'openai-compatible' && values.type !== 'anthropic-compatible')) {
      throw new Error('Provider type must be "openai-compatible" or "anthropic-compatible".');
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
      type: values.type as ProviderType,
      api_key: values.api_key.trim() || undefined,
      base_url: values.base_url.trim(),
      model: nextModel,
      models: nextModels.length > 0 ? nextModels : undefined,
    };
  }

  private updateProviderFormFieldValue(nextValue: string): void {
    const formState = this.host.state.providerFormState;
    if (!formState) return;

    const fields = getVisibleProviderFormFields(formState.providerId);
    const field = fields[formState.activeFieldIndex];
    formState.values[field.key] = nextValue;
    formState.values = normalizeProviderFormValues(formState.values);
    formState.cursorOffset = Math.max(0, Math.min(formState.cursorOffset, nextValue.length));
    formState.error = undefined;
  }

  startProviderForm(providerId: string): void {
    const providerSlot = this.getProviderSlots().find(item => item.id === providerId);
    if (!providerSlot) return;
    this.host.state.providerFormState = this.createProviderFormState(providerSlot);
    this.host.renderProviderModal();
  }

  async saveProviderForm(): Promise<void> {
    const formState = this.host.state.providerFormState;
    if (!formState) return;

    try {
      const originalId = formState.providerId;
      const wasActiveProvider = this.host.runtime.getResolvedProvider().id === originalId;
      const newId = formState.values.id?.trim() || originalId;
      const previousProviderConfig = this.host.config.providers[originalId];
      const nextConfig = this.getProviderFormConfig(originalId, formState.values, previousProviderConfig);

      if (!isPresetProviderId(originalId) && !nextConfig.api_key) {
        throw new Error('API key is required for preset providers.');
      }

      if (isPresetProviderId(originalId) && !nextConfig.api_key) {
        throw new Error('API key is required for preset providers.');
      }

      if (isPresetProviderId(originalId) && isPresetProviderId(originalId)) {
        // Preset provider - check API key
        if (!nextConfig.api_key) {
          throw new Error('API key is required for preset providers.');
        }
      }

      if (!isPresetProviderId(originalId) && newId !== originalId) {
        renameProvider(this.host.config, originalId, newId);
      }

      upsertProvider(this.host.config, newId, nextConfig);

      this.host.state.providerModalNotice = null;
      // Fetch models for all providers (preset and custom)
      try {
        const fetchedModels = await fetchAvailableModels(resolveProviderConfig(this.host.config, newId));
        if (fetchedModels.length > 0) {
          const currentModel = this.host.config.providers[newId].model;
          const orderedModels = currentModel && fetchedModels.includes(currentModel)
            ? [currentModel, ...fetchedModels.filter(model => model !== currentModel)]
            : fetchedModels;
          this.host.config.providers[newId].models = orderedModels;
          this.host.config.providers[newId].model = orderedModels[0];
          this.host.state.providerModalNotice = `Fetched ${fetchedModels.length} models for ${getProviderLabel(resolveProviderConfig(this.host.config, newId))}.`;
        } else {
          this.host.state.providerModalNotice = `Saved provider. No models were returned for ${getProviderPlaceholderLabel(newId)}.`;
        }
      } catch (error) {
        this.host.state.providerModalNotice = `Saved provider. Failed to refresh models: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }

      if (wasActiveProvider) {
        await this.host.runtime.switchProvider(newId, false);
      }

      await this.host.runtime.persistConfig();
      this.host.state.providerFormState = null;
      await this.host.refreshActiveProviderView();
      if (wasActiveProvider) {
        this.syncSelectionsToResolvedProvider();
      } else {
        const providerModel = this.host.config.providers[newId]?.model;
        this.syncProviderModalSelections(newId);
        this.syncModelModalSelection(newId, providerModel);
      }
      this.host.renderProviderModal();
    } catch (error) {
      formState.error = error instanceof Error ? error.message : 'Unknown error';
      this.host.renderProviderModal();
    }
  }

  insertProviderFormText(text: string): void {
    const formState = this.host.state.providerFormState;
    if (!formState) return;

    const fields = getVisibleProviderFormFields(formState.providerId);
    const field = fields[formState.activeFieldIndex];

    const currentValue = formState.values[field.key] || '';
    const clampedOffset = Math.max(0, Math.min(formState.cursorOffset, currentValue.length));
    const nextValue = `${currentValue.slice(0, clampedOffset)}${text}${currentValue.slice(clampedOffset)}`;
    formState.cursorOffset = clampedOffset + text.length;
    this.updateProviderFormFieldValue(nextValue);
  }

  deleteProviderFormText(): void {
    const formState = this.host.state.providerFormState;
    if (!formState) return;

    const fields = getVisibleProviderFormFields(formState.providerId);
    const field = fields[formState.activeFieldIndex];

    const currentValue = formState.values[field.key] || '';
    const clampedOffset = Math.max(0, Math.min(formState.cursorOffset, currentValue.length));
    if (clampedOffset === 0) return;

    const nextValue = `${currentValue.slice(0, clampedOffset - 1)}${currentValue.slice(clampedOffset)}`;
    formState.cursorOffset = clampedOffset - 1;
    this.updateProviderFormFieldValue(nextValue);
  }

  moveProviderFormCursor(delta: number): void {
    const formState = this.host.state.providerFormState;
    if (!formState) return;

    const fields = getVisibleProviderFormFields(formState.providerId);
    const field = fields[formState.activeFieldIndex];

    const currentValue = formState.values[field.key] || '';
    formState.cursorOffset = Math.max(0, Math.min(formState.cursorOffset + delta, currentValue.length));
    formState.error = undefined;
    this.host.renderProviderModal();
  }

  moveProviderFormField(delta: number): void {
    const formState = this.host.state.providerFormState;
    if (!formState) return;

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
    this.host.renderProviderModal();
  }

  insertProviderFormPaste(text: string): void {
    const normalizedText = text
      .replace(/\r\n/g, '\n')
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
      .replace(/\n/g, ' ');
    if (!normalizedText) return;
    this.insertProviderFormText(normalizedText);
    this.host.renderProviderModal();
  }

  placeProviderFormCursorFromMouse(mouseX: number, mouseY: number, modalNode: { visible: boolean; x?: number; y?: number }): void {
    const formState = this.host.state.providerFormState;
    if (!formState || !modalNode.visible || typeof modalNode.x !== 'number' || typeof modalNode.y !== 'number') {
      return;
    }

    const visibleFields = getVisibleProviderFormFields(formState.providerId);
    const contentX = modalNode.x + 1;
    const contentY = modalNode.y + 1;
    const fieldStartLine = contentY + 2;
    const clickedFieldIndex = mouseY - fieldStartLine;
    if (clickedFieldIndex < 0 || clickedFieldIndex >= visibleFields.length) return;

    formState.activeFieldIndex = clickedFieldIndex;
    const field = visibleFields[clickedFieldIndex];
    const currentValue = formState.values[field.key] || '';
    const valueColumnX = contentX + 17;
    formState.cursorOffset = Math.max(0, Math.min(mouseX - valueColumnX, currentValue.length));
    formState.error = undefined;
    this.host.renderProviderModal();
  }

  // ── Add provider ───────────────────────────────────────────────────────

  startAddProvider(): void {
    this.host.state.addProviderNameInput = { value: '', cursorOffset: 0 };
    this.host.state.providerModalNotice = null;
    this.host.renderProviderModal();
  }

  showDeleteProviderConfirmation(providerId: string): void {
    this.host.state.deleteProviderConfirm = { providerId };
    this.host.state.providerModalNotice = null;
    this.host.renderProviderModal();
  }

  async deleteCustomProvider(providerId: string): Promise<void> {
    if (isPresetProviderId(providerId)) return;

    delete this.host.config.providers[providerId];

    if (this.host.config.provider === providerId) {
      const remaining = Object.keys(this.host.config.providers);
      if (remaining.length > 0) {
        this.host.config.provider = remaining[0];
        await this.host.runtime.switchProvider(this.host.config.provider, false);
      } else {
        this.host.config.provider = '';
      }
    }

    await this.host.runtime.persistConfig();
    this.host.state.providerModalNotice = `Deleted provider ${providerId}.`;
    this.host.state.deleteProviderConfirm = null;
    this.syncProviderModalSelections(this.host.config.provider);
    await this.host.refreshActiveProviderView();
    this.host.renderProviderModal();
  }

  showDeleteSessionConfirmation(id: string): void {
    this.host.state.deleteSessionConfirm = { id };
    this.host.renderSessionsModal();
  }

  showDeleteModelConfirmation(model: string, providerId: string): void {
    this.host.state.deleteModelConfirm = { model, providerId };
    this.host.state.modelModalNotice = null;
    this.host.renderModelModal();
  }

  async addCustomProvider(name: string): Promise<void> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      this.host.state.providerModalNotice = 'Provider name cannot be empty.';
      this.host.renderProviderModal();
      return;
    }

    if (!isProviderIdUnique(this.host.config, trimmedName)) {
      this.host.state.providerModalNotice = `Provider "${trimmedName}" already exists. Please use a unique name.`;
      this.host.renderProviderModal();
      return;
    }

    if (isPresetProviderId(trimmedName)) {
      this.host.state.providerModalNotice = 'Cannot use a preset provider name.';
      this.host.renderProviderModal();
      return;
    }

    this.host.config.providers[trimmedName] = {
      type: 'openai-compatible',
      api_key: '',
      base_url: 'http://localhost:8080/v1',
      model: 'llama3',
    };

    await this.host.runtime.persistConfig();
    this.host.state.addProviderNameInput = null;
    this.host.state.providerModalNotice = `Created provider "${trimmedName}".`;
    this.syncProviderModalSelections(trimmedName);
    await this.host.refreshActiveProviderView();
    this.startProviderForm(trimmedName);
  }

  // ── Model operations ───────────────────────────────────────────────────

  startAddModelInput(): void {
    const selectedProvider = this.getSelectedModelModalProvider();
    if (!selectedProvider) return;
    this.host.state.addModelInput = { value: '', cursorOffset: 0 };
    this.host.state.addModelInputProviderId = selectedProvider.id;
    this.host.state.addModelInputProviderName = selectedProvider.displayName;
    this.host.state.modelModalNotice = null;
    this.host.renderModelModal();
  }

  cancelAddModelInput(): void {
    this.host.state.addModelInput = null;
    this.host.renderModelModal();
  }

  moveAddModelCursor(delta: number): void {
    if (!this.host.state.addModelInput) return;
    this.host.state.addModelInput.cursorOffset = Math.max(0, Math.min(this.host.state.addModelInput.cursorOffset + delta, this.host.state.addModelInput.value.length));
  }

  deleteAddModelChar(): void {
    if (!this.host.state.addModelInput) return;
    const { value, cursorOffset } = this.host.state.addModelInput;
    if (cursorOffset > 0) {
      this.host.state.addModelInput.value = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
      this.host.state.addModelInput.cursorOffset--;
    }
  }

  insertAddModelChar(char: string): void {
    if (!this.host.state.addModelInput) return;
    const { value, cursorOffset } = this.host.state.addModelInput;
    this.host.state.addModelInput.value = value.slice(0, cursorOffset) + char + value.slice(cursorOffset);
    this.host.state.addModelInput.cursorOffset++;
  }

  insertAddModelPaste(text: string): void {
    if (!this.host.state.addModelInput) return;
    const normalized = text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').replace(/\n/g, ' ');
    if (!normalized) return;
    const { value, cursorOffset } = this.host.state.addModelInput;
    this.host.state.addModelInput.value = value.slice(0, cursorOffset) + normalized + value.slice(cursorOffset);
    this.host.state.addModelInput.cursorOffset += normalized.length;
  }

  async confirmAddModelInput(): Promise<void> {
    if (!this.host.state.addModelInput) return;
    const modelName = this.host.state.addModelInput.value.trim();
    if (!modelName) {
      this.host.state.modelModalNotice = 'Model name cannot be empty';
      this.host.state.addModelInput = null;
      this.host.renderModelModal();
      return;
    }

    const provider = this.host.config.providers[this.host.state.addModelInputProviderId];
    if (!provider) {
      this.host.state.modelModalNotice = 'Provider not found';
      this.host.state.addModelInput = null;
      this.host.renderModelModal();
      return;
    }

    const existingModels = (provider.models && provider.models.length > 0 ? provider.models : [provider.model]).filter(Boolean);
    if (existingModels.map(m => m.trim()).includes(modelName)) {
      this.host.state.modelModalNotice = `Model "${modelName}" already exists for this provider`;
      this.host.state.addModelInput = null;
      this.host.renderModelModal();
      return;
    }

    const newModelList = [...existingModels, modelName];
    provider.models = normalizeModels(newModelList, provider.model);
    await this.host.runtime.persistConfig();

    this.host.state.addModelInput = null;
    this.host.state.modelModalNotice = `Added model ${modelName} to ${this.host.state.addModelInputProviderName}`;
    this.syncModelModalSelection(this.host.state.addModelInputProviderId);
    await this.host.refreshActiveProviderView();
    this.host.renderModelModal();
  }

  async deleteSelectedCustomModel(): Promise<void> {
    const selectedProvider = this.getSelectedModelModalProvider();
    if (!selectedProvider) return;

    const models = this.getModelModalModels(selectedProvider);
    if (models.length <= 1) {
      this.host.state.modelModalNotice = 'Cannot delete the only model for this provider.';
      this.host.renderModelModal();
      return;
    }

    const selectedModel = models[this.host.state.modelModalModelIndex];
    if (!selectedModel) return;

    try {
      removeProviderModel(this.host.config, selectedProvider.id, selectedModel);
      if (this.host.runtime.getResolvedProvider().id === selectedProvider.id) {
        await this.host.runtime.switchProvider(selectedProvider.id, false);
      }
      await this.host.runtime.persistConfig();
      this.syncModelModalSelection(selectedProvider.id);
      await this.host.refreshActiveProviderView();
      this.host.state.modelModalNotice = `Deleted model ${selectedModel} from ${selectedProvider.displayName}.`;
      this.host.renderModelModal();
    } catch (error) {
      this.host.state.modelModalNotice = error instanceof Error ? error.message : 'Unknown error';
      this.host.renderModelModal();
    }
  }

  async applyModelSelection(): Promise<void> {
    const selectedProvider = this.getSelectedModelModalProvider();
    if (!selectedProvider) return;

    const models = this.getModelModalModels(selectedProvider);
    const selectedModel = models[this.host.state.modelModalModelIndex];
    if (!selectedModel) return;

    if (this.host.runtime.getResolvedProvider().id !== selectedProvider.id) {
      await this.host.runtime.switchProvider(selectedProvider.id, false);
    }
    if (this.host.config.providers[selectedProvider.id]?.model !== selectedModel) {
      setProviderModel(this.host.config, selectedProvider.id, selectedModel);
      if (this.host.config.provider === selectedProvider.id) {
        await this.host.runtime.switchModel(selectedModel, false);
      }
    }
    await this.host.runtime.persistConfig();
    await this.host.refreshActiveProviderView();
    this.syncSelectionsToResolvedProvider();
    this.host.closeModelModal();
  }

  // ── Filter operations ──────────────────────────────────────────────────

  updateModelFilter(nextValue: string): void {
    this.host.state.modelModalFilter.value = nextValue;
    this.host.state.modelModalFilter.cursorOffset = Math.max(0, Math.min(this.host.state.modelModalFilter.cursorOffset, nextValue.length));
    const selectedProvider = this.getSelectedModelModalProvider();
    const filteredModels = this.getModelModalModels(selectedProvider);
    this.host.state.modelModalModelIndex = Math.max(0, Math.min(this.host.state.modelModalModelIndex, Math.max(0, filteredModels.length - 1)));
    this.host.state.modelModalModelScrollOffset = clampScrollOffset(
      this.host.state.modelModalModelIndex,
      this.host.state.modelModalModelScrollOffset,
      providerModalVisibleModels,
      filteredModels.length,
    );
  }

  insertModelFilterText(text: string): void {
    const currentValue = this.host.state.modelModalFilter.value;
    const offset = Math.max(0, Math.min(this.host.state.modelModalFilter.cursorOffset, currentValue.length));
    this.updateModelFilter(`${currentValue.slice(0, offset)}${text}${currentValue.slice(offset)}`);
    this.host.state.modelModalFilter.cursorOffset = offset + text.length;
  }

  deleteModelFilterText(): void {
    const currentValue = this.host.state.modelModalFilter.value;
    const offset = Math.max(0, Math.min(this.host.state.modelModalFilter.cursorOffset, currentValue.length));
    if (offset === 0) return;
    this.updateModelFilter(`${currentValue.slice(0, offset - 1)}${currentValue.slice(offset)}`);
    this.host.state.modelModalFilter.cursorOffset = offset - 1;
  }

  moveModelFilterCursor(delta: number): void {
    this.host.state.modelModalFilter.cursorOffset = Math.max(0, Math.min(this.host.state.modelModalFilter.cursorOffset + delta, this.host.state.modelModalFilter.value.length));
  }

  insertModelFilterPaste(text: string): void {
    const normalizedText = text
      .replace(/\r\n/g, '\n')
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
      .replace(/\n/g, ' ');
    if (!normalizedText) return;
    this.insertModelFilterText(normalizedText);
  }

  // ── Modal open ─────────────────────────────────────────────────────────

  openProviderModal(): void {
    this.host.state.providerModalOpen = true;
    this.host.state.providerFormState = null;
    this.host.state.providerModalNotice = null;
    this.host.state.modelModalOpen = false;
    this.syncProviderModalSelections(this.host.runtime.getResolvedProvider().id);
    this.host.renderProviderModal();
  }

  openModelModal(providerId?: string): void {
    const resolvedProvider = this.host.runtime.getResolvedProvider();
    this.host.state.modelModalOpen = true;
    this.host.state.modelModalFocus = 'models';
    this.host.state.modelModalNotice = null;
    this.host.state.modelModalFilter = { value: '', cursorOffset: 0 };
    this.syncModelModalSelection(
      providerId || resolvedProvider.id,
      providerId === resolvedProvider.id ? resolvedProvider.model : undefined,
    );
    this.host.renderModelModal();
  }

  updateSessionsList(): void {
    const allSessions = this.host.listSessions();
    // Only show saved sessions (with non-empty id)
    this.host.state.sessionsList = allSessions.filter(s => s.id !== '');
    if (!this.host.state.sessionsList.some(s => s.id === this.host.getCurrentSession().id)) {
      const cs = this.host.getCurrentSession();
      // Only add to list if it's a saved session (has an id)
      if (cs.id) {
        this.host.state.sessionsList.unshift({
        id: cs.id,
        title: cs.title,
        provider: cs.provider,
        model: cs.model,
        prompt_tokens: cs.prompt_tokens,
        completion_tokens: cs.completion_tokens,
        total_tokens: cs.total_tokens,
        last_token_speed: cs.last_token_speed,
        created_at: Date.now(),
        updated_at: Date.now(),
        message_count: this.host.getMessages().filter(m => m.role !== 'system').length,
        });
      }
    }
  }

  // ── Command handlers ───────────────────────────────────────────────────

  async handleProviderCommand(_args: string[]): Promise<string | void> {
    this.openProviderModal();
    return 'Opened provider modal';
  }

  async handleModelCommand(_args: string[]): Promise<string | void> {
    this.openModelModal();
    return 'Opened model modal';
  }
}
