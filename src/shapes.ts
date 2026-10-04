import type { Shape, StyleRun, TextRunStyle } from './model';

const polygonPoints = Array.from({ length: 3 }, (_, index) => {
  const angle = -Math.PI / 2 + index * 2 * Math.PI / 3;
  return { x: (1 + Math.cos(angle)) / 2, y: (1 + Math.sin(angle)) / 2 };
});
const starPoints = Array.from({ length: 10 }, (_, index) => {
  const angle = -Math.PI / 2 + index * Math.PI / 5;
  const radius = index % 2 === 0 ? 0.5 : 0.22;
  return { x: 0.5 + Math.cos(angle) * radius, y: 0.5 + Math.sin(angle) * radius };
});

/** Absolute world-coordinate path, shared by canvas rendering and SVG export. */
export function pathForShape(shape: Pick<Shape, 'type' | 'x' | 'y' | 'width' | 'height' | 'flipX' | 'flipY'>): string {
  const { x, y, width, height } = shape;
  if (shape.type === 'line' || shape.type === 'arrow') {
    const startX = x + (width <= 1 ? width / 2 : shape.flipX ? width : 0);
    const startY = y + (height <= 1 ? height / 2 : shape.flipY ? height : 0);
    const endX = x + (width <= 1 ? width / 2 : shape.flipX ? 0 : width);
    const endY = y + (height <= 1 ? height / 2 : shape.flipY ? 0 : height);
    let path = `M ${startX} ${startY} L ${endX} ${endY}`;
    if (shape.type === 'arrow') {
      const dx = endX - startX;
      const dy = endY - startY;
      const length = Math.hypot(dx, dy);
      const head = Math.min(14, length / 3);
      if (length > 0) {
        const along = head / length;
        const wing = head * 0.5 / length;
        path += ` M ${endX - dx * along - dy * wing} ${endY - dy * along + dx * wing}` +
          ` L ${endX} ${endY} L ${endX - dx * along + dy * wing} ${endY - dy * along - dx * wing}`;
      }
    }
    return path;
  }
  if (shape.type !== 'polygon' && shape.type !== 'star') return '';
  const points = shape.type === 'polygon' ? polygonPoints : starPoints;
  let path = '';
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    path += `${index ? ' L ' : 'M '}${x + point.x * width} ${y + point.y * height}`;
  }
  return `${path} Z`;
}

/** World-space outline with CSS-style proportional clamping at every adjacent edge. */
export function roundedRectPath(shape: Pick<Shape, 'x' | 'y' | 'width' | 'height' | 'cornerRadii'>): string {
  const { x, y, width, height } = shape;
  const tl = shape.cornerRadii?.[0] ?? 0;
  const tr = shape.cornerRadii?.[1] ?? 0;
  const br = shape.cornerRadii?.[2] ?? 0;
  const bl = shape.cornerRadii?.[3] ?? 0;
  const scale = Math.min(1,
    width / (tl + tr || 1), width / (bl + br || 1),
    height / (tl + bl || 1), height / (tr + br || 1));
  const topLeft = tl * scale;
  const topRight = tr * scale;
  const bottomRight = br * scale;
  const bottomLeft = bl * scale;
  return `M ${x + topLeft} ${y} H ${x + width - topRight}` +
    (topRight ? ` A ${topRight} ${topRight} 0 0 1 ${x + width} ${y + topRight}` : ` L ${x + width} ${y}`) +
    ` V ${y + height - bottomRight}` +
    (bottomRight ? ` A ${bottomRight} ${bottomRight} 0 0 1 ${x + width - bottomRight} ${y + height}` :
      ` L ${x + width} ${y + height}`) +
    ` H ${x + bottomLeft}` +
    (bottomLeft ? ` A ${bottomLeft} ${bottomLeft} 0 0 1 ${x} ${y + height - bottomLeft}` :
      ` L ${x} ${y + height}`) +
    ` V ${y + topLeft}` +
    (topLeft ? ` A ${topLeft} ${topLeft} 0 0 1 ${x + topLeft} ${y}` : ` L ${x} ${y}`) + ' Z';
}

/** Lines and arrows bake their flip into geometry; every other shape mirrors through an SVG transform. */
export function mirrorsViaTransform(shape: Pick<Shape, 'type'>): boolean {
  return shape.type !== 'line' && shape.type !== 'arrow' && shape.type !== 'boolean';
}

/** SVG transform for a shape: mirror about its own center first, then rotate (undefined when neither applies). */
export function shapeTransform(shape: Pick<Shape, 'type' | 'x' | 'y' | 'width' | 'height' | 'rotation' | 'flipX' | 'flipY'>): string | undefined {
  if (shape.type === 'boolean') return undefined;
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const parts: string[] = [];
  if (shape.rotation) parts.push(`rotate(${shape.rotation} ${cx} ${cy})`);
  if (mirrorsViaTransform(shape) && (shape.flipX || shape.flipY)) {
    parts.push(`translate(${cx} ${cy}) scale(${shape.flipX ? -1 : 1} ${shape.flipY ? -1 : 1}) translate(${-cx} ${-cy})`);
  }
  return parts.length ? parts.join(' ') : undefined;
}

export function isTextPathHost(shape: Shape): boolean {
  return shape.type === 'line' || shape.type === 'arrow' || shape.type === 'rect' ||
    shape.type === 'ellipse' || shape.type === 'polygon' || shape.type === 'star';
}

export function isClosedTextPathHost(shape: Shape): boolean {
  return shape.type === 'ellipse' || shape.type === 'rect' || shape.type === 'polygon' || shape.type === 'star';
}

/** Outline traversal (arrowheads are excluded); reversing the path reverses text without mirroring glyphs. */
export function textPathForShape(shape: Shape, reverse = false): string {
  const { x, y, width, height } = shape;
  if (shape.type === 'line' || shape.type === 'arrow') {
    const x1 = x + (width <= 1 ? width / 2 : shape.flipX ? width : 0);
    const y1 = y + (height <= 1 ? height / 2 : shape.flipY ? height : 0);
    const x2 = x + (width <= 1 ? width / 2 : shape.flipX ? 0 : width);
    const y2 = y + (height <= 1 ? height / 2 : shape.flipY ? 0 : height);
    return reverse ? `M ${x2} ${y2} L ${x1} ${y1}` : `M ${x1} ${y1} L ${x2} ${y2}`;
  }
  if (shape.type === 'ellipse') {
    const cx = x + width / 2;
    const cy = y + height / 2;
    const rx = width / 2;
    const ry = height / 2;
    const sweep = reverse ? 0 : 1;
    const single = `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 ${sweep} ${cx + rx} ${cy} A ${rx} ${ry} 0 1 ${sweep} ${cx - rx} ${cy}`;
    return `${single} A ${rx} ${ry} 0 1 ${sweep} ${cx + rx} ${cy} A ${rx} ${ry} 0 1 ${sweep} ${cx - rx} ${cy} Z`;
  }
  if (shape.type === 'rect') {
    const single = (!reverse ? roundedRectPath(shape) : (() => {
      const [tl, tr, br, bl] = shape.cornerRadii ?? [0, 0, 0, 0];
      const scale = Math.min(1, width / (tl + tr || 1), width / (bl + br || 1),
        height / (tl + bl || 1), height / (tr + br || 1));
      const a = tl * scale, b = tr * scale, c = br * scale, d = bl * scale;
      return `M ${x + a} ${y}` +
        (a ? ` A ${a} ${a} 0 0 0 ${x} ${y + a}` : ` L ${x} ${y}`) +
        ` V ${y + height - d}` +
        (d ? ` A ${d} ${d} 0 0 0 ${x + d} ${y + height}` : ` L ${x} ${y + height}`) +
        ` H ${x + width - c}` +
        (c ? ` A ${c} ${c} 0 0 0 ${x + width} ${y + height - c}` : ` L ${x + width} ${y + height}`) +
        ` V ${y + b}` +
        (b ? ` A ${b} ${b} 0 0 0 ${x + width - b} ${y}` : ` L ${x + width} ${y}`) +
        ` H ${x + a}`;
    })()).replace(/\s*Z\s*$/i, '');
    const continuation = single.replace(/^M\s*[\d.e+-]+\s+[\d.e+-]+\s*/i, 'L ');
    return `${single} ${continuation} Z`;
  }
  if (shape.type === 'polygon' || shape.type === 'star') {
    const points = shape.type === 'polygon' ? polygonPoints : starPoints;
    const ordered = reverse
      ? points.map((_, index) => points[(points.length - index) % points.length])
      : points;
    const segs = ordered.map(p => `${x + p.x * width} ${y + p.y * height}`);
    return `M ${segs[0]} ` + segs.slice(1).map(s => `L ${s}`).join(' ') + ` L ${segs[0]} ` +
      segs.slice(1).map(s => `L ${s}`).join(' ') + ` L ${segs[0]} Z`;
  }
  return '';
}

type TextLayout = Pick<Shape, 'text' | 'width' | 'fontSize' | 'fontFamily' | 'fontWeight' |
  'fontStyle' | 'letterSpacing' | 'lineHeight' | 'textSizing' | 'styleRuns'> & { fill?: string };

let textContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function measuredWidth(value: string, shape: TextLayout): number {
  const fontSize = shape.fontSize ?? 36;
  const letterSpacing = shape.letterSpacing ?? 0;
  if (textContext === undefined) {
    textContext = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') :
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d') : null;
  }
  if (textContext) {
    textContext.font = `${shape.fontStyle ?? 'normal'} ${shape.fontWeight ?? 400} ${fontSize}px ${shape.fontFamily ?? 'sans-serif'}`;
    if (typeof textContext.letterSpacing === 'string') {
      textContext.letterSpacing = `${letterSpacing}px`;
      return textContext.measureText(value).width;
    }
    if (!letterSpacing) return textContext.measureText(value).width;
  }
  let characters = 0;
  let estimatedAdvance = 0;
  // Headless document readers have no canvas; approximate complete grapheme advances.
  for (const { segment } of graphemes.segment(value)) {
    characters++;
    if (!textContext) estimatedAdvance += fontSize * (segment === ' ' ? 0.33 : 0.6);
  }
  return Math.max(0, (textContext ? textContext.measureText(value).width : estimatedAdvance) +
    characters * letterSpacing);
}

/** Resolves the fully-merged character style at a text offset: shape-level defaults overridden by the styleRun, if any, covering that index. */
export function resolveTextStyle(
  shape: Pick<Shape, 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle' | 'fill' | 'letterSpacing' | 'styleRuns'>,
  index: number,
): TextRunStyle {
  const run = shape.styleRuns?.find(candidate => candidate.start <= index && index < candidate.end);
  return {
    fontFamily: run?.fontFamily ?? shape.fontFamily ?? 'sans-serif',
    fontSize: run?.fontSize ?? shape.fontSize ?? 36,
    fontWeight: run?.fontWeight ?? shape.fontWeight ?? 400,
    fontStyle: run?.fontStyle ?? shape.fontStyle ?? 'normal',
    fill: run?.fill ?? shape.fill,
    letterSpacing: run?.letterSpacing ?? shape.letterSpacing ?? 0,
  };
}

type TextAtom = { text: string; start: number };
export type TextSegment = { text: string; style: TextRunStyle; width: number };

/** Splits shape.text on paragraph breaks, keeping each paragraph's absolute offset for style resolution. */
function splitParagraphs(text: string): { text: string; offset: number }[] {
  const paragraphs: { text: string; offset: number }[] = [];
  const breaks = /\r\n|\r|\n/g;
  let cursor = 0;
  let lineBreak: RegExpExecArray | null;
  while ((lineBreak = breaks.exec(text))) {
    paragraphs.push({ text: text.slice(cursor, lineBreak.index), offset: cursor });
    cursor = lineBreak.index + lineBreak[0].length;
  }
  paragraphs.push({ text: text.slice(cursor), offset: cursor });
  return paragraphs;
}

/** Splits a word/space token into style-homogeneous pieces at any styleRun boundary inside it. */
function splitAtRunBoundaries(text: string, start: number, styleRuns: readonly StyleRun[] | undefined): TextAtom[] {
  if (!styleRuns?.length) return [{ text, start }];
  const end = start + text.length;
  const boundaries = new Set<number>([start, end]);
  for (const run of styleRuns) {
    if (run.start > start && run.start < end) boundaries.add(run.start);
    if (run.end > start && run.end < end) boundaries.add(run.end);
  }
  if (boundaries.size === 2) return [{ text, start }];
  const points = [...boundaries].sort((a, b) => a - b);
  const atoms: TextAtom[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    atoms.push({ text: text.slice(points[index] - start, points[index + 1] - start), start: points[index] });
  }
  return atoms;
}

function paragraphAtoms(text: string, offset: number, styleRuns: readonly StyleRun[] | undefined): TextAtom[] {
  const atoms: TextAtom[] = [];
  const tokenPattern = /[ \t]+|[^ \t]+/g;
  let token: RegExpExecArray | null;
  while ((token = tokenPattern.exec(text))) atoms.push(...splitAtRunBoundaries(token[0], offset + token.index, styleRuns));
  return atoms;
}

function toSegment(shape: TextLayout & Pick<Shape, 'fill'>, atom: TextAtom): TextSegment {
  const style = resolveTextStyle(shape, atom.start);
  return { text: atom.text, style, width: measuredWidth(atom.text, { ...shape, ...style }) };
}

/** Recombines consecutive atoms that resolved to an identical style into one segment. */
function mergeAdjacentSegments(segments: TextSegment[]): TextSegment[] {
  const merged: TextSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const sameStyle = previous !== undefined && previous.style.fontFamily === segment.style.fontFamily &&
      previous.style.fontSize === segment.style.fontSize && previous.style.fontWeight === segment.style.fontWeight &&
      previous.style.fontStyle === segment.style.fontStyle && previous.style.fill === segment.style.fill &&
      previous.style.letterSpacing === segment.style.letterSpacing;
    if (sameStyle) {
      previous.text += segment.text;
      previous.width += segment.width;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/**
 * Rich per-segment replacement for textLines: each line is an ordered run of style-homogeneous segments.
 * Mirrors pre-wrap/overflow-wrap: anywhere without splitting a grapheme cluster.
 */
export function textRunLines(shape: TextLayout): TextSegment[][] {
  // fill is optional on TextLayout for back-compat with callers that only need wrapping/measurement,
  // but resolveTextStyle's TextRunStyle.fill is always a string.
  const layout: TextLayout & Pick<Shape, 'fill'> = { ...shape, fill: shape.fill ?? '' };
  const lines: TextSegment[][] = [];
  for (const paragraph of splitParagraphs(layout.text ?? '')) {
    const atoms = paragraphAtoms(paragraph.text, paragraph.offset, layout.styleRuns);
    if (!atoms.length) {
      // Blank paragraphs still carry a zero-width segment so every line has a resolvable style.
      lines.push([{ text: '', style: resolveTextStyle(layout, paragraph.offset), width: 0 }]);
      continue;
    }
    if (layout.textSizing === 'auto-width') {
      lines.push(mergeAdjacentSegments(atoms.map(atom => toSegment(layout, atom))));
      continue;
    }
    let line: TextSegment[] = [];
    let lineWidth = 0;
    for (const atom of atoms) {
      const segment = toSegment(layout, atom);
      if (/^[ \t]/.test(segment.text)) {
        // Preserved spaces hang at soft breaks, rather than creating extra blank lines.
        line.push(segment);
        lineWidth += segment.width;
        continue;
      }
      if (line.length && lineWidth + segment.width > layout.width) {
        lines.push(mergeAdjacentSegments(line));
        line = [];
        lineWidth = 0;
      }
      if (segment.width <= layout.width) {
        line.push(segment);
        lineWidth += segment.width;
      } else {
        // Even a grapheme wider than the box remains intact on its own line.
        const glyphLayout = { ...layout, ...segment.style };
        for (const { segment: grapheme } of graphemes.segment(atom.text)) {
          const width = measuredWidth(grapheme, glyphLayout);
          if (line.length && lineWidth + width > layout.width) {
            lines.push(mergeAdjacentSegments(line));
            line = [];
            lineWidth = 0;
          }
          line.push({ text: grapheme, style: segment.style, width });
          lineWidth += width;
        }
      }
    }
    lines.push(mergeAdjacentSegments(line));
  }
  return lines;
}

/** One unwrapped SVG text chunk, optionally capped by host perimeter to prevent text overlap. */
export function textPathSegments(shape: Shape, host?: Shape): TextSegment[] {
  const lines = textRunLines({ ...shape, textSizing: 'auto-width' });
  const rawSegments: TextSegment[] = [];
  for (const [index, line] of lines.entries()) {
    if (index) rawSegments.push({ text: ' ', style: line[0].style, width: 0 });
    rawSegments.push(...line.map(segment => ({ ...segment, text: segment.text.replace(/[\r\n]/g, ' ') })));
  }
  if (!host || !isClosedTextPathHost(host)) return rawSegments;

  const maxPerimeter = textPathPerimeter(host);
  let accumulated = 0;
  const result: TextSegment[] = [];
  for (const seg of rawSegments) {
    let segText = '';
    for (const { segment: char } of graphemes.segment(seg.text)) {
      const w = measuredWidth(char, {
        ...shape,
        fontSize: seg.style.fontSize,
        fontFamily: seg.style.fontFamily,
        fontWeight: seg.style.fontWeight,
        fontStyle: seg.style.fontStyle,
        letterSpacing: seg.style.letterSpacing,
      });
      if (accumulated + w > maxPerimeter) {
        if (segText) result.push({ ...seg, text: segText, width: measuredWidth(segText, { ...shape, fontSize: seg.style.fontSize, fontFamily: seg.style.fontFamily, fontWeight: seg.style.fontWeight, fontStyle: seg.style.fontStyle, letterSpacing: seg.style.letterSpacing }) });
        return result;
      }
      accumulated += w;
      segText += char;
    }
    if (segText) result.push({ ...seg, text: segText, width: measuredWidth(segText, { ...shape, fontSize: seg.style.fontSize, fontFamily: seg.style.fontFamily, fontWeight: seg.style.fontWeight, fontStyle: seg.style.fontStyle, letterSpacing: seg.style.letterSpacing }) });
  }
  return result;
}

/** Computes the perimeter of a closed textPath host shape. */
export function textPathPerimeter(host: Shape): number {
  const { width, height } = host;
  if (host.type === 'ellipse') {
    const a = width / 2;
    const b = height / 2;
    // Ramanujan's approximation for ellipse perimeter
    const h = ((a - b) * (a - b)) / ((a + b) * (a + b) || 1);
    return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  }
  if (host.type === 'rect') {
    const [tl, tr, br, bl] = host.cornerRadii ?? [0, 0, 0, 0];
    const scale = Math.min(1, width / (tl + tr || 1), width / (bl + br || 1),
      height / (tl + bl || 1), height / (tr + br || 1));
    const sumCorners = (tl + tr + br + bl) * scale;
    return 2 * (width + height) - 8 * (sumCorners / 4) + 2 * Math.PI * (sumCorners / 4);
  }
  if (host.type === 'polygon') {
    const pts = polygonPoints.map(p => ({ x: p.x * width, y: p.y * height }));
    return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) +
      Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y) +
      Math.hypot(pts[0].x - pts[2].x, pts[0].y - pts[2].y);
  }
  if (host.type === 'star') {
    const pts = starPoints.map(p => ({ x: p.x * width, y: p.y * height }));
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const next = pts[(i + 1) % pts.length];
      sum += Math.hypot(next.x - pts[i].x, next.y - pts[i].y);
    }
    return sum;
  }
  return Infinity;
}

/** Computes measured length along a textPath from its text segments. */
export function textPathComputedLength(shape: Shape, host?: Shape): number {
  const segments = textPathSegments(shape, host);
  let length = 0;
  for (const segment of segments) {
    length += measuredWidth(segment.text, {
      ...shape,
      fontSize: segment.style.fontSize,
      fontFamily: segment.style.fontFamily,
      fontWeight: segment.style.fontWeight,
      fontStyle: segment.style.fontStyle,
      letterSpacing: segment.style.letterSpacing,
    });
  }
  return length;
}

/** Samples points and normals along the host path to generate an outline ribbon around curved text. */
export function textPathRibbon(path: SVGPathElement, offsetPercent: number, textLength: number, fontSize: number): {
  ribbonPath: string;
  handlePoint: { x: number; y: number };
} | null {
  const pathLength = path.getTotalLength();
  if (!pathLength) return null;
  const isClosed = path.getAttribute('d')?.includes(' Z');
  // On closed looping paths, total length is 2 loops so loopLength is half.
  const loopLength = isClosed ? pathLength / 2 : pathLength;
  const start = Math.max(0, Math.min(loopLength, (offsetPercent / 100) * loopLength));
  const end = Math.min(pathLength, start + Math.max(1, textLength));
  const steps = 36;
  const outer: { x: number; y: number }[] = [];
  const inner: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const d = start + (end - start) * (i / steps);
    const p = path.getPointAtLength(d);
    const d1 = Math.max(0, d - 0.5);
    const d2 = Math.min(pathLength, d + 0.5);
    const p1 = path.getPointAtLength(d1);
    const p2 = path.getPointAtLength(d2);
    const tx = p2.x - p1.x;
    const ty = p2.y - p1.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    outer.push({ x: p.x - nx * fontSize * 1.05, y: p.y - ny * fontSize * 1.05 });
    inner.push({ x: p.x + nx * fontSize * 0.25, y: p.y + ny * fontSize * 0.25 });
  }
  let ribbon = `M ${outer[0].x} ${outer[0].y}`;
  for (let i = 1; i < outer.length; i++) ribbon += ` L ${outer[i].x} ${outer[i].y}`;
  ribbon += ` L ${inner[inner.length - 1].x} ${inner[inner.length - 1].y}`;
  for (let i = inner.length - 2; i >= 0; i--) ribbon += ` L ${inner[i].x} ${inner[i].y}`;
  ribbon += ' Z';
  const hp = path.getPointAtLength(start);
  return { ribbonPath: ribbon, handlePoint: { x: hp.x, y: hp.y } };
}

/** Mirrors pre-wrap/overflow-wrap: anywhere without splitting a grapheme cluster. */
export function textLines(shape: TextLayout): string[] {
  return textRunLines(shape).map(line => line.map(segment => segment.text).join(''));
}

export type TextLineMetrics = { segments: TextSegment[]; height: number; baseline: number };

/** Per-line height/baseline: auto mode grows each line to its tallest segment; an explicit lineHeight applies uniformly (may overflow taller glyphs, matching Figma's fixed-line-height behavior). */
export function textLineMetrics(shape: TextLayout): TextLineMetrics[] {
  return textRunLines(shape).map(segments => {
    const baseline = Math.max(...segments.map(segment => segment.style.fontSize));
    return { segments, baseline, height: shape.lineHeight ?? baseline * 1.2 };
  });
}

/** Content height, including overflow below a fixed-size text box. */
export function textHeight(shape: TextLayout): number {
  return textLineMetrics(shape).reduce((total, line) => total + line.height, 0);
}

/** Missing sizing metadata retains the constrained, auto-height behavior of older files. */
export function textSize(shape: TextLayout & Pick<Shape, 'height'>): { width: number; height: number } {
  if (shape.textSizing === 'fixed') return { width: shape.width, height: shape.height };
  const metrics = textLineMetrics(shape);
  let width = shape.width;
  if (shape.textSizing === 'auto-width') {
    width = 1;
    for (const line of metrics) width = Math.max(width, line.segments.reduce((total, segment) => total + segment.width, 0));
    width = Math.ceil(width * 100) / 100;
  }
  const height = Math.round(metrics.reduce((total, line) => total + line.height, 0) * 100) / 100;
  return { width, height };
}
