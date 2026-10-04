import { describe, expect, it } from 'vitest';
import { angleBetween, center, drawBounds, fitCamera, normalizeAngle, resizeBounds, rotatedBounds, rotateVector, snapAngle, snapDrawBounds, snapResizeBounds, worldAt, zoomAt, type Bounds, type Handle } from './geometry';

const original: Bounds = { x: -20, y: 30, width: 100, height: 50 };

describe('drawing bounds', () => {
  it('normalizes a reversed ellipse drag without clipping negative world coordinates', () => {
    expect(drawBounds({ x: 40, y: 50 }, { x: -30, y: -20 }, 'ellipse'))
      .toEqual({ x: -30, y: -20, width: 70, height: 70 });
  });

  it('reflects live drag coordinates even if just one axis changes', () => {
    expect(drawBounds({ x: -10, y: 12 }, { x: 13, y: 12 }, 'rect'))
      .toEqual({ x: -10, y: 12, width: 23, height: 1 });
    expect(drawBounds({ x: 10, y: 10 }, { x: 6.5, y: 4.5 }, 'text'))
      .toEqual({ x: 6.5, y: 4.5, width: 3.5, height: 5.5 });
  });

  it.each([
    ['rect', 160, 120], ['ellipse', 160, 120], ['text', 280, 64],
    ['frame', 480, 320], ['line', 180, 1], ['arrow', 180, 1],
    ['polygon', 160, 160], ['star', 160, 160],
  ] as const)('uses a %s click default without repositioning the click', (type, width, height) => {
    expect(drawBounds({ x: -200, y: 900 }, { x: -200, y: 900 }, type))
      .toEqual({ x: -200, y: 900, width, height });
  });
  it('normalizes reversed line and arrow drags while preserving their visible extent', () => {
    for (const type of ['line', 'arrow'] as const) {
      expect(drawBounds({ x: 80, y: 35 }, { x: -30, y: -15 }, type))
        .toEqual({ x: -30, y: -15, width: 110, height: 50 });
    }
  });
});

describe('snapped drawing bounds', () => {
  it('snaps within two screen pixels of tens, leaving custom integer sizes available', () => {
    expect(snapDrawBounds({ x: -100.25, y: 4.125 }, { x: -79.25, y: 25.125 }, 'rect', 2))
      .toEqual({ x: -100.25, y: 4.125, width: 20, height: 20 });
    expect(snapDrawBounds({ x: -100.25, y: 4.125 }, { x: -79.24, y: 25.135 }, 'rect', 2))
      .toEqual({ x: -100.25, y: 4.125, width: 21, height: 21 });
    expect(snapDrawBounds({ x: -8, y: -6 }, { x: 13.5, y: 15.5 }, 'frame', 1.25))
      .toEqual({ x: -8, y: -6, width: 20, height: 20 });
    expect(snapDrawBounds({ x: 0, y: 0 }, { x: 19.4, y: 19.4 }, 'rect', 0.25))
      .toEqual({ x: 0, y: 0, width: 19, height: 19 });
  });

  it('keeps the starting corner fixed on a reversed drag, including negative fractional positions', () => {
    expect(snapDrawBounds({ x: -10.25, y: 30.5 }, { x: -31.26, y: 9.49 }, 'ellipse', 1))
      .toEqual({ x: -30.25, y: 10.5, width: 20, height: 20 });
    expect(snapDrawBounds({ x: -10.25, y: 30.5 }, { x: -34.26, y: 7.99 }, 'ellipse', 1, true))
      .toEqual({ x: -34.25, y: 8, width: 24, height: 22.5 });
  });
  it('uses exact frame and line click defaults even in fine mode', () => {
    for (const type of ['frame', 'line', 'arrow'] as const) {
      const point = { x: -31.25, y: 14.5 };
      expect(snapDrawBounds(point, point, type, 1.25, true)).toEqual(drawBounds(point, point, type));
    }
    expect(snapDrawBounds({ x: 1, y: 2 }, { x: 37.8, y: 2 }, 'line', 0.5))
      .toEqual({ x: 1, y: 2, width: 40, height: 1 });
    expect(snapDrawBounds({ x: -2, y: 25 }, { x: -2, y: -11.8 }, 'arrow', 0.5))
      .toEqual({ x: -2, y: -15, width: 1, height: 40 });
  });

  it('rounds fine drag dimensions to tenths without snapping to tens', () => {
    expect(snapDrawBounds({ x: 4, y: -6 }, { x: 28.06, y: 20.04 }, 'rect', 2, true))
      .toEqual({ x: 4, y: -6, width: 24.1, height: 26 });
  });
});

describe('camera', () => {
  it('maps between world and screen, including negative world positions', () => {
    expect(worldAt({ x: 100, y: 50, zoom: 2 }, { x: 60, y: 70 })).toEqual({ x: -20, y: 10 });
  });

  it('anchors zoom at the cursor and clamps the zoom range', () => {
    const camera = { x: 100, y: 50, zoom: 2 };
    const screen = { x: 60, y: 70 };
    const before = worldAt(camera, screen);
    for (const requested of [0.01, 0.5, 20]) {
      const next = zoomAt(camera, requested, screen);
      expect(next.zoom).toBe(Math.min(8, Math.max(0.1, requested)));
      expect(worldAt(next, screen).x).toBeCloseTo(before.x);
      expect(worldAt(next, screen).y).toBeCloseTo(before.y);
      expect(camera).toEqual({ x: 100, y: 50, zoom: 2 });
    }
  });

  it('centers the empty infinite canvas at its world origin at 100%', () => {
    const camera = fitCamera(1200, 800);
    expect(camera).toEqual({ x: 600, y: 400, zoom: 1 });
    expect(worldAt(camera, { x: 600, y: 400 })).toEqual({ x: 0, y: 0 });
  });

  it('fits off-origin content with padding and keeps its center in view', () => {
    const bounds = { x: -200, y: 120, width: 800, height: 600 };
    const camera = fitCamera(1000, 800, bounds);
    expect(camera.zoom).toBeCloseTo(1.13);
    const center = worldAt(camera, { x: 500, y: 400 });
    expect(center.x).toBeCloseTo(200);
    expect(center.y).toBeCloseTo(420);
    expect(worldAt(camera, { x: 48, y: 61 }).x).toBeCloseTo(-200);
    expect(worldAt(camera, { x: 48, y: 61 }).y).toBeCloseTo(120);
  });
});

describe('resizing', () => {
  it.each([
    ['nw', { x: -30, y: 25, width: 110, height: 55 }],
    ['ne', { x: -20, y: 25, width: 110, height: 55 }],
    ['se', { x: -20, y: 30, width: 110, height: 55 }],
    ['sw', { x: -30, y: 30, width: 110, height: 55 }],
  ] as const)('resizes the %s corner with its opposite corner anchored', (handle, expected) => {
    expect(resizeBounds(original, handle, handle.includes('w') ? -10 : 10, handle.includes('n') ? -5 : 5)).toEqual(expected);
  });

  it.each([
    ['n', { x: -20, y: 35, width: 100, height: 45 }],
    ['e', { x: -20, y: 30, width: 110, height: 50 }],
    ['s', { x: -20, y: 30, width: 100, height: 55 }],
    ['w', { x: -10, y: 30, width: 90, height: 50 }],
  ] as const)('resizes the %s edge only on its own axis', (handle, expected) => {
    expect(resizeBounds(original, handle, 10, 5, true)).toEqual(expected);
  });

  it.each(['nw', 'ne', 'se', 'sw'] as Handle[])('locks aspect ratio at the %s corner', handle => {
    const oppositeX = handle.includes('w') ? original.x + original.width : original.x;
    const oppositeY = handle.includes('n') ? original.y + original.height : original.y;
    const resized = resizeBounds(original, handle, handle.includes('w') ? -30 : 30, 0, true);
    expect(resized.width).toBe(130);
    expect(resized.height).toBe(65);
    expect(handle.includes('w') ? resized.x + resized.width : resized.x).toBe(oppositeX);
    expect(handle.includes('n') ? resized.y + resized.height : resized.y).toBe(oppositeY);
  });

  it('allows vertical movement to drive aspect-locked resize', () => {
    expect(resizeBounds(original, 'nw', 0, -25, true))
      .toEqual({ x: -70, y: 5, width: 150, height: 75 });
  });

  it('clamps crossing at one unit and keeps the opposite edge fixed', () => {
    expect(resizeBounds(original, 'w', 200, 0)).toEqual({ x: 79, y: 30, width: 1, height: 50 });
    expect(resizeBounds(original, 'n', 0, 200)).toEqual({ x: -20, y: 79, width: 100, height: 1 });
    expect(resizeBounds(original, 'se', -200, -200)).toEqual({ x: -20, y: 30, width: 1, height: 1 });
    const locked = resizeBounds(original, 'nw', 200, 200, true);
    expect(locked.width / locked.height).toBe(2);
    expect(locked.width).toBe(2);
    expect(locked.height).toBe(1);
    expect(locked.x + locked.width).toBe(80);
    expect(locked.y + locked.height).toBe(80);
  });
});

describe('snapped resizing bounds', () => {
  it('anchors the opposite edge of left and top handles after snapping', () => {
    const left = snapResizeBounds(original, 'w', 28.9, 100, false, 1.5);
    expect(left).toEqual({ x: 10, y: 30, width: 70, height: 50 });
    expect(left.x + left.width).toBe(80);
    const top = snapResizeBounds(original, 'n', 100, 18.9, false, 1.5);
    expect(top).toEqual({ x: -20, y: 50, width: 100, height: 30 });
    expect(top.y + top.height).toBe(80);
    expect(snapResizeBounds(original, 'w', 26.9, 0, false, 2))
      .toEqual({ x: 7, y: 30, width: 73, height: 50 });
  });

  it('preserves untouched fractional axes and rounds fine resizes to tenths', () => {
    const fractional: Bounds = { x: -31.25, y: 14.5, width: 87.4, height: 32.6 };
    expect(snapResizeBounds(fractional, 'e', 3.1, 4, false, 1))
      .toEqual({ x: -31.25, y: 14.5, width: 90, height: 32.6 });
    expect(snapResizeBounds(original, 'e', 24.06, 0, false, 1, true))
      .toEqual({ x: -20, y: 30, width: 124.1, height: 50 });
    expect(snapResizeBounds(original, 'w', 124, 0, false, 1, true))
      .toEqual({ x: 79, y: 30, width: 1, height: 50 });
  });

  it.each(['nw', 'ne', 'se', 'sw'] as Handle[])('locks %s corners to the original ratio and opposite corner', handle => {
    const widthDirection = handle.includes('w') ? -1 : 1;
    const resized = snapResizeBounds(original, handle, widthDirection * 19.1, 0, true, 1);
    expect(resized.width).toBe(120);
    expect(resized.height).toBe(60);
    expect(handle.includes('w') ? resized.x + resized.width : resized.x).toBe(handle.includes('w') ? 80 : -20);
    expect(handle.includes('n') ? resized.y + resized.height : resized.y).toBe(handle.includes('n') ? 80 : 30);
  });

  it('lets the dominant vertical corner drag snap while maintaining aspect and clamps crossing', () => {
    expect(snapResizeBounds(original, 'nw', 0, -11.9, true, 1))
      .toEqual({ x: -40, y: 20, width: 120, height: 60 });
    expect(snapResizeBounds(original, 'nw', 200, 200, true, 1))
      .toEqual({ x: 78, y: 79, width: 2, height: 1 });
  });
});

describe('rotation and aspect-locked images', () => {
  it('keeps an image ratio while resizing a side and fixes the opposite edge midpoint', () => {
    expect(snapResizeBounds(original, 'e', 20, 0, true, 1)).toEqual({
      x: -20, y: 25, width: 120, height: 60,
    });
    expect(snapResizeBounds(original, 'n', 0, -10, true, 1)).toEqual({
      x: -30, y: 20, width: 120, height: 60,
    });
    expect(snapResizeBounds(original, 'e', 20, 0, false, 1)).toEqual({
      x: -20, y: 30, width: 120, height: 50,
    });
  });

  it('snaps rotation to 15-degree increments and keeps a rotated resize anchored', () => {
    const pivot = center(original);
    expect(angleBetween(pivot, { x: pivot.x, y: pivot.y + 30 })).toBe(90);
    expect(normalizeAngle(snapAngle(103))).toBe(105);
    const resized = snapResizeBounds(original, 'se', 20, 10, true, 1);
    const originalCenter = center(original);
    const nextCenter = center(resized);
    const delta = { x: nextCenter.x - originalCenter.x, y: nextCenter.y - originalCenter.y };
    const rotatedDelta = rotateVector(delta, 90);
    const adjusted = {
      ...resized, x: resized.x + rotatedDelta.x - delta.x, y: resized.y + rotatedDelta.y - delta.y,
    };
    const worldAnchor = (box: Bounds) => {
      const midpoint = center(box);
      const offset = rotateVector({ x: box.x - midpoint.x, y: box.y - midpoint.y }, 90);
      return { x: midpoint.x + offset.x, y: midpoint.y + offset.y };
    };
    expect(worldAnchor(adjusted).x).toBeCloseTo(worldAnchor(original).x);
    expect(worldAnchor(adjusted).y).toBeCloseTo(worldAnchor(original).y);
  });
});

describe('rotated visible bounds', () => {
  it('includes corners outside the unrotated box when fitting and exporting', () => {
    const box = rotatedBounds(original, 90);
    expect(box.x).toBeCloseTo(5);
    expect(box.y).toBeCloseTo(5);
    expect(box.width).toBeCloseTo(50);
    expect(box.height).toBeCloseTo(100);
    expect(rotatedBounds(original, 0)).toBe(original);
  });

  it('rotates overflowing text content around the original text box, not its taller overflow', () => {
    const overflow = rotatedBounds({ x: 0, y: 0, width: 100, height: 80 }, 90, { x: 50, y: 20 });
    expect(overflow.x).toBeCloseTo(-10);
    expect(overflow.y).toBeCloseTo(-30);
    expect(overflow.width).toBeCloseTo(80);
    expect(overflow.height).toBeCloseTo(100);
  });
});
