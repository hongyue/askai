export interface MutableTextNode {
  content: ReturnType<typeof import("@opentui/core").stringToStyledText>;
}

export interface MutableBoxNode {
  x?: number;
  y?: number;
  width?: number;
  height?: number | 'auto' | `${number}%`;
  visible: boolean;
  add(obj: unknown, index?: number): number;
  remove(id: string): void;
  requestRender(): void;
  onMouseDown?: ((event: { x: number; y: number }) => void) | undefined;
  onMouseUp?: ((event: { x: number; y: number }) => void) | undefined;
  onMouseDragEnd?: ((event: { x: number; y: number }) => void) | undefined;
  onMouseScroll?: ((event: { scroll?: { direction?: string; delta?: number } }) => void) | undefined;
  // ScrollBox methods (available when the node is a ScrollBox)
  scrollTo?(position: number | { x: number; y: number }): void;
  scrollChildIntoView?(childId: string): void;
  scrollBy?(delta: number | { x: number; y: number }): void;
  findDescendantById?(id: string): { x?: number; y?: number; height?: number } | null;
  scrollTop?: number;
  viewport?: { x?: number; y?: number; height?: number; width?: number };
}

export interface MutableInputNode {
  plainText: string;
  cursorOffset?: number;
  setText(text: string): void;
  insertText(text: string): void;
  focus(): void;
  blur?: () => void;
  onContentChange?: (() => void) | undefined;
  onSubmit?: (() => void) | undefined;
}
