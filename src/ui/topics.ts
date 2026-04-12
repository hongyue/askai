/**
 * Topic browser: floating modal that lists user messages for quick navigation.
 */

import { stringToStyledText } from "@opentui/core";
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
  topicsModalText: MutableTextNode;
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
    this.render();
  }

  close(): void {
    this.host.state.open = false;
    this.host.state.keyword = '';
    this.host.state.filter = { value: '', cursorOffset: 0 };
    this.host.state.selectedIndex = 0;
    this.host.topicsModalNode.visible = false;
    this.host.root.requestRender();
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

    const lines: string[] = [];

    // Title + filter
    const titleText = this.host.state.keyword
      ? `Topics: "${this.host.state.keyword}"  (type to filter, ↑↓ jump, Enter select, Esc close)`
      : `Topics: all user messages  (type to filter, ↑↓ jump, Enter select, Esc close)`;
    lines.push(titleText);
    lines.push('');

    // Filter input
    const filterCursor = Math.max(0, Math.min(this.host.state.filter.cursorOffset, this.host.state.filter.value.length));
    const filterVal = this.host.state.filter.value;
    if (filterVal.length > 0) {
      if (filterCursor < filterVal.length) {
        lines.push(` > ${filterVal.slice(0, filterCursor)}${filterVal[filterCursor]}${filterVal.slice(filterCursor + 1)}`);
      } else {
        lines.push(` > ${filterVal} `);
      }
    } else {
      lines.push(' > (type to filter)');
    }
    if (allTopics.length > TOPICS_VISIBLE_COUNT) {
      lines.push(`  ${allTopics.length} topics  (${scrollOffset + 1}-${Math.min(scrollOffset + TOPICS_VISIBLE_COUNT, allTopics.length)})`);
    }
    lines.push('');

    // Topic list
    items.forEach((topic, visibleIdx) => {
      const actualIdx = scrollOffset + visibleIdx;
      const isSelected = actualIdx === this.host.state.selectedIndex;
      const marker = isSelected ? '[>] ' : '    ';
      lines.push(`${marker}${topic.snippet}`);
    });

    if (allTopics.length === 0) {
      const totalMessages = this.host.messages.length;
      const userMessages = this.host.messages.filter(m => m.role === 'user').length;
      lines.push(`  No user topics found (${userMessages} user messages in ${totalMessages} total)`);
      lines.push('');
    }

    const text = lines.join('\n');

    this.host.topicsModalText.content = stringToStyledText(text);
    this.host.topicsModalNode.visible = true;
    this.host.root.requestRender();
  }

  updateFilterValue(delta: number): void {
    this.host.state.filter.cursorOffset = Math.max(0, this.host.state.filter.cursorOffset + delta);
    this.recomputeFilter();
    this.render();
  }

  insertFilterChar(char: string): void {
    const f = this.host.state.filter;
    const offset = Math.max(0, Math.min(f.cursorOffset, f.value.length));
    f.value = f.value.slice(0, offset) + char + f.value.slice(offset);
    f.cursorOffset = offset + 1;
    this.recomputeFilter();
    this.render();
  }

  deleteFilterChar(): void {
    const f = this.host.state.filter;
    if (f.cursorOffset > 0) {
      f.value = f.value.slice(0, f.cursorOffset - 1) + f.value.slice(f.cursorOffset);
      f.cursorOffset = f.cursorOffset - 1;
      this.recomputeFilter();
      this.render();
    }
  }

  private recomputeFilter(): void {
    const allTopics = this.getTopics();
    this.host.state.selectedIndex = Math.max(0, Math.min(this.host.state.selectedIndex, allTopics.length - 1));
    this.host.state.scrollOffset = 0;
  }
}
