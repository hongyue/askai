import type { KeyEvent } from "@opentui/core";
import type { SessionStorage } from "./session";
import type { TokenUsage } from "./providers/base";
import type { ProviderType } from './config';

// ── Constants ───────────────────────────────────────────────────────────────

export const oneShotFeedbackPrompts = [
  'Thinking...',
  'Working on it...',
  'Checking...',
  'Putting it together...',
  'One moment...',
];

export const oneShotFeedbackColor = '\x1b[38;5;45m';
export const ansiReset = '\x1b[0m';
export const mcpDetailsModalHeight = 20;
export const mcpDetailsVisibleLineCount = 15;
export const mcpDetailsFooterLineCount = 3;
export const sessionsVisibleLineCount = 15;
export const statusSpinnerFrames = ['|', '/', '-', '\\'] as const;
export const enableModifyOtherKeys = '\x1b[>4;2m';
export const resetModifyOtherKeys = '\x1b[>4m';
export const shiftEnterSequences = new Set([
  '\x1b[13;2u',
  '\x1b[27;2;13~',
  '\x1b[13;2~',
]);

export const approvalActions = [
  { key: 'y', label: 'Yes' },
  { key: 'n', label: 'No' },
  { key: 'a', label: 'All' },
  { key: 'x', label: 'None' },
] as const;

export type ApprovalActionKey = typeof approvalActions[number]['key'];

export const presetProviderMeta = [
  { id: 'openai', displayName: 'OpenAI', type: 'openai-compatible' as ProviderType, baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  { id: 'anthropic', displayName: 'Anthropic', type: 'anthropic-compatible' as ProviderType, baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'openrouter', displayName: 'OpenRouter', type: 'openai-compatible' as ProviderType, baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini' },
] as const;

export const promptAccentBorderChars = {
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

// ── Session Helpers ─────────────────────────────────────────────────────────

export function createEmptySession(provider: string, model: string): SessionStorage {
  return {
    id: '',
    title: 'New Session',
    provider,
    model,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    last_token_speed: null,
  };
}

// ── Formatters ──────────────────────────────────────────────────────────────

export function formatNumberCompact(value: number): string {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return `${Math.round(value)}`;
}

export function formatTokenSpeed(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return '-- tok/s';
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} tok/s`;
}

export function formatStatusStats(session: SessionStorage): string {
  return `${formatTokenSpeed(session.last_token_speed)}  ${formatNumberCompact(session.total_tokens)} tok`;
}

export function formatElapsedSeconds(startedAt?: number): string {
  if (!startedAt) {
    return '';
  }
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

export function calculateTokenSpeed(usage: TokenUsage | undefined, startedAt: number, finishedAt = Date.now()): number | undefined {
  if (!usage || usage.outputTokens <= 0) {
    return undefined;
  }

  const elapsedMs = Math.max(1, finishedAt - startedAt);
  return usage.outputTokens / (elapsedMs / 1000);
}

export function getRandomOneShotFeedbackPrompt(): string {
  const index = Math.floor(Math.random() * oneShotFeedbackPrompts.length);
  return oneShotFeedbackPrompts[index];
}

// ── Scroll Helpers ──────────────────────────────────────────────────────────

export function clampScrollOffset(selectedIndex: number, currentOffset: number, visibleCount: number, totalCount: number): number {
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

// ── Keyboard Sequence Matchers ──────────────────────────────────────────────
// All support both traditional terminal and Kitty keyboard protocol.

export function isEnter(sequence: string): boolean {
  return sequence === '\r' || sequence === '\n' || sequence === '\x1b[13u' || sequence === '\x1b[13;1u';
}

export function isEscape(sequence: string): boolean {
  return sequence === '\x1b' || sequence === '\x1b\x1b' || sequence === '\x1b[27u' || sequence === '\x1b[27;1u';
}

export function isArrowUp(sequence: string): boolean {
  return sequence === '\x1b[A' || sequence === '\x1b[Au' || sequence === '\x1b[57352u';
}

export function isArrowDown(sequence: string): boolean {
  return sequence === '\x1b[B' || sequence === '\x1b[Bu' || sequence === '\x1b[57353u';
}

export function isArrowLeft(sequence: string): boolean {
  return sequence === '\x1b[D' || sequence === '\x1b[Du' || sequence === '\x1b[57350u';
}

export function isArrowRight(sequence: string): boolean {
  return sequence === '\x1b[C' || sequence === '\x1b[Cu' || sequence === '\x1b[57351u';
}

export function isTab(sequence: string): boolean {
  return sequence === '\t' || sequence === '\x1b[Iu' || sequence === '\x1b[9u';
}

export function isShiftTab(sequence: string): boolean {
  return sequence === '\x1b[Z' || sequence === '\x1b[I;2u' || sequence === '\x1b[9;2u';
}

export function isBackspace(sequence: string): boolean {
  return sequence === '\x7f' || sequence === '\x1b[127u' || sequence === '\b';
}

export function isCtrlC(sequence: string): boolean {
  return sequence === '\x03' || sequence === '\x1b[99;5u';
}

export function isCtrlA(sequence: string): boolean {
  return sequence === '\x01' || sequence === '\x1b[1;5u' || sequence === '\x1b[97;5u';
}

export function isCtrlE(sequence: string): boolean {
  return sequence === '\x05' || sequence === '\x1b[5;5u' || sequence === '\x1b[101;5u';
}

export function isCtrlU(sequence: string): boolean {
  return sequence === '\x15' || sequence === '\x1b[21;5u' || sequence === '\x1b[117;5u';
}

export function getChar(sequence: string): string | null {
  if (sequence.length === 1) {
    return sequence;
  }
  const kittyMatch = sequence.match(/^\x1b\[(\d+)(?:;\d+)?u$/);
  if (kittyMatch) {
    return String.fromCharCode(parseInt(kittyMatch[1], 10));
  }
  return null;
}

export function isChar(sequence: string, char: string): boolean {
  const c = getChar(sequence);
  return c !== null && c === char;
}

export function isCharIgnoreCase(sequence: string, char: string): boolean {
  const c = getChar(sequence);
  return c !== null && c.toLowerCase() === char.toLowerCase();
}

export function isEscapeKey(key: KeyEvent): boolean {
  return key.name === 'escape'
    || key.name === 'esc'
    || key.sequence === '\x1b'
    || key.raw === '\x1b'
    || key.code === 'Escape'
    || key.baseCode === 27;
}
