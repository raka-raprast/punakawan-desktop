import type { Shape } from './model';

export type Point = { x: number; y: number };
export type Bounds = Point & { width: number; height: number };
export type Camera = Point & { zoom: number };
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

// Camera x/y are the screen position of the world origin.
export function worldAt(camera: Camera, screen: Point): Point {
  return { x: (screen.x - camera.x) / camera.zoom, y: (screen.y - camera.y) / camera.zoom };
}

export function zoomAt(camera: Camera, nextZoom: number, screen: Point): Camera {
  const zoom = Math.min(8, Math.max(0.1, nextZoom));
  const world = worldAt(camera, screen);
  return { x: screen.x - world.x * zoom, y: screen.y - world.y * zoom, zoom };
}

export function center(bounds: Bounds): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** Rotates a free vector (not a positioned point) by the given angle in degrees. */
export function rotateVector(vector: Point, degrees: number): Point {
  const rad = degrees * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos };
}

/** Angle in degrees from `origin` to `point`, 0 pointing right, increasing clockwise (matches screen/SVG y-down coordinates). */
export function angleBetween(origin: Point, point: Point): number {
  return Math.atan2(point.y - origin.y, point.x - origin.x) * 180 / Math.PI;
}

export function snapAngle(degrees: number, step = 15): number {
  return Math.round(degrees / step) * step;
}

export function normalizeAngle(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Axis-aligned footprint of a rectangle rotated around `pivot` (its own center by default). */
export function rotatedBounds(bounds: Bounds, degrees: number, pivot?: Point): Bounds {
  if (!degrees) return bounds;
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const width = bounds.width * Math.abs(cos) + bounds.height * Math.abs(sin);
  const height = bounds.width * Math.abs(sin) + bounds.height * Math.abs(cos);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const dx = pivot ? cx - pivot.x : 0;
  const dy = pivot ? cy - pivot.y : 0;
  const rotatedCx = pivot ? pivot.x + dx * cos - dy * sin : cx;
  const rotatedCy = pivot ? pivot.y + dx * sin + dy * cos : cy;
  return { x: rotatedCx - width / 2, y: rotatedCy - height / 2, width, height };
}

export function fitCamera(width: number, height: number, bounds?: Bounds): Camera {
  if (!bounds) return { x: width / 2, y: height / 2, zoom: 1 };
  const padding = Math.min(48, width * 0.1, height * 0.1);
  const zoom = Math.min(8, (width - 2 * padding) / bounds.width, (height - 2 * padding) / bounds.height);
  return {
    x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: height / 2 - (bounds.y + bounds.height / 2) * zoom,
    zoom,
  };
}

export function resizeBounds(original: Bounds, handle: Handle, dx: number, dy: number, keepAspect = false): Bounds {
  const left = handle.includes('w');
  const right = handle.includes('e');
  const top = handle.includes('n');
  const bottom = handle.includes('s');
  const corner = (left || right) && (top || bottom);

  if (corner && keepAspect) {
    // Use the axis with the greater proportional movement. The opposite corner stays fixed.
    const horizontalScale = 1 + (left ? -dx : dx) / original.width;
    const verticalScale = 1 + (top ? -dy : dy) / original.height;
    const requestedScale = Math.abs(horizontalScale - 1) >= Math.abs(verticalScale - 1)
      ? horizontalScale : verticalScale;
    const scale = Math.max(1 / original.width, 1 / original.height, requestedScale);
    const width = original.width * scale;
    const height = original.height * scale;
    return {
      x: left ? original.x + original.width - width : original.x,
      y: top ? original.y + original.height - height : original.y,
      width, height,
    };
  }

  const x = left ? Math.min(original.x + dx, original.x + original.width - 1) : original.x;
  const y = top ? Math.min(original.y + dy, original.y + original.height - 1) : original.y;
  const width = left ? original.x + original.width - x : Math.max(1, original.width + (right ? dx : 0));
  const height = top ? original.y + original.height - y : Math.max(1, original.height + (bottom ? dy : 0));
  return { x, y, width, height };
}

export function drawBounds(start: Point, end: Point, type: Exclude<Shape['type'], 'image'>): Bounds {
  if (start.x === end.x && start.y === end.y) {
    const [width, height] = type === 'frame' ? [480, 320] :
      type === 'text' ? [280, 64] :
      type === 'line' || type === 'arrow' ? [180, 1] :
      type === 'polygon' || type === 'star' ? [160, 160] : [160, 120];
    return { x: start.x, y: start.y, width, height };
  }
  return {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.max(1, Math.abs(end.x - start.x)), height: Math.max(1, Math.abs(end.y - start.y)),
  };
}

function snapDimension(value: number, zoom: number, fine: boolean): number {
  if (fine) return Math.max(1, Math.round(value * 10) / 10);
  const nearestTen = Math.round(value / 10) * 10;
  if (value >= 20 && Math.abs(value - nearestTen) * zoom <= 2) return nearestTen;
  return Math.max(1, Math.round(value));
}

export function snapDrawBounds(
  start: Point, end: Point, type: Exclude<Shape['type'], 'image'>, zoom: number, fine = false,
): Bounds {
  const raw = drawBounds(start, end, type);
  if (start.x === end.x && start.y === end.y) return raw;

  const width = snapDimension(raw.width, zoom, fine);
  const height = snapDimension(raw.height, zoom, fine);
  return {
    x: end.x < start.x ? start.x - width : start.x,
    y: end.y < start.y ? start.y - height : start.y,
    width, height,
  };
}

export function snapResizeBounds(
  original: Bounds, handle: Handle, dx: number, dy: number,
  keepAspect: boolean, zoom: number, fine = false,
): Bounds {
  const raw = resizeBounds(original, handle, dx, dy, keepAspect);
  const left = handle.includes('w');
  const right = handle.includes('e');
  const top = handle.includes('n');
  const bottom = handle.includes('s');
  let width = raw.width;
  let height = raw.height;

  if (keepAspect && (left || right || top || bottom)) {
    const corner = (left || right) && (top || bottom);
    const horizontalMovement = Math.abs((left ? -dx : dx) / original.width);
    const verticalMovement = Math.abs((top ? -dy : dy) / original.height);
    const minScale = Math.max(1 / original.width, 1 / original.height);
    const useWidth = !top && !bottom || (corner && horizontalMovement >= verticalMovement);
    const scale = useWidth
      ? Math.max(minScale, snapDimension(width, zoom, fine) / original.width)
      : Math.max(minScale, snapDimension(height, zoom, fine) / original.height);
    width = original.width * scale;
    height = original.height * scale;
  } else {
    if (left || right) width = snapDimension(width, zoom, fine);
    if (top || bottom) height = snapDimension(height, zoom, fine);
  }

  return {
    x: left ? original.x + original.width - width : right ? original.x :
      original.x + (original.width - width) / 2,
    y: top ? original.y + original.height - height : bottom ? original.y :
      original.y + (original.height - height) / 2,
    width, height,
  };
}
