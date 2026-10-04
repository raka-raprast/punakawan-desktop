import type { StyleRun, TextRunStyle } from './model';

/** The six character-level properties a style run can override. */
const runProps = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fill', 'letterSpacing'] as const;
type RunProp = (typeof runProps)[number];

function applyProp(span: HTMLSpanElement, key: RunProp, value: TextRunStyle[RunProp]): void {
  if (key === 'fontFamily') span.style.fontFamily = value as string;
  else if (key === 'fontWeight') span.style.fontWeight = String(value);
  else if (key === 'fontStyle') span.style.fontStyle = value as string;
  else if (key === 'fontSize') span.style.fontSize = `${value}px`;
  else if (key === 'fill') span.style.color = value as string;
  else span.style.letterSpacing = `${value}px`;
}

/** Sets a span's full resolved style, both as inline CSS (for rendering) and as a JSON data attribute (the source of truth
 * for read-back: browsers normalize inline style values on read, e.g. color always serializes back as rgb(...), which would
 * otherwise make every span look like a fill override even when it matches the shape default exactly). */
function setSpanStyle(span: HTMLSpanElement, style: TextRunStyle): void {
  for (const key of runProps) applyProp(span, key, style[key]);
  span.dataset.style = JSON.stringify(style);
}

/** Reads a span's resolved style from its data attribute, falling back to `defaults` if missing or malformed. */
function readSpanStyle(span: HTMLSpanElement, defaults: TextRunStyle): TextRunStyle {
  if (span.dataset.style) {
    try { return { ...defaults, ...(JSON.parse(span.dataset.style) as Partial<TextRunStyle>) }; }
    catch { /* malformed: fall through to defaults */ }
  }
  return defaults;
}

function diffFromDefaults(style: TextRunStyle, defaults: TextRunStyle): Partial<TextRunStyle> {
  const overrides: Partial<TextRunStyle> = {};
  for (const key of runProps) if (style[key] !== defaults[key]) (overrides as Record<RunProp, unknown>)[key] = style[key];
  return overrides;
}

/** Sets the shape-level default style on the editor root; typed text outside any span inherits it via CSS. */
export function applyRootDefaults(root: HTMLElement, defaults: TextRunStyle): void {
  root.style.fontFamily = defaults.fontFamily;
  root.style.fontWeight = String(defaults.fontWeight);
  root.style.fontStyle = defaults.fontStyle;
  root.style.fontSize = `${defaults.fontSize}px`;
  root.style.color = defaults.fill;
  root.style.letterSpacing = `${defaults.letterSpacing}px`;
}

/** Rebuilds the editor's DOM from plain text plus style runs: bare text nodes for default-styled stretches, styled spans for overrides. */
export function buildEditorContent(root: HTMLElement, text: string, styleRuns: StyleRun[], defaults: TextRunStyle): void {
  applyRootDefaults(root, defaults);
  root.replaceChildren();
  let cursor = 0;
  for (const run of [...styleRuns].sort((a, b) => a.start - b.start)) {
    if (run.start > cursor) root.appendChild(document.createTextNode(text.slice(cursor, run.start)));
    const span = document.createElement('span');
    setSpanStyle(span, { ...defaults, ...diffFromDefaults({ ...defaults, ...run } as TextRunStyle, defaults) });
    span.appendChild(document.createTextNode(text.slice(run.start, run.end)));
    root.appendChild(span);
    cursor = run.end;
  }
  if (cursor < text.length) root.appendChild(document.createTextNode(text.slice(cursor)));
}

/** Reads the editor's current DOM back into plain text plus minimal style runs (only non-default stretches). */
export function readEditorContent(root: HTMLElement, defaults: TextRunStyle): { text: string; runs: StyleRun[] } {
  let text = '';
  const runs: StyleRun[] = [];
  let pending: (StyleRun & { style: Partial<TextRunStyle> }) | null = null;
  const flush = () => {
    if (pending) { pending.end = text.length; runs.push({ start: pending.start, end: pending.end, ...pending.style }); }
    pending = null;
  };
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      flush();
      text += (child as Text).data;
    } else if (child instanceof HTMLBRElement) {
      flush();
      text += '\n';
    } else if (child instanceof HTMLSpanElement) {
      const overrides = diffFromDefaults(readSpanStyle(child, defaults), defaults);
      const segment = child.textContent ?? '';
      if (Object.keys(overrides).length === 0) {
        flush();
        text += segment;
      } else if (pending && runProps.every(key => pending!.style[key] === overrides[key])) {
        text += segment;
      } else {
        flush();
        pending = { start: text.length, end: text.length, style: overrides };
        text += segment;
      }
    }
  }
  flush();
  return { text, runs };
}

/** Resolved style across a character range, plus which properties disagree within it ("mixed", Figma-style). */
export function selectionStyleSummary(root: HTMLElement, start: number, end: number, defaults: TextRunStyle):
  TextRunStyle & { mixed: Set<RunProp> } {
  let cursor = 0;
  let result: TextRunStyle | null = null;
  const mixed = new Set<RunProp>();
  for (const child of Array.from(root.childNodes)) {
    const length = (child.textContent ?? '').length;
    const segStart = cursor;
    cursor += length;
    if (cursor <= start || segStart >= end) continue;
    const style = child instanceof HTMLSpanElement ? readSpanStyle(child, defaults) : defaults;
    if (!result) result = style;
    else for (const key of runProps) if (result[key] !== style[key]) mixed.add(key);
  }
  return { ...(result ?? defaults), mixed };
}

function textOffsetAt(root: HTMLElement, container: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  if (container.nodeType === Node.TEXT_NODE) {
    let total = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node === container) return total + offset;
      total += (node as Text).data.length;
    }
    return total;
  }
  const boundary = container.childNodes[offset] ?? null;
  let total = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (boundary && (node === boundary || boundary.contains(node))) return total;
    total += (node as Text).data.length;
  }
  return total;
}

/** The current browser selection expressed as flat character offsets into the editor's text, or null if outside root. */
export function getSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (range.commonAncestorContainer !== root && !root.contains(range.commonAncestorContainer)) return null;
  const a = textOffsetAt(root, range.startContainer, range.startOffset);
  const b = textOffsetAt(root, range.endContainer, range.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function locate(root: HTMLElement, index: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (index <= total + node.data.length) return { node, offset: index - total };
    total += node.data.length;
    last = node;
  }
  return last ? { node: last, offset: last.data.length } : { node: root, offset: 0 };
}

/** Viewport-relative rects covering a character range, for a custom highlight overlay that stays visible even when the editor isn't focused (native ::selection disappears on blur). */
export function selectionOverlayRects(root: HTMLElement, start: number, end: number): DOMRect[] {
  if (start >= end) return [];
  const a = locate(root, start);
  const b = locate(root, end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return Array.from(range.getClientRects());
}

/** Restores the browser selection to a character range within the editor (used after a style change so it stays highlighted). */
export function setSelectionOffsets(root: HTMLElement, start: number, end: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const a = locate(root, start);
  const b = locate(root, end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Inserts text at the caret (or over a selection), used for intercepted Enter/paste to avoid contentEditable's div/br structural pollution. */
export function insertTextAtCaret(root: HTMLElement, text: string): void {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (range.commonAncestorContainer !== root && !root.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const container = range.startContainer;
  const offset = range.startOffset;
  let caretNode: Text;
  if (container.nodeType === Node.TEXT_NODE) {
    (container as Text).insertData(offset, text);
    caretNode = container as Text;
  } else {
    caretNode = document.createTextNode(text);
    if (container.childNodes[offset]) container.insertBefore(caretNode, container.childNodes[offset]);
    else container.appendChild(caretNode);
  }
  const after = document.createRange();
  after.setStart(caretNode, (container.nodeType === Node.TEXT_NODE ? offset : 0) + text.length);
  after.collapse(true);
  selection.removeAllRanges();
  selection.addRange(after);
}

function wrapBareTextChildren(root: HTMLElement, defaults: TextRunStyle): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== Node.TEXT_NODE) continue;
    const span = document.createElement('span');
    setSpanStyle(span, defaults);
    root.insertBefore(span, child);
    span.appendChild(child);
  }
}

/** Splits the text node's span at `offset`, returning the span ending exactly there and the span starting exactly there. */
function boundarySpans(node: Text, offset: number): { endingHere: HTMLSpanElement; startingHere: HTMLSpanElement } {
  const span = node.parentElement as HTMLSpanElement;
  if (offset === 0) return { endingHere: (span.previousElementSibling as HTMLSpanElement) ?? span, startingHere: span };
  if (offset === node.data.length) return { endingHere: span, startingHere: (span.nextElementSibling as HTMLSpanElement) ?? span };
  const tail = node.splitText(offset);
  const after = span.cloneNode(false) as HTMLSpanElement;
  span.after(after);
  after.appendChild(tail);
  return { endingHere: span, startingHere: after };
}

function mergeAdjacentSpans(root: HTMLElement): void {
  let span = root.firstElementChild as HTMLSpanElement | null;
  while (span) {
    const next = span.nextElementSibling as HTMLSpanElement | null;
    if (next instanceof HTMLSpanElement && span.dataset.style === next.dataset.style) {
      (span.firstChild as Text).appendData(next.textContent ?? '');
      next.remove();
      continue;
    }
    span = next;
  }
}

/** Applies a partial style patch to exactly the [start, end) character range, splitting/merging spans as needed, and restores the selection. */
export function applyRunStyle(root: HTMLElement, start: number, end: number, patch: Partial<TextRunStyle>, defaults: TextRunStyle): void {
  if (start >= end) return;
  wrapBareTextChildren(root, defaults);
  const startPos = locate(root, start);
  const endPos = locate(root, end);
  let first: HTMLSpanElement;
  let last: HTMLSpanElement;
  if (startPos.node === endPos.node) {
    const { startingHere } = boundarySpans(startPos.node as Text, startPos.offset);
    const localEnd = endPos.offset - startPos.offset;
    const { endingHere } = boundarySpans(startingHere.firstChild as Text, localEnd);
    first = endingHere;
    last = endingHere;
  } else {
    first = boundarySpans(startPos.node as Text, startPos.offset).startingHere;
    last = boundarySpans(endPos.node as Text, endPos.offset).endingHere;
  }
  for (let node: Element | null = first; node; node = node.nextElementSibling) {
    if (node instanceof HTMLSpanElement) setSpanStyle(node, { ...readSpanStyle(node, defaults), ...patch });
    if (node === last) break;
  }
  mergeAdjacentSpans(root);
  setSelectionOffsets(root, start, end);
}
