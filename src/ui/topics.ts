/**
 * Topic browser: floating modal that lists user messages for quick navigation.
 */

import { stringToStyledText, StyledText, fg, white, bgWhite, black } from "@opentui/core";
import type { Message } from "../providers/base";
import type { MutableTextNode, MutableBoxNode } from "./tui-types";

// ── State ────────────────────────────────────────────────────────────────────

export interface TopicFilterState {
  value: string;
  cursorOffset: number;
}

export interface TopicBrowserState {
  open: boolean;
  keyword: string;
  filter: TopicFilterState;
  selectedIndex: number;
  scrollOffset: number;
}

export function createTopicBrowserState(): TopicBrowserState {
  return {
    open: false,
    keyword: '',
    filter: { value: '', cursorOffset: 0 },
    selectedIndex: 0,
    scrollOffset: 0,
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

interface TopicEntry {
  msgIndex: number;
  content: string;
  snippet: string;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\].*?\x07/g, '').replace(/\r\n/g, '\n');
}

function extractUserTopics(messages: Message[]): TopicEntry[] {
  const topics: TopicEntry[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      const raw = m.content || '';
      const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const clean = stripAnsi(content);
      const lineBreak = clean.indexOf('\n');
      const snippet = lineBreak > 0
        ? clean.slice(0, Math.min(lineBreak, 70))
        : clean.slice(0, 70);
      topics.push({ msgIndex: i, content: clean, snippet });
    }
  }
  return topics;
}

export function filterTopics(topics: TopicEntry[], filter: string): TopicEntry[] {
  if (!filter.trim()) return topics;
  const f = filter.toLowerCase();
  return topics.filter(t => t.content.toLowerCase().includes(f));
}

function formatFilterValue(value: string, cursorOffset: number): any[] {
  if (value.length === 0) {
    return [white('(type to filter)')];
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

export function getVisibleTopics(topics: TopicEntry[], selectedIndex: number, scrollOffset: number, visibleCount: number): { items: TopicEntry[]; scrollOffset: number } {
  let offset = scrollOffset;
  if (selectedIndex < offset) offset = selectedIndex;
  else if (selectedIndex >= offset + visibleCount) offset = selectedIndex - visibleCount + 1;
  const maxOffset = Math.max(0, topics.length - visibleCount);
  offset = Math.max(0, Math.min(offset, maxOffset));
  return { items: topics.slice(offset, offset + visibleCount), scrollOffset: offset };
}

// ── Host interface ───────────────────────────────────────────────────────────

export interface ITopicBrowserHost {
  state: TopicBrowserState;
  messages: Message[];
  chatNodeIds: string[];
  chatNode: { scrollChildIntoView?(childId: string): void };
  root: { requestRender(): void };
  topicsModalNode: MutableBoxNode;
  topicsModalHeader: MutableTextNode;
  topicsModalScroll: MutableBoxNode;
  topicsModalText: MutableTextNode;
  inputNode: { blur?(): void; focus?(): void };
}

// ── Manager ──────────────────────────────────────────────────────────────────

const TOPICS_VISIBLE_COUNT = 12;

export class TopicBrowserManager {
  constructor(private host: ITopicBrowserHost) {}

  get state(): TopicBrowserState { return this.host.state; }

  open(keyword: string): void {
    this.host.state.keyword = keyword;
    this.host.state.filter = { value: '', cursorOffset: 0 };
    this.host.state.selectedIndex = 0;
    this.host.state.scrollOffset = 0;
    this.host.state.open = true;
    const allTopics = this.getTopics();
    this.host.state.selectedIndex = Math.max(0, allTopics.length - 1); // start at most recent
    this.host.inputNode.blur?.();
    this.render();
  }

  close(): void {
    this.host.state.open = false;
    this.host.state.keyword = '';
    this.host.state.filter = { value: '', cursorOffset: 0 };
    this.host.state.selectedIndex = 0;
    this.host.topicsModalNode.visible = false;
    this.host.root.requestRender();
    this.host.inputNode.focus?.();
  }

  navigateUp(): void {
    const allTopics = this.getTopics();
    if (allTopics.length === 0) return;
    this.host.state.selectedIndex = Math.max(0, this.host.state.selectedIndex - 1);
    this.host.state.scrollOffset = this.getScrollOffset();
    this.render();
  }

  navigateDown(): void {
    const allTopics = this.getTopics();
    if (allTopics.length === 0) return;
    this.host.state.selectedIndex = Math.min(allTopics.length - 1, this.host.state.selectedIndex + 1);
    this.host.state.scrollOffset = this.getScrollOffset();
    this.render();
  }

  pageUp(): void {
    const allTopics = this.getTopics();
    if (allTopics.length === 0) return;
    this.host.state.selectedIndex = Math.max(0, this.host.state.selectedIndex - TOPICS_VISIBLE_COUNT);
    this.host.state.scrollOffset = this.getScrollOffset();
    this.render();
  }

  pageDown(): void {
    const allTopics = this.getTopics();
    if (allTopics.length === 0) return;
    this.host.state.selectedIndex = Math.min(allTopics.length - 1, this.host.state.selectedIndex + TOPICS_VISIBLE_COUNT);
    this.host.state.scrollOffset = this.getScrollOffset();
    this.render();
  }

  selectAndJump(): void {
    this.jumpToSelected();
    this.close();
  }

  private getTopics(): TopicEntry[] {
    const all = extractUserTopics(this.host.messages);
    return filterTopics(all, this.host.state.filter.value);
  }

  private getScrollOffset(): number {
    const topics = this.getTopics();
    const { scrollOffset } = getVisibleTopics(topics, this.host.state.selectedIndex, this.host.state.scrollOffset, TOPICS_VISIBLE_COUNT);
    return scrollOffset;
  }

  private jumpToSelected(): void {
    const topics = this.getTopics();
    const topic = topics[this.host.state.selectedIndex];
    if (!topic) return;
    const nodeId = this.host.chatNodeIds[topic.msgIndex];
    if (!nodeId) return;
    this.host.chatNode.scrollChildIntoView?.(nodeId);
  }

  render(): void {
    if (!this.host.state.open) {
      this.host.topicsModalNode.visible = false;
      this.host.root.requestRender();
      return;
    }

    const allTopics = this.getTopics();
    const { items, scrollOffset } = getVisibleTopics(allTopics, this.host.state.selectedIndex, this.host.state.scrollOffset, TOPICS_VISIBLE_COUNT);
    this.host.state.scrollOffset = scrollOffset;

    // Header: title
    const titleText = this.host.state.keyword
      ? `Topics: "${this.host.state.keyword}"  (type to filter, ↑↓ jump, Enter select, Esc close)`
      : `Topics: all user messages  (type to filter, ↑↓ jump, Enter select, Esc close)`;
    this.host.topicsModalHeader.content = stringToStyledText(titleText);

    // Filter input with proper cursor rendering (same as model modal)
    const filterChunks = formatFilterValue(this.host.state.filter.value, this.host.state.filter.cursorOffset);
    const filterContent = [white('Filter  '), ...filterChunks];
    if (allTopics.length > TOPICS_VISIBLE_COUNT) {
      filterContent.push(white(`  (${allTopics.length} topics, ${scrollOffset + 1}-${Math.min(scrollOffset + TOPICS_VISIBLE_COUNT, allTopics.length)})`));
    }
    this.host.topicsModalHeader.content = new StyledText(filterContent);

    // Scrollable body: all topics
    const bodyLines: string[] = [];
    if (allTopics.length === 0) {
      const totalMessages = this.host.messages.length;
      const userMessages = this.host.messages.filter(m => m.role === 'user').length;
      bodyLines.push(`  No user topics found (${userMessages} user messages in ${totalMessages} total)`);
    } else {
      items.forEach((topic, visibleIdx) => {
        const actualIdx = scrollOffset + visibleIdx;
        const isSelected = actualIdx === this.host.state.selectedIndex;
        const marker = isSelected ? '[>] ' : '    ';
        bodyLines.push(`${marker}${topic.snippet}`);
      });
    }
    this.host.topicsModalText.content = stringToStyledText(bodyLines.join('\n'));
    this.host.topicsModalNode.visible = true;
    this.host.root.requestRender();
  }

  updateFilterValue(delta: number): void {
    this.host.state.filter.cursorOffset = Math.max(0, Math.min(this.host.state.filter.cursorOffset + delta, this.host.state.filter.value.length));
    this.recomputeFilter();
    this.render();
  }

  insertFilterText(text: string): void {
    const f = this.host.state.filter;
    const offset = Math.max(0, Math.min(f.cursorOffset, f.value.length));
    f.value = f.value.slice(0, offset) + text + f.value.slice(offset);
    f.cursorOffset = offset + text.length;
    this.recomputeFilter();
    this.render();
  }

  deleteFilterText(): void {
    const f = this.host.state.filter;
    if (f.cursorOffset <= 0) return;
    f.value = f.value.slice(0, f.cursorOffset - 1) + f.value.slice(f.cursorOffset);
    f.cursorOffset = f.cursorOffset - 1;
    this.recomputeFilter();
    this.render();
  }

  insertFilterPaste(text: string): void {
    const normalizedText = text
      .replace(/\r\n/g, '\n')
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
      .replace(/\n/g, ' ');
    if (!normalizedText) return;
    this.insertFilterText(normalizedText);
  }

  private recomputeFilter(): void {
    const allTopics = this.getTopics();
    this.host.state.selectedIndex = Math.max(0, Math.min(this.host.state.selectedIndex, allTopics.length - 1));
    this.host.state.scrollOffset = 0;
  }
}
