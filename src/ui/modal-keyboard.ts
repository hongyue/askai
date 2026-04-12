/**
 * Modal keyboard handlers for TUIApp.
 *
 * This module provides standalone keyboard handling functions that can be
 * composed into TUIApp. Each function takes a context object with the
 * state and methods it needs.
 */

import {
  isEnter, isEscape, isArrowUp, isArrowDown, isArrowLeft, isArrowRight,
  isTab, isShiftTab, isBackspace, isCtrlA, isCtrlE, isCtrlU,
  getChar, isChar, isCharIgnoreCase,
  clampScrollOffset,
} from '../input-utils';

const providerModalVisibleModels = 8;

// ── Context interface ───────────────────────────────────────────────────────

export interface ModalKeyboardContext {
  // Modal open state
  providerModalOpen: boolean;
  modelModalOpen: boolean;

  // Provider modal state
  getProviderFormState(): { providerId: string; activeFieldIndex: number; cursorOffset: number; values: Record<string, string>; error?: string } | null;
  setProviderFormState(state: { providerId: string; activeFieldIndex: number; cursorOffset: number; values: Record<string, string>; error?: string } | null): void;
  getAddProviderNameInput(): { value: string; cursorOffset: number } | null;
  setAddProviderNameInput(input: { value: string; cursorOffset: number } | null): void;
  getDeleteProviderConfirm(): { providerId: string } | null;
  setDeleteProviderConfirm(confirm: { providerId: string } | null): void;
  getProviderModalProviderIndex(): number;
  setProviderModalProviderIndex(index: number): void;
  providerModalNotice: string | null;

  // Model modal state
  getModelModalFocus(): 'providers' | 'filter' | 'models';
  setModelModalFocus(focus: 'providers' | 'filter' | 'models'): void;
  getAddModelInput(): { value: string; cursorOffset: number } | null;
  setAddModelInput(input: { value: string; cursorOffset: number } | null): void;
  getModelModalFilter(): { value: string; cursorOffset: number };
  setModelModalFilter(filter: { value: string; cursorOffset: number }): void;
  getModelModalProviderIndex(): number;
  setModelModalProviderIndex(index: number): void;
  getModelModalModelIndex(): number;
  setModelModalModelIndex(index: number): void;
  getModelModalModelScrollOffset(): number;
  setModelModalModelScrollOffset(offset: number): void;

  // Methods called by keyboard handlers
  renderProviderModal(): void;
  renderModelModal(): void;
  closeProviderModal(): void;
  closeModelModal(): void;
  openModelModal(providerId?: string): void;
  getProviderSlots(): Array<{ id: string; displayName: string }>;
  getSelectedProviderSlot(): { id: string } | undefined;
  syncProviderModalSelections(providerId: string): void;
  syncModelModalSelection(providerId?: string, model?: string): void;
  getSelectedModelModalProvider(): { id: string } | undefined;
  getModelModalModels(provider: { id: string } | undefined): string[];
  isCustomProviderId(providerId: string): boolean;
  startProviderForm(providerId: string): void;
  startAddProvider(): void;
  showDeleteProviderConfirmation(providerId: string): void;
  deleteCustomProvider(providerId: string): Promise<void>;
  addCustomProvider(name: string): Promise<void>;
  startAddModelInput(): void;
  cancelAddModelInput(): void;
  confirmAddModelInput(): Promise<void>;
  deleteSelectedCustomModel(): Promise<void>;
  applyModelSelection(): Promise<void>;
  moveProviderFormField(delta: number): void;
  moveProviderFormCursor(delta: number): void;
  saveProviderForm(): Promise<void>;
  insertProviderFormText(text: string): void;
  deleteProviderFormText(): void;
  getVisibleProviderFormFields(providerId: string): Array<{ key: string; kind: string }>;
  moveAddModelCursor(delta: number): void;
  deleteAddModelChar(): void;
  insertAddModelChar(char: string): void;
  moveModelFilterCursor(delta: number): void;
  deleteModelFilterText(): void;
  insertModelFilterText(text: string): void;
}

// ── Provider modal keyboard handler ─────────────────────────────────────────

const providerTypeOptions: string[] = ['openai-compatible', 'anthropic-compatible'];

function cycleProviderFormSelectValue(
  ctx: ModalKeyboardContext,
  formState: { providerId: string; activeFieldIndex: number; values: Record<string, string> },
  delta: number,
): void {
  const visibleFields = ctx.getVisibleProviderFormFields(formState.providerId || '');
  const currentField = visibleFields[formState.activeFieldIndex];
  if (!currentField || currentField.key !== 'type') return;

  const currentValue = formState.values['type'] || 'openai-compatible';
  const currentIndex = providerTypeOptions.indexOf(currentValue);
  const nextIndex = currentIndex < 0 ? 0 : ((currentIndex + delta + providerTypeOptions.length) % providerTypeOptions.length);
  formState.values['type'] = providerTypeOptions[nextIndex];
}

export async function handleProviderModalKey(ctx: ModalKeyboardContext, sequence: string): Promise<boolean> {
  if (!ctx.providerModalOpen) return false;

  // Handle provider form edit state
  const formState = ctx.getProviderFormState();
  if (formState) {
    if (isEscape(sequence)) {
      ctx.setProviderFormState(null);
      ctx.renderProviderModal();
      return true;
    }
    if (isTab(sequence) || isArrowDown(sequence)) {
      ctx.moveProviderFormField(1);
      return true;
    }
    if (isShiftTab(sequence) || isArrowUp(sequence)) {
      ctx.moveProviderFormField(-1);
      return true;
    }
    if (sequence === '\x13') {
      await ctx.saveProviderForm();
      return true;
    }

    // Check if current field is a select field
    const visibleFields = ctx.getVisibleProviderFormFields(formState.providerId);
    const currentField = visibleFields[formState.activeFieldIndex];
    const isSelectField = currentField && currentField.kind === 'select';

    if (isSelectField) {
      // For select fields, left/right cycle through options
      if (isArrowLeft(sequence) || isArrowRight(sequence)) {
        cycleProviderFormSelectValue(ctx, formState, isArrowLeft(sequence) ? -1 : 1);
        ctx.renderProviderModal();
        return true;
      }
      // Ignore text input for select fields
      const char = getChar(sequence);
      if (char !== null && char.charCodeAt(0) >= 32) return true;
      if (isBackspace(sequence)) return true;
      if (isCtrlA(sequence) || isCtrlE(sequence) || isCtrlU(sequence)) return true;
      if (sequence === ' ') return true;
    } else {
      // Normal text field behavior
      if (isArrowLeft(sequence)) {
        ctx.moveProviderFormCursor(-1);
        return true;
      }
      if (isArrowRight(sequence) || sequence === ' ') {
        if (sequence === ' ') {
          ctx.insertProviderFormText(' ');
          ctx.renderProviderModal();
        } else {
          ctx.moveProviderFormCursor(1);
        }
        return true;
      }
      if (isCtrlA(sequence)) {
        formState.cursorOffset = 0;
        ctx.renderProviderModal();
        return true;
      }
      if (isCtrlE(sequence)) {
        const fs = ctx.getProviderFormState()!;
        const visibleFields = ctx.getVisibleProviderFormFields(fs.providerId);
        const currentField = visibleFields[fs.activeFieldIndex];
        if (currentField) {
          fs.cursorOffset = (fs.values[currentField.key] || '').length;
          ctx.renderProviderModal();
        }
        return true;
      }
      if (isCtrlU(sequence)) {
        const fs = ctx.getProviderFormState()!;
        const visibleFields = ctx.getVisibleProviderFormFields(fs.providerId);
        const currentField = visibleFields[fs.activeFieldIndex];
        if (currentField) {
          const currentValue = fs.values[currentField.key] || '';
          fs.values[currentField.key] = currentValue.slice(fs.cursorOffset);
          fs.cursorOffset = 0;
          ctx.renderProviderModal();
        }
        return true;
      }
      if (isBackspace(sequence)) {
        ctx.deleteProviderFormText();
        ctx.renderProviderModal();
        return true;
      }
      {
        const char = getChar(sequence);
        if (char !== null && char.charCodeAt(0) >= 32) {
          ctx.insertProviderFormText(char);
          ctx.renderProviderModal();
          return true;
        }
      }
    }

    if (isEnter(sequence)) {
      await ctx.saveProviderForm();
      return true;
    }

    if (sequence.length > 1 && !sequence.includes('\x1b')) {
      return true;
    }
    return true;
  }

  // Handle add provider name input state
  const addInput = ctx.getAddProviderNameInput();
  if (addInput) {
    if (isEscape(sequence)) {
      ctx.setAddProviderNameInput(null);
      ctx.providerModalNotice = null;
      ctx.renderProviderModal();
      return true;
    }
    if (isEnter(sequence)) {
      await ctx.addCustomProvider(addInput.value);
      return true;
    }
    if (isArrowLeft(sequence)) {
      addInput.cursorOffset = Math.max(0, addInput.cursorOffset - 1);
      ctx.renderProviderModal();
      return true;
    }
    if (isArrowRight(sequence)) {
      addInput.cursorOffset = Math.min(addInput.value.length, addInput.cursorOffset + 1);
      ctx.renderProviderModal();
      return true;
    }
    if (isCtrlA(sequence)) {
      addInput.cursorOffset = 0;
      ctx.renderProviderModal();
      return true;
    }
    if (isCtrlE(sequence)) {
      addInput.cursorOffset = addInput.value.length;
      ctx.renderProviderModal();
      return true;
    }
    if (isCtrlU(sequence)) {
      addInput.value = addInput.value.slice(addInput.cursorOffset);
      addInput.cursorOffset = 0;
      ctx.renderProviderModal();
      return true;
    }
    if (isBackspace(sequence)) {
      if (addInput.cursorOffset > 0) {
        addInput.value = addInput.value.slice(0, addInput.cursorOffset - 1) + addInput.value.slice(addInput.cursorOffset);
        addInput.cursorOffset--;
        ctx.renderProviderModal();
      }
      return true;
    }
    {
      const char = getChar(sequence);
      if (char !== null && char.charCodeAt(0) >= 32) {
        addInput.value = addInput.value.slice(0, addInput.cursorOffset) + char + addInput.value.slice(addInput.cursorOffset);
        addInput.cursorOffset++;
        ctx.providerModalNotice = null;
        ctx.renderProviderModal();
        return true;
      }
    }
    if (sequence.length > 1 && !sequence.includes('\x1b')) {
      return true;
    }
    return true;
  }

  // Handle delete provider confirmation state
  const delConfirm = ctx.getDeleteProviderConfirm();
  if (delConfirm) {
    if (isCharIgnoreCase(sequence, 'y')) {
      await ctx.deleteCustomProvider(delConfirm.providerId);
      return true;
    }
    if (isEscape(sequence) || isCharIgnoreCase(sequence, 'n')) {
      ctx.setDeleteProviderConfirm(null);
      ctx.renderProviderModal();
      return true;
    }
    return true;
  }

  if (isEscape(sequence) || isCharIgnoreCase(sequence, 'q')) {
    ctx.closeProviderModal();
    return true;
  }
  if (isArrowUp(sequence)) {
    const providers = ctx.getProviderSlots();
    if (providers.length > 0) {
      const newIndex = (ctx.getProviderModalProviderIndex() + providers.length - 1) % providers.length;
      ctx.setProviderModalProviderIndex(newIndex);
      ctx.syncProviderModalSelections(providers[newIndex].id);
    }
    ctx.renderProviderModal();
    return true;
  }
  if (isArrowDown(sequence)) {
    const providers = ctx.getProviderSlots();
    if (providers.length > 0) {
      const newIndex = (ctx.getProviderModalProviderIndex() + 1) % providers.length;
      ctx.setProviderModalProviderIndex(newIndex);
      ctx.syncProviderModalSelections(providers[newIndex].id);
    }
    ctx.renderProviderModal();
    return true;
  }
  if (isCharIgnoreCase(sequence, 'm')) {
    ctx.openModelModal(ctx.getSelectedProviderSlot()?.id);
    return true;
  }
  if (isEnter(sequence)) {
    const selectedProvider = ctx.getSelectedProviderSlot();
    if (selectedProvider) {
      ctx.startProviderForm(selectedProvider.id);
    }
    return true;
  }
  if (isChar(sequence, '+') || isCharIgnoreCase(sequence, 'a')) {
    ctx.startAddProvider();
    return true;
  }
  if (isCharIgnoreCase(sequence, 'd')) {
    const selectedProvider = ctx.getSelectedProviderSlot();
    if (selectedProvider && ctx.isCustomProviderId(selectedProvider.id)) {
      ctx.showDeleteProviderConfirmation(selectedProvider.id);
    }
    return true;
  }

  return sequence.length > 0;
}

// ── Model modal keyboard handler ────────────────────────────────────────────

export async function handleModelModalKey(ctx: ModalKeyboardContext, sequence: string): Promise<boolean> {
  if (!ctx.modelModalOpen) return false;

  const addModelInput = ctx.getAddModelInput();
  if (addModelInput) {
    if (isEscape(sequence)) {
      ctx.cancelAddModelInput();
      return true;
    }
    if (isEnter(sequence)) {
      await ctx.confirmAddModelInput();
      return true;
    }
    if (isArrowLeft(sequence)) {
      ctx.moveAddModelCursor(-1);
      ctx.renderModelModal();
      return true;
    }
    if (isArrowRight(sequence)) {
      ctx.moveAddModelCursor(1);
      ctx.renderModelModal();
      return true;
    }
    if (isCtrlA(sequence)) {
      addModelInput.cursorOffset = 0;
      ctx.renderModelModal();
      return true;
    }
    if (isCtrlE(sequence)) {
      addModelInput.cursorOffset = addModelInput.value.length;
      ctx.renderModelModal();
      return true;
    }
    if (isCtrlU(sequence)) {
      addModelInput.value = addModelInput.value.slice(addModelInput.cursorOffset);
      addModelInput.cursorOffset = 0;
      ctx.renderModelModal();
      return true;
    }
    if (isBackspace(sequence)) {
      ctx.deleteAddModelChar();
      ctx.renderModelModal();
      return true;
    }
    {
      const char = getChar(sequence);
      if (char !== null && char.charCodeAt(0) >= 32) {
        ctx.insertAddModelChar(char);
        ctx.renderModelModal();
        return true;
      }
    }
    if (sequence.length > 1 && !sequence.includes('\x1b')) {
      return true;
    }
    return true;
  }

  if (isTab(sequence)) {
    const focus = ctx.getModelModalFocus();
    const newFocus = focus === 'providers' ? 'filter' : focus === 'filter' ? 'models' : 'providers';
    ctx.setModelModalFocus(newFocus);
    ctx.renderModelModal();
    return true;
  }

  if (ctx.getModelModalFocus() !== 'filter' && (isChar(sequence, '+') || isCharIgnoreCase(sequence, 'a'))) {
    ctx.startAddModelInput();
    return true;
  }

  if (ctx.getModelModalFocus() === 'filter') {
    const filter = ctx.getModelModalFilter();
    if (isArrowLeft(sequence)) {
      ctx.moveModelFilterCursor(-1);
      ctx.renderModelModal();
      return true;
    }
    if (isArrowRight(sequence)) {
      ctx.moveModelFilterCursor(1);
      ctx.renderModelModal();
      return true;
    }
    if (isCtrlA(sequence)) {
      filter.cursorOffset = 0;
      ctx.renderModelModal();
      return true;
    }
    if (isCtrlE(sequence)) {
      filter.cursorOffset = filter.value.length;
      ctx.renderModelModal();
      return true;
    }
    if (isCtrlU(sequence)) {
      filter.value = filter.value.slice(filter.cursorOffset);
      filter.cursorOffset = 0;
      ctx.renderModelModal();
      return true;
    }
    if (isBackspace(sequence)) {
      ctx.deleteModelFilterText();
      ctx.renderModelModal();
      return true;
    }
    if (isEnter(sequence)) {
      ctx.setModelModalFocus('models');
      ctx.renderModelModal();
      return true;
    }
    {
      const char = getChar(sequence);
      if (char !== null && char.charCodeAt(0) >= 32) {
        ctx.insertModelFilterText(char);
        ctx.renderModelModal();
        return true;
      }
    }
    if (sequence.length > 1 && !sequence.includes('\x1b')) {
      return true;
    }
    return true;
  }
  if (isEscape(sequence) || isCharIgnoreCase(sequence, 'q')) {
    ctx.closeModelModal();
    return true;
  }
  if (isArrowUp(sequence)) {
    if (ctx.getModelModalFocus() === 'providers') {
      const providers = ctx.getProviderSlots();
      if (providers.length > 0) {
        const newIndex = (ctx.getModelModalProviderIndex() + providers.length - 1) % providers.length;
        ctx.setModelModalProviderIndex(newIndex);
        ctx.syncModelModalSelection(providers[newIndex].id);
      }
    } else {
      const models = ctx.getModelModalModels(ctx.getSelectedModelModalProvider());
      if (models.length > 0) {
        const newIndex = (ctx.getModelModalModelIndex() + models.length - 1) % models.length;
        ctx.setModelModalModelIndex(newIndex);
        const newOffset = clampScrollOffset(
          newIndex,
          ctx.getModelModalModelScrollOffset(),
          providerModalVisibleModels,
          models.length,
        );
        ctx.setModelModalModelScrollOffset(newOffset);
      }
    }
    ctx.renderModelModal();
    return true;
  }
  if (isArrowDown(sequence)) {
    if (ctx.getModelModalFocus() === 'providers') {
      const providers = ctx.getProviderSlots();
      if (providers.length > 0) {
        const newIndex = (ctx.getModelModalProviderIndex() + 1) % providers.length;
        ctx.setModelModalProviderIndex(newIndex);
        ctx.syncModelModalSelection(providers[newIndex].id);
      }
    } else {
      const models = ctx.getModelModalModels(ctx.getSelectedModelModalProvider());
      if (models.length > 0) {
        const newIndex = (ctx.getModelModalModelIndex() + 1) % models.length;
        ctx.setModelModalModelIndex(newIndex);
        const newOffset = clampScrollOffset(
          newIndex,
          ctx.getModelModalModelScrollOffset(),
          providerModalVisibleModels,
          models.length,
        );
        ctx.setModelModalModelScrollOffset(newOffset);
      }
    }
    ctx.renderModelModal();
    return true;
  }
  if (isCharIgnoreCase(sequence, 'd')) {
    await ctx.deleteSelectedCustomModel();
    return true;
  }
  if (isEnter(sequence)) {
    await ctx.applyModelSelection();
    return true;
  }

  return sequence.length > 0;
}
