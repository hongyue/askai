/**
 * Command palette management for TUIApp.
 *
 * Extracted from TUIApp to separate palette rendering, opening, closing,
 * and input reset logic from the main class.
 */

import { StyledText, fg, stringToStyledText } from "@opentui/core";
import type { Command } from "../commands";
import type { MutableBoxNode, MutableTextNode, MutableInputNode } from "./tui-types";

interface PaletteState {
  open: boolean;
  query: string;
  selectedIndex: number;
  matches: Command[];
}

export interface IPaletteHost {
  getPalette(): PaletteState;
  setPalette(state: PaletteState): void;
  commands: readonly Command[];
  cmdListBoxNode: MutableBoxNode;
  cmdListTextNode: MutableTextNode;
  inputNode: MutableInputNode;
  inputBuffer: string;
  setInputBuffer(value: string): void;
  updateFooterLayout(): void;
  root: { requestRender(): void };
}

export class PaletteManager {
  constructor(private host: IPaletteHost) {}

  render(): void {
    const palette = this.host.getPalette();
    this.host.cmdListBoxNode.visible = palette.open;
    this.host.updateFooterLayout();
    if (!palette.open) {
      this.host.cmdListTextNode.content = stringToStyledText('');
      this.host.root.requestRender();
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
    this.host.cmdListTextNode.content = new StyledText(chunks);
    this.host.root.requestRender();
  }

  close(): void {
    this.host.setPalette({
      open: false,
      query: '',
      selectedIndex: 0,
      matches: [...this.host.commands],
    });
    this.render();
  }

  open(query: string): void {
    const normalized = query.toLowerCase();
    const matches = query
      ? this.host.commands.filter(command =>
        command.name.toLowerCase().includes(normalized)
      )
      : [...this.host.commands];

    if (matches.length === 0) {
      this.close();
      return;
    }

    const palette = this.host.getPalette();
    const selectedIndex = Math.min(palette.selectedIndex, matches.length - 1);
    this.host.setPalette({
      open: true,
      query,
      selectedIndex: Math.max(0, selectedIndex),
      matches,
    });
    this.render();
  }

  clearInput(): void {
    this.host.inputNode.setText('');
    this.host.setInputBuffer('');
    this.close();
    this.host.inputNode.focus();
  }
}
