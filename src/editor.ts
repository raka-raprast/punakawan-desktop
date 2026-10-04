import type { Bounds } from './geometry';
import { rotatedBounds } from './geometry';
import type { DesignPage, ExportFormat, Shape } from './model';
import { isClosedTextPathHost, measuredWidth, pathForShape, roundedRectPath, shapeTransform, textLineMetrics, textPathForShape, textPathSegments, textSize, type TextSegment } from './shapes';

import { appearanceMargin, backdropLayer, backdropMarkup, effectsFilter, strokeOverlay, visibleStroke } from './appearance';
/** Trims trailing space/tab glyphs from a wrapped line's last segment, recomputing its measured width. */
function trimTrailingSpace(shape: Shape, line: TextSegment[]): TextSegment[] {
  const last = line[line.length - 1];
  const trimmed = last.text.replace(/[ \t]+$/, '');
  if (trimmed === last.text) return line;
  const width = trimmed ? measuredWidth(trimmed, { ...shape, ...last.style }) : 0;
  return [...line.slice(0, -1), { text: trimmed, style: last.style, width }];
}

function boundsForShapes(shapes: readonly Shape[], pageShapes: readonly Shape[] = shapes): Bounds {
  if (!shapes.length) return { x: 0, y: 0, width: 1, height: 1 };
  let hosts: Map<string, Shape> | undefined;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const shape of shapes) {
    let host: Shape | undefined;
    if (shape.textPathId) {
      if (!hosts) {
        hosts = new Map();
        for (const entry of pageShapes) hosts.set(entry.id, entry);
      }
      host = hosts.get(shape.textPathId);
    }
    let x = host?.x ?? shape.x;
    let y = host?.y ?? shape.y;
    let width = host?.width ?? shape.width;
    let height = host?.height ?? shape.height;
    if (host) {
      let padding = shape.fontSize ?? 36;
      for (const run of shape.styleRuns ?? []) padding = Math.max(padding, run.fontSize ?? 0);
      x -= padding;
      y -= padding;
      width += padding * 2;
      height += padding * 2;
    } else if (shape.type === 'text') {
      const metrics = textLineMetrics(shape);
      let contentWidth = 0;
      for (const line of metrics) {
        const segments = shape.textSizing === 'auto-width' ? line.segments : trimTrailingSpace(shape, line.segments);
        contentWidth = Math.max(contentWidth, segments.reduce((total, segment) => total + segment.width, 0));
      }
      const contentHeight = metrics.reduce((total, line) => total + line.height, 0);
      if (shape.textSizing === 'auto-width') width = contentWidth;
      const overflow = Math.max(0, contentWidth - width);
      if (shape.textAlign === 'center') x -= overflow / 2;
      else if (shape.textAlign === 'right') x -= overflow;
      width += overflow;
      height = shape.textSizing === 'fixed' ? Math.max(height, contentHeight) : contentHeight;
    }
    const pivot = host ?? shape;
    // Boolean outlines are cached in world space; rotation has already been applied to operands.
    const rotation = pivot.type === 'boolean' ? 0 : pivot.rotation ?? 0;
    const box = rotatedBounds({ x, y, width, height }, rotation,
      rotation ? { x: pivot.x + pivot.width / 2, y: pivot.y + pivot.height / 2 } : undefined);
    const margin = host ? 0 : appearanceMargin(shape);
    left = Math.min(left, box.x - margin);
    top = Math.min(top, box.y - margin);
    right = Math.max(right, box.x + box.width + margin);
    bottom = Math.max(bottom, box.y + box.height + margin);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function visibleShapes(page: DesignPage): Shape[] {
  const hosts = new Map(page.shapes.map(shape => [shape.id, shape]));
  return page.shapes.filter(shape => {
    if (shape.hidden || page.shapes.some(entry => entry.textPathId === shape.id)) return false;
    if (shape.type === 'boolean' && !shape.pathData) return false;
    const seen = new Set<string>();
    let parentId = shape.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = hosts.get(parentId);
      if (parent?.type === 'boolean' || parent?.hidden) return false;
      parentId = parent?.parentId;
    }
    return true;
  });
}

export function pageBounds(page: DesignPage): Bounds {
  return boundsForShapes(visibleShapes(page), page.shapes);
}

function selectedShapes(page: DesignPage, selected: Shape): Shape[] {
  if (selected.type === 'frame') return [selected, ...visibleShapes(page).filter(shape =>
    shape.parentId === selected.id && shape.id !== selected.id)];
  return [selected, ...page.shapes.filter(shape => shape.textPathId === selected.id)];
}

const xmlEntities: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};
const xml = (value: string): string => value.replace(/[&<>"']/g, character => xmlEntities[character]);

function shapeMarkup(shape: Shape, index: number, host?: Shape): string {
  const { x, y, width, height } = shape;
  const stroke = visibleStroke(shape);
  const overlay = strokeOverlay(shape, String(index));
  const outline = stroke && !overlay
    ? ` stroke="${xml(stroke.color)}" stroke-width="${stroke.width}"${stroke.opacity !== 1 ? ` stroke-opacity="${stroke.opacity}"` : ''}` : '';
  let markup: string;
  if (shape.type === 'rect' || shape.type === 'frame') {
    markup = shape.cornerRadii?.some(radius => radius > 0) ?
      `<path d="${roundedRectPath(shape)}" fill="${xml(shape.fill)}"${outline}/>` :
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${xml(shape.fill)}"${outline}/>`;
  } else if (shape.type === 'ellipse') {
    markup = `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${xml(shape.fill)}"${outline}/>`;
  } else if (shape.type === 'image') {
    const clip = `image-clip-${index}`;
    const path = roundedRectPath(shape);
    markup = `<defs><clipPath id="${clip}" clipPathUnits="userSpaceOnUse"><path d="${path}"/></clipPath></defs>` +
      `<g clip-path="url(#${clip})"><image x="${x}" y="${y}" width="${width}" height="${height}" ` +
      `preserveAspectRatio="xMidYMid slice" href="${xml(shape.src ?? '')}"/>` +
      (shape.stroke === undefined ? '' : `<path d="${path}" fill="none"${outline}/>`) +
      `</g>`;
  } else if (shape.type === 'line' || shape.type === 'arrow') {
    markup = `<path d="${pathForShape(shape)}" fill="none" stroke="${xml(shape.fill)}" stroke-width="${shape.strokeWidth ?? 2}" stroke-linecap="round" stroke-linejoin="round"/>`;
  } else if (shape.type === 'polygon' || shape.type === 'star') {
    markup = `<path d="${pathForShape(shape)}" fill="${xml(shape.fill)}"${outline}/>`;
  } else if (shape.type === 'vector' || shape.type === 'boolean') {
    markup = `<path d="${xml(shape.pathData ?? '')}" transform="translate(${x} ${y}) scale(${width} ${height})" ` +
      `fill="${xml(shape.fill)}" fill-rule="evenodd" vector-effect="non-scaling-stroke"${outline}/>`;
  } else if (shape.textPathId) {
    const spans = textPathSegments(shape, host).filter(segment => segment.text).map(segment =>
      `<tspan font-family="${xml(segment.style.fontFamily)}" font-size="${segment.style.fontSize}" ` +
      `font-weight="${segment.style.fontWeight}" font-style="${segment.style.fontStyle}" ` +
      `fill="${xml(segment.style.fill)}" letter-spacing="${segment.style.letterSpacing}">${xml(segment.text)}</tspan>`).join('');
    const offset = host && isClosedTextPathHost(host) ? `${(shape.textPathOffset ?? 0) / 2}%` : `${shape.textPathOffset ?? 0}%`;
    markup = `<text fill="${xml(shape.fill)}"${outline} paint-order="stroke" xml:space="preserve">` +
      `<textPath href="#text-path-${index}" xlink:href="#text-path-${index}" startOffset="${offset}">${spans}</textPath></text>`;
  } else {
    const align = shape.textAlign ?? 'left';
    const textWidth = shape.textSizing === 'auto-width' ? textSize(shape).width : width;
    const anchorX = align === 'center' ? x + textWidth / 2 : align === 'right' ? x + textWidth : x;
    const anchor = align === 'left' ? '' : ` text-anchor="${align === 'center' ? 'middle' : 'end'}"`;
    let lineTop = 0;
    const spans = textLineMetrics(shape).map(line => {
      const lineY = y + lineTop + line.baseline;
      lineTop += line.height;
      const trimmed = shape.textSizing === 'auto-width' ? line.segments : trimTrailingSpace(shape, line.segments);
      const visible = trimmed.filter(segment => segment.text.length > 0);
      const segments = visible.length ? visible : [{ ...trimmed[trimmed.length - 1], text: ' ' }];
      return segments.map((segment, segmentIndex) => {
        // Only the first tspan of a line gets an absolute position; later ones flow after it as
        // part of the same SVG text chunk, so native text-anchor aligns the whole line correctly.
        const position = segmentIndex === 0 ? ` x="${anchorX}" y="${lineY}"` : '';
        return `<tspan${position} font-family="${xml(segment.style.fontFamily)}" font-size="${segment.style.fontSize}" ` +
          `font-weight="${segment.style.fontWeight}" font-style="${segment.style.fontStyle}" ` +
          `fill="${xml(segment.style.fill)}" letter-spacing="${segment.style.letterSpacing}">${xml(segment.text || ' ')}</tspan>`;
      }).join('');
    }).join('');
    markup = `<text fill="${xml(shape.fill)}"${outline}${anchor} paint-order="stroke" xml:space="preserve">${spans}</text>`;
  }
  if (overlay) markup += overlay;
  const effect = effectsFilter(shape, String(index), host);
  if (effect) markup = `<defs>${effect.markup}</defs><g filter="url(#${effect.id})">${markup}</g>`;
  const transform = host && host.rotation
    ? `rotate(${host.rotation} ${host.x + host.width / 2} ${host.y + host.height / 2})`
    : host ? undefined : shapeTransform(shape);
  const attrs = [shape.opacity !== undefined && shape.opacity !== 1 ? `opacity="${shape.opacity}"` : '',
    transform ? `transform="${transform}"` : '']
    .filter(Boolean).join(' ');
  return attrs ? `<g ${attrs}>${markup}</g>` : markup;
}

export function svgForPage(page: DesignPage, selected?: Shape): string {
  const shapes = selected ? selectedShapes(page, selected) : visibleShapes(page);
  const bounds = selected ? boundsForShapes(shapes, page.shapes) : pageBounds(page);
  const hosts = new Map(page.shapes.map(shape => [shape.id, shape]));
  let markup = '';
  let defs = '';
  let index = 0;
  const paint = (shape: Shape, host?: Shape) => {
    // Everything painted so far is what sits behind this shape.
    const layer = host || !markup ? null : backdropLayer(shape, String(index));
    if (layer) markup += backdropMarkup(layer, markup);
    markup += shapeMarkup(shape, index++, host);
  };
  for (const shape of shapes) if (shape.type === 'frame') paint(shape);
  for (const shape of shapes) if (shape.type !== 'frame') {
    const host = shape.textPathId ? hosts.get(shape.textPathId) : undefined;
    if (host) defs += `<path id="text-path-${index}" d="${textPathForShape(host, shape.textPathFlip)}"/>`;
    paint(shape, host);
  }
  const xlink = defs ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg"${xlink} width="${bounds.width}" height="${bounds.height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}">${defs ? `<defs>${defs}</defs>` : ''}${markup}</svg>`;
}

/** `scale` multiplies raster output size; SVG is resolution independent and ignores it. JPG gets a white background; PNG and WebP keep transparency. */
export async function exportBase64(page: DesignPage, extension: ExportFormat, selected?: Shape, scale = 1): Promise<string> {
  const svg = svgForPage(page, selected);
  if (extension === 'svg') {
    const bytes = new TextEncoder().encode(svg);
    let value = '';
    for (let index = 0; index < bytes.length; index += 8192) {
      value += String.fromCharCode(...bytes.subarray(index, index + 8192));
    }
    return btoa(value);
  }
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    const bounds = selected ? boundsForShapes(selectedShapes(page, selected), page.shapes) : pageBounds(page);
    canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
    canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error(`${extension.toUpperCase()} export is unavailable on this device.`);
    if (extension === 'jpg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const mime = extension === 'jpg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : 'image/png';
    const dataUrl = canvas.toDataURL(mime, 0.92);
    // Engines without a WebP encoder silently return PNG; refuse rather than write a mislabeled file.
    if (!dataUrl.startsWith(`data:${mime}`)) throw new Error(`This device cannot encode ${extension.toUpperCase()}. Export PNG or SVG instead.`);
    return dataUrl.split(',')[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}
