import { useEffect, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, ArrowUpRight, Blend, Check, ChevronDown, ChevronRight, Circle, Combine, Copy, Download, Ellipsis,
  Eye, EyeOff, FilePlus2, FlipHorizontal2, FlipVertical2, FolderOpen, Frame, Hand, ImagePlus, Layers2, Layers3, ListFilter, Lock, LockOpen, Maximize2, Minus, MousePointer2, Plus,
  RectangleHorizontal, Redo2, RotateCcw, RotateCw, Save, Settings2, Slash, Spline, SquareMinus, Star, Trash2, Triangle, Type as TypeIcon,
  Undo2, Ungroup, X, Aperture, Grid3x3, Grip, Sparkles, Square, SquareDashedBottom, Waves,
} from 'lucide-react';
import {
  deleteRecovery, importAsset, listFonts, listRecovery, loadAppState, pickAsset, pickExport,
  pickOpenFile, pickSaveFile, readDesign, recordRecent, savePreferences, saveRecovery,
  writeDesign, writeExport, pickExportFolder,
} from './bridge';
import { booleanShape, canBooleanShape, recomputeBooleanGroups, type BooleanOperation } from './boolean';
import { angleBetween, center, drawBounds, fitCamera, normalizeAngle, rotatedBounds, rotateVector, snapAngle, snapDrawBounds, snapResizeBounds, worldAt, zoomAt } from './geometry';
import type { Bounds, Camera, Handle, Point } from './geometry';
import { exportBase64, pageBounds } from './editor';
import { newDocument, newPage, parseDesign } from './model';
import type { DesignFile, DesignPage, Effect, ExportFormat, ExportSetting, FontFamily, Preferences, RecoveryEntry, Session, Shape, StyleRun, TextRunStyle } from './model';
import { isClosedTextPathHost, isTextPathHost, pathForShape, resolveTextStyle, roundedRectPath, shapeTransform, textHeight, textLineMetrics, textPathComputedLength, textPathForShape, textPathRibbon, textPathSegments, textSize } from './shapes';
import { backdropLayer, effectsFilter, exportFileNames, newEffect, strokeOverlay, supportsStrokePosition, visibleStroke } from './appearance';
import type { TextSegment } from './shapes';
import {
  applyRunStyle, buildEditorContent, getSelectionOffsets, insertTextAtCaret, readEditorContent,
  selectionOverlayRects, selectionStyleSummary, setSelectionOffsets,
} from './richtext';

type HistoryEntry = { document: DesignFile; pageId: string; selectedIds: string[] };
type Workspace = {
  key: string;
  session: Session;
  pageId: string;
  selectedIds: string[];
  camera: Camera;
  cameraReady: boolean;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  recoveryId: string;
  queue: Promise<void>;
  recoveryTimer?: number;
  autosaveTimer?: number;
  savePicker?: Promise<string | null>;
};
type DrawingTool = Exclude<Shape['type'], 'image' | 'vector' | 'boolean'>;
type Tool = 'select' | 'hand' | 'textPath' | DrawingTool;
type Modal = { kind: 'preferences' } | { kind: 'recovery' } | { kind: 'export' } |
  { kind: 'close'; key: string } | null;
type Drag = { kind: 'pan'; workspace: Workspace; start: Point; camera: Camera } |
  { kind: 'move'; workspace: Workspace; before: HistoryEntry; start: Point; shapes: { shape: Shape; bounds: Bounds }[] } |
  { kind: 'resize'; workspace: Workspace; before: HistoryEntry; start: Point; bounds: Bounds; handle: Handle; shapes: { shape: Shape; bounds: Bounds; textSizing: Shape['textSizing'] }[] } |
  { kind: 'path-offset'; workspace: Workspace; before: HistoryEntry; start: Point; shape: Shape; host: Shape; offset: number } |
  { kind: 'marquee'; workspace: Workspace; start: Point; end: Point; additive: boolean } |
  { kind: 'rotate'; workspace: Workspace; before: HistoryEntry; shape: Shape; center: Point; startAngle: number; startRotation: number; descendants: { shape: Shape; bounds: Bounds; rotation: number }[] } |
  { kind: 'draw'; workspace: Workspace; type: DrawingTool; start: Point; end: Point; fine: boolean };
type ContextMenu = { x: number; y: number; world: Point; layer?: boolean };
type InlineRename = { workspaceKey: string; shapeId: string; value: string; surface: 'layer' | 'canvas' };
type TextEdit = { workspaceKey: string; pageId: string; shapeId: string; value: string; runs: StyleRun[];
  selection: { start: number; end: number } | null; before: HistoryEntry; isNew: boolean };
type RecoverySnapshot = { document: DesignFile; path: string | null; revision: number };

const defaults: Preferences = { theme: 'system', autosave: true, shortcuts: {} };
const bindings: Record<string, string> = {
  new: 'Mod+N', open: 'Mod+O', save: 'Mod+S', saveAs: 'Mod+Shift+S',
  export: 'Mod+Shift+E', select: 'V', hand: 'H', frame: 'F', rect: 'R', line: 'L',
  arrow: 'Shift+L', ellipse: 'O', polygon: 'P', star: 'Shift+S', text: 'T', textPath: 'Shift+T',
  union: 'Alt+Shift+U', subtract: 'Alt+Shift+S', intersect: 'Alt+Shift+I',
  exclude: 'Alt+Shift+E', flatten: 'Alt+Shift+F', ungroup: 'Mod+Shift+G',
  hide: 'Mod+Shift+H', lock: 'Mod+Shift+L', flipH: 'Shift+H', flipV: 'Shift+V', rotate90: 'Alt+Shift+R',
};
const actions = [
  ['new', 'New design'], ['open', 'Open design'], ['save', 'Save'], ['saveAs', 'Save as'],
  ['export', 'Export'], ['select', 'Select tool'], ['hand', 'Hand tool'], ['frame', 'Frame tool'],
  ['rect', 'Rectangle tool'], ['line', 'Line tool'], ['arrow', 'Arrow tool'], ['ellipse', 'Ellipse tool'],
  ['polygon', 'Polygon tool'], ['star', 'Star tool'], ['text', 'Text tool'], ['textPath', 'Text on path tool'],
  ['union', 'Union selection'], ['subtract', 'Subtract selection'], ['intersect', 'Intersect selection'],
  ['exclude', 'Exclude selection'], ['flatten', 'Flatten selection'], ['ungroup', 'Ungroup selection'],
  ['hide', 'Show/Hide selection'], ['lock', 'Lock/Unlock selection'], ['flipH', 'Flip horizontal'],
  ['flipV', 'Flip vertical'], ['rotate90', 'Rotate 90°'],
] as const;
const shapeChoices = [
  ['rect', RectangleHorizontal, 'Rectangle'], ['line', Slash, 'Line'], ['arrow', ArrowUpRight, 'Arrow'],
  ['ellipse', Circle, 'Ellipse'], ['polygon', Triangle, 'Polygon'], ['star', Star, 'Star'],
] as const;
const textChoices = [
  ['text', TypeIcon, 'Text'],
  ['textPath', Spline, 'Text on path'],
] as const;
const booleanChoices = [
  ['union', Combine, 'Union', 'U'], ['subtract', SquareMinus, 'Subtract', 'S'],
  ['intersect', Layers2, 'Intersect', 'I'], ['exclude', Blend, 'Exclude', 'E'],
  ['flatten', ListFilter, 'Flatten', 'F'],
] as const;
const zeroCorners: [number, number, number, number] = [0, 0, 0, 0];
const cornerLabels = [['Top left', 0], ['Top right', 1], ['Bottom right', 2], ['Bottom left', 3]] as const;
const textAlignChoices = [['left', AlignLeft, 'Align left'], ['center', AlignCenter, 'Align center'],
  ['right', AlignRight, 'Align right']] as const;
const genericFonts: FontFamily[] = ['sans-serif', 'serif', 'monospace'].map(family => ({
  family, styles: [
    { label: 'Regular', weight: 400, style: 'normal' },
    { label: 'Italic', weight: 400, style: 'italic' },
    { label: 'Bold', weight: 700, style: 'normal' },
    { label: 'Bold Italic', weight: 700, style: 'italic' },
  ],
}));
const reserved: Record<string, true> = {
  'Mod+Q': true, 'Mod+W': true, 'Mod+R': true, 'Mod+Tab': true, 'Mod+Space': true,
  'Mod+Shift+I': true, 'Mod+Shift+C': true, 'Mod+Alt+I': true, 'Mod+0': true,
  'Mod+-': true, 'Mod+=': true, 'Mod+Alt+D': true, 'Mod+Alt+Q': true,
};
function shortcutAllowed(combo: string): boolean {
  if (reserved[combo]) return false;
  return Object.values(bindings).includes(combo) || /^(Shift\+)?[A-Z]$/.test(combo) ||
    /^Mod\+(Shift\+)?[A-Z]$/.test(combo) || /^Mod\+Alt\+(Shift\+)?[A-Z]$/.test(combo) || /^Alt\+Shift\+[A-Z]$/.test(combo);
}
const basename = (path: string) => path.split(/[\\/]/).pop() || path;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const isEditable = (target: EventTarget | null) => target instanceof HTMLElement &&
  !!target.closest('input, textarea, select, [contenteditable="true"]');

function keyCombo(event: KeyboardEvent | ReactKeyboardEvent): string | null {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (event.getModifierState('AltGraph') || (mac && event.ctrlKey) ||
    (!mac && event.metaKey) || (event.altKey && !mod && !event.shiftKey)) return null;
  const raw = event.altKey && event.code.startsWith('Key')
    ? event.code.slice(3) : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (!/^[A-Z0-9,.-]$/.test(raw)) return null;
  return [mod ? 'Mod' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', raw]
    .filter(Boolean).join('+');
}

function recoveryValue(entry: RecoveryEntry): RecoverySnapshot | null {
  try {
    const value: unknown = JSON.parse(entry.content);
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<RecoverySnapshot>;
    const document = parseDesign(JSON.stringify(candidate.document));
    if ((candidate.path !== null && typeof candidate.path !== 'string') ||
      typeof candidate.revision !== 'number' || !Number.isFinite(candidate.revision)) return null;
    return { document, path: candidate.path, revision: candidate.revision };
  } catch { return null; }
}
function effectView(shape: Shape, node: ReactNode, host?: Shape) {
  const effect = effectsFilter(shape, shape.id, host);
  if (!effect) return node;
  return <g><defs dangerouslySetInnerHTML={{ __html: effect.markup }}/><g filter={`url(#${effect.id})`}>{node}</g></g>;
}
/** Background blur / Glass: the artwork behind `shape`, blurred and clipped to its outline. */
function backdropView(shape: Shape, below: Shape[]) {
  const layer = backdropLayer(shape, shape.id);
  if (!layer || !below.length) return null;
  return <g key={`backdrop-${shape.id}`} pointerEvents="none" clipPath={layer.clip}>
    <defs dangerouslySetInnerHTML={{ __html: layer.defs }}/>
    <g filter={layer.filter} transform={layer.transform}>
      {below.map(entry => <g key={entry.id} transform={shapeTransform(entry)}>{effectView(entry, shapeView(entry))}</g>)}
    </g>
  </g>;
}
function shapeView(shape: Shape, preview = false, host?: Shape) {
  const common = { key: shape.id, 'data-shape-id': shape.id, opacity: shape.opacity ?? 1 };
  const fill = preview ? 'none' : shape.fill;
  const stroke = preview ? null : visibleStroke(shape);
  const overlay = preview ? null : strokeOverlay(shape, shape.id);
  const border = preview ? { stroke: '#3b5ee8', strokeWidth: shape.strokeWidth ?? 1, strokeLinejoin: 'round' as const }
    : stroke && !overlay
      ? { stroke: stroke.color, strokeWidth: stroke.width, strokeOpacity: stroke.opacity, strokeLinejoin: 'round' as const }
      : { stroke: shape.type === 'frame' && shape.stroke === undefined ? 'var(--rule)' : 'none',
        strokeWidth: shape.strokeWidth ?? 1, strokeLinejoin: 'round' as const };
  // Inside/outside strokes are painted by a clipped overlay, so the shape itself then carries no stroke.
  const own = overlay ? { key: shape.id } : common;
  const wrap = (node: ReactElement) => overlay
    ? <g {...common}>{node}<g pointerEvents="none" dangerouslySetInnerHTML={{ __html: overlay }}/></g> : node;
  if (shape.type === 'frame' || shape.type === 'rect') return wrap(<path {...own}
    className={preview ? `drawing-outline${shape.type === 'frame' ? ' frame-draft' : ''}` : shape.type === 'frame' ? 'frame-shape' : undefined}
    d={roundedRectPath(shape)} fill={fill} {...border}/>);
  if (shape.type === 'ellipse') return wrap(<ellipse {...own} className={preview ? 'drawing-outline' : undefined}
    cx={shape.x + shape.width / 2} cy={shape.y + shape.height / 2}
    rx={shape.width / 2} ry={shape.height / 2} fill={fill} {...border}/>);
  if (shape.type === 'line' || shape.type === 'arrow') return <path {...common}
    className={preview ? 'drawing-outline path-draft' : undefined} d={pathForShape(shape)}
    fill="none" stroke={shape.fill} strokeWidth={shape.strokeWidth ?? 2} strokeLinecap="round" strokeLinejoin="round"/>;
  if (shape.type === 'polygon' || shape.type === 'star') return wrap(<path {...own}
    className={preview ? 'drawing-outline' : undefined} d={pathForShape(shape)} fill={fill} {...border}/>);
  if (shape.type === 'vector' || shape.type === 'boolean') return wrap(<path {...own} d={shape.pathData}
    transform={`translate(${shape.x} ${shape.y}) scale(${shape.width} ${shape.height})`}
    fill={fill} fillRule="evenodd" {...border} vectorEffect="non-scaling-stroke"/>);
  if (shape.type === 'image') {
    const clipId = `image-clip-${shape.id}`;
    return <g {...common} clipPath={`url(#${clipId})`}>
      <defs><clipPath id={clipId} clipPathUnits="userSpaceOnUse"><path d={roundedRectPath(shape)}/></clipPath></defs>
      <image x={shape.x} y={shape.y} width={shape.width} height={shape.height}
        href={shape.src} preserveAspectRatio="xMidYMid slice"/>
      {stroke && <path d={roundedRectPath(shape)} fill="none" stroke={stroke.color} strokeOpacity={stroke.opacity}
        strokeWidth={stroke.width} strokeLinejoin="round"/>}
    </g>;
  }
  if (preview) return <rect {...common} className="drawing-outline" x={shape.x} y={shape.y}
    width={shape.width} height={shape.height} fill="none"/>;
  if (shape.textPathId && host) return <text {...common} fill={shape.fill}
    stroke={visibleStroke(shape)?.color ?? 'none'} strokeWidth={shape.strokeWidth ?? 1} strokeOpacity={shape.strokeOpacity} paintOrder="stroke" xmlSpace="preserve">
    <textPath href={`#text-path-${shape.id}`} xlinkHref={`#text-path-${shape.id}`} startOffset={host && isClosedTextPathHost(host) ? `${((shape.textPathOffset ?? 0) / 2)}%` : `${shape.textPathOffset ?? 0}%`}>
      {textPathSegments(shape, host).map((segment, index) => <tspan key={index}
        fontFamily={segment.style.fontFamily} fontSize={segment.style.fontSize}
        fontWeight={segment.style.fontWeight} fontStyle={segment.style.fontStyle}
        fill={segment.style.fill} letterSpacing={segment.style.letterSpacing}>{segment.text}</tspan>)}
    </textPath>
  </text>;
  if (!shape.text) return null;
  const align = shape.textAlign ?? 'left';
  const anchorX = align === 'center' ? shape.x + shape.width / 2 : align === 'right' ? shape.x + shape.width : shape.x;
  const autoWidth = shape.textSizing === 'auto-width';
  let lineTop = 0;
  return <text {...common} fill={shape.fill}
    stroke={visibleStroke(shape)?.color ?? 'none'} strokeWidth={shape.strokeWidth ?? 1} strokeOpacity={shape.strokeOpacity} paintOrder="stroke"
    textAnchor={align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'} xmlSpace="preserve">
    {textLineMetrics(shape).map((line, index) => {
      const y = shape.y + lineTop + line.baseline;
      lineTop += line.height;
      return visibleLineSegments(line.segments, autoWidth).map((segment, segIndex) =>
        <tspan key={`${index}-${segIndex}`} {...(segIndex === 0 ? { x: anchorX, y } : {})}
          fontFamily={segment.style.fontFamily} fontSize={segment.style.fontSize}
          fontWeight={segment.style.fontWeight} fontStyle={segment.style.fontStyle}
          fill={segment.style.fill} letterSpacing={segment.style.letterSpacing}>
          {segment.text}
        </tspan>);
    })}
  </text>;
}

/** Drops a line's trailing hanging whitespace (matching CSS pre-wrap) unless the whole line is blank, in which case it keeps one space so the line still occupies its row. */
function visibleLineSegments(segments: TextSegment[], autoWidth: boolean): { text: string; style: TextRunStyle }[] {
  if (autoWidth || !segments.length) return segments;
  const last = segments[segments.length - 1];
  const trimmed = last.text.replace(/[ \t]+$/, '');
  const withTrim = trimmed === last.text ? segments : [...segments.slice(0, -1), { ...last, text: trimmed }];
  const nonEmpty = withTrim.filter(segment => segment.text.length > 0);
  return nonEmpty.length ? nonEmpty : [{ style: last.style, text: ' ' }];
}

/** Shape-level defaults with no per-character override applied, used to seed/compare the rich text editor's spans. */
function shapeDefaults(shape: Shape): TextRunStyle {
  return resolveTextStyle(shape, shape.text?.length ?? 0);
}

function textOnPathColor(host: Shape): string {
  if (host.type === 'line' || host.type === 'arrow') return host.fill;
  const hex = /^#([\da-f]{6})$/i.exec(host.fill);
  if (!hex) return '#202b43';
  const color = Number.parseInt(hex[1], 16);
  const brightness = ((color >> 16) & 255) * .2126 + ((color >> 8) & 255) * .7152 +
    (color & 255) * .0722;
  return brightness < 150 ? '#ffffff' : '#202b43';
}

function boundsFor(shapes: Shape[]): Bounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const shape of shapes) {
    left = Math.min(left, shape.x);
    top = Math.min(top, shape.y);
    right = Math.max(right, shape.x + shape.width);
    bottom = Math.max(bottom, shape.y + shape.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function visualBoundsFor(shapes: Shape[], pageShapes: Shape[]): Bounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const shape of shapes) {
    const host = shape.textPathId ? pageShapes.find(entry => entry.id === shape.textPathId) : undefined;
    let box: Bounds = host ?? shape;
    if (host) {
      let padding = shape.fontSize ?? 36;
      for (const run of shape.styleRuns ?? []) padding = Math.max(padding, run.fontSize ?? 0);
      box = { x: host.x - padding, y: host.y - padding,
        width: host.width + 2 * padding, height: host.height + 2 * padding };
    }
    const extent = rotatedBounds(box, (host ?? shape).rotation ?? 0);
    left = Math.min(left, extent.x);
    top = Math.min(top, extent.y);
    right = Math.max(right, extent.x + extent.width);
    bottom = Math.max(bottom, extent.y + extent.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** SVG rotate transform around a bounds' own center, or undefined when unrotated (avoids a no-op attribute). */
function rotateTransform(bounds: Bounds, rotation: number | undefined): string | undefined {
  if (!rotation) return undefined;
  return `rotate(${rotation} ${bounds.x + bounds.width / 2} ${bounds.y + bounds.height / 2})`;
}

function containingFrame(shapes: Shape[], object: Shape): string | undefined {
  if (object.type === 'frame') return undefined;
  for (let index = shapes.length - 1; index >= 0; index--) {
    const frame = shapes[index];
    if (frame.type === 'frame' && frame.id !== object.id &&
      object.x >= frame.x && object.y >= frame.y &&
      object.x + object.width <= frame.x + frame.width &&
      object.y + object.height <= frame.y + frame.height) return frame.id;
  }
  return undefined;
}

function selectedWithChildren(shapes: Shape[], ids: string[]): Shape[] {
  const chosen = new Set(ids);
  let count: number;
  do {
    count = chosen.size;
    for (const shape of shapes) if (shape.parentId && chosen.has(shape.parentId)) chosen.add(shape.id);
  } while (chosen.size !== count);
  return shapes.filter(shape => chosen.has(shape.id) || (!!shape.textPathId && chosen.has(shape.textPathId)));
}
function booleanOperands(shapes: Shape[], ids: string[], byId: Map<string, Shape>): Shape[] {
  return shapes.filter(shape => {
    if (!ids.includes(shape.id)) return false;
    let parentId = shape.parentId;
    while (parentId) {
      if (ids.includes(parentId)) return false;
      parentId = byId.get(parentId)?.parentId;
    }
    return true;
  });
}

function descendants(shapes: Shape[], parent: Shape): Shape[] {
  return selectedWithChildren(shapes, [parent.id]).filter(shape => shape.id !== parent.id);
}

function transformChildren(shapes: Shape[], parent: Shape, next: Bounds) {
  const sx = next.width / parent.width;
  const sy = next.height / parent.height;
  for (const child of descendants(shapes, parent)) {
    child.x = Math.round((next.x + (child.x - parent.x) * sx) * 100) / 100;
    child.y = Math.round((next.y + (child.y - parent.y) * sy) * 100) / 100;
    child.width = Math.max(1, Math.round(child.width * sx * 100) / 100);
    child.height = Math.max(1, Math.round(child.height * sy * 100) / 100);
  }
}

function rotateChildren(shapes: Shape[], parent: Shape, pivot: Point, delta: number) {
  for (const child of descendants(shapes, parent)) {
    if (child.type === 'boolean') {
      child.rotation = normalizeAngle((child.rotation ?? 0) + delta);
      continue;
    }
    const middle = center(child);
    const rotated = rotateVector({ x: middle.x - pivot.x, y: middle.y - pivot.y }, delta);
    child.x = Math.round((pivot.x + rotated.x - child.width / 2) * 100) / 100;
    child.y = Math.round((pivot.y + rotated.y - child.height / 2) * 100) / 100;
    child.rotation = normalizeAngle((child.rotation ?? 0) + delta);
  }
}

function pruneEmptyBooleanGroups(page: DesignPage) {
  let count: number;
  do {
    count = page.shapes.length;
    const parents = new Set(page.shapes.map(shape => shape.parentId));
    page.shapes = page.shapes.filter(shape => shape.type !== 'boolean' || parents.has(shape.id));
  } while (page.shapes.length !== count);
}

function cloneShapes(shapes: Shape[], offset: Point, existing: Shape[] = [], rename = false) {
  const ids = new Map(shapes.map(shape => [shape.id, crypto.randomUUID()]));
  const copies: Shape[] = shapes.map(shape => {
    const textPathId = shape.textPathId && (ids.get(shape.textPathId) ??
      (existing.some(host => host.id === shape.textPathId) ? shape.textPathId : undefined));
    return {
      ...shape, id: ids.get(shape.id)!, name: rename ? `${shape.name} copy` : shape.name,
      x: shape.x + offset.x, y: shape.y + offset.y,
      parentId: shape.parentId && ids.has(shape.parentId) ? ids.get(shape.parentId) : undefined,
      textPathId, textPathOffset: textPathId
        ? Math.min(100, (shape.textPathOffset ?? 0) + (ids.has(shape.textPathId!) ? 0 : 10)) : undefined,
      textPathFlip: textPathId ? shape.textPathFlip : undefined,
    };
  });

  const candidates = existing.length ? [...existing, ...copies] : copies;
  for (const copy of copies) {
    if (copy.type !== 'frame' && !copy.parentId) copy.parentId = containingFrame(candidates, copy);
  }
  return { copies, ids };
}
/** Keep styled characters outside an inspector text replacement at their new offsets. */
function runsAfterTextEdit(oldText: string, newText: string, runs: StyleRun[] | undefined): StyleRun[] | undefined {
  if (!runs?.length) return runs;
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const delta = newEnd - oldEnd;
  const next: StyleRun[] = [];
  for (const run of runs) {
    if (run.end <= start) next.push(run);
    else if (run.start >= oldEnd) next.push({ ...run, start: run.start + delta, end: run.end + delta });
    else {
      if (run.start < start) next.push({ ...run, end: start });
      if (run.end > oldEnd) next.push({ ...run, start: newEnd, end: run.end + delta });
    }
  }
  const inherited = runs.find(run => run.start <= start && start < run.end);
  if (inherited && newEnd > start) next.push({ ...inherited, start, end: newEnd });
  next.sort((a, b) => a.start - b.start);
  return next.length ? next : undefined;
}

function snapshot(item: Workspace): HistoryEntry {
  return {
    document: {
      ...item.session.document,
      pages: item.session.document.pages.map(page => ({
        ...page, shapes: page.shapes.map(shape => ({ ...shape })),
      })),
    },
    pageId: item.pageId,
    selectedIds: [...item.selectedIds],
  };
}


function NumberField({ label, value, min, max, onCommit }: {
  label: string; value: number | null; min?: number; max?: number; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return <label className="field"><span>{label}</span><input type="text" inputMode="decimal"
    value={draft ?? (value === null ? '' : String(value))} placeholder={value === null ? 'Mixed' : undefined}
    onFocus={event => setDraft(event.currentTarget.value)}
    onChange={event => setDraft(event.currentTarget.value)}
    onBlur={event => {
      const text = event.currentTarget.value;
      setDraft(null);
      if (!text.trim()) return;
      const number = Number(text);
      if (Number.isFinite(number)) onCommit(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, number)));
    }}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.currentTarget.value = value === null ? '' : String(value);
        event.currentTarget.blur();
      }
    }}/></label>;
}
function ColorField({ label, value, onCommit }: {
  label: string; value: string | null; onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return <label className="field full"><span>{label}</span><div className="color-field">
    <input type="color" aria-label={`Choose ${label.toLowerCase()}`}
      value={value && /^#[\da-f]{6}$/i.test(value) ? value : '#3b5ee8'}
      onChange={event => onCommit(event.target.value)}/>
    <input type="text" aria-label={`${label} hex`} value={draft ?? value ?? ''} placeholder={value === null ? 'Mixed' : undefined}
      onFocus={event => setDraft(event.currentTarget.value)}
      onChange={event => setDraft(event.currentTarget.value)}
      onBlur={event => {
        const text = event.currentTarget.value.trim();
        setDraft(null);
        if (/^#[\da-f]{6}$/i.test(text)) onCommit(text);
        else if (/^#[\da-f]{3}$/i.test(text))
          onCommit(`#${[...text.slice(1)].map(digit => digit + digit).join('')}`);
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.value = value ?? ''; event.currentTarget.blur(); }
      }}/>
  </div></label>;
}


/** Open state for a popover that closes on an outside press or Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  return { open, setOpen, ref };
}
function Dropdown<T extends string | number>({ value, options, onChange, label, disabled }: {
  value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void; label: string; disabled?: boolean;
}) {
  const { open, setOpen, ref } = usePopover();
  const current = options.find(option => option.value === value);
  return <div className="dropdown" ref={ref}>
    <button type="button" className="dropdown-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={label}
      disabled={disabled} onClick={() => setOpen(!open)}><span>{current?.label ?? String(value)}</span><ChevronDown size={14} aria-hidden="true"/></button>
    {open && <div className="dropdown-menu" role="listbox" aria-label={label}>
      {options.map(option => <button type="button" key={String(option.value)} role="option" aria-selected={option.value === value}
        onClick={() => { onChange(option.value); setOpen(false); }}>
        <span className="dropdown-check">{option.value === value && <Check size={14} aria-hidden="true"/>}</span>{option.label}</button>)}
    </div>}
  </div>;
}
function PaintField({ label, color, opacity, onColor, onOpacity }: {
  label: string; color: string; opacity: number; onColor: (value: string) => void; onOpacity: (value: number) => void;
}) {
  const [hex, setHex] = useState<string | null>(null);
  const [alpha, setAlpha] = useState<string | null>(null);
  const finish = (event: ReactKeyboardEvent<HTMLInputElement>, original: string) => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
    if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.value = original; event.currentTarget.blur(); }
  };
  const shown = color.replace(/^#/, '').toUpperCase();
  return <div className="paint-field">
    <input type="color" className="paint-swatch" aria-label={`${label} color`}
      value={/^#[\da-f]{6}$/i.test(color) ? color : '#000000'} onChange={event => onColor(event.target.value)}/>
    <input className="paint-hex" aria-label={`${label} hex`} maxLength={7} value={hex ?? shown}
      onFocus={event => setHex(event.currentTarget.value)} onChange={event => setHex(event.currentTarget.value)}
      onBlur={event => {
        const text = event.currentTarget.value.trim().replace(/^#/, '');
        setHex(null);
        if (/^[\da-f]{6}$/i.test(text)) onColor(`#${text.toLowerCase()}`);
        else if (/^[\da-f]{3}$/i.test(text)) onColor(`#${[...text].map(digit => digit + digit).join('').toLowerCase()}`);
      }}
      onKeyDown={event => finish(event, shown)}/>
    <input className="paint-alpha" aria-label={`${label} opacity`} inputMode="decimal" value={alpha ?? String(Math.round(opacity * 100))}
      onFocus={event => setAlpha(event.currentTarget.value)} onChange={event => setAlpha(event.currentTarget.value)}
      onBlur={event => {
        const number = Number(event.currentTarget.value);
        setAlpha(null);
        if (event.currentTarget.value.trim() && Number.isFinite(number)) onOpacity(Math.min(100, Math.max(0, number)) / 100);
      }}
      onKeyDown={event => finish(event, String(Math.round(opacity * 100)))}/>
    <span className="paint-unit">%</span>
  </div>;
}
function SectionHeader({ title, onAdd, addLabel, addDisabled }: {
  title: string; onAdd: () => void; addLabel: string; addDisabled?: boolean;
}) {
  return <header className="prop-header"><h3>{title}</h3>
    <button className="prop-add" aria-label={addLabel} title={addLabel} disabled={addDisabled} onClick={onAdd}><Plus size={16}/></button></header>;
}
const strokePositions = [
  { value: 'center', label: 'Center' }, { value: 'inside', label: 'Inside' }, { value: 'outside', label: 'Outside' },
] as const;
function StrokeSection({ shape, onChange }: { shape: Shape; onChange: (changes: Partial<Shape>) => void }) {
  const present = shape.stroke !== undefined && shape.stroke !== 'none';
  return <section className="prop-section" aria-label="Stroke">
    <SectionHeader title="Stroke" addLabel={present ? 'Stroke already added' : 'Add stroke'} addDisabled={present}
      onAdd={() => onChange({ stroke: '#000000', strokeWidth: 1, strokeOpacity: undefined, strokeHidden: undefined,
        strokePosition: supportsStrokePosition(shape) ? 'inside' : undefined })}/>
    {present && <div className="prop-body">
      <div className="prop-row">
        <PaintField label="Stroke" color={shape.stroke!} opacity={shape.strokeOpacity ?? 1}
          onColor={stroke => onChange({ stroke })} onOpacity={strokeOpacity => onChange({ strokeOpacity })}/>
        <button className="prop-icon" aria-pressed={!!shape.strokeHidden} aria-label={shape.strokeHidden ? 'Show stroke' : 'Hide stroke'}
          title={shape.strokeHidden ? 'Show stroke' : 'Hide stroke'} onClick={() => onChange({ strokeHidden: shape.strokeHidden ? undefined : true })}>
          {shape.strokeHidden ? <EyeOff size={16}/> : <Eye size={16}/>}</button>
        <button className="prop-icon" aria-label="Remove stroke" title="Remove stroke"
          onClick={() => onChange({ stroke: undefined, strokeWidth: undefined, strokeOpacity: undefined, strokePosition: undefined, strokeHidden: undefined })}>
          <Minus size={16}/></button>
      </div>
      <div className="prop-pair">
        {supportsStrokePosition(shape) && <div className="field"><span>Position</span>
          <Dropdown label="Stroke position" value={shape.strokePosition ?? 'center'} options={strokePositions}
            onChange={strokePosition => onChange({ strokePosition })}/></div>}
        <NumberField label="Weight" value={shape.strokeWidth ?? 1} min={0} onCommit={strokeWidth => onChange({ strokeWidth })}/>
      </div>
    </div>}
  </section>;
}
const effectChoices = [
  { value: 'innerShadow', label: 'Inner shadow', Icon: Square },
  { value: 'dropShadow', label: 'Drop shadow', Icon: SquareDashedBottom },
  { value: 'layerBlur', label: 'Layer blur', Icon: Grip },
  { value: 'backgroundBlur', label: 'Background blur', Icon: Grid3x3 },
  { value: 'noise', label: 'Noise', Icon: Sparkles },
  { value: 'texture', label: 'Texture', Icon: Waves },
  { value: 'glass', label: 'Glass', Icon: Aperture },
] as const;
function EffectsSection({ effects, onChange }: { effects: Effect[]; onChange: (effects: Effect[]) => void }) {
  const menu = usePopover();
  const update = (id: string, changes: Partial<Effect>) =>
    onChange(effects.map(effect => effect.id === id ? { ...effect, ...changes } : effect));
  const retype = (id: string, type: Effect['type']) =>
    onChange(effects.map(effect => effect.id === id ? { ...newEffect(type, id), visible: effect.visible } : effect));
  return <section className="prop-section" aria-label="Effects">
    <header className="prop-header"><h3>Effects</h3>
      <div className="effect-add" ref={menu.ref}>
        <button className="prop-add" aria-label="Add effect" title="Add effect" aria-haspopup="menu" aria-expanded={menu.open}
          onClick={() => menu.setOpen(!menu.open)}><Plus size={16}/></button>
        {menu.open && <div className="dropdown-menu effect-menu" role="menu" aria-label="Add effect">
          {effectChoices.map(({ value, label, Icon }) => <button type="button" key={value} role="menuitem"
            onClick={() => { onChange([...effects, newEffect(value, crypto.randomUUID())]); menu.setOpen(false); }}>
            <Icon size={16} aria-hidden="true"/>{label}</button>)}
        </div>}
      </div>
    </header>
    {effects.map((effect, index) => {
      const amount = (label: string, key: 'x' | 'y' | 'blur' | 'spread' | 'size' | 'density' | 'radius' | 'refraction' | 'depth' | 'dispersion' | 'frost' | 'light',
        min: number, max?: number, fallback = 0) =>
        <NumberField key={key} label={label} value={effect[key] ?? fallback} min={min} max={max}
          onCommit={value => update(effect.id, { [key]: value } as Partial<Effect>)}/>;
      const paint = <PaintField label={`Effect ${index + 1}`} color={effect.color} opacity={effect.opacity}
        onColor={color => update(effect.id, { color })} onOpacity={opacity => update(effect.id, { opacity })}/>;
      return <div className="prop-body" key={effect.id}>
        <div className="prop-row">
          <Dropdown label={`Effect ${index + 1} type`} value={effect.type} options={effectChoices}
            onChange={type => retype(effect.id, type)}/>
          <button className="prop-icon" aria-pressed={!effect.visible} aria-label={effect.visible ? 'Hide effect' : 'Show effect'}
            title={effect.visible ? 'Hide effect' : 'Show effect'} onClick={() => update(effect.id, { visible: !effect.visible })}>
            {effect.visible ? <Eye size={16}/> : <EyeOff size={16}/>}</button>
          <button className="prop-icon" aria-label="Remove effect" title="Remove effect"
            onClick={() => onChange(effects.filter(entry => entry.id !== effect.id))}><Minus size={16}/></button>
        </div>
        {(effect.type === 'layerBlur' || effect.type === 'backgroundBlur') && amount('Blur', 'blur', 0)}
        {(effect.type === 'dropShadow' || effect.type === 'innerShadow') && <>
          <div className="prop-pair">{amount('X', 'x', -1000)}{amount('Y', 'y', -1000)}{amount('Blur', 'blur', 0)}{amount('Spread', 'spread', -1000)}</div>
          {paint}
        </>}
        {effect.type === 'noise' && <>
          <div className="prop-pair">{amount('Size', 'size', .5, undefined, 2)}{amount('Density %', 'density', 0, 100, 50)}</div>
          {paint}
        </>}
        {effect.type === 'texture' && <div className="prop-pair">{amount('Size', 'size', .5, undefined, 2)}{amount('Relief', 'radius', 0, undefined, 1)}</div>}
        {effect.type === 'glass' && <div className="prop-pair">
          {amount('Refraction', 'refraction', 0, 100, 40)}{amount('Depth', 'depth', 0, undefined, 20)}
          {amount('Dispersion', 'dispersion', 0, undefined, 0)}{amount('Frost', 'frost', 0, undefined, 8)}
          {amount('Light %', 'light', 0, 100, 50)}
        </div>}
      </div>;
    })}
  </section>;
}
const exportScales = [.5, .75, 1, 1.5, 2, 3, 4].map(value => ({ value, label: `${value}x` }));
const exportFormats = [{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }, { value: 'webp', label: 'WebP' }, { value: 'svg', label: 'SVG' }] as const;
function SuffixInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <input className="export-suffix" aria-label="Export suffix" placeholder="Suffix" value={draft ?? value}
    onFocus={event => setDraft(event.currentTarget.value)} onChange={event => setDraft(event.currentTarget.value)}
    onBlur={event => { setDraft(null); onCommit(event.currentTarget.value.replace(/[\\/:*?"<>|]/g, '')); }}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.value = value; event.currentTarget.blur(); }
    }}/>;
}
function ExportSection({ settings, name, onChange, onExport }: {
  settings: ExportSetting[]; name: string; onChange: (settings: ExportSetting[]) => void; onExport: () => void;
}) {
  const update = (id: string, changes: Partial<ExportSetting>) =>
    onChange(settings.map(setting => setting.id === id ? { ...setting, ...changes } : setting));
  return <section className="prop-section" aria-label="Export">
    <SectionHeader title="Export" addLabel="Add export setting" onAdd={() => onChange([...settings, {
      id: crypto.randomUUID(), scale: 1, format: 'png', suffix: '',
    }])}/>
    {settings.length > 0 && <div className="prop-body">
      {settings.map((setting, index) => <div className="prop-row export-row" key={setting.id}>
        <Dropdown label={`Export ${index + 1} scale`} value={setting.scale} options={exportScales} disabled={setting.format === 'svg'}
          onChange={scale => update(setting.id, { scale })}/>
        <SuffixInput value={setting.suffix} onCommit={suffix => { if (suffix !== setting.suffix) update(setting.id, { suffix }); }}/>
        <Dropdown label={`Export ${index + 1} format`} value={setting.format} options={exportFormats}
          onChange={format => update(setting.id, { format })}/>
        <button className="prop-icon" aria-label="Remove export setting" title="Remove export setting"
          onClick={() => onChange(settings.filter(entry => entry.id !== setting.id))}><Minus size={16}/></button>
      </div>)}
      <button className="button primary export-button" onClick={onExport}><Download size={15}/> Export {name}</button>
    </div>}
  </section>;
}

export default function App() {
  const workspaces = useRef<Workspace[]>([]);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [lastShape, setLastShape] = useState<(typeof shapeChoices)[number][0]>('rect');
  const [shapeMenu, setShapeMenu] = useState(false);
  const [lastTextTool, setLastTextTool] = useState<(typeof textChoices)[number][0]>('text');
  const [textMenu, setTextMenu] = useState(false);
  const [renaming, setRenaming] = useState<InlineRename | null>(null);
  const [editingText, setEditingText] = useState<TextEdit | null>(null);
  const [editorFocused, setEditorFocused] = useState(false);
  const richEditorRef = useRef<HTMLDivElement>(null);
  const [collapsedLayers, setCollapsedLayers] = useState<Set<string>>(new Set());
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [status, setStatus] = useState('Preparing workspace…');
  const [error, setError] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [expandedCorners, setExpandedCorners] = useState<Set<string>>(new Set());
  const recentRef = useRef<string[]>([]);
  const recentQueue = useRef(Promise.resolve());
  const [fonts, setFonts] = useState<FontFamily[]>(genericFonts);
  const [preferences, setPreferences] = useState<Preferences>(defaults);
  const preferencesRef = useRef(defaults);
  const preferencesQueue = useRef(Promise.resolve());
  const [recoveries, setRecoveries] = useState<RecoveryEntry[]>([]);
  const [exportScope, setExportScope] = useState<'page' | 'selection'>('page');
  const [booleanMenu, setBooleanMenu] = useState<{ x: number; y: number } | null>(null);
  const [lastBoolean, setLastBoolean] = useState<BooleanOperation>('union');
  const booleanMenuRef = useRef<HTMLDivElement>(null);
  const booleanTriggerRef = useRef<HTMLButtonElement>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('svg');
  const [recording, setRecording] = useState<string | null>(null);
  const [draft, setDraft] = useState<Extract<Drag, { kind: 'draw' }> | null>(null);
  const [marquee, setMarquee] = useState<Extract<Drag, { kind: 'marquee' }> | null>(null);
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const shapeMenuRef = useRef<HTMLDivElement>(null);
  const textMenuRef = useRef<HTMLDivElement>(null);
  const [canvasElement, setCanvasElement] = useState<SVGSVGElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [leftRailWidth, setLeftRailWidth] = useState(228);
  const [rightRailWidth, setRightRailWidth] = useState(254);
  const railDrag = useRef<{ side: 'left' | 'right'; startX: number; startWidth: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const lastTextTap = useRef<{ id: string; x: number; y: number; time: number } | null>(null);
  const lastCanvasShape = useRef<string | null>(null);
  const pendingTextEdit = useRef<{ workspace: Workspace; shape: Shape } | null>(null);
  const pendingPathAttach = useRef<{ workspace: Workspace; host: Shape } | null>(null);
  const spaceHeld = useRef(false);
  const clipboard = useRef<Shape[]>([]);
  const clipboardSelection = useRef<string[]>([]);
  const pasteCount = useRef(0);
  const shortcutHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  const closing = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentShape = shapeChoices.find(([type]) => type === lastShape) ?? shapeChoices[0];
  const CurrentShapeIcon = currentShape[1];
  const currentTextTool = textChoices.find(([type]) => type === lastTextTool) ?? textChoices[0];
  const CurrentTextIcon = currentTextTool[1];
  const workspace = workspaces.current.find(item => item.key === activeKey);
  const page = workspace?.session.document.pages.find(item => item.id === workspace.pageId);
  const shapeById = new Map(page?.shapes.map(shape => [shape.id, shape]) ?? []);
  const hiddenOperandIds = new Set<string>();
  const hiddenIds = new Set<string>();
  const lockedIds = new Set<string>();
  for (const shape of page?.shapes ?? []) {
    if (shape.guide) hiddenOperandIds.add(shape.id);
    let ancestor: Shape | undefined = shape;
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      if (ancestor.hidden) hiddenIds.add(shape.id);
      if (ancestor.locked) lockedIds.add(shape.id);
      if (ancestor !== shape && ancestor.type === 'boolean') hiddenOperandIds.add(shape.id);
      ancestor = ancestor.parentId ? shapeById.get(ancestor.parentId) : undefined;
    }
    if (hiddenIds.has(shape.id)) hiddenOperandIds.add(shape.id);
  }
  const editingGroup = page?.shapes.find(shape => shape.id === editingGroupId && shape.type === 'boolean');
  const selection = page?.shapes.filter(shape => workspace?.selectedIds.includes(shape.id)) ?? [];
  const selected = selection.length === 1 ? selection[0] : undefined;
  const textPreview = selected && editingText && editingText.workspaceKey === workspace?.key &&
    editingText.pageId === page?.id && editingText.shapeId === selected.id
    ? { ...selected, text: editingText.value, styleRuns: editingText.runs,
      ...textSize({ ...selected, text: editingText.value, styleRuns: editingText.runs }) } : null;
  const linkedHost = selected?.textPathId ? page?.shapes.find(shape => shape.id === selected.textPathId) : undefined;
  const selectionBox = linkedHost ?? (textPreview ?? (selection.length > 1 && page
    ? visualBoundsFor(selection, page.shapes) : selection.length ? boundsFor(selection) : null));
  const CurrentBooleanIcon = booleanChoices.find(([operation]) => operation === lastBoolean)?.[1] ?? Combine;
  const effectiveShortcuts = { ...bindings, ...preferences.shortcuts };
  const selectionLocked = selection.some(entry => lockedIds.has(entry.id));
  const selectionVisible = selection.some(entry => !hiddenIds.has(entry.id));
  // Back-to-front paint order (frames first), minus anything not drawn; Background blur/Glass sample what precedes a shape.
  const textPathHostIds = new Set((page?.shapes ?? []).filter(entry => entry.textPathId).map(entry => entry.textPathId!));
  const paintOrder = page ? [...page.shapes.filter(entry => entry.type === 'frame'), ...page.shapes.filter(entry => entry.type !== 'frame')]
    .filter(entry => !hiddenIds.has(entry.id) && !hiddenOperandIds.has(entry.id) && !entry.textPathId && !textPathHostIds.has(entry.id)) : [];
  const belowOf = (shape: Shape): Shape[] => {
    const position = paintOrder.findIndex(entry => entry.id === shape.id);
    return position < 0 ? [] : paintOrder.slice(0, position);
  };
  const hint = (action: string) => (effectiveShortcuts[action] ?? '')
    .replace('Mod+', /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+').replace('Alt+', '⌥').replace('Shift+', '⇧');

  function notify(text: string) { setError(''); setStatus(text); }
  function fail(context: string, cause: unknown) { setError(`${context}: ${message(cause)}`); setStatus('Action needs attention'); }
  function enqueue<T>(item: Workspace, job: () => Promise<T>): Promise<T> {
    const result = item.queue.then(job);
    item.queue = result.then(() => {}, () => {});
    return result;
  }
  function clearTimers(item: Workspace) {
    if (item.autosaveTimer) clearTimeout(item.autosaveTimer);
    if (item.recoveryTimer) clearTimeout(item.recoveryTimer);
  }
  function syncRecovery(item: Workspace): Promise<void> {
    if (item.recoveryTimer) clearTimeout(item.recoveryTimer);
    return enqueue(item, async () => {
      const session = item.session;
      if (session.path && session.revision === session.savedRevision) {
        await deleteRecovery(item.recoveryId);
      } else {
        const content = JSON.stringify({ document: session.document, path: session.path, revision: session.revision });
        await saveRecovery(item.recoveryId, content);
      }
    });
  }
  function schedulePersistence(item: Workspace) {
    if (item.recoveryTimer) clearTimeout(item.recoveryTimer);
    item.recoveryTimer = window.setTimeout(() => { void syncRecovery(item).catch(cause => fail('Could not protect recovery copy', cause)); }, 380);
    if (item.autosaveTimer) clearTimeout(item.autosaveTimer);
    if (preferencesRef.current.autosave && item.session.path) {
      item.autosaveTimer = window.setTimeout(() => {
        if (preferencesRef.current.autosave && item.session.dirty) void save(item, false);
      }, 1500);
    }
  }
  function changed(item: Workspace) {
    const currentPage = item.session.document.pages.find(page => page.id === item.pageId);
    if (currentPage) {
      for (const shape of currentPage.shapes) {
        const host = shape.textPathId && currentPage.shapes.find(entry => entry.id === shape.textPathId);
        if (host) {
          shape.x = host.x;
          shape.y = host.y;
          shape.parentId = host.parentId;
        }
      }
      recomputeBooleanGroups(currentPage);
    }
    item.session.revision += 1;
    item.session.dirty = true;
    schedulePersistence(item);
    refresh();
  }
  function remember(item: Workspace, before = snapshot(item)) {
    item.undo.push(before);
    if (item.undo.length > 80) item.undo.shift();
    item.redo.length = 0;
  }
  function history(item: Workspace, direction: 'undo' | 'redo') {
    const source = direction === 'undo' ? item.undo : item.redo;
    const target = direction === 'undo' ? item.redo : item.undo;
    const entry = source.pop();
    if (!entry) return;
    target.push(snapshot(item));
    item.session.document = entry.document;
    item.pageId = entry.pageId;
    item.selectedIds = entry.selectedIds;
    setEditingGroupId(null);
    setBooleanMenu(null);
    setMenu(null);
    changed(item);
  }
  function setSelection(item: Workspace, ids: string[]) {
    item.selectedIds = ids;
    setBooleanMenu(null);
    refresh();
  }
  function fitView(item: Workspace) {
    if (!canvasSize.width || !canvasSize.height) return;
    const visiblePage = item.session.document.pages.find(entry => entry.id === item.pageId);
    item.camera = fitCamera(canvasSize.width, canvasSize.height,
      visiblePage?.shapes.length ? pageBounds(visiblePage) : undefined);
    item.cameraReady = true;
    refresh();
  }
  function zoomView(item: Workspace, zoom: number, screen: Point = { x: canvasSize.width / 2, y: canvasSize.height / 2 }) {
    item.camera = zoomAt(item.camera, zoom, screen);
    refresh();
  }
  function screenPoint(event: { clientX: number; clientY: number }, svg: SVGSVGElement): Point {
    const rect = svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function makeWorkspace(document: DesignFile, path: string | null, dirty = false, revision = 0, recoveryId?: string): Workspace {
    return { key: crypto.randomUUID(), pageId: document.pages[0].id, selectedIds: [],
      camera: { x: 0, y: 0, zoom: 1 }, cameraReady: false, undo: [], redo: [],
      recoveryId: recoveryId ?? crypto.randomUUID(), queue: Promise.resolve(),
      session: { document, path, dirty, revision, savedRevision: dirty ? revision - 1 : revision } };
  }
  function addWorkspace(item: Workspace) {
    workspaces.current.push(item);
    setActiveKey(item.key);
    setTool('select');
    setShapeMenu(false);
    refresh();
  }
  function createDocument() {
    const item = makeWorkspace(newDocument(), null, true);
    addWorkspace(item);
    schedulePersistence(item);
    notify('New design ready. Save to choose a location.');
  }
  async function addRecent(path: string) {
    const pending = recentQueue.current.then(async () => {
      if (recentRef.current[0] === path) return;
      await recordRecent(path);
      recentRef.current = [path, ...recentRef.current.filter(entry => entry !== path)].slice(0, 12);
      setRecent(recentRef.current);
    });
    recentQueue.current = pending.then(() => {}, () => {});
    await pending;
  }
  async function openDocument(path?: string) {
    try {
      const chosen = path ?? await pickOpenFile();
      if (!chosen) return;
      const existing = workspaces.current.find(item => item.session.path === chosen);
      if (existing) { setActiveKey(existing.key); notify('File is already open.'); return; }
      const document = parseDesign(await readDesign(chosen));
      addWorkspace(makeWorkspace(document, chosen));
      notify(`Opened ${document.name}`);
      try { await addRecent(chosen); } catch (cause) { fail('Opened file, but could not update recents', cause); }
    } catch (cause) { fail('Could not open design', cause); }
  }
  async function save(item: Workspace, choosePath: boolean): Promise<boolean> {
    try {
      let path = item.session.path;
      if (choosePath || !path) {
        const picker = item.savePicker ??= pickSaveFile(path ?? undefined);
        let chosen: string | null;
        try { chosen = await picker; }
        finally { if (item.savePicker === picker) item.savePicker = undefined; }
        if (!chosen) return false;
        const occupied = workspaces.current.find(other => other !== item && other.session.path === chosen);
        if (occupied) throw new Error('That file is already open in another tab. Choose another location.');
        path = chosen;
      }
      const requestedPath = path;
      const target = await enqueue(item, async () => {
        const destination = choosePath || !item.session.path ? requestedPath : item.session.path;
        const revision = item.session.revision;
        const content = JSON.stringify(item.session.document);
        await writeDesign(destination, content);
        item.session.path = destination;
        item.session.savedRevision = Math.max(item.session.savedRevision, revision);
        item.session.dirty = item.session.revision !== item.session.savedRevision;
        refresh();
        return destination;
      });
      let warning = '';
      try { await syncRecovery(item); } catch (cause) { warning = `Could not update recovery copy: ${message(cause)}`; }
      try { await addRecent(target); } catch (cause) { warning = `Could not update recent designs: ${message(cause)}`; }
      if (item.session.dirty) {
        notify('Saved a snapshot; newer edits still need saving.');
        schedulePersistence(item);
      } else notify(`Saved ${basename(target)}`);
      if (warning) fail('File saved with a warning', warning);
      return true;
    } catch (cause) { fail('Could not save design', cause); return false; }
  }
  async function saveActive(choosePath = false) {
    if (workspace) await save(workspace, choosePath);
  }
  async function flushAll(): Promise<boolean> {
    const outcomes = await Promise.allSettled(workspaces.current.map(async item => {
      clearTimers(item);
      let saved = true;
      if (item.session.path && item.session.dirty && preferencesRef.current.autosave) {
        saved = await save(item, false);
      }
      await syncRecovery(item);
      if (!saved) throw new Error(`Could not save ${item.session.document.name}`);
    }));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed?.status === 'rejected') { fail('Could not finish writing before close', failed.reason); return false; }
    return true;
  }
  async function importImage() {
    if (!workspace || !page) return;
    const item = workspace;
    const pageId = page.id;
    try {
      const path = await pickAsset();
      if (!path) return;
      const asset = await importAsset(path);
      const image = new Image();
      image.src = asset.dataUrl;
      await image.decode();
      const scale = Math.min(1, 480 / image.naturalWidth, 360 / image.naturalHeight);
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const target = item.session.document.pages.find(entry => entry.id === pageId);
      if (!target) return;
      const center = worldAt(item.camera, { x: canvasSize.width / 2, y: canvasSize.height / 2 });
      const shape: Shape = { id: crypto.randomUUID(), type: 'image', name: asset.name,
        x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2),
        width, height, fill: '#ffffff', src: asset.dataUrl, lockAspect: true };
      shape.parentId = containingFrame(target.shapes, shape);
      remember(item);
      target.shapes.push(shape);
      item.selectedIds = [shape.id];
      changed(item);
      notify(`Embedded ${asset.name} in the design`);
    } catch (cause) { fail('Could not import image', cause); }
  }
  async function doExport() {
    if (!workspace || !page) return;
    const item = workspace;
    const currentPage = page;
    const shape = exportScope === 'selection' ? selected : undefined;
    if (exportScope === 'selection' && !shape) { fail('Could not export', 'Select a shape first.'); return; }
    try {
      const name = (shape?.name ?? currentPage.name).replace(/[^a-z0-9._-]+/gi, '-');
      const path = await pickExport(name, exportFormat);
      if (!path) return;
      notify('Rendering export…');
      const data = await exportBase64(currentPage, exportFormat, shape);
      await writeExport(path, data);
      setModal(null);
      notify(`Exported ${basename(path)} from ${item.session.document.name}`);
    } catch (cause) { fail('Could not export design', cause); }
  }
  async function exportSettings(item: Workspace, currentPage: DesignPage, shape: Shape) {
    const settings = shape.exports ?? [];
    if (!settings.length) return;
    try {
      const names = exportFileNames(shape.name.replace(/[^a-z0-9._-]+/gi, '-') || 'export', settings);
      const targets: string[] = [];
      if (settings.length === 1) {
        const path = await pickExport(names[0], settings[0].format);
        if (!path) return;
        targets.push(path);
      } else {
        const folder = await pickExportFolder();
        if (!folder) return;
        const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
        for (const name of names) targets.push(`${folder.replace(/[\\/]+$/, '')}${separator}${name}`);
      }
      notify('Rendering export…');
      for (const [index, setting] of settings.entries())
        await writeExport(targets[index], await exportBase64(currentPage, setting.format, shape, setting.scale));
      notify(settings.length === 1 ? `Exported ${basename(targets[0])} from ${item.session.document.name}`
        : `Exported ${settings.length} files from ${item.session.document.name}`);
    } catch (cause) { fail('Could not export', cause); }
  }
  async function updatePreferences(next: Preferences) {
    const oldAutosave = preferencesRef.current.autosave;
    preferencesRef.current = next;
    setPreferences(next);
    if (oldAutosave !== next.autosave) {
      for (const item of workspaces.current) {
        if (item.autosaveTimer) clearTimeout(item.autosaveTimer);
        if (next.autosave && item.session.path && item.session.dirty) schedulePersistence(item);
      }
    }
    const pending = preferencesQueue.current.then(() => savePreferences(next));
    preferencesQueue.current = pending.then(() => {}, () => {});
    try { await pending; notify('Preferences saved'); }
    catch (cause) { fail('Could not save preferences; retry your change', cause); }
  }
  function setShortcut(action: string, combo: string) {
    if (combo && !shortcutAllowed(combo)) { fail('Shortcut unavailable', 'Use a letter, Shift + letter, or Mod + Alt + letter. System combinations stay reserved.'); return; }
    if (combo && actions.some(([key]) => key !== action && effectiveShortcuts[key] === combo)) {
      fail('Shortcut already in use', `${combo} is assigned to another action. Clear it there first.`); return;
    }
    setRecording(null);
    void updatePreferences({ ...preferencesRef.current,
      shortcuts: { ...preferencesRef.current.shortcuts, [action]: combo } });
  }
  function restoreRecovery(entry: RecoveryEntry) {
    const snapshot = recoveryValue(entry);
    if (!snapshot) { fail('Could not restore copy', 'Its contents are invalid. Discard this copy or keep it for later.'); return; }
    const other = workspaces.current.find(item => item.session.path && item.session.path === snapshot.path);
    if (other) { setActiveKey(other.key); fail('Copy already open', 'Close the open tab before restoring its recovery copy.'); return; }
    addWorkspace(makeWorkspace(snapshot.document, snapshot.path, true, snapshot.revision, entry.id));
    setRecoveries(current => current.filter(item => item.id !== entry.id));
    notify(`Restored ${snapshot.document.name}; save to keep this version.`);
  }
  async function discardRecovery(entry: RecoveryEntry) {
    try {
      await deleteRecovery(entry.id);
      setRecoveries(current => current.filter(item => item.id !== entry.id));
      notify('Recovery copy discarded');
    } catch (cause) { fail('Could not discard recovery copy', cause); }
  }
  async function closeWorkspace(item: Workspace, discard = false) {
    if (item.session.dirty && !discard) { setModal({ kind: 'close', key: item.key }); return; }
    if (discard) {
      try { clearTimers(item); await item.queue; await deleteRecovery(item.recoveryId); }
      catch (cause) { fail('Could not discard recovery copy', cause); return; }
    } else {
      try { clearTimers(item); await item.queue; } catch (cause) { fail('Could not finish file writes', cause); return; }
    }
    workspaces.current = workspaces.current.filter(entry => entry !== item);
    if (activeKey === item.key) setActiveKey(workspaces.current.at(-1)?.key ?? null);
    setModal(null);
    refresh();
  }
  function editShape(item: Workspace, shape: Shape, changes: Partial<Shape>) {
    if (lockedIds.has(shape.id) && ['x', 'y', 'width', 'height', 'rotation'].some(key => key in changes)) {
      notify('Unlock the layer to change its size or position.');
      return;
    }
    if (shape.type === 'text') {
      if (changes.height !== undefined && changes.height !== shape.height) changes = { ...changes, textSizing: 'fixed' };
      else if (changes.width !== undefined && changes.width !== shape.width)
        changes = { ...changes, textSizing: shape.textSizing === 'fixed' ? 'fixed' : 'auto-height' };
      if (changes.text !== undefined || changes.width !== undefined || changes.height !== undefined ||
        changes.fontSize !== undefined || changes.fontFamily !== undefined || changes.fontWeight !== undefined ||
        changes.fontStyle !== undefined || changes.textSizing !== undefined || changes.styleRuns !== undefined ||
        changes.lineHeight !== undefined || changes.letterSpacing !== undefined)
        changes = { ...changes, ...textSize({ ...shape, ...changes }) };
    }
    if (Object.entries(changes).every(([key, value]) => shape[key as keyof Shape] === value)) return;
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    remember(item);
    const dx = (changes.x ?? shape.x) - shape.x;
    const dy = (changes.y ?? shape.y) - shape.y;
    if (current && shape.type === 'boolean') {
      if (changes.x !== undefined || changes.y !== undefined ||
        changes.width !== undefined || changes.height !== undefined)
        transformChildren(current.shapes, shape, { x: changes.x ?? shape.x, y: changes.y ?? shape.y,
          width: changes.width ?? shape.width, height: changes.height ?? shape.height });
      if (changes.rotation !== undefined)
        rotateChildren(current.shapes, shape,
          center({ x: changes.x ?? shape.x, y: changes.y ?? shape.y,
            width: changes.width ?? shape.width, height: changes.height ?? shape.height }),
          normalizeAngle(changes.rotation - (shape.rotation ?? 0)));
      if (changes.fill !== undefined) {
        let first = current.shapes.find(child => child.parentId === shape.id);
        while (first?.type === 'boolean') {
          const groupId = first.id;
          first = current.shapes.find(child => child.parentId === groupId);
        }
        if (first) first.fill = changes.fill;
      }
    } else if (current && shape.type === 'frame' && (dx || dy)) {
      for (const child of descendants(current.shapes, shape)) {
        child.x += dx;
        child.y += dy;
      }
    }
    Object.assign(shape, changes);
    if (current && shape.type !== 'frame' &&
      !(shape.parentId && current.shapes.some(parent => parent.id === shape.parentId && parent.type === 'boolean')) &&
      (changes.x !== undefined || changes.y !== undefined || changes.width !== undefined || changes.height !== undefined))
      shape.parentId = containingFrame(current.shapes, shape);
    changed(item);
  }
  function beginRename(item: Workspace, shape: Shape, surface: InlineRename['surface']) {
    setSelection(item, [shape.id]);
    setRenaming({ workspaceKey: item.key, shapeId: shape.id, value: shape.name, surface });
  }
  function finishRename(value: string) {
    if (!renaming) return;
    const item = workspaces.current.find(entry => entry.key === renaming.workspaceKey);
    const shape = item?.session.document.pages.find(entry => entry.id === item.pageId)
      ?.shapes.find(entry => entry.id === renaming.shapeId);
    if (item && shape && value.trim()) editShape(item, shape, { name: value.trim() });
    setRenaming(null);
  }
  function beginTextEdit(item: Workspace, shape: Shape, isNew = false, before = snapshot(item)) {
    setSelection(item, [shape.id]);
    setTool('select');
    setEditingText({ workspaceKey: item.key, pageId: item.pageId, shapeId: shape.id,
      value: shape.text ?? '', runs: shape.styleRuns ?? [], selection: null, before, isNew });
  }
  function activateTextPath(item: Workspace, host?: Shape) {
    setTextMenu(false);
    setShapeMenu(false);
    setLastTextTool('textPath');
    const currentPage = item.session.document.pages.find(entry => entry.id === item.pageId);
    const target = host && isTextPathHost(host)
      ? host
      : currentPage?.shapes.find(shape => item.selectedIds.includes(shape.id) && isTextPathHost(shape));
    if (target && currentPage) {
      attachTextToPath(item, currentPage, target);
      return;
    }
    setTool('textPath');
    notify('Click a vector shape or empty canvas to add text on path.');
  }
  function createTextOnPath(item: Workspace, currentPage: DesignPage, host: Shape) {
    const before = snapshot(item);
    const shape: Shape = {
      id: crypto.randomUUID(), type: 'text', name: 'Text on path', x: host.x, y: host.y,
      width: Math.max(1, host.width), height: 44, fill: textOnPathColor(host), text: '',
      fontFamily: 'sans-serif', fontSize: 36, fontWeight: 400, fontStyle: 'normal',
      textSizing: 'auto-width', textPathId: host.id, textPathOffset: 0, textPathFlip: false,
      parentId: host.parentId,
    };
    currentPage.shapes.splice(currentPage.shapes.indexOf(host) + 1, 0, shape);
    beginTextEdit(item, shape, true, before);
  }
  function attachTextToPath(item: Workspace, currentPage: DesignPage, host: Shape) {
    createTextOnPath(item, currentPage, host);
  }
  function spawnTextOnPathAt(item: Workspace, currentPage: DesignPage, position: Point) {
    const host: Shape = {
      id: crypto.randomUUID(),
      type: 'ellipse',
      name: 'Path guide',
      guide: true,
      x: position.x - 100,
      y: position.y - 100,
      width: 200,
      height: 200,
      fill: '#3b5ee8',
    };
    host.parentId = containingFrame(currentPage.shapes, host);
    currentPage.shapes.push(host);
    createTextOnPath(item, currentPage, host);
  }
  function detachTextFromPath(item: Workspace, shape: Shape, host: Shape) {
    const path = canvasElement?.querySelector<SVGPathElement>(`#text-path-${shape.id}`);
    const start = path?.getPointAtLength(path.getTotalLength() * (shape.textPathOffset ?? 0) / 100);
    const center = { x: host.x + host.width / 2, y: host.y + host.height / 2 };
    const rotated = start && rotateVector({ x: start.x - center.x, y: start.y - center.y }, host.rotation ?? 0);
    editShape(item, shape, {
      textPathId: undefined, textPathOffset: undefined, textPathFlip: undefined,
      x: rotated ? center.x + rotated.x : host.x,
      y: rotated ? center.y + rotated.y - (shape.fontSize ?? 36) : host.y,
      rotation: host.rotation,
    });
    if (host.guide) {
      const current = item.session.document.pages.find(entry => entry.id === item.pageId);
      if (current) current.shapes = current.shapes.filter(entry => entry.id !== host.id);
      changed(item);
    }
  }
  function editingShapeRef(): Shape | undefined {
    if (!editingText) return undefined;
    const item = workspaces.current.find(entry => entry.key === editingText.workspaceKey);
    return item?.session.document.pages.find(entry => entry.id === editingText.pageId)
      ?.shapes.find(entry => entry.id === editingText.shapeId);
  }
  function syncEditorFromDom() {
    const root = richEditorRef.current;
    const shape = editingShapeRef();
    if (!root || !shape) return;
    const { text, runs } = readEditorContent(root, shapeDefaults(shape));
    setEditingText(previous => previous && { ...previous, value: text, runs });
  }
  function finishTextEdit() {
    if (!editingText) return;
    const item = workspaces.current.find(entry => entry.key === editingText.workspaceKey);
    const current = item?.session.document.pages.find(entry => entry.id === editingText.pageId);
    const shape = current?.shapes.find(entry => entry.id === editingText.shapeId);
    if (!item || !current || !shape) { setEditingText(null); return; }
    const { value, runs } = editingText;
    if (!value.trim()) {
      if (!editingText.isNew) remember(item, editingText.before);
      current.shapes.splice(current.shapes.indexOf(shape), 1);
      const guide = shape.textPathId ? current.shapes.find(entry => entry.id === shape.textPathId) : undefined;
      if (guide?.guide) current.shapes.splice(current.shapes.indexOf(guide), 1);
      item.selectedIds = [];
      if (editingText.isNew) refresh(); else changed(item);
    } else if (editingText.isNew || value !== shape.text || JSON.stringify(runs) !== JSON.stringify(shape.styleRuns ?? [])) {
      remember(item, editingText.before);
      shape.text = value;
      shape.styleRuns = runs.length ? runs : undefined;
      Object.assign(shape, textSize(shape));
      const host = shape.textPathId && current.shapes.find(entry => entry.id === shape.textPathId);
      shape.parentId = host ? host.parentId : containingFrame(current.shapes, shape);
      changed(item);
    }
    setEditingText(null);
  }
  function addPage(item: Workspace) {
    remember(item);
    const next = newPage(`Canvas ${item.session.document.pages.length + 1}`);
    item.session.document.pages.push(next);
    item.pageId = next.id;
    item.selectedIds = [];
    changed(item);
  }
  function duplicatePage(item: Workspace, original: DesignPage) {
    remember(item);
    const copy: DesignPage = { id: crypto.randomUUID(), name: `${original.name} copy`,
      shapes: cloneShapes(original.shapes, { x: 0, y: 0 }).copies };
    item.session.document.pages.splice(item.session.document.pages.indexOf(original) + 1, 0, copy);
    item.pageId = copy.id;
    item.selectedIds = [];
    changed(item);
  }
  function deletePage(item: Workspace, original: DesignPage) {
    if (item.session.document.pages.length === 1) return;
    if (!window.confirm(`Delete “${original.name}” and its ${original.shapes.length} shapes?`)) return;
    remember(item);
    const index = item.session.document.pages.indexOf(original);
    item.session.document.pages.splice(index, 1);
    item.pageId = item.session.document.pages[Math.min(index, item.session.document.pages.length - 1)].id;
    item.selectedIds = [];
    changed(item);
  }
  function removeSelection(item: Workspace) {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    if (!current || !item.selectedIds.length) return;
    const removable = item.selectedIds.filter(id => !lockedIds.has(id));
    if (!removable.length) { notify('Unlock the layer to delete it.'); return; }
    if (removable.length < item.selectedIds.length) notify('Locked layers were kept.');
    remember(item);
    const ids = new Set(selectedWithChildren(current.shapes, removable).map(shape => shape.id));
    for (const shape of current.shapes) {
      const host = ids.has(shape.id) && shape.textPathId ? current.shapes.find(entry => entry.id === shape.textPathId) : undefined;
      if (host?.guide && !current.shapes.some(other => other.textPathId === host.id && !ids.has(other.id))) ids.add(host.id);
    }
    current.shapes = current.shapes.filter(shape => !ids.has(shape.id));
    pruneEmptyBooleanGroups(current);
    if (editingGroupId && !current.shapes.some(shape => shape.id === editingGroupId))
      setEditingGroupId(null);
    item.selectedIds = item.selectedIds.filter(id => lockedIds.has(id));
    setMenu(null);
    changed(item);
  }
  function moveShape(item: Workspace, currentPage: DesignPage, shape: Shape, step: number) {
    const siblings = currentPage.shapes.filter(entry => entry.parentId === shape.parentId &&
      (entry.type === 'frame') === (shape.type === 'frame'));
    const other = siblings[siblings.indexOf(shape) + step];
    if (!other) return;
    const next = currentPage.shapes.indexOf(other);
    const index = currentPage.shapes.indexOf(shape);
    remember(item);
    currentPage.shapes.splice(index, 1);
    currentPage.shapes.splice(next, 0, shape);
    changed(item);
  }
  function arrangeSelection(item: Workspace, position: 'front' | 'back') {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    if (!current || !item.selectedIds.length) return;
    const selected = current.shapes.filter(shape => item.selectedIds.includes(shape.id));
    const rest = current.shapes.filter(shape => !item.selectedIds.includes(shape.id));
    if (!selected.length || selected.every((shape, index) =>
      current.shapes[(position === 'front' ? current.shapes.length - selected.length : 0) + index] === shape)) return;
    remember(item);
    current.shapes = position === 'front' ? [...rest, ...selected] : [...selected, ...rest];
    changed(item);
  }
  function duplicateSelection(item: Workspace) {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    if (!current) return;
    const originals = selectedWithChildren(current.shapes, item.selectedIds);
    if (!originals.length) return;
    remember(item);
    const { copies, ids } = cloneShapes(originals, { x: 24, y: 24 }, current.shapes, true);
    current.shapes.push(...copies);
    item.selectedIds = item.selectedIds.map(id => ids.get(id)!).filter(Boolean);
    changed(item);
  }
  function canApplyBoolean(item: Workspace, operation: BooleanOperation): boolean {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    if (!current) return false;
    const chosen = booleanOperands(current.shapes, item.selectedIds, shapeById);
    if (chosen.length < (operation === 'flatten' ? 1 : 2) || !chosen.every(canBooleanShape)) return false;
    if (operation === 'flatten' && chosen.some(shape => shape.fill !== chosen[0].fill)) return false;
    return !current.shapes.some(shape => shape.textPathId && chosen.some(host => host.id === shape.textPathId));
  }
  function applyBoolean(item: Workspace, operation: BooleanOperation) {
    if (!canApplyBoolean(item, operation)) return;
    const current = item.session.document.pages.find(entry => entry.id === item.pageId)!;
    const chosen = booleanOperands(current.shapes, item.selectedIds, shapeById);
    try {
      const result = booleanShape(chosen, operation);
      remember(item);
      const insertAt = current.shapes.indexOf(chosen[0]);
      const name = operation[0].toUpperCase() + operation.slice(1);
      if (operation === 'flatten') {
        const ids = new Set(selectedWithChildren(current.shapes, chosen.map(shape => shape.id))
          .map(shape => shape.id));
        current.shapes = current.shapes.filter(shape => !ids.has(shape.id));
        if (result) {
          result.name = name;
          current.shapes.splice(insertAt, 0, result);
        }
        pruneEmptyBooleanGroups(current);
        item.selectedIds = result ? [result.id] : [];
      } else {
        const bounds = result ?? boundsFor(chosen);
        const group: Shape = { id: crypto.randomUUID(), type: 'boolean', booleanOperation: operation,
          name, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
          fill: chosen[0].fill, pathData: result?.pathData ?? '',
          parentId: chosen.every(shape => shape.parentId === chosen[0].parentId)
            ? chosen[0].parentId : undefined };
        current.shapes.splice(insertAt, 0, group);
        for (const shape of chosen) shape.parentId = group.id;
        pruneEmptyBooleanGroups(current);
        item.selectedIds = [group.id];
      }
      setEditingGroupId(null);
      setLastBoolean(operation);
      setBooleanMenu(null);
      changed(item);
      notify(operation === 'flatten' ? (result ? 'Flattened into a vector' : 'Flattened result is empty') :
        `${name} group created; double-click it to edit its shapes`);
    } catch (cause) { fail('Could not combine shapes', cause); }
  }
  function canUngroup(item: Workspace): boolean {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    if (!current) return false;
    return current.shapes.some(shape => item.selectedIds.includes(shape.id) && shape.type === 'boolean');
  }
  function ungroupSelection(item: Workspace) {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    if (!current) return;
    const groupsToUngroup = current.shapes.filter(shape => item.selectedIds.includes(shape.id) && shape.type === 'boolean');
    if (!groupsToUngroup.length) return;
    remember(item);
    const newSelectedIds: string[] = [];
    for (const group of groupsToUngroup) {
      const children = current.shapes.filter(shape => shape.parentId === group.id);
      for (const child of children) {
        child.parentId = group.parentId;
        newSelectedIds.push(child.id);
      }
      const index = current.shapes.indexOf(group);
      if (index >= 0) current.shapes.splice(index, 1);
    }
    pruneEmptyBooleanGroups(current);
    item.selectedIds = newSelectedIds;
    if (editingGroupId && groupsToUngroup.some(g => g.id === editingGroupId)) setEditingGroupId(null);
    setMenu(null);
    changed(item);
    notify(`Ungrouped ${groupsToUngroup.length} Boolean ${groupsToUngroup.length === 1 ? 'group' : 'groups'}`);
  }
  /** Shapes that rotate/flip acts on: selected non-frame shapes (text on path acts through its path), plus operands of selected Boolean groups. Locked shapes are skipped. */
  function arrangeTargets(item: Workspace): Shape[] {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    if (!current) return [];
    const byId = new Map(current.shapes.map(entry => [entry.id, entry]));
    const chosen = new Set<string>();
    for (const id of item.selectedIds) {
      const entry = byId.get(id);
      if (!entry || entry.type === 'frame' || lockedIds.has(id) || hiddenIds.has(id)) continue;
      chosen.add(entry.textPathId && byId.has(entry.textPathId) ? entry.textPathId : entry.id);
      if (entry.type === 'boolean') for (const child of descendants(current.shapes, entry)) chosen.add(child.id);
    }
    return current.shapes.filter(entry => chosen.has(entry.id));
  }
  function transformSelection(item: Workspace, operation: 'rotate90' | 'flipH' | 'flipV') {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    const targets = arrangeTargets(item);
    if (!current || !targets.length) {
      notify('Select an unlocked, visible shape first.');
      return;
    }
    remember(item);
    const pivot = center(visualBoundsFor(targets, current.shapes));
    const round = (value: number) => Math.round(value * 100) / 100;
    for (const entry of targets) {
      if (entry.type !== 'boolean') {
        const mid = center(entry);
        if (operation === 'rotate90') {
          const turned = rotateVector({ x: mid.x - pivot.x, y: mid.y - pivot.y }, 90);
          entry.x = round(pivot.x + turned.x - entry.width / 2);
          entry.y = round(pivot.y + turned.y - entry.height / 2);
        } else if (operation === 'flipH') entry.x = round(2 * pivot.x - mid.x - entry.width / 2);
        else entry.y = round(2 * pivot.y - mid.y - entry.height / 2);
      }
      if (operation === 'rotate90') entry.rotation = normalizeAngle((entry.rotation ?? 0) + 90) || undefined;
      else {
        if (entry.rotation) entry.rotation = normalizeAngle(-entry.rotation) || undefined;
        const linked = current.shapes.find(other => other.textPathId === entry.id);
        if (linked) linked.textPathFlip = !linked.textPathFlip;
        else if (entry.type !== 'boolean') {
          const key = operation === 'flipH' ? 'flipX' : 'flipY';
          entry[key] = entry[key] ? undefined : true;
        }
      }
    }
    setMenu(null);
    changed(item);
  }
  /** Hide when anything in the set is visible, otherwise show everything again. */
  function toggleHidden(item: Workspace, ids = item.selectedIds) {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    const targets = current?.shapes.filter(entry => ids.includes(entry.id) && !entry.guide) ?? [];
    if (!current || !targets.length) return;
    const hide = targets.some(entry => !entry.hidden);
    remember(item);
    for (const entry of targets) entry.hidden = hide ? true : undefined;
    if (hide) item.selectedIds = item.selectedIds.filter(id => !targets.some(entry => entry.id === id));
    setMenu(null);
    changed(item);
    notify(hide ? 'Hidden. Use the eye in Layers to show it again.' : 'Shown');
  }
  function toggleLocked(item: Workspace, ids = item.selectedIds) {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    const targets = current?.shapes.filter(entry => ids.includes(entry.id) && !entry.guide) ?? [];
    if (!current || !targets.length) return;
    const lock = targets.some(entry => !entry.locked);
    remember(item);
    for (const entry of targets) entry.locked = lock ? true : undefined;
    setMenu(null);
    changed(item);
    notify(lock ? 'Locked. It can no longer be moved or edited on canvas.' : 'Unlocked');
  }
  function copySelection(item: Workspace) {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    const originals = current ? selectedWithChildren(current.shapes, item.selectedIds) : [];
    clipboard.current = originals.map(shape => ({ ...shape }));
    clipboardSelection.current = [...item.selectedIds];
    pasteCount.current = 0;
    if (clipboard.current.length) notify(`Copied ${clipboard.current.length} ${clipboard.current.length === 1 ? 'object' : 'objects'}`);
  }
  function pasteSelection(item: Workspace, at?: Point) {
    const current = item.session.document.pages.find(entry => entry.id === item.pageId);
    if (!current || !clipboard.current.length) return;
    remember(item);
    pasteCount.current += 1;
    const origin = boundsFor(clipboard.current);
    const offset = at ? { x: Math.round(at.x - origin.x), y: Math.round(at.y - origin.y) }
      : { x: 24 * pasteCount.current, y: 24 * pasteCount.current };
    const { copies, ids } = cloneShapes(clipboard.current, offset, current.shapes);
    current.shapes.push(...copies);
    item.selectedIds = clipboardSelection.current.map(id => ids.get(id)!).filter(Boolean);
    changed(item);
  }
  function affectsBooleanGroup(shape: Shape) {
    let current: Shape | undefined = shape;
    while (current) {
      if (current.type === 'boolean') return true;
      current = current.parentId ? shapeById.get(current.parentId) : undefined;
    }
    return false;
  }
  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    setBooleanMenu(null);
    if (!workspace || !page || (event.button !== 0 && event.button !== 1)) return;
    setMenu(null);
    setShapeMenu(false);
    setTextMenu(false);
    const screen = screenPoint(event, event.currentTarget);
    const previousTextTap = lastTextTap.current;
    lastTextTap.current = null;
    lastCanvasShape.current = null;
    if (event.button === 1 || spaceHeld.current || tool === 'hand') {
      event.preventDefault();
      drag.current = { kind: 'pan', workspace, start: screen, camera: { ...workspace.camera } };
    } else {
      const position = worldAt(workspace.camera, screen);
      const element = event.target as Element;
      const hit = page.shapes.find(entry => entry.id === element.closest('[data-shape-id]')?.getAttribute('data-shape-id'));
      const shape = hit && !lockedIds.has(hit.id) ? hit : undefined;
      lastCanvasShape.current = shape?.id ?? null;
      if (tool === 'textPath') {
        if (shape && isTextPathHost(shape)) {
          event.preventDefault();
          attachTextToPath(workspace, page, shape);
        } else if (!shape) {
          event.preventDefault();
          spawnTextOnPathAt(workspace, page, position);
        } else {
          notify('Choose a line, arrow, rectangle, ellipse, polygon, or star, or tap empty canvas.');
        }
        return;
      }
      const handle = element.closest('[data-handle]')?.getAttribute('data-handle') as Handle | undefined;
      const rotateHandle = !handle ? element.closest('[data-rotate-handle]')?.getAttribute('data-rotate-handle') : undefined;
      if (tool === 'select' && shape?.type === 'text' && !event.shiftKey &&
        previousTextTap?.id === shape.id && event.timeStamp - previousTextTap.time < 450 &&
        Math.hypot(screen.x - previousTextTap.x, screen.y - previousTextTap.y) < 6) {
        event.preventDefault();
        pendingTextEdit.current = { workspace, shape };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      const transformTargets = linkedHost ? [linkedHost] : selectedWithChildren(page.shapes, selection.map(shape => shape.id));
      const lockedSelection = transformTargets.some(entry => lockedIds.has(entry.id));
      if (tool === 'select' && handle && selectionBox && selection.length && !lockedSelection) {
        drag.current = { kind: 'resize', workspace, before: snapshot(workspace), start: position,
          bounds: { x: selectionBox.x, y: selectionBox.y, width: selectionBox.width, height: selectionBox.height }, handle, shapes: transformTargets
            .map(current => ({
              shape: current, bounds: { x: current.x, y: current.y, width: current.width, height: current.height },
              textSizing: current.textSizing,
            })) };
      } else if (tool === 'select' && rotateHandle && selectionBox && selection.length === 1 && !lockedSelection) {
        const pivot = { x: selectionBox.x + selectionBox.width / 2, y: selectionBox.y + selectionBox.height / 2 };
        const rotating = linkedHost ?? selection[0];
        drag.current = { kind: 'rotate', workspace, before: snapshot(workspace), shape: rotating,
          center: pivot, startAngle: angleBetween(pivot, position), startRotation: rotating.rotation ?? 0,
          descendants: rotating.type === 'boolean' ? descendants(page.shapes, rotating).map(child => ({
            shape: child, bounds: { x: child.x, y: child.y, width: child.width, height: child.height },
            rotation: child.rotation ?? 0,
          })) : [] };
      } else if (tool === 'select' && shape) {
        if (editingGroupId && shape.parentId !== editingGroupId && shape.id !== editingGroupId)
          setEditingGroupId(null);
        if (event.shiftKey) {
          setSelection(workspace, workspace.selectedIds.includes(shape.id)
            ? workspace.selectedIds.filter(id => id !== shape.id) : [...workspace.selectedIds, shape.id]);
        } else {
          if (!workspace.selectedIds.includes(shape.id)) setSelection(workspace, [shape.id]);
          const host = shape.textPathId && page.shapes.find(entry => entry.id === shape.textPathId);
          if (host) {
            drag.current = { kind: 'path-offset', workspace, before: snapshot(workspace),
              start: position, shape, host, offset: shape.textPathOffset ?? 0 };
          } else {
            const shapes = selectedWithChildren(page.shapes,
              workspace.selectedIds.includes(shape.id) ? workspace.selectedIds : [shape.id])
              .filter(entry => !lockedIds.has(entry.id));
            drag.current = { kind: 'move', workspace, before: snapshot(workspace), start: position,
              shapes: shapes.map(current => ({ shape: current,
                bounds: { x: current.x, y: current.y, width: current.width, height: current.height } })) };
          }
        }
      } else if (tool === 'select') {
        if (!event.shiftKey) { setSelection(workspace, []); setEditingGroupId(null); }
        const gesture: Extract<Drag, { kind: 'marquee' }> =
          { kind: 'marquee', workspace, start: position, end: position, additive: event.shiftKey };
        drag.current = gesture;
        setMarquee(gesture);
      } else {
        drag.current = { kind: 'draw', workspace, type: tool, start: position, end: position, fine: event.altKey };
        setDraft(drag.current);
      }
    }
    if (drag.current) event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const gesture = drag.current;
    if (!gesture) return;
    const screen = screenPoint(event, event.currentTarget);
    if (gesture.kind === 'pan') {
      gesture.workspace.camera = { ...gesture.camera,
        x: gesture.camera.x + screen.x - gesture.start.x,
        y: gesture.camera.y + screen.y - gesture.start.y };
      refresh();
      return;
    }
    const position = worldAt(gesture.workspace.camera, screen);
    if (gesture.kind === 'path-offset') {
      if (Math.hypot(position.x - gesture.start.x, position.y - gesture.start.y) * gesture.workspace.camera.zoom < 3) return;
      const path = event.currentTarget.querySelector<SVGPathElement>(`#text-path-${gesture.shape.id}`);
      if (!path) return;
      const length = path.getTotalLength();
      const center = { x: gesture.host.x + gesture.host.width / 2, y: gesture.host.y + gesture.host.height / 2 };
      const unrotated = rotateVector({ x: position.x - center.x, y: position.y - center.y }, -(gesture.host.rotation ?? 0));
      const point = { x: unrotated.x + center.x, y: unrotated.y + center.y };
      let nearest = 0;
      let distance = Infinity;
      const sampleCount = 64;
      const isClosed = isClosedTextPathHost(gesture.host);
      const searchLength = isClosed ? length / 2 : length;
      for (let i = 0; i <= sampleCount; i++) {
        const sample = path.getPointAtLength(searchLength * i / sampleCount);
        const d = (sample.x - point.x) ** 2 + (sample.y - point.y) ** 2;
        if (d < distance) { distance = d; nearest = i / sampleCount; }
      }
      let lo = Math.max(0, nearest - 1 / sampleCount);
      let hi = Math.min(1, nearest + 1 / sampleCount);
      for (let i = 0; i < 12; i++) {
        const a = lo + (hi - lo) / 3;
        const b = hi - (hi - lo) / 3;
        const pa = path.getPointAtLength(searchLength * a);
        const pb = path.getPointAtLength(searchLength * b);
        if ((pa.x - point.x) ** 2 + (pa.y - point.y) ** 2 < (pb.x - point.x) ** 2 + (pb.y - point.y) ** 2) hi = b;
        else lo = a;
      }
      gesture.shape.textPathOffset = Math.round((lo + hi) * 50 * 10) / 10;
      refresh();
      return;
    }
    const currentPage = gesture.workspace.session.document.pages.find(entry => entry.id === gesture.workspace.pageId);
    if (!currentPage) return;
    if (gesture.kind === 'move') {
      const dx = position.x - gesture.start.x;
      const dy = position.y - gesture.start.y;
      if (gesture.shapes.every(({ shape, bounds }) =>
        shape.x === Math.round(bounds.x + dx) && shape.y === Math.round(bounds.y + dy))) return;
      for (const { shape, bounds } of gesture.shapes) {
        shape.x = Math.round(bounds.x + dx);
        shape.y = Math.round(bounds.y + dy);
      }
      if (gesture.shapes.some(({ shape }) => affectsBooleanGroup(shape))) recomputeBooleanGroups(currentPage);
      refresh();
    } else if (gesture.kind === 'resize') {
      const worldDx = position.x - gesture.start.x;
      const worldDy = position.y - gesture.start.y;
      const singleShape = gesture.shapes.length === 1 ? gesture.shapes[0].shape : null;
      const rotation = singleShape?.type === 'boolean' ? 0 : singleShape?.rotation ?? 0;
      const { x: dx, y: dy } = rotation ? rotateVector({ x: worldDx, y: worldDy }, -rotation) : { x: worldDx, y: worldDy };
      const horizontal = gesture.handle.includes('e') || gesture.handle.includes('w');
      const vertical = gesture.handle.includes('n') || gesture.handle.includes('s');
      if ((!horizontal || dx === 0) && (!vertical || dy === 0)) {
        for (const { shape, bounds, textSizing } of gesture.shapes) Object.assign(shape, bounds, { textSizing });
        if (gesture.shapes.some(({ shape }) => affectsBooleanGroup(shape))) recomputeBooleanGroups(currentPage);
        refresh();
        return;
      }
      const defaultLocked = singleShape?.type === 'image' ? singleShape.lockAspect !== false :
        singleShape?.lockAspect === true;
      const keepAspect = defaultLocked ? !event.shiftKey : event.shiftKey;
      const resized = snapResizeBounds(gesture.bounds, gesture.handle, dx, dy,
        keepAspect, gesture.workspace.camera.zoom, event.altKey);
      const scaleX = resized.width / gesture.bounds.width;
      const scaleY = resized.height / gesture.bounds.height;
      for (const { shape, bounds, textSizing } of gesture.shapes) {
        shape.x = Math.round((resized.x + (bounds.x - gesture.bounds.x) * scaleX) * 100) / 100;
        shape.y = Math.round((resized.y + (bounds.y - gesture.bounds.y) * scaleY) * 100) / 100;
        shape.width = Math.max(1, Math.round(bounds.width * scaleX * 100) / 100);
        shape.height = Math.max(1, Math.round(bounds.height * scaleY * 100) / 100);
        if (shape.type === 'text') {
          const widthChanged = shape.width !== bounds.width;
          const heightChanged = shape.height !== bounds.height;
          shape.textSizing = widthChanged || heightChanged
            ? gesture.handle === 'e' || gesture.handle === 'w'
              ? textSizing === 'fixed' ? 'fixed' : 'auto-height'
              : 'fixed'
            : textSizing;
          Object.assign(shape, textSize(shape));
        }
      }
      if (rotation && singleShape) {
        const oldCenter = center(gesture.bounds);
        const newCenter = center(singleShape);
        const shift = { x: newCenter.x - oldCenter.x, y: newCenter.y - oldCenter.y };
        const rotatedShift = rotateVector(shift, rotation);
        // Keep the opposite corner (or opposite edge midpoint) fixed in world space.
        singleShape.x += rotatedShift.x - shift.x;
        singleShape.y += rotatedShift.y - shift.y;
      }
      if (gesture.shapes.some(({ shape }) => affectsBooleanGroup(shape))) recomputeBooleanGroups(currentPage);
      refresh();
    } else if (gesture.kind === 'rotate') {
      const currentAngle = angleBetween(gesture.center, position);
      let rotation = normalizeAngle(gesture.startRotation + (currentAngle - gesture.startAngle));
      if (event.shiftKey) rotation = normalizeAngle(snapAngle(rotation));
      gesture.shape.rotation = rotation;
      if (gesture.descendants.length) {
        const delta = normalizeAngle(rotation - gesture.startRotation);
        for (const { shape, bounds, rotation: initial } of gesture.descendants) {
          if (shape.type === 'boolean') {
            shape.rotation = normalizeAngle(initial + delta);
            continue;
          }
          const midpoint = center(bounds);
          const next = rotateVector({ x: midpoint.x - gesture.center.x,
            y: midpoint.y - gesture.center.y }, delta);
          shape.x = Math.round((gesture.center.x + next.x - bounds.width / 2) * 100) / 100;
          shape.y = Math.round((gesture.center.y + next.y - bounds.height / 2) * 100) / 100;
          shape.rotation = normalizeAngle(initial + delta);
        }
      }
      if (affectsBooleanGroup(gesture.shape)) recomputeBooleanGroups(currentPage);
      refresh();
    } else if (gesture.kind === 'draw') {
      gesture.end = position;
      gesture.fine = event.altKey;
      setDraft({ ...gesture });
    } else {
      gesture.end = position;
      setMarquee({ ...gesture });
    }
  }
  function insertShape(item: Workspace, currentPage: DesignPage, type: DrawingTool, bounds: Bounds,
    from?: Point, to?: Point) {
    const before = type === 'text' ? snapshot(item) : null;
    if (type !== 'text') remember(item);
    const name = type === 'rect' ? 'Rectangle' : type[0].toUpperCase() + type.slice(1);
    const shape: Shape = {
      id: crypto.randomUUID(), type, name, ...bounds,
      fill: type === 'frame' ? '#ffffff' : '#3b5ee8',
      ...(type === 'text' ? { text: '', fontFamily: 'sans-serif', fontSize: 36,
        fontWeight: 400, fontStyle: 'normal' as const,
        textSizing: from && to && Math.abs(to.x - from.x) * item.camera.zoom >= 4
          ? 'fixed' as const : 'auto-width' as const } : {}),
      ...((type === 'line' || type === 'arrow') && from && to
        ? { flipX: to.x < from.x, flipY: to.y < from.y } : {}),
    };
    if (type === 'text') Object.assign(shape, textSize(shape));
    if (type === 'frame') {
      currentPage.shapes.unshift(shape);
      const frameOnly = [shape];
      for (const object of currentPage.shapes) {
        if (object !== shape && object.type !== 'frame' && !object.parentId &&
          containingFrame(frameOnly, object)) object.parentId = shape.id;
      }
    } else {
      shape.parentId = containingFrame(currentPage.shapes, shape);
      if (type === 'text' && shape.parentId) shape.fill = '#202b43';
      currentPage.shapes.push(shape);
    }
    if (type === 'text') beginTextEdit(item, shape, true, before!);
    else {
      item.selectedIds = [shape.id];
      setTool('select');
      changed(item);
    }
  }
  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (pendingPathAttach.current) {
      pendingPathAttach.current = null;
    }
    if (pendingTextEdit.current) {
      const { workspace: item, shape } = pendingTextEdit.current;
      pendingTextEdit.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      beginTextEdit(item, shape);
      return;
    }
    const gesture = drag.current;
    if (!gesture) return;
    pointerMove(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setDraft(null);
    setMarquee(null);
    if (gesture.kind === 'pan') return;
    const currentPage = gesture.workspace.session.document.pages.find(entry => entry.id === gesture.workspace.pageId);
    if (!currentPage) return;
    if (gesture.kind === 'path-offset') {
      if (gesture.shape.textPathOffset !== gesture.offset) {
        remember(gesture.workspace, gesture.before);
        changed(gesture.workspace);
      } else {
        const screen = screenPoint(event, event.currentTarget);
        lastTextTap.current = { id: gesture.shape.id, x: screen.x, y: screen.y, time: event.timeStamp };
      }
      return;
    }
    if (gesture.kind === 'move' || gesture.kind === 'resize') {
      const modified = gesture.shapes.some(({ shape, bounds }) => shape.x !== bounds.x || shape.y !== bounds.y ||
        shape.width !== bounds.width || shape.height !== bounds.height) ||
        (gesture.kind === 'resize' && gesture.shapes.some(({ shape, textSizing }) => shape.textSizing !== textSizing));
      if (modified) {
        if (gesture.kind === 'move') {
          const movedFrames = new Set(gesture.shapes.filter(({ shape }) => shape.type === 'frame').map(({ shape }) => shape.id));
          for (const { shape } of gesture.shapes) {
            if (shape.type !== 'frame' && !movedFrames.has(shape.parentId ?? '') &&
              !currentPage.shapes.some(parent => parent.id === shape.parentId && parent.type === 'boolean'))
              shape.parentId = containingFrame(currentPage.shapes, shape);
          }
        }
        remember(gesture.workspace, gesture.before);
        changed(gesture.workspace);
      }
      if (!modified && gesture.kind === 'move' && gesture.shapes.length === 1 &&
        gesture.shapes[0].shape.type === 'text') {
        const screen = screenPoint(event, event.currentTarget);
        lastTextTap.current = { id: gesture.shapes[0].shape.id,
          x: screen.x, y: screen.y, time: event.timeStamp };
      }
      return;
    }
    if (gesture.kind === 'rotate') {
      if (gesture.shape.rotation !== gesture.startRotation) {
        remember(gesture.workspace, gesture.before);
        changed(gesture.workspace);
      }
      return;
    }
    if (gesture.kind === 'marquee') {
      const area = drawBounds(gesture.start, gesture.end, 'rect');
      if (Math.abs(gesture.end.x - gesture.start.x) * gesture.workspace.camera.zoom < 4 &&
        Math.abs(gesture.end.y - gesture.start.y) * gesture.workspace.camera.zoom < 4) return;
      const hits = marqueeHits(currentPage.shapes, area).map(shape => shape.id);
      setSelection(gesture.workspace, gesture.additive ? [...new Set([...gesture.workspace.selectedIds, ...hits])] : hits);
      return;
    }
    insertShape(gesture.workspace, currentPage, gesture.type,
      snapDrawBounds(gesture.start, gesture.end, gesture.type, gesture.workspace.camera.zoom, gesture.fine),
      gesture.start, gesture.end);
  }
  function pointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    pendingTextEdit.current = null;
    pendingPathAttach.current = null;
    const gesture = drag.current;
    if (!gesture) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (gesture.kind === 'move' || gesture.kind === 'resize') {
      for (const { shape, bounds } of gesture.shapes) Object.assign(shape, bounds);
      if (gesture.kind === 'resize')
        for (const { shape, textSizing } of gesture.shapes) shape.textSizing = textSizing;
    }
    if (gesture.kind === 'path-offset') gesture.shape.textPathOffset = gesture.offset;
    if (gesture.kind === 'rotate') {
      gesture.shape.rotation = gesture.startRotation;
      for (const { shape, bounds, rotation } of gesture.descendants) Object.assign(shape, bounds, { rotation });
    }
    const current = gesture.workspace.session.document.pages.find(entry => entry.id === gesture.workspace.pageId);
    if (current?.shapes.some(shape => shape.type === 'boolean')) recomputeBooleanGroups(current);
    drag.current = null;
    setDraft(null);
    setMarquee(null);
    refresh();
  }
  function openContextMenu(event: ReactMouseEvent<SVGSVGElement>) {
    if (!workspace || !page) return;
    event.preventDefault();
    const shape = page.shapes.find(entry => entry.id === (event.target as Element)
      .closest('[data-shape-id]')?.getAttribute('data-shape-id'));
    if (shape && !workspace.selectedIds.includes(shape.id)) setSelection(workspace, [shape.id]);
    else if (!shape) setSelection(workspace, []);
    setMenu({ x: Math.min(event.clientX, window.innerWidth - 210),
      y: Math.min(event.clientY, window.innerHeight - 310),
      world: worldAt(workspace.camera, screenPoint(event, event.currentTarget)) });
  }

  shortcutHandler.current = event => {
    if (modal || event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Escape') {
      if (booleanMenu) { setBooleanMenu(null); booleanTriggerRef.current?.focus(); event.preventDefault(); return; }
      if (menu) { setMenu(null); event.preventDefault(); return; }
      if (shapeMenu) { setShapeMenu(false); event.preventDefault(); return; }
      if (textMenu) { setTextMenu(false); event.preventDefault(); return; }
      if (editingGroupId && workspace) {
        setEditingGroupId(null);
        setSelection(workspace, [editingGroupId]);
        event.preventDefault();
        return;
      }
      if (workspace) { drag.current = null; setDraft(null); spaceHeld.current = false; setTool('select'); setSelection(workspace, []); }
      return;
    }
    if (menu || shapeMenu || textMenu || booleanMenu || isEditable(event.target)) return;
    if (workspace && event.key === ' ') {
      event.preventDefault();
      spaceHeld.current = true;
      refresh();
      return;
    }
    if (workspace && (event.key === 'Delete' || event.key === 'Backspace') && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (workspace.selectedIds.length) { event.preventDefault(); removeSelection(workspace); }
      return;
    }
    if (workspace && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) &&
      !event.metaKey && !event.ctrlKey && !event.altKey && workspace.selectedIds.length) {
      event.preventDefault();
      remember(workspace);
      const step = event.shiftKey ? 10 : 1;
      const x = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const y = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      if (page) {
        const moved = selectedWithChildren(page.shapes, workspace.selectedIds).filter(shape => !lockedIds.has(shape.id));
        const movedIds = new Set(moved.map(shape => shape.id));
        const movedFrames = new Set(moved.filter(shape => shape.type === 'frame').map(shape => shape.id));
        for (const shape of moved) {
          if (shape.textPathId && !movedIds.has(shape.textPathId)) {
            shape.textPathOffset = Math.min(100, Math.max(0,
              (shape.textPathOffset ?? 0) + (x || y)));
          } else { shape.x += x; shape.y += y; }
        }
        for (const shape of moved) {
          if (shape.textPathId) continue;
          if (shape.type !== 'frame' && !movedFrames.has(shape.parentId ?? '') &&
            !page.shapes.some(parent => parent.id === shape.parentId && parent.type === 'boolean'))
            shape.parentId = containingFrame(page.shapes, shape);
        }
      }
      changed(workspace);
      return;
    }
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (workspace && mod && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'z' || (key === 'y' && !event.shiftKey)) {
        event.preventDefault();
        history(workspace, event.shiftKey || key === 'y' ? 'redo' : 'undo');
        return;
      }
      if (!event.shiftKey && ['c', 'v', 'd', 'a'].includes(key)) {
        event.preventDefault();
        if (key === 'c') copySelection(workspace);
        if (key === 'v') pasteSelection(workspace);
        if (key === 'd') duplicateSelection(workspace);
        if (key === 'a' && page) setSelection(workspace, page.shapes.filter(shape => !hiddenOperandIds.has(shape.id) && !lockedIds.has(shape.id)).map(shape => shape.id));
        return;
      }
    }
    if (workspace && !mod && !event.altKey && (event.key === ']' || event.key === '[') && workspace.selectedIds.length) {
      event.preventDefault();
      arrangeSelection(workspace, event.key === ']' ? 'front' : 'back');
      return;
    }
    if (workspace && !mod && !event.altKey && ['=', '+', '-'].includes(event.key)) {
      event.preventDefault();
      zoomView(workspace, workspace.camera.zoom * (event.key === '-' ? 1 / 1.25 : 1.25));
      return;
    }
    const combo = keyCombo(event);
    if (!combo || !shortcutAllowed(combo)) return;
    const action = actions.find(([key]) => effectiveShortcuts[key] === combo)?.[0];
    if (!action || (!combo.includes('Mod') && !workspace)) return;
    event.preventDefault();
    if (action === 'new') createDocument();
    else if (action === 'open') void openDocument();
    else if (action === 'save') void saveActive();
    else if (action === 'saveAs') void saveActive(true);
    else if (action === 'export' && workspace) setModal({ kind: 'export' });
    else if (['union', 'subtract', 'intersect', 'exclude', 'flatten'].includes(action) && workspace)
      applyBoolean(workspace, action as BooleanOperation);
    else if (action === 'ungroup' && workspace) ungroupSelection(workspace);
    else if (action === 'hide' && workspace) toggleHidden(workspace);
    else if (action === 'lock' && workspace) toggleLocked(workspace);
    else if ((action === 'flipH' || action === 'flipV' || action === 'rotate90') && workspace) transformSelection(workspace, action);
    else if (['select', 'hand', 'frame', 'rect', 'line', 'arrow', 'ellipse', 'polygon', 'star', 'text', 'textPath'].includes(action) && workspace) {
      setTool(action as Tool);
      const shapeChoice = shapeChoices.find(([type]) => type === action);
      if (shapeChoice) setLastShape(shapeChoice[0]);
      if (action === 'text' || action === 'textPath') setLastTextTool(action);
    }
  };
  useEffect(() => {
    let live = true;
    const onKey = (event: KeyboardEvent) => shortcutHandler.current(event);
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') { spaceHeld.current = false; refresh(); }
    };
    const onVisible = () => { if (document.visibilityState === 'hidden') void flushAll(); };
    const onUnload = (event: BeforeUnloadEvent) => {
      if (!('__TAURI_INTERNALS__' in window) && workspaces.current.some(item => item.session.dirty)) {
        event.preventDefault(); event.returnValue = '';
      }
      void flushAll();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('beforeunload', onUnload);
    void Promise.allSettled([
      Promise.resolve().then(loadAppState),
      Promise.resolve().then(listFonts),
      Promise.resolve().then(listRecovery),
    ]).then(results => {
      if (!live) return;
      const [stateResult, fontResult, recoveryResult] = results;
      if (stateResult.status === 'fulfilled') {
        recentRef.current = stateResult.value.recent;
        setRecent(stateResult.value.recent);
        preferencesRef.current = stateResult.value.preferences;
        setPreferences(stateResult.value.preferences);
        setStatus('Ready to make something');
      } else fail('Native storage unavailable', stateResult.reason);
      if (fontResult.status === 'fulfilled')
        setFonts([...fontResult.value, ...genericFonts.filter(font => !fontResult.value.some(entry => entry.family === font.family))]);
      else fail('Could not discover installed fonts', fontResult.reason);
      if (recoveryResult.status === 'fulfilled' && recoveryResult.value.length) {
        setRecoveries(recoveryResult.value);
        setModal({ kind: 'recovery' });
      } else if (recoveryResult.status === 'rejected') fail('Could not check recovery copies', recoveryResult.reason);
    });
    let unlisten: (() => void) | undefined;
    if ('__TAURI_INTERNALS__' in window) {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        const nativeWindow = getCurrentWindow();
        return nativeWindow.onCloseRequested(async event => {
          if (closing.current) return;
          event.preventDefault();
          const okay = await flushAll();
          if (!okay && !window.confirm('Some changes could not be saved. Close anyway?')) return;
          closing.current = true;
          await nativeWindow.destroy();
        });
      }).then(stop => { if (live) unlisten = stop; else stop(); })
        .catch(cause => fail('Could not prepare safe-close handler', cause));
    }
    return () => {
      live = false;
      unlisten?.();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = preferences.theme; }, [preferences.theme]);
  useEffect(() => {
    if (!canvasElement || !workspace) return;
    const item = workspace;
    let previous = { width: canvasElement.clientWidth, height: canvasElement.clientHeight };
    const observer = new ResizeObserver(() => {
      const width = canvasElement.clientWidth;
      const height = canvasElement.clientHeight;
      if (!width || !height) return;
      if (!item.cameraReady) {
        const initialPage = item.session.document.pages.find(entry => entry.id === item.pageId);
        item.camera = fitCamera(width, height,
          initialPage?.shapes.length ? pageBounds(initialPage) : undefined);
        item.cameraReady = true;
      } else {
        item.camera.x += (width - previous.width) / 2;
        item.camera.y += (height - previous.height) / 2;
      }
      previous = { width, height };
      setCanvasSize(previous);
      refresh();
    });
    observer.observe(canvasElement);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const screen = screenPoint(event, canvasElement);
        item.camera = zoomAt(item.camera, item.camera.zoom * Math.exp(-event.deltaY * 0.002), screen);
      } else {
        item.camera.x -= event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
        item.camera.y -= event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      }
      refresh();
    };
    canvasElement.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); canvasElement.removeEventListener('wheel', wheel); };
  }, [canvasElement, activeKey]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menu]);
  useEffect(() => {
    if (!shapeMenu) return;
    shapeMenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!shapeMenuRef.current?.contains(event.target as Node) &&
        !(event.target as Element).closest('.shape-tool-trigger')) setShapeMenu(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [shapeMenu]);
  useEffect(() => {
    if (!textMenu) return;
    textMenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!textMenuRef.current?.contains(event.target as Node) &&
        !(event.target as Element).closest('.text-tool-trigger')) setTextMenu(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [textMenu]);
  useEffect(() => {
    if (!booleanMenu) return;
    booleanMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!booleanMenuRef.current?.contains(event.target as Node) &&
        !booleanTriggerRef.current?.contains(event.target as Node)) setBooleanMenu(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [booleanMenu]);
  useEffect(() => {
    const root = richEditorRef.current;
    const shape = editingShapeRef();
    if (!root || !shape) return;
    buildEditorContent(root, shape.text ?? '', shape.styleRuns ?? [], shapeDefaults(shape));
    root.focus();
    const end = (shape.text ?? '').length;
    setSelectionOffsets(root, end, end);
  }, [editingText?.shapeId, editingText?.workspaceKey]);
  useEffect(() => {
    if (!editingText) return;
    const handler = () => {
      const root = richEditorRef.current;
      if (!root || document.activeElement !== root) return;
      setEditingText(previous => previous && { ...previous, selection: getSelectionOffsets(root) });
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [editingText?.shapeId, editingText?.workspaceKey]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();
    const onDialogKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRecording(null);
        setModal(null);
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const elements = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)'));
      if (!elements.length) { event.preventDefault(); return; }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onDialogKey);
    return () => { document.removeEventListener('keydown', onDialogKey); previous?.focus(); };
  }, [modal]);

  const activeShapeType = selected ? selected.type[0].toUpperCase() + selected.type.slice(1) : 'Canvas';
  const updateSelected = (changes: Partial<Shape>) => { if (workspace && selected) editShape(workspace, selected, changes); };
  const activeShape = selected?.type === 'text' ? selected : undefined;
  const textSelection = activeShape && editingText && editingText.workspaceKey === workspace?.key &&
    editingText.shapeId === activeShape.id && editingText.selection &&
    editingText.selection.start !== editingText.selection.end ? editingText.selection : null;
  const textSelectionStyle = textSelection && richEditorRef.current && activeShape
    ? selectionStyleSummary(richEditorRef.current, textSelection.start, textSelection.end,
      shapeDefaults(activeShape)) : null;
  function updateTextStyle(changes: Partial<TextRunStyle>) {
    if (!workspace || !activeShape) return;
    const root = richEditorRef.current;
    if (textSelection && root) {
      applyRunStyle(root, textSelection.start, textSelection.end, changes, shapeDefaults(activeShape));
      syncEditorFromDom();
    } else editShape(workspace, activeShape, changes);
  }
  const cornerRadii = selected?.cornerRadii ?? zeroCorners;
  function numberField(label: string, field: 'x' | 'y' | 'width' | 'height', value: number) {
    return <NumberField label={label} value={value}
      min={field === 'width' || field === 'height' ? 1 : undefined}
      onCommit={next => updateSelected({ [field]: next })}/>;
  }
  const cornersSplit = !!selected && (expandedCorners.has(selected.id) ||
    cornerRadii.some(radius => radius !== cornerRadii[0]));
  const selectedSiblings = selected && page ? page.shapes.filter(shape =>
    shape.parentId === selected.parentId && (shape.type === 'frame') === (selected.type === 'frame')) : [];
  const selectedOrder = selected ? selectedSiblings.indexOf(selected) : -1;
  const selectedFont = fonts.find(font => font.family === (selected?.fontFamily ?? 'sans-serif'));
  const selectedFontStyle = `${selected?.fontWeight ?? 400}:${selected?.fontStyle ?? 'normal'}`;

  const frameLayers: Shape[] = [];
  const outsideLayers: Shape[] = [];
  const layerChildren = new Map<string, Shape[]>();
  for (const shape of page?.shapes ?? []) {
    if (shape.guide) continue;
    if (shape.type === 'frame') frameLayers.push(shape);
    else if (shape.parentId) {
      const children = layerChildren.get(shape.parentId) ?? [];
      children.push(shape);
      layerChildren.set(shape.parentId, children);
    } else outsideLayers.push(shape);
  }
  frameLayers.reverse();
  outsideLayers.reverse();
  for (const children of layerChildren.values()) children.reverse();
  function layerButton(shape: Shape) {
    const Icon = shape.type === 'frame' ? Frame : shape.type === 'rect' ? RectangleHorizontal :
      shape.type === 'ellipse' ? Circle : shape.type === 'image' ? ImagePlus :
      shape.type === 'line' ? Slash : shape.type === 'arrow' ? ArrowUpRight :
      shape.type === 'polygon' ? Triangle : shape.type === 'star' ? Star :
      shape.type === 'boolean' ? booleanChoices.find(([operation]) => operation === shape.booleanOperation)?.[1] ?? Combine :
      shape.type === 'vector' ? Combine : TypeIcon;
    return <div className={`layer-row ${workspace?.selectedIds.includes(shape.id) ? 'active' : ''}${hiddenIds.has(shape.id) ? ' is-hidden' : ''}${lockedIds.has(shape.id) ? ' is-locked' : ''}`}
      onContextMenu={event => {
        if (!workspace) return;
        event.preventDefault();
        if (!workspace.selectedIds.includes(shape.id)) setSelection(workspace, [shape.id]);
        setEditingGroupId(shape.parentId && shapeById.get(shape.parentId)?.type === 'boolean' ? shape.parentId : null);
        setTool('select');
        setMenu({ x: Math.min(event.clientX, window.innerWidth - 230),
          y: Math.min(event.clientY, window.innerHeight - 380), layer: true, world: center(shape) });
      }}>
      <button className="layer-select" title={`Select ${shape.name}`} aria-label={`Select ${shape.name}`}
        aria-pressed={workspace?.selectedIds.includes(shape.id)} onClick={event => {
          if (!workspace) return;
          setEditingGroupId(shape.parentId && shapeById.get(shape.parentId)?.type === 'boolean'
            ? shape.parentId : null);
          setSelection(workspace, event.shiftKey
            ? workspace.selectedIds.includes(shape.id) ? workspace.selectedIds.filter(id => id !== shape.id)
              : [...workspace.selectedIds, shape.id] : [shape.id]);
          setTool('select');
        }}><Icon size={15}/></button>
      {renaming?.surface === 'layer' && renaming.shapeId === shape.id && renaming.workspaceKey === workspace?.key
        ? <input className="layer-name-input" aria-label={`Rename ${shape.name}`} value={renaming.value}
          ref={node => { if (node && document.activeElement !== node) { node.focus(); node.select(); } }}
          onChange={event => setRenaming({ ...renaming, value: event.target.value })}
          onBlur={event => finishRename(event.currentTarget.value)}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') { event.currentTarget.value = shape.name; event.currentTarget.blur(); }
          }}/>
        : <button className="layer-name" title={`Rename ${shape.name}`} aria-label={`Rename ${shape.name}`}
          onClick={() => { if (workspace) beginRename(workspace, shape, 'layer'); }}>{shape.name}</button>}
      {shape.type !== 'frame' && shape.type !== 'boolean' && <span className="layer-leaf-spacer" aria-hidden="true"/>}
      <button className={`layer-action${shape.locked ? ' on' : ''}`} aria-pressed={!!shape.locked}
        title={shape.locked ? 'Unlock' : 'Lock'} aria-label={`${shape.locked ? 'Unlock' : 'Lock'} ${shape.name}`}
        onClick={() => { if (workspace) toggleLocked(workspace, [shape.id]); }}>
        {lockedIds.has(shape.id) ? <Lock size={13}/> : <LockOpen size={13}/>}</button>
      <button className={`layer-action${shape.hidden ? ' on' : ''}`} aria-pressed={!!shape.hidden}
        title={shape.hidden ? 'Show' : 'Hide'} aria-label={`${shape.hidden ? 'Show' : 'Hide'} ${shape.name}`}
        onClick={() => { if (workspace) toggleHidden(workspace, [shape.id]); }}>
        {hiddenIds.has(shape.id) ? <EyeOff size={13}/> : <Eye size={13}/>}</button>
    </div>;
  }
  function layerEntry(shape: Shape): ReactElement {
    const children = layerChildren.get(shape.id) ?? [];
    if (shape.type !== 'frame' && shape.type !== 'boolean')
      return <div key={shape.id}>{layerButton(shape)}</div>;
    const collapsed = collapsedLayers.has(shape.id);
    return <div className="layer-frame-group" key={shape.id}>
      <div className="frame-row">
        <button className="tiny-button" aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${shape.name}`}
          aria-expanded={!collapsed} onClick={() => setCollapsedLayers(previous => {
            const next = new Set(previous);
            if (next.has(shape.id)) next.delete(shape.id); else next.add(shape.id);
            return next;
          })}><ChevronRight size={14} className={collapsed ? '' : 'expanded'}/></button>
        {layerButton(shape)}<span className="count">{children.length}</span>
      </div>
      {!collapsed && children.map(child =>
        <div className="layer-child" key={child.id}>{layerEntry(child)}</div>)}
    </div>;
  }
  /** Thin edge highlight that follows a selected shape's real geometry (not its bounding box). */
  function edgeOutline(shape: Shape) {
    const zoom = workspace?.camera.zoom ?? 1;
    const host = shape.textPathId ? shapeById.get(shape.textPathId) : undefined;
    const draw = (key: string, stroke: string, width: number) => {
      const common = { key, fill: 'none', stroke, strokeWidth: width / zoom,
        strokeLinejoin: 'round' as const, pointerEvents: 'none' as const };
      if (host) return <path {...common} d={textPathForShape(host, shape.textPathFlip)}/>;
      if (shape.type === 'ellipse') return <ellipse {...common} cx={shape.x + shape.width / 2}
        cy={shape.y + shape.height / 2} rx={shape.width / 2} ry={shape.height / 2}/>;
      if (shape.type === 'line' || shape.type === 'arrow' || shape.type === 'polygon' || shape.type === 'star')
        return <path {...common} d={pathForShape(shape)}/>;
      if (shape.type === 'vector' || shape.type === 'boolean') return <path {...common} d={shape.pathData}
        transform={`translate(${shape.x} ${shape.y}) scale(${shape.width} ${shape.height})`}
        vectorEffect="non-scaling-stroke" strokeWidth={width}/>;
      if (shape.type === 'text') return <rect {...common} x={shape.x} y={shape.y} width={shape.width} height={shape.height}/>;
      return <path {...common} d={roundedRectPath(shape)}/>;
    };
    // White halo keeps the edge visible over same-colored fills.
    return <g key={`edge-${shape.id}`} transform={host ? rotateTransform(host, host.rotation) : shapeTransform(shape)}>
      {draw('halo', '#ffffff', 3.5)}{draw('edge', '#3b5ee8', 1.5)}</g>;
  }
  /** Objects a marquee over `area` would select; shared by the live preview and the release commit. */
  function marqueeHits(shapes: Shape[], area: Bounds): Shape[] {
    return shapes.filter(shape =>
      (!hiddenOperandIds.has(shape.id) || shape.parentId === editingGroupId) &&
      !hiddenIds.has(shape.id) && !lockedIds.has(shape.id) &&
      shape.x < area.x + area.width && shape.x + shape.width > area.x &&
      shape.y < area.y + area.height && shape.y + shape.height > area.y);
  }
  function canvasLabel(shape: Shape) {
    const zoom = workspace?.camera.zoom ?? 1;
    return <text className="frame-label" x={shape.x} y={shape.y - 10 / zoom}
      fontSize={12 / zoom} role="button" tabIndex={0} aria-label={`Rename ${shape.name}`}
      onPointerDown={event => event.stopPropagation()}
      onClick={() => { if (workspace) beginRename(workspace, shape, 'canvas'); }}
      onKeyDown={event => {
        if ((event.key === 'Enter' || event.key === ' ') && workspace) {
          event.preventDefault();
          event.stopPropagation();
          beginRename(workspace, shape, 'canvas');
        }
      }}>{shape.name}</text>;
  }


  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => setActiveKey(null)} aria-label="Go to welcome screen"><span className="brand-mark"><Layers3 size={18} strokeWidth={2.2}/></span><span>punakawan<span className="brand-dot">.</span></span></button>
      <span className="top-divider" aria-hidden="true" />
      <span className="top-context">{workspace ? 'Design workspace' : 'Your workspace'}</span>
      <div className="top-spacer" />
      {recoveries.length > 0 && <button className="button quiet" onClick={() => setModal({ kind: 'recovery' })}>Recovery ({recoveries.length})</button>}
      {workspace && <><button className="button quiet" onClick={() => void saveActive(true)}><Ellipsis size={16}/> Save as</button>
        <button className="button quiet" onClick={() => setModal({ kind: 'export' })}><Download size={16}/> Export</button>
        <button className="button primary" onClick={() => void saveActive()}><Save size={16}/> Save<span className="shortcut-hint">{effectiveShortcuts.save || ' '}</span></button></>}
      <button className="icon-button settings-button" title="Preferences" aria-label="Open preferences" onClick={() => setModal({ kind: 'preferences' })}><Settings2 size={18}/></button>
    </header>
    <div className="tabbar" role="tablist" aria-label="Open designs">
      <button className={`home-tab ${!workspace ? 'current' : ''}`} role="tab" aria-selected={!workspace} onClick={() => setActiveKey(null)}>Home</button>
      {workspaces.current.map(item => <div className={`file-tab ${workspace === item ? 'current' : ''}`} key={item.key}>
        <button role="tab" aria-selected={workspace === item} onClick={() => setActiveKey(item.key)} title={item.session.path ?? 'Not saved yet'}>
          <span className={`dirty-dot ${item.session.dirty ? 'visible' : ''}`} aria-label={item.session.dirty ? 'Unsaved changes' : undefined}/>
          {item.session.document.name}</button><button className="tab-close" aria-label={`Close ${item.session.document.name}`} onClick={() => void closeWorkspace(item)}><X size={13}/></button>
      </div>)}
      <button className="new-tab" title="New design" aria-label="New design" onClick={createDocument}><Plus size={16}/></button>
    </div>
    {workspace && page ? <main className="workspace-layout" aria-label="Design editor" style={{ gridTemplateColumns: `${leftRailWidth}px minmax(400px, 1fr) ${rightRailWidth}px` }}>
      <aside className="left-rail" aria-label="Pages and layers">
        <div className="rail-heading"><div><span className="section-label">FILE</span><h2>Pages <span className="count">{workspace.session.document.pages.length}</span></h2></div>
          <button className="icon-button" title="Add page" aria-label="Add page" onClick={() => addPage(workspace)}><Plus size={17}/></button></div>
        <div className="page-list">{workspace.session.document.pages.map((entry, index) => <div className={`page-row ${entry.id === page.id ? 'active' : ''}`} key={entry.id}>
          <button className="page-entry" aria-label={`Open ${entry.name}`} aria-current={entry.id === page.id ? 'page' : undefined} onClick={() => { workspace.pageId = entry.id; workspace.selectedIds = []; refresh(); }}>
            <span className="page-index">{String(index + 1).padStart(2, '0')}</span><span className="page-name">{entry.name}</span><span className="page-count">{entry.shapes.length}</span></button>
          {entry.id === page.id && <div className="page-actions"><button className="tiny-button" title="Duplicate page" aria-label={`Duplicate ${entry.name}`} onClick={() => duplicatePage(workspace, entry)}><Copy size={13}/></button>
            <button className="tiny-button" disabled={workspace.session.document.pages.length === 1} title="Delete page" aria-label={`Delete ${entry.name}`} onClick={() => deletePage(workspace, entry)}><Trash2 size={13}/></button></div>}</div>)}</div>
        <div className="rail-separator"/>
        <div className="rail-heading compact"><div><span className="section-label">ON THIS CANVAS</span><h2>Layers <span className="count">{page.shapes.filter(shape => !shape.guide).length}</span></h2></div></div>
        {page.shapes.length ? <div className="layer-list">
          {outsideLayers.map(layerEntry)}
          {frameLayers.map(layerEntry)}
        </div> : <p className="rail-empty">No layers yet. Draw anywhere, or press F to add a frame.</p>}
        <div className="rail-foot"><span className="section-label">DOCUMENT</span><span>{workspace.session.path ? basename(workspace.session.path) : 'Not saved to disk'}</span></div>
      </aside>
      <div
        className="rail-divider rail-divider-left"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize pages and layers panel"
        style={{ left: leftRailWidth, transform: 'translateX(-50%)' }}
        onPointerDown={event => {
          railDrag.current = { side: 'left', startX: event.clientX, startWidth: leftRailWidth };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const gesture = railDrag.current;
          if (!gesture || gesture.side !== 'left') return;
          const limit = (event.currentTarget.parentElement?.clientWidth ?? window.innerWidth) - rightRailWidth - 400;
          setLeftRailWidth(Math.max(228, Math.min(limit, gesture.startWidth + event.clientX - gesture.startX)));
        }}
        onPointerUp={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          railDrag.current = null;
        }}
        onPointerCancel={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          railDrag.current = null;
        }}
      />
      <section className="work-area" aria-label="Canvas">
        <div className="canvas-toolbar"><div className="tool-cluster" role="toolbar" aria-label="Drawing tools">
          {([['select', MousePointer2, 'Select'], ['hand', Hand, 'Hand'], ['frame', Frame, 'Frame']] as const).map(([key, Icon, label]) =>
            <button key={key} className={`tool-button ${tool === key ? 'active' : ''}`} title={`${label} (${effectiveShortcuts[key] || 'unassigned'})`} aria-label={`${label} tool`} aria-pressed={tool === key} onClick={() => { setTool(key); setShapeMenu(false); }}><Icon size={17}/><span>{label}</span></button>)}
          <div className="shape-tool-wrap">
            <button className={`tool-button ${tool === lastShape ? 'active' : ''}`}
              title={`${currentShape[2]} (${effectiveShortcuts[lastShape] || 'unassigned'})`}
              aria-label={`${currentShape[2]} tool`} aria-pressed={tool === lastShape}
              onClick={() => { setTool(lastShape); setShapeMenu(false); }}><CurrentShapeIcon size={17}/><span>{currentShape[2]}</span></button>
            <button className="shape-tool-trigger shape-dropdown-toggle" title="Choose shape" aria-label="Choose shape"
              aria-haspopup="menu" aria-expanded={shapeMenu} onClick={() => setShapeMenu(!shapeMenu)}><ChevronDown size={14}/></button>
            {shapeMenu && <div ref={shapeMenuRef} className="shape-picker" role="menu" aria-label="Shape tools">
              {shapeChoices.map(([key, Icon, label]) => <button key={key} className="shape-option" role="menuitem"
                onClick={() => { setTool(key); setLastShape(key); setShapeMenu(false); }}>
                <Icon size={16}/><span>{label}</span><small>{effectiveShortcuts[key] || ''}</small>
              </button>)}
              <span className="menu-separator"/>
              <button className="shape-option" role="menuitem" onClick={() => { setShapeMenu(false); void importImage(); }}>
                <ImagePlus size={16}/><span>Image</span><small>Import</small>
              </button>
            </div>}
          </div>
          <div className="text-tool-wrap">
            <button className={`tool-button ${tool === lastTextTool ? 'active' : ''}`}
              title={`${currentTextTool[2]} (${effectiveShortcuts[lastTextTool] || 'unassigned'})`}
              aria-label={`${currentTextTool[2]} tool`} aria-pressed={tool === lastTextTool}
              onClick={() => {
                if (lastTextTool === 'textPath' && workspace) activateTextPath(workspace);
                else { setTool('text'); setLastTextTool('text'); setShapeMenu(false); setTextMenu(false); }
              }}><CurrentTextIcon size={17}/><span>{currentTextTool[2]}</span></button>
            <button className="text-tool-trigger text-dropdown-toggle" title="Choose text tool" aria-label="Choose text tool"
              aria-haspopup="menu" aria-expanded={textMenu} onClick={() => { setTextMenu(!textMenu); setShapeMenu(false); }}><ChevronDown size={14}/></button>
            {textMenu && <div ref={textMenuRef} className="text-picker shape-picker" role="menu" aria-label="Text tools">
              <button className={`shape-option ${lastTextTool === 'text' ? 'active' : ''}`} role="menuitem"
                onClick={() => { setTool('text'); setLastTextTool('text'); setTextMenu(false); }}>
                <TypeIcon size={16}/><span>Text</span><small>{effectiveShortcuts.text || ''}</small>
              </button>
              <button className={`shape-option ${lastTextTool === 'textPath' ? 'active' : ''}`} role="menuitem"
                onClick={() => { if (workspace) activateTextPath(workspace); else { setTool('textPath'); setLastTextTool('textPath'); setTextMenu(false); } }}>
                <Spline size={16}/><span>Text on path</span><small>{effectiveShortcuts.textPath || ''}</small>
              </button>
            </div>}
          </div>
        </div>
          {tool !== 'select' && tool !== 'hand' && <button className="button quiet add-object" title="Add an object at the center of the view" onClick={() => {
            const center = worldAt(workspace.camera, { x: canvasSize.width / 2, y: canvasSize.height / 2 });
            if (tool === 'textPath') {
              spawnTextOnPathAt(workspace, page, center);
            } else {
              const bounds = drawBounds(center, center, tool);
              insertShape(workspace, page, tool, { ...bounds, x: center.x - bounds.width / 2, y: center.y - bounds.height / 2 });
            }
          }}><Plus size={16}/> Add {tool === 'textPath' ? 'text on path' : tool} to canvas</button>}
          <span className="toolbar-divider"/><button className="button quiet import-button" aria-label="Import image" title="Import image" onClick={() => void importImage()}><ImagePlus size={17}/> Import image</button>
          <div className="top-spacer"/>
          <div className="view-controls" role="group" aria-label="Canvas view">
            <button className="icon-button" title="Undo (Mod+Z)" aria-label="Undo" disabled={!workspace.undo.length} onClick={() => history(workspace, 'undo')}><Undo2 size={16}/></button>
            <button className="icon-button" title="Redo (Mod+Shift+Z)" aria-label="Redo" disabled={!workspace.redo.length} onClick={() => history(workspace, 'redo')}><Redo2 size={16}/></button>
            <span className="toolbar-divider"/>
            <button className="icon-button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomView(workspace, workspace.camera.zoom / 1.25)}><Minus size={16}/></button>
            <button className="zoom-value" title="Reset to 100%" onClick={() => zoomView(workspace, 1)}>{Math.round(workspace.camera.zoom * 100)}%</button>
            <button className="icon-button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomView(workspace, workspace.camera.zoom * 1.25)}><Plus size={16}/></button>
            <button className="icon-button" title="Fit content in view" aria-label="Fit content in view" onClick={() => fitView(workspace)}><Maximize2 size={16}/></button>
          </div>
        </div>
        <div className="canvas-viewport">
          <svg ref={setCanvasElement} className={`infinite-canvas tool-${tool}${spaceHeld.current ? ' panning' : ''}${drag.current?.kind === 'rotate' ? ' rotating' : ''}`}
            width="100%" height="100%" viewBox={`0 0 ${canvasSize.width || 1} ${canvasSize.height || 1}`}
            role="img" aria-label={`${page.name} infinite design canvas; drag a tool to draw, select objects to resize, space-drag to pan`}
            onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel}
            onDragStart={event => event.preventDefault()}
            onContextMenu={openContextMenu} onDoubleClick={event => {
              if (tool === 'textPath') return;
              const targetId = (event.target as Element).closest('[data-shape-id]')?.getAttribute('data-shape-id')
                ?? lastCanvasShape.current;
              const target = page.shapes.find(entry => entry.id === targetId);
              if (target?.type === 'text') { beginTextEdit(workspace, target); return; }
              const group = target?.type === 'boolean' ? target :
                target?.parentId && shapeById.get(target.parentId)?.type === 'boolean'
                  ? shapeById.get(target.parentId) : undefined;
              if (!group || group.type !== 'boolean') return;
              const position = worldAt(workspace.camera, screenPoint(event, event.currentTarget));
              let child: Shape | undefined;
              for (let index = page.shapes.length - 1; index >= 0; index--) {
                const candidate = page.shapes[index];
                if (candidate.parentId === group.id &&
                  position.x >= candidate.x && position.x <= candidate.x + candidate.width &&
                  position.y >= candidate.y && position.y <= candidate.y + candidate.height) {
                  child = candidate;
                  break;
                }
              }
              setEditingGroupId(group.id);
              setCollapsedLayers(previous => {
                if (!previous.has(group.id)) return previous;
                const next = new Set(previous);
                next.delete(group.id);
                return next;
              });
              setSelection(workspace, [child?.id ?? group.id]);
            }}>
            <defs><pattern id="canvas-dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--canvas-dot)"/></pattern>
              {page.shapes.filter(shape => shape.textPathId).map(shape => {
                const host = page.shapes.find(entry => entry.id === shape.textPathId);
                return host ? <path key={shape.id} id={`text-path-${shape.id}`}
                  d={textPathForShape(host, shape.textPathFlip)}/> : null;
              })}
            </defs>
            <g transform={`translate(${workspace.camera.x} ${workspace.camera.y}) scale(${workspace.camera.zoom})`}>
              {workspace.camera.zoom >= .3 && canvasSize.width > 0 && <rect
                x={-workspace.camera.x / workspace.camera.zoom} y={-workspace.camera.y / workspace.camera.zoom}
                width={canvasSize.width / workspace.camera.zoom} height={canvasSize.height / workspace.camera.zoom}
                fill="url(#canvas-dots)" pointerEvents="none"/>}
              {page.shapes.filter(shape => shape.type === 'frame' && !hiddenIds.has(shape.id)).map(shape =>
                <g key={shape.id} data-shape-id={shape.id} className={workspace.selectedIds.includes(shape.id) ? 'selected-shape' : ''}
                  pointerEvents={lockedIds.has(shape.id) ? 'none' : undefined}>
                  {backdropView(shape, belowOf(shape))}
                  {effectView(shape, shapeView(shape))}
                  {canvasLabel(shape)}
                  {!lockedIds.has(shape.id) && <rect data-shape-id={shape.id} x={shape.x} y={shape.y} width={shape.width} height={shape.height}
                    fill="none" stroke="transparent" strokeWidth={12 / workspace.camera.zoom} pointerEvents="stroke"/>}
                </g>)}
              {page.shapes.filter(shape => shape.type !== 'frame' && !hiddenOperandIds.has(shape.id)).map(shape => {
                const host = shape.textPathId && page.shapes.find(entry => entry.id === shape.textPathId);
                const isAttachedHost = !shape.textPathId && page.shapes.some(entry => entry.textPathId === shape.id);
                return <g key={shape.id}>
                  {backdropView(shape, belowOf(shape))}
                  <g data-shape-id={shape.id} className={workspace.selectedIds.includes(shape.id) ? 'selected-shape' : ''}
                    pointerEvents={lockedIds.has(shape.id) ? 'none' : undefined}
                    transform={host ? rotateTransform(host, host.rotation) : shapeTransform(shape)}>
                    {editingText?.shapeId !== shape.id || editingText.workspaceKey !== workspace.key || host
                      ? isAttachedHost
                        ? null
                        : effectView(shape, shapeView(host && editingText?.shapeId === shape.id ? { ...shape, text: editingText.value,
                          styleRuns: editingText.runs } : shape, false, host || undefined), host || undefined) : null}
                    {shape.type === 'boolean' && workspace.selectedIds.includes(shape.id) && !lockedIds.has(shape.id) &&
                      <rect data-shape-id={shape.id} x={shape.x} y={shape.y}
                        width={shape.width} height={shape.height} fill="transparent" pointerEvents="all"/>}
                    {lockedIds.has(shape.id) ? null : host ? <path d={textPathForShape(host, shape.textPathFlip)} fill="none"
                      stroke="transparent" strokeWidth={Math.max(24, (shape.fontSize ?? 36) * 1.2)}
                      pointerEvents="stroke" data-shape-id={shape.id}/>
                      : <rect data-shape-id={shape.id} x={shape.x} y={shape.y} width={shape.width} height={shape.height}
                        fill="none" stroke="transparent" strokeWidth={12 / workspace.camera.zoom} pointerEvents="stroke"/>}
                  </g>
                  {selected?.id === shape.id && canvasLabel(shape)}
                </g>;
              })}
              {editingGroup && page.shapes.filter(shape => shape.parentId === editingGroup.id).map(shape =>
                <g key={`operand-${shape.id}`} data-shape-id={shape.id}
                  className="boolean-operand-outline" transform={shapeTransform(shape)}>
                  <g pointerEvents="none">{shapeView(shape, true)}</g>
                  <rect data-shape-id={shape.id} x={shape.x} y={shape.y} width={shape.width} height={shape.height}
                    fill="transparent" pointerEvents="all"/>
                  {selected?.id === shape.id && canvasLabel(shape)}
                </g>)}
              {marquee?.workspace === workspace && (() => {
                const zoom = workspace.camera.zoom;
                if (Math.abs(marquee.end.x - marquee.start.x) * zoom < 4 && Math.abs(marquee.end.y - marquee.start.y) * zoom < 4) return null;
                return marqueeHits(page.shapes, drawBounds(marquee.start, marquee.end, 'rect'))
                  .filter(shape => !shape.guide).map(edgeOutline);
              })()}
              {selectionVisible && selection.length > 1 && selection.filter(shape => !shape.guide && !hiddenIds.has(shape.id)).map(edgeOutline)}
              {selectionBox && selectionVisible && tool !== 'textPath' && <g className="selection-controls"
                transform={rotateTransform(selectionBox, linkedHost?.rotation ??
                  (selection.length === 1 && selection[0].type !== 'boolean' ? selection[0].rotation : undefined))}>
                {(() => {
                  const textOnPathShape = selected?.textPathId ? selected : undefined;
                  const pathEl = textOnPathShape && canvasElement?.querySelector<SVGPathElement>(`#text-path-${textOnPathShape.id}`);
                  const ribbon = pathEl && textOnPathShape && textPathRibbon(
                    pathEl,
                    textOnPathShape.textPathOffset ?? 0,
                    textPathComputedLength(textOnPathShape, linkedHost),
                    textOnPathShape.fontSize ?? 36
                  );
                  if (linkedHost && ribbon) {
                    const zoom = workspace.camera.zoom;
                    const label = `${Math.round(linkedHost.width)} × ${Math.round(linkedHost.height)}`;
                    const labelWidth = (label.length * 6.6 + 16) / zoom;
                    return <>
                      <rect x={selectionBox.x - 4 / zoom} y={selectionBox.y - 4 / zoom}
                        width={selectionBox.width + 8 / zoom} height={selectionBox.height + 8 / zoom}
                        fill="none" stroke="#3b5ee8" strokeWidth={1 / zoom} strokeDasharray={`${2 / zoom} ${2 / zoom}`} pointerEvents="none"/>
                      <path className="selection-outline" d={textPathForShape(linkedHost, false)}
                        fill="none" strokeWidth={1.5 / zoom} pointerEvents="none"/>
                      <circle cx={ribbon.handlePoint.x} cy={ribbon.handlePoint.y} r={5 / zoom}
                        fill="#ffffff" stroke="#3b5ee8" strokeWidth={2 / zoom} pointerEvents="all"
                        data-shape-id={selected!.id} style={{ cursor: 'grab' }}/>
                      <g pointerEvents="none">
                        <rect x={selectionBox.x + selectionBox.width / 2 - labelWidth / 2}
                          y={selectionBox.y + selectionBox.height + 14 / zoom} width={labelWidth} height={20 / zoom}
                          rx={4 / zoom} fill="#3b5ee8"/>
                        <text x={selectionBox.x + selectionBox.width / 2} y={selectionBox.y + selectionBox.height + 28 / zoom}
                          fontSize={11 / zoom} fontWeight={600} fill="#ffffff" textAnchor="middle">{label}</text>
                      </g>
                    </>;
                  }
                  return <rect className="selection-outline" data-shape-id={selection[0].id} x={selectionBox.x} y={selectionBox.y}
                    width={selectionBox.width} height={selectionBox.height} fill="none" strokeWidth={1.5 / workspace.camera.zoom} pointerEvents="stroke"/>;
                })()}
                {!selectionLocked && selection.length === 1 && selection[0].type !== 'frame' && (['nw', 'ne', 'se', 'sw'] as const).map(corner => {
                  const x = selectionBox.x + (corner === 'ne' || corner === 'se' ? selectionBox.width : 0);
                  const y = selectionBox.y + (corner === 'se' || corner === 'sw' ? selectionBox.height : 0);
                  return <rect key={`rotate-${corner}`} data-rotate-handle={corner} className="rotate-handle"
                    x={x - 10 / workspace.camera.zoom} y={y - 10 / workspace.camera.zoom}
                    width={20 / workspace.camera.zoom} height={20 / workspace.camera.zoom} fill="transparent"/>;
                })}
                {!selectionLocked && ([['nw', selectionBox.x, selectionBox.y], ['n', selectionBox.x + selectionBox.width / 2, selectionBox.y],
                  ['ne', selectionBox.x + selectionBox.width, selectionBox.y], ['e', selectionBox.x + selectionBox.width, selectionBox.y + selectionBox.height / 2],
                  ['se', selectionBox.x + selectionBox.width, selectionBox.y + selectionBox.height],
                  ['s', selectionBox.x + selectionBox.width / 2, selectionBox.y + selectionBox.height],
                  ['sw', selectionBox.x, selectionBox.y + selectionBox.height], ['w', selectionBox.x, selectionBox.y + selectionBox.height / 2]] as const)
                  .map(([handle, x, y]) => <rect key={handle} data-handle={handle} className={`resize-handle handle-${handle}`}
                    x={x - 4 / workspace.camera.zoom} y={y - 4 / workspace.camera.zoom}
                    width={8 / workspace.camera.zoom} height={8 / workspace.camera.zoom} strokeWidth={1.5 / workspace.camera.zoom}/>)}
              </g>}
              {draft?.workspace === workspace && (() => {
                const bounds = snapDrawBounds(draft.start, draft.end, draft.type, workspace.camera.zoom, draft.fine);
                const preview: Shape = { id: 'draft', type: draft.type, name: '', ...bounds, fill: '#3b5ee8',
                  flipX: draft.start.x > draft.end.x, flipY: draft.start.y > draft.end.y };
                return <g pointerEvents="none" strokeWidth={2 / workspace.camera.zoom}>{shapeView(preview, true)}</g>;
              })()}
            </g>
          </svg>
          {marquee?.workspace === workspace && (marquee.start.x !== marquee.end.x || marquee.start.y !== marquee.end.y) && <div
            className="selection-marquee" aria-hidden="true"
            style={{
              left: workspace.camera.x + Math.min(marquee.start.x, marquee.end.x) * workspace.camera.zoom,
              top: workspace.camera.y + Math.min(marquee.start.y, marquee.end.y) * workspace.camera.zoom,
              width: Math.abs(marquee.end.x - marquee.start.x) * workspace.camera.zoom,
              height: Math.abs(marquee.end.y - marquee.start.y) * workspace.camera.zoom,
            }}/>}
          {editingText?.workspaceKey === workspace.key && editingText.pageId === page.id && (() => {
            const shape = page.shapes.find(entry => entry.id === editingText.shapeId);
            if (!shape) return null;
            const host = shape.textPathId ? page.shapes.find(entry => entry.id === shape.textPathId) : undefined;
            const zoom = workspace.camera.zoom;
            const fontSize = shape.fontSize ?? 36;
            const preview = textPreview ?? shape;
            const autoWidth = shape.textSizing === 'auto-width';
            const editorWidth = autoWidth && !editingText.value
              ? textSize({ ...shape, text: 'Type here…' }).width : preview.width;
            const overlayRects = !editorFocused && textSelection && richEditorRef.current
              ? selectionOverlayRects(richEditorRef.current, textSelection.start, textSelection.end) : [];
            const isTextPath = !!host;
            return <>
              <div ref={richEditorRef} className={`canvas-text-editor${isTextPath ? ' text-path-editor' : ''}`} aria-label="Edit text on canvas"
                contentEditable suppressContentEditableWarning spellCheck={false} data-placeholder="Type here…"
                style={isTextPath ? {
                  position: 'fixed',
                  top: -9999,
                  left: -9999,
                  opacity: 0,
                  pointerEvents: 'none',
                  width: 1,
                  height: 1,
                  overflow: 'hidden',
                } : {
                  left: workspace.camera.x + shape.x * zoom,
                  top: workspace.camera.y + shape.y * zoom,
                  width: editorWidth,
                  height: Math.max(preview.height, textHeight({ ...preview, text: editingText.value, styleRuns: editingText.runs })),
                  transform: `scale(${zoom})`,
                  transformOrigin: 'top left',
                  whiteSpace: autoWidth ? 'pre' : 'pre-wrap',
                  lineHeight: `${shape.lineHeight ?? fontSize * 1.2}px`,
                  outlineWidth: `${1 / zoom}px`,
                  outlineColor: 'var(--accent)',
                  textAlign: shape.textAlign ?? 'left',
                }}
                onFocus={() => setEditorFocused(true)}
                onInput={syncEditorFromDom}
                onBlur={() => {
                  setEditorFocused(false);
                  window.setTimeout(() => {
                    const active = document.activeElement;
                    if (active instanceof HTMLElement && active.closest('.right-rail')) return;
                    finishTextEdit();
                  }, 0);
                }}
                onPaste={event => {
                  event.preventDefault();
                  insertTextAtCaret(event.currentTarget, event.clipboardData.getData('text/plain'));
                  syncEditorFromDom();
                }}
                onKeyDown={event => {
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    buildEditorContent(event.currentTarget, shape.text ?? '', shape.styleRuns ?? [], shapeDefaults(shape));
                    syncEditorFromDom();
                    event.currentTarget.blur();
                    return;
                  }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.blur(); return; }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    insertTextAtCaret(event.currentTarget, '\n');
                    syncEditorFromDom();
                  }
                }}/>
              {!isTextPath && overlayRects.map((rect, index) => <div key={index} className="text-selection-overlay" aria-hidden="true"
                style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}/>)}
            </>;
          })()}
          {renaming?.surface === 'canvas' && renaming.workspaceKey === workspace.key && (() => {
            const shape = page.shapes.find(entry => entry.id === renaming.shapeId);
            return shape && <input className="canvas-name-editor" aria-label={`Rename ${shape.name}`}
              style={{ left: workspace.camera.x + shape.x * workspace.camera.zoom,
                top: workspace.camera.y + shape.y * workspace.camera.zoom - 30 }}
              value={renaming.value}
              ref={node => { if (node && document.activeElement !== node) { node.focus(); node.select(); } }}
              onChange={event => setRenaming({ ...renaming, value: event.target.value })}
              onBlur={event => finishRename(event.currentTarget.value)}
              onKeyDown={event => {
                event.stopPropagation();
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') { event.currentTarget.value = shape.name; event.currentTarget.blur(); }
              }}/>;
          })()}
          <div className="canvas-help">Space + drag to pan <span>·</span> Ctrl/⌘ + wheel to zoom <span>·</span> Shift-click to select more</div>
        </div>
        <div className="canvas-under"><span>{page.shapes.length} {page.shapes.length === 1 ? 'object' : 'objects'} · {selection.length} selected</span>
          <span>Infinite canvas · add frames where you need them</span></div>
      </section>
      <div
        className="rail-divider rail-divider-right"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector panel"
        style={{ right: rightRailWidth, transform: 'translateX(50%)' }}
        onPointerDown={event => {
          railDrag.current = { side: 'right', startX: event.clientX, startWidth: rightRailWidth };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const gesture = railDrag.current;
          if (!gesture || gesture.side !== 'right') return;
          const limit = (event.currentTarget.parentElement?.clientWidth ?? window.innerWidth) - leftRailWidth - 400;
          setRightRailWidth(Math.max(254, Math.min(limit, gesture.startWidth + gesture.startX - event.clientX)));
        }}
        onPointerUp={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          railDrag.current = null;
        }}
        onPointerCancel={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          railDrag.current = null;
        }}
      />
      <aside className="right-rail" aria-label="Properties inspector">
        {selection.length > 1 ? <div className="inspector-heading selection-heading">
          <div className="selection-heading-row"><h2>{selection.length} selected</h2><div className="boolean-actions">
            <button className="boolean-icon-button" title={`${lastBoolean[0].toUpperCase() + lastBoolean.slice(1)} selection`}
              aria-label={`${lastBoolean[0].toUpperCase() + lastBoolean.slice(1)} selection`}
              disabled={!canApplyBoolean(workspace, lastBoolean)} onClick={() => applyBoolean(workspace, lastBoolean)}>
              <CurrentBooleanIcon size={19}/></button>
            <button className="boolean-icon-button" title="Duplicate selection" aria-label="Duplicate selection"
              onClick={() => duplicateSelection(workspace)}><Copy size={18}/></button>
            <button ref={booleanTriggerRef} className="boolean-menu-trigger" title="Boolean operations"
              aria-label="Boolean operations" aria-haspopup="menu" aria-expanded={!!booleanMenu}
              onClick={event => {
                if (booleanMenu) { setBooleanMenu(null); return; }
                const bounds = event.currentTarget.getBoundingClientRect();
                setBooleanMenu({ x: Math.max(8, Math.min(window.innerWidth - 312, bounds.right - 280)),
                  y: Math.max(8, Math.min(window.innerHeight - 276, bounds.bottom + 8)) });
              }}><ChevronDown size={16}/></button>
            <button className="boolean-icon-button" title="More selection actions" aria-label="More selection actions"
              onClick={event => {
                const bounds = event.currentTarget.getBoundingClientRect();
                setMenu({ x: bounds.right - 202, y: bounds.bottom + 8, world: center(selectionBox!) });
              }}><Ellipsis size={20}/></button>
          </div></div>
        </div> : <div className="inspector-heading"><span className="section-label">INSPECTOR</span><h2>{activeShapeType}</h2><p>{selected ? 'Fine-tune the selected object.' : 'An open canvas for frames and free-floating objects.'}</p></div>}
        {selection.length > 1 ? <div className="inspector-body">
          <div className="page-spec"><span>SELECTION</span><strong>{Math.round(selectionBox?.width ?? 0)} × {Math.round(selectionBox?.height ?? 0)} px</strong><span>{selection.length} objects on {page.name}</span></div>
          <div className="object-actions">
            <button className="button quiet" onClick={() => duplicateSelection(workspace)}><Copy size={15}/> Duplicate</button>
            {canUngroup(workspace) && <button className="button quiet" onClick={() => ungroupSelection(workspace)}><Ungroup size={15}/> Ungroup</button>}
          </div>
          <div className="object-actions transform-actions">
            <button className="icon-button" title="Rotate 90°" aria-label="Rotate 90 degrees" onClick={() => transformSelection(workspace, 'rotate90')}><RotateCw size={16}/></button>
            <button className="icon-button" title="Flip horizontal" aria-label="Flip horizontal" onClick={() => transformSelection(workspace, 'flipH')}><FlipHorizontal2 size={16}/></button>
            <button className="icon-button" title="Flip vertical" aria-label="Flip vertical" onClick={() => transformSelection(workspace, 'flipV')}><FlipVertical2 size={16}/></button>
            <button className="icon-button" title="Hide" aria-label="Hide" onClick={() => toggleHidden(workspace)}><EyeOff size={16}/></button>
            <button className="icon-button" title="Lock" aria-label="Lock" onClick={() => toggleLocked(workspace)}><Lock size={16}/></button>
          </div>
          <button className="button danger" onClick={() => removeSelection(workspace)}><Trash2 size={15}/> Delete selected</button>
        </div> : selected ? <div className="inspector-body" key={selected.id}>
          <label className="field full"><span>Layer name</span><input value={selected.name} onChange={event => updateSelected({ name: event.target.value })}/></label>
          {!linkedHost ? <><div className="field-group-label">POSITION & SIZE</div><div className="field-grid">
            {numberField('X', 'x', selected.x)}{numberField('Y', 'y', selected.y)}
            {selected.type === 'image' && (selected.lockAspect ?? true) ? <>
              <NumberField label="Width" min={1} value={selected.width} onCommit={width => {
                if (width === selected.width) return;
                const ratio = selected.height / selected.width;
                updateSelected({ width, height: Math.max(1, Math.round(width * ratio * 100) / 100) });
              }}/>
              <NumberField label="Height" min={1} value={selected.height} onCommit={height => {
                if (height === selected.height) return;
                const ratio = selected.width / selected.height;
                updateSelected({ height, width: Math.max(1, Math.round(height * ratio * 100) / 100) });
              }}/>
            </> : <>{numberField('Width', 'width', selected.width)}{numberField('Height', 'height', selected.height)}</>}
            {selected.type !== 'frame' && <NumberField label="Rotation °" value={Math.round((selected.rotation ?? 0) * 100) / 100}
              onCommit={value => updateSelected({ rotation: normalizeAngle(value) })}/>}
          </div>
          {selected.type === 'image' && <label className="field-toggle">
            <input type="checkbox" checked={selected.lockAspect ?? true}
              onChange={event => updateSelected({ lockAspect: event.target.checked })}/>
            <span>{(selected.lockAspect ?? true) ? <Lock size={14}/> : <LockOpen size={14}/>} Lock aspect ratio</span>
          </label>}
          <p className="field-hint">Drag near rounded sizes to snap · Alt-drag for 0.1 px steps. Hold Shift while dragging a corner to rotate in 15° steps.</p>
          </> : <div className="page-spec"><span>ATTACHED TO</span><strong>{linkedHost.name}</strong>
            <span>Position and rotation follow the host shape.</span></div>}
          {selected.type === 'text' && <><div className="field-group-label">TYPE</div>
            <label className="field full"><span>Text content</span><textarea rows={4} value={selected.text ?? ''}
              onChange={event => {
                if (editingText?.shapeId === selected.id) setEditingText(null);
                updateSelected({ text: event.target.value,
                  styleRuns: runsAfterTextEdit(selected.text ?? '', event.target.value, selected.styleRuns) });
              }}
              onBlur={event => {
                if (event.currentTarget.value.trim() || !page.shapes.includes(selected)) return;
                remember(workspace);
                page.shapes.splice(page.shapes.indexOf(selected), 1);
                workspace.selectedIds = [];
                changed(workspace);
              }}/></label>
            {linkedHost && <>
              <div className="field-group-label">TEXT ON PATH</div>
              <NumberField label="Start offset %" value={selected.textPathOffset ?? 0} min={0} max={100}
                onCommit={textPathOffset => updateSelected({ textPathOffset })}/>
              <label className="field-toggle"><input type="checkbox" checked={selected.textPathFlip ?? false}
                onChange={event => updateSelected({ textPathFlip: event.target.checked })}/><span>Flip path direction</span></label>
              <p className="field-hint">Drag the text along the path to change its start offset.</p>
              <button className="button quiet" onClick={() => {
                if (editingText?.shapeId === selected.id) finishTextEdit();
                detachTextFromPath(workspace, selected, linkedHost);
              }}>Detach from path</button>
            </>}
            {textSelection && <p className="field-hint">Styling {textSelection.end - textSelection.start} selected character{textSelection.end - textSelection.start === 1 ? '' : 's'}.</p>}
            <label className="field full"><span>Font family</span>
              <select value={textSelectionStyle?.mixed.has('fontFamily') ? '__mixed__' : textSelectionStyle?.fontFamily ?? selected.fontFamily ?? 'sans-serif'}
              onChange={event => {
                if (event.target.value === '__mixed__') return;
                const family = fonts.find(font => font.family === event.target.value);
                const currentWeight = textSelectionStyle?.fontWeight ?? selected.fontWeight ?? 400;
                const currentStyle = textSelectionStyle?.fontStyle ?? selected.fontStyle ?? 'normal';
                const style = family?.styles.find(option => option.weight === currentWeight && option.style === currentStyle) ??
                  family?.styles.find(option => option.weight === 400 && option.style === 'normal') ?? family?.styles[0];
                updateTextStyle({ fontFamily: event.target.value, fontWeight: style?.weight ?? 400, fontStyle: style?.style ?? 'normal' });
              }}>
              {textSelectionStyle?.mixed.has('fontFamily') && <option value="__mixed__">Mixed</option>}
              {!selectedFont && <option value={selected.fontFamily}>{selected.fontFamily} (not installed)</option>}
              {fonts.map(font => <option key={font.family} value={font.family}>{font.family}</option>)}
            </select></label>
            <label className="field full"><span>Font style</span>
              <select value={textSelectionStyle?.mixed.has('fontWeight') || textSelectionStyle?.mixed.has('fontStyle') ? '__mixed__' :
                `${textSelectionStyle?.fontWeight ?? selected.fontWeight ?? 400}:${textSelectionStyle?.fontStyle ?? selected.fontStyle ?? 'normal'}`}
              disabled={!selectedFont}
              onChange={event => {
                if (event.target.value === '__mixed__') return;
                const style = selectedFont?.styles.find(option => `${option.weight}:${option.style}` === event.target.value);
                if (style) updateTextStyle({ fontWeight: style.weight, fontStyle: style.style });
              }}>
              {(textSelectionStyle?.mixed.has('fontWeight') || textSelectionStyle?.mixed.has('fontStyle')) && <option value="__mixed__">Mixed</option>}
              {!selectedFont?.styles.some(option => `${option.weight}:${option.style}` === selectedFontStyle) &&
                <option value={selectedFontStyle}>{selected.fontWeight ?? 400} {selected.fontStyle ?? 'normal'} (not installed)</option>}
              {selectedFont?.styles.map(style => <option key={`${style.weight}:${style.style}`}
                value={`${style.weight}:${style.style}`}>{style.label}</option>)}
            </select></label>
            {!linkedHost && <label className="field full"><span>Text resizing</span><select value={selected.textSizing ?? 'auto-height'}
              onChange={event => updateSelected({ textSizing: event.target.value as Shape['textSizing'] })}>
              <option value="auto-width">Auto width</option>
              <option value="auto-height">Auto height</option>
              <option value="fixed">Fixed size</option>
            </select></label>}
            {!linkedHost && <p className="field-hint">Auto width grows with your text. Resize a side to wrap; resize a corner to set both dimensions.</p>}
            <div className="field-grid">
              <NumberField label="Font size" min={1} max={300}
                value={textSelection ? (textSelectionStyle!.mixed.has('fontSize') ? null : textSelectionStyle!.fontSize) : (selected.fontSize ?? 36)}
                onCommit={fontSize => updateTextStyle({ fontSize })}/>
              <NumberField label="Line height px" value={selected.lineHeight ?? Math.round((selected.fontSize ?? 36) * 12) / 10}
                min={1} onCommit={lineHeight => updateSelected({ lineHeight })}/>
            </div>
            <NumberField label="Letter spacing px"
              value={textSelection ? (textSelectionStyle!.mixed.has('letterSpacing') ? null : textSelectionStyle!.letterSpacing) : (selected.letterSpacing ?? 0)}
              onCommit={letterSpacing => updateTextStyle({ letterSpacing })}/>
            {!linkedHost && <div className="alignment-row" role="group" aria-label="Text alignment">
              {textAlignChoices.map(([value, Icon, label]) => <button key={value} className="icon-button"
                title={label} aria-label={label} aria-pressed={(selected.textAlign ?? 'left') === value}
                onClick={() => updateSelected({ textAlign: value })}><Icon size={17}/></button>)}
            </div>}
          </>}
          <div className="field-group-label">APPEARANCE</div>
          {selected.type !== 'image' && <ColorField
            label={selected.type === 'line' || selected.type === 'arrow' ? 'Stroke color' : 'Fill color'}
            value={selected.type === 'text' && textSelection ? (textSelectionStyle!.mixed.has('fill') ? null : textSelectionStyle!.fill) : selected.fill}
            onCommit={fill => selected.type === 'text' ? updateTextStyle({ fill }) : updateSelected({ fill })}/>}
          <NumberField label="Opacity %" value={Math.round((selected.opacity ?? 1) * 100)} min={0} max={100}
            onCommit={value => updateSelected({ opacity: value / 100 })}/>
          {selected.type === 'line' || selected.type === 'arrow'
            ? <NumberField label="Line width" value={selected.strokeWidth ?? 2} min={0}
              onCommit={strokeWidth => updateSelected({ strokeWidth })}/>
            : <StrokeSection shape={selected} onChange={updateSelected}/>}
          {(selected.type === 'frame' || selected.type === 'rect' || selected.type === 'image') && <>
            <div className="field-group-label">CORNERS</div>
            <button className="corner-toggle" aria-expanded={cornersSplit} onClick={() => {
              const next = new Set(expandedCorners);
              if (cornersSplit) {
                next.delete(selected.id);
                updateSelected({ cornerRadii: [cornerRadii[0], cornerRadii[0], cornerRadii[0], cornerRadii[0]] });
              } else next.add(selected.id);
              setExpandedCorners(next);
            }}>{cornersSplit ? 'Use one radius' : 'Edit each corner'}</button>
            {cornersSplit ? <div className="field-grid corner-grid">
              {cornerLabels.map(([label, index]) => <NumberField key={label} label={label}
                value={cornerRadii[index]} min={0} onCommit={value => {
                  const next: [number, number, number, number] = [...cornerRadii];
                  next[index] = value;
                  updateSelected({ cornerRadii: next });
                }}/>)}
            </div> : <NumberField label="All corners" value={cornerRadii[0]} min={0}
              onCommit={radius => updateSelected({ cornerRadii: [radius, radius, radius, radius] })}/>}
          </>}
          {selected.type === 'image' && <div className="image-info">Images fill their bounds without distortion. Resize to adjust the crop; the original stays embedded in the file.</div>}
          <EffectsSection effects={selected.effects ?? []} onChange={effects => updateSelected({ effects: effects.length ? effects : undefined })}/>
          <ExportSection settings={selected.exports ?? []} name={selected.name}
            onChange={exports => updateSelected({ exports: exports.length ? exports : undefined })}
            onExport={() => void exportSettings(workspace, page, selected)}/>
          <div className="object-actions"><button className="button quiet" disabled={selectedOrder <= 0} onClick={() => moveShape(workspace, page, selected, -1)}><ArrowDown size={15}/> Send back</button>
            <button className="button quiet" disabled={selectedOrder >= selectedSiblings.length - 1} onClick={() => moveShape(workspace, page, selected, 1)}><ArrowUp size={15}/> Bring front</button></div>
          <div className="object-actions transform-actions">
            <button className="icon-button" title={`Rotate 90° (${hint('rotate90')})`} aria-label="Rotate 90 degrees" onClick={() => transformSelection(workspace, 'rotate90')}><RotateCw size={16}/></button>
            <button className="icon-button" title={`Flip horizontal (${hint('flipH')})`} aria-label="Flip horizontal" onClick={() => transformSelection(workspace, 'flipH')}><FlipHorizontal2 size={16}/></button>
            <button className="icon-button" title={`Flip vertical (${hint('flipV')})`} aria-label="Flip vertical" onClick={() => transformSelection(workspace, 'flipV')}><FlipVertical2 size={16}/></button>
            <button className="icon-button" title={selected.hidden ? 'Show' : 'Hide'} aria-label={selected.hidden ? 'Show' : 'Hide'} onClick={() => toggleHidden(workspace)}>{selected.hidden ? <EyeOff size={16}/> : <Eye size={16}/>}</button>
            <button className="icon-button" title={selected.locked ? 'Unlock' : 'Lock'} aria-label={selected.locked ? 'Unlock' : 'Lock'} onClick={() => toggleLocked(workspace)}>{selected.locked ? <Lock size={16}/> : <LockOpen size={16}/>}</button>
          </div>
          {selected.type === 'boolean' && <div className="object-actions">
            <button className="button quiet" onClick={() => ungroupSelection(workspace)}><Ungroup size={15}/> Ungroup</button>
            <button className="button quiet" disabled={!canApplyBoolean(workspace, 'flatten')}
              title={canApplyBoolean(workspace, 'flatten') ? 'Merge into one independent vector' : 'Nothing to flatten: the result is empty'}
              onClick={() => applyBoolean(workspace, 'flatten')}><ListFilter size={15}/> Flatten</button>
          </div>}
          <button className="button danger" onClick={() => removeSelection(workspace)}><Trash2 size={15}/> Delete object</button>
        </div> : <div className="inspector-body">
          <label className="field full"><span>Design name</span><input value={workspace.session.document.name} onChange={event => { if (event.target.value !== workspace.session.document.name) { remember(workspace); workspace.session.document.name = event.target.value; changed(workspace); } }}/></label>
          <label className="field full"><span>Canvas name</span><input value={page.name} onChange={event => { if (event.target.value !== page.name) { remember(workspace); page.name = event.target.value; changed(workspace); } }}/></label>
          <p className="inspector-note">Draw anywhere on the infinite canvas. Frames give objects a named area; objects outside frames stay at the top level in Layers.</p>
        </div>}
      </aside>
    </main> : <main className="welcome" aria-label="Welcome">
      <div className="welcome-main"><div className="welcome-title-row"><div><p className="welcome-overline">LOCAL DESIGN WORKSPACE</p><h1>Your next idea<br/><em>starts here.</em></h1><p className="welcome-copy">Design freely on an infinite canvas, organize objects in frames, and save everything to a local file.</p></div>
        <div className="welcome-art" aria-hidden="true"><div className="preview-top"><span/><span/><span/></div><div className="preview-board"><div className="preview-circle"/><div className="preview-square"/><div className="preview-caption"><i/><i/></div></div><span className="preview-cursor"><MousePointer2 size={24} fill="#3b5ee8" stroke="white" strokeWidth={1.8}/></span></div></div>
        <div className="welcome-actions"><button className="button primary large" onClick={createDocument}><FilePlus2 size={19}/> New design</button><button className="button outlined large" onClick={() => void openDocument()}><FolderOpen size={19}/> Open a file</button></div>
        <div className="recent-section"><div className="recent-heading"><h2>Recent designs</h2><span>{recent.length ? `${recent.length} ${recent.length === 1 ? 'file' : 'files'}` : 'Your work, close at hand'}</span></div>
          {recent.length ? <div className="recent-list">{recent.map(path => <button key={path} className="recent-row" title={path} onClick={() => void openDocument(path)}><span className="recent-file-icon"><Layers3 size={18}/></span><span className="recent-names"><strong>{basename(path)}</strong><small>{path}</small></span><ChevronRight size={17}/></button>)}</div>
            : <div className="recent-empty"><span className="empty-graphic"><Layers3 size={22}/></span><div><strong>A clean slate.</strong><p>Files you open or save will appear here.</p></div></div>}</div>
      </div><aside className="welcome-side"><span className="side-rule"/><p>MAKE SOMETHING<br/>WORTH KEEPING.</p><span>Shapes, type, images and pages. One local file for your entire design.</span><div className="side-footer">BUILT FOR THE DESKTOP <ArrowUpRight size={14}/></div></aside>
    </main>}
    <footer className="statusbar"><span className={`status-indicator ${error ? 'error' : ''}`}/><span role={error ? 'alert' : 'status'}>{error || status}</span>{!('__TAURI_INTERNALS__' in window) && <span className="preview-warning">Preview only — files and recovery require the desktop app</span>}<span className="top-spacer"/>
      {workspace && <span className="save-state">{workspace.session.dirty ? 'Unsaved changes' : 'Saved'} · {workspace.session.path ? basename(workspace.session.path) : 'Untitled design'}</span>}
      <span className="status-version">PUNAKAWAN / DESKTOP</span></footer>
    {booleanMenu && workspace && <div ref={booleanMenuRef} className="boolean-menu" role="menu"
      aria-label="Boolean operations" style={{ left: booleanMenu.x, top: Math.max(8, booleanMenu.y) }}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = choices.indexOf(document.activeElement as HTMLButtonElement);
        choices[(index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length]?.focus();
      }}>
      {booleanChoices.map(([operation, Icon, label]) => <button key={operation} role="menuitem"
        disabled={!canApplyBoolean(workspace, operation)}
        title={!canApplyBoolean(workspace, operation) ?
          'Select opaque, unstroked closed shapes without attached text; Flatten needs matching fills' : undefined}
        onClick={() => applyBoolean(workspace, operation)}>
        <Icon size={23} strokeWidth={1.9} aria-hidden="true"/>
        <span>{label}</span>
        <kbd>{(effectiveShortcuts[operation] ?? '').replace('Mod+', /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+')
          .replace('Alt+', '⌥').replace('Shift+', '⇧')}</kbd>
      </button>)}
      {canUngroup(workspace) && <>
        <span className="menu-separator"/>
        <button role="menuitem" onClick={() => { ungroupSelection(workspace); setBooleanMenu(null); }}>
          <Ungroup size={23} strokeWidth={1.9} aria-hidden="true"/>
          <span>Ungroup</span>
          <kbd>{(effectiveShortcuts.ungroup ?? '').replace('Mod+', /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+')
            .replace('Alt+', '⌥').replace('Shift+', '⇧')}</kbd>
        </button>
      </>}
    </div>}
    {menu && workspace && page && <div ref={menuRef} className="canvas-context-menu" role="menu" aria-label="Canvas actions"
      style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }} onContextMenu={event => event.preventDefault()}>
      {workspace.selectedIds.length ? <>
        <button role="menuitem" onClick={() => { copySelection(workspace); setMenu(null); }}><Copy size={15}/> Copy <span>⌘C</span></button>
        <button role="menuitem" disabled={!clipboard.current.length} onClick={() => { pasteSelection(workspace, menu.world); setMenu(null); }}><Copy size={15}/> Paste <span>⌘V</span></button>
        <button role="menuitem" onClick={() => { duplicateSelection(workspace); setMenu(null); }}><Copy size={15}/> Duplicate <span>⌘D</span></button>
        <span className="menu-separator"/>
        <button role="menuitem" onClick={() => { arrangeSelection(workspace, 'front'); setMenu(null); }}><ArrowUp size={15}/> Bring to front <span>]</span></button>
        <button role="menuitem" onClick={() => { arrangeSelection(workspace, 'back'); setMenu(null); }}><ArrowDown size={15}/> Send to back <span>[</span></button>
        {(canUngroup(workspace) || selection.length === 1 || canApplyBoolean(workspace, 'flatten')) && <span className="menu-separator"/>}
        {canUngroup(workspace) && <button role="menuitem" onClick={() => { ungroupSelection(workspace); setMenu(null); }}><Ungroup size={15}/> Ungroup <span>⌘⇧G</span></button>}
        {selection.length === 1 && <button role="menuitem" onClick={() => { beginRename(workspace, selection[0], menu.layer ? 'layer' : 'canvas'); setMenu(null); }}><TypeIcon size={15}/> Rename</button>}
        {canApplyBoolean(workspace, 'flatten') && <button role="menuitem" onClick={() => { applyBoolean(workspace, 'flatten'); setMenu(null); }}><ListFilter size={15}/> Flatten <span>{hint('flatten')}</span></button>}
        <span className="menu-separator"/>
        <button role="menuitem" onClick={() => transformSelection(workspace, 'rotate90')}><RotateCw size={15}/> Rotate 90° <span>{hint('rotate90')}</span></button>
        <button role="menuitem" onClick={() => transformSelection(workspace, 'flipH')}><FlipHorizontal2 size={15}/> Flip horizontal <span>{hint('flipH')}</span></button>
        <button role="menuitem" onClick={() => transformSelection(workspace, 'flipV')}><FlipVertical2 size={15}/> Flip vertical <span>{hint('flipV')}</span></button>
        <span className="menu-separator"/>
        <button role="menuitem" onClick={() => toggleHidden(workspace)}>{selection.every(entry => entry.hidden) ? <Eye size={15}/> : <EyeOff size={15}/>} {selection.every(entry => entry.hidden) ? 'Show' : 'Hide'} <span>{hint('hide')}</span></button>
        <button role="menuitem" onClick={() => toggleLocked(workspace)}>{selection.every(entry => entry.locked) ? <LockOpen size={15}/> : <Lock size={15}/>} {selection.every(entry => entry.locked) ? 'Unlock' : 'Lock'} <span>{hint('lock')}</span></button>
        <span className="menu-separator"/>
        <button role="menuitem" className="danger-text" onClick={() => removeSelection(workspace)}><Trash2 size={15}/> Delete <span>⌫</span></button>
      </> : <>
        <button role="menuitem" onClick={() => { insertShape(workspace, page, 'frame', drawBounds(menu.world, menu.world, 'frame')); setMenu(null); }}><Frame size={15}/> Add frame</button>
        <button role="menuitem" onClick={() => { insertShape(workspace, page, 'rect', drawBounds(menu.world, menu.world, 'rect')); setMenu(null); }}><RectangleHorizontal size={15}/> Add rectangle</button>
        <button role="menuitem" onClick={() => { insertShape(workspace, page, 'text', drawBounds(menu.world, menu.world, 'text')); setMenu(null); }}><TypeIcon size={15}/> Add text</button>
        <button role="menuitem" onClick={() => { spawnTextOnPathAt(workspace, page, menu.world); setMenu(null); }}><Spline size={15}/> Add text on path</button>
      </>}
      {!workspace.selectedIds.length && <><span className="menu-separator"/>
      <button role="menuitem" disabled={!clipboard.current.length} onClick={() => { pasteSelection(workspace, menu.world); setMenu(null); }}><Copy size={15}/> Paste here <span>⌘V</span></button></>}
      {workspace.selectedIds.length > 0 && <span className="menu-separator"/>}
      <button role="menuitem" onClick={() => { fitView(workspace); setMenu(null); }}><Maximize2 size={15}/> Fit content</button>
    </div>}
    {modal && <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && modal.kind !== 'recovery') setModal(null); }}><div ref={dialogRef} tabIndex={-1} className={`dialog ${modal.kind === 'preferences' ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      {modal.kind === 'preferences' && <><div className="dialog-heading"><div><span className="section-label">WORKSPACE</span><h2 id="dialog-title">Preferences</h2></div><button className="icon-button" aria-label="Close preferences" onClick={() => { setRecording(null); setModal(null); }}><X size={18}/></button></div>
        <div className="dialog-content"><div className="setting-row"><div><strong>Appearance</strong><p>Use the color scheme that fits your workspace.</p></div><label className="sr-only" htmlFor="theme">Appearance</label><select id="theme" value={preferences.theme} onChange={event => void updatePreferences({ ...preferencesRef.current, theme: event.target.value as Preferences['theme'] })}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
          <div className="setting-row"><div><strong>Autosave</strong><p>Save edits to existing files after a pause. Untitled designs keep recovery copies until saved.</p></div><label className="switch"><input type="checkbox" aria-label="Autosave existing files" checked={preferences.autosave} onChange={event => void updatePreferences({ ...preferencesRef.current, autosave: event.target.checked })}/><span/></label></div>
          <div className="shortcuts-heading"><h3>Keyboard shortcuts</h3><p>Click a shortcut, press your new combination, or clear it. System combinations stay reserved.</p></div>
          <div className="shortcut-list">{actions.map(([action, label]) => <div className="shortcut-row" key={action}><span>{label}</span><div><button className={`shortcut-key ${recording === action ? 'recording' : ''}`} aria-label={`Set shortcut for ${label}`} onClick={() => setRecording(action)}
            onKeyDown={event => { if (recording !== action) return; event.preventDefault(); event.stopPropagation(); if (event.key === 'Escape') { setRecording(null); return; }
              if (event.key === 'Backspace' || event.key === 'Delete') { setShortcut(action, ''); return; }
              const combo = keyCombo(event); if (combo) setShortcut(action, combo); }}>{recording === action ? 'Press keys…' : effectiveShortcuts[action] || 'Not set'}</button>
            <button className="tiny-button" title={`Clear ${label} shortcut`} aria-label={`Clear ${label} shortcut`} onClick={() => setShortcut(action, '')}><X size={14}/></button>
            <button className="tiny-button" title={`Reset ${label} shortcut`} aria-label={`Reset ${label} shortcut`} onClick={() => setShortcut(action, bindings[action])}><RotateCcw size={14}/></button></div></div>)}</div>
        </div><div className="dialog-footer"><button className="button primary" onClick={() => setModal(null)}><Check size={15}/> Done</button></div></>}
      {modal.kind === 'recovery' && <><div className="dialog-heading"><div><span className="section-label">RECOVER YOUR WORK</span><h2 id="dialog-title">Found unsaved work</h2></div></div><div className="dialog-content"><p className="dialog-intro">Choose which copies to restore or discard. Restored work stays unsaved until you save it.</p>
        {recoveries.map(entry => { const snapshot = recoveryValue(entry); return <div className="recovery-row" key={entry.id}><div><strong>{snapshot?.document.name || 'Unreadable recovery copy'}</strong><small>{snapshot?.path || 'Untitled design'}</small></div><button className="button outlined" disabled={!snapshot} onClick={() => restoreRecovery(entry)}>Restore</button><button className="button quiet danger-text" onClick={() => void discardRecovery(entry)}>Discard</button></div>; })}</div>
        <div className="dialog-footer"><button className="button quiet" onClick={() => setModal(null)}>Keep copies for later</button><button className="button primary" onClick={() => setModal(null)}>Continue</button></div></>}
      {modal.kind === 'export' && <><div className="dialog-heading"><div><span className="section-label">OUTPUT</span><h2 id="dialog-title">Export design</h2></div><button className="icon-button" aria-label="Close export dialog" onClick={() => setModal(null)}><X size={18}/></button></div><div className="dialog-content"><p className="dialog-intro">Export the bounds of your canvas objects or just the selection. Selected frames include their contents.</p>
        <fieldset className="choice-group"><legend>Content</legend><label><input type="radio" name="scope" checked={exportScope === 'page'} onChange={() => setExportScope('page')}/> Entire canvas</label><label><input type="radio" name="scope" disabled={!selected} checked={exportScope === 'selection'} onChange={() => setExportScope('selection')}/> {selected?.type === 'frame' ? 'Selected frame and contents' : 'Selected object'}{!selected ? ' (select one first)' : ''}</label></fieldset>
        <fieldset className="choice-group"><legend>Format</legend><label><input type="radio" name="format" checked={exportFormat === 'svg'} onChange={() => setExportFormat('svg')}/> SVG vector</label><label><input type="radio" name="format" checked={exportFormat === 'png'} onChange={() => setExportFormat('png')}/> PNG image</label><label><input type="radio" name="format" checked={exportFormat === 'webp'} onChange={() => setExportFormat('webp')}/> WebP image</label></fieldset></div>
        <div className="dialog-footer"><button className="button quiet" onClick={() => setModal(null)}>Cancel</button><button className="button primary" onClick={() => void doExport()}><Download size={15}/> Export</button></div></>}
      {modal.kind === 'close' && <><div className="dialog-heading"><div><span className="section-label">UNSAVED CHANGES</span><h2 id="dialog-title">Close this design?</h2></div></div><div className="dialog-content"><p className="dialog-intro">Save your edits before closing, or discard this tab and its recovery copy.</p></div><div className="dialog-footer"><button className="button quiet" onClick={() => setModal(null)}>Cancel</button><button className="button danger" onClick={() => { const item = workspaces.current.find(entry => entry.key === modal.key); if (item) void closeWorkspace(item, true); }}>Discard changes</button><button className="button primary" onClick={() => { const item = workspaces.current.find(entry => entry.key === modal.key); if (item) void save(item, false).then(saved => { if (saved && !item.session.dirty) void closeWorkspace(item); }); }}><Save size={15}/> Save and close</button></div></>}
    </div></div>}
  </div>;
}
