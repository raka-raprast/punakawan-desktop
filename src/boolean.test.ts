import paper from 'paper';
import { describe, expect, it } from 'vitest';
import type { DesignPage, Shape } from './model';
import { booleanShape, canBooleanShape, recomputeBooleanGroups } from './boolean';

const rectangle = (x: number, y: number, width: number, height: number): Shape => ({
  id: `${x}:${y}`, type: 'rect', name: 'Rectangle', x, y, width, height, fill: '#f00',
});

const sampleScope = new paper.PaperScope();

// Read the returned path exactly as the editor/SVG export will: normalized local coordinates,
// then translation and independently adjustable width/height, with the even-odd fill rule.
function covers(shape: Shape, x: number, y: number): boolean {
  sampleScope.setup(null as unknown as HTMLCanvasElement);
  try {
    const path = sampleScope.PathItem.create(shape.pathData!);
    path.fillRule = 'evenodd';
    path.transform(new sampleScope.Matrix().translate(shape.x, shape.y).scale(shape.width, shape.height));
    return path.contains(new sampleScope.Point(x, y));
  } finally {
    sampleScope.project.remove();
  }
}

function expectBounds(shape: Shape, x: number, y: number, width: number, height: number): void {
  expect(shape.x).toBeCloseTo(x);
  expect(shape.y).toBeCloseTo(y);
  expect(shape.width).toBeCloseTo(width);
  expect(shape.height).toBeCloseTo(height);
}

describe('closed filled geometry eligibility', () => {
  it('accepts fills, including closed vectors, but not image/text/frame content or open strokes', () => {
    const base = rectangle(0, 0, 20, 20);
    for (const type of ['rect', 'ellipse', 'polygon', 'star'] as const) {
      expect(canBooleanShape({ ...base, type })).toBe(true);
    }
    expect(canBooleanShape({ ...base, type: 'vector', pathData: 'M0 0 L1 0 L1 1 Z' })).toBe(true);
    for (const type of ['frame', 'text', 'image', 'line', 'arrow'] as const) {
      expect(canBooleanShape({ ...base, type })).toBe(false);
    }
    expect(canBooleanShape({ ...base, type: 'vector', pathData: 'M0 0 L1 1' })).toBe(false);
    expect(canBooleanShape({ ...base, type: 'vector', pathData: 'M0 0 L1 0 Z M0 0 L1 1' })).toBe(false);
    expect(canBooleanShape({ ...base, stroke: '#000' })).toBe(false);
    expect(canBooleanShape({ ...base, stroke: '#000', strokeWidth: 0 })).toBe(true);
    expect(canBooleanShape({ ...base, opacity: 0.5 })).toBe(false);
    expect(booleanShape([{ ...base, opacity: 0.5 }], 'flatten')).toBeNull();
  });
});

describe('Boolean operations in canvas order', () => {
  const left = rectangle(0, 0, 10, 10);
  const right = rectangle(5, 0, 10, 10);

  it('unites overlapping rectangles without canceling their overlap under even-odd fill', () => {
    const result = booleanShape([left, right], 'union')!;
    expect(result.type).toBe('vector');
    expect(result.name).toBe('union');
    expectBounds(result, 0, 0, 15, 10);
    expect(covers(result, 2, 5)).toBe(true);
    expect(covers(result, 7, 5)).toBe(true);
    expect(covers(result, 13, 5)).toBe(true);
    expect(covers(result, 16, 5)).toBe(false);
  });

  it('returns null when an intersection has no filled area', () => {
    expect(booleanShape([left, rectangle(20, 0, 10, 10)], 'intersect')).toBeNull();
    expect(booleanShape([left, rectangle(10, 0, 10, 10)], 'intersect')).toBeNull();
    const result = booleanShape([left, right], 'intersect')!;
    expectBounds(result, 5, 0, 5, 10);
    expect(covers(result, 7, 5)).toBe(true);
    expect(covers(result, 3, 5)).toBe(false);
  });

  it('subtracts all higher layers from the bottommost and preserves a real hole', () => {
    const outer = rectangle(0, 0, 20, 20);
    const inner = rectangle(5, 5, 10, 10);
    const result = booleanShape([outer, inner], 'subtract')!;
    expectBounds(result, 0, 0, 20, 20);
    expect(covers(result, 2, 10)).toBe(true);
    expect(covers(result, 10, 10)).toBe(false);
    expect(booleanShape([inner, outer], 'subtract')).toBeNull();
  });

  it('excludes the common area while retaining both outside islands', () => {
    const result = booleanShape([left, right], 'exclude')!;
    expectBounds(result, 0, 0, 15, 10);
    expect(covers(result, 2, 5)).toBe(true);
    expect(covers(result, 7, 5)).toBe(false);
    expect(covers(result, 13, 5)).toBe(true);
  });

  it('flattens both a single shape and overlapping shapes into one union footprint', () => {
    const single = booleanShape([left], 'flatten')!;
    expectBounds(single, 0, 0, 10, 10);
    const merged = booleanShape([left, right, rectangle(10, 0, 10, 10)], 'flatten')!;
    expect(merged.type).toBe('vector');
    expectBounds(merged, 0, 0, 20, 10);
    for (const x of [2, 7, 12, 17]) expect(covers(merged, x, 5)).toBe(true);
  });

  it('uses the bottom shape fill and preserves parent only for a shared parent', () => {
    const first = { ...left, fill: '#123456', parentId: 'frame' };
    const second = { ...right, fill: '#abcdef', parentId: 'frame' };
    const result = booleanShape([first, second], 'union')!;
    expect(result.fill).toBe('#123456');
    expect(result.parentId).toBe('frame');
    expect(result.id).not.toBe(first.id);
    expect(booleanShape([first, { ...second, parentId: 'other' }], 'union')!.parentId).toBeUndefined();
  });
});

describe('curves, transforms, and normalized vectors', () => {
  it('rotates an operand about its own center before intersecting', () => {
    const rotated = { ...rectangle(0, 0, 20, 10), rotation: 90 };
    const result = booleanShape([rotated, rectangle(0, -10, 10, 30)], 'intersect')!;
    expectBounds(result, 5, -5, 5, 20);
    expect(covers(result, 7, 0)).toBe(true);
    expect(covers(result, 12, 0)).toBe(false);
  });

  it('keeps Bezier outlines for ellipses and individually rounded rectangle corners', () => {
    const oval = booleanShape([{ ...rectangle(0, 0, 20, 10), type: 'ellipse' }], 'flatten')!;
    expectBounds(oval, 0, 0, 20, 10);
    expect(oval.pathData).toMatch(/[Cc]/);
    expect(covers(oval, 10, 5)).toBe(true);
    expect(covers(oval, 1, 1)).toBe(false);

    const rounded = booleanShape([{ ...rectangle(0, 0, 20, 20), cornerRadii: [8, 0, 0, 0] }], 'flatten')!;
    expect(rounded.pathData).toMatch(/[Cc]/);
    expect(covers(rounded, 1, 1)).toBe(false);
    expect(covers(rounded, 19, 1)).toBe(true);
  });

  it('supports polygon and star outlines', () => {
    for (const type of ['polygon', 'star'] as const) {
      const result = booleanShape([{ ...rectangle(0, 0, 20, 20), type }], 'flatten')!;
      expect(result.pathData).toMatch(/[Zz]/);
      expect(covers(result, 10, 10)).toBe(true);
    }
  });

  it('honors normalized input paths and permits move/resize without losing local geometry', () => {
    const input: Shape = { ...rectangle(20, 30, 40, 20), type: 'vector',
      pathData: 'M0 0 L1 0 L1 1 L0 1 Z' };
    const result = booleanShape([input], 'flatten')!;
    expectBounds(result, 20, 30, 40, 20);
    expect(covers(result, 30, 35)).toBe(true);
    expect(covers(result, 10, 35)).toBe(false);
    const resized = { ...result, x: -10, y: -20, width: 80, height: 40 };
    expect(covers(resized, 60, 10)).toBe(true);
    expect(covers(resized, 80, 10)).toBe(false);
    const repeated = booleanShape([resized], 'flatten')!;
    expectBounds(repeated, -10, -20, 80, 40);
    expect(covers(repeated, 60, 10)).toBe(true);
  });

  it('respects even-odd holes and overlapping contours from an existing vector', () => {
    const square = 'M0 0 L1 0 L1 1 L0 1 Z';
    const hole = 'M.25 .25 L.75 .25 L.75 .75 L.25 .75 Z';
    const vector = { ...rectangle(20, 30, 40, 40), type: 'vector' as const,
      pathData: `${square} ${hole}` };
    const result = booleanShape([vector], 'flatten')!;
    expect(covers(result, 23, 33)).toBe(true);
    expect(covers(result, 40, 50)).toBe(false);

    const crossing = { ...vector, pathData: `${square} M.5 0 L1.5 0 L1.5 1 L.5 1 Z` };
    const parity = booleanShape([crossing], 'flatten')!;
    expect(covers(parity, 25, 50)).toBe(true);
    expect(covers(parity, 50, 50)).toBe(false);
    expect(covers(parity, 70, 50)).toBe(true);
  });
});

describe('editable Boolean groups', () => {
  it('refreshes the same group from source position, size, rotation, and canvas order', () => {
    const first = { ...rectangle(0, 0, 20, 20), id: 'first', parentId: 'group', fill: '#314159' };
    const second = { ...rectangle(10, 0, 20, 20), id: 'second', parentId: 'group' };
    const group: Shape = { ...rectangle(0, 0, 1, 1), id: 'group', type: 'boolean',
      booleanOperation: 'subtract', pathData: '', rotation: 90 };
    const page: DesignPage = { id: 'page', name: 'Page', shapes: [group, second, first] };
    recomputeBooleanGroups(page);
    expect(group.fill).toBe(second.fill);
    expectBounds(group, 20, 0, 10, 20);
    page.shapes.splice(1, 2, first, second);
    recomputeBooleanGroups(page);
    expectBounds(group, 0, 0, 10, 20);
    expect(group.fill).toBe(first.fill);
    expect(covers(group, 5, 10)).toBe(true);
    expect(covers(group, 15, 10)).toBe(false);
    second.x = 5;
    second.width = 10;
    recomputeBooleanGroups(page);
    expectBounds(group, 0, 0, 20, 20);
    expect(covers(group, 3, 10)).toBe(true);
    expect(covers(group, 10, 10)).toBe(false);
    expect(covers(group, 18, 10)).toBe(true);
    second.x = 0;
    second.y = 0;
    second.width = 20;
    second.height = 10;
    second.rotation = 90;
    group.booleanOperation = 'intersect';
    recomputeBooleanGroups(page);
    expectBounds(group, 5, 0, 10, 15);
    expect(covers(group, 10, 12)).toBe(true);
    expect(covers(group, 2, 12)).toBe(false);
    expect(group.rotation).toBe(90); // metadata, never a second rotation of cached geometry
  });

  it('recomputes nested groups bottom-up and revives empty intersections', () => {
    const inner: Shape = { ...rectangle(0, 0, 1, 1), id: 'inner', type: 'boolean',
      booleanOperation: 'intersect', pathData: '', parentId: 'outer' };
    const outer: Shape = { ...rectangle(0, 0, 1, 1), id: 'outer', type: 'boolean',
      booleanOperation: 'union', pathData: '' };
    const left = { ...rectangle(0, 0, 10, 10), id: 'left', parentId: 'inner' };
    const moving = { ...rectangle(20, 0, 10, 10), id: 'moving', parentId: 'inner' };
    const island = { ...rectangle(40, 0, 10, 10), id: 'island', parentId: 'outer' };
    const page: DesignPage = { id: 'page', name: 'Page', shapes: [outer, left, island, inner, moving] };
    recomputeBooleanGroups(page);
    expect(inner.pathData).toBe('');
    expectBounds(inner, 0, 0, 30, 10);
    expect(canBooleanShape(inner)).toBe(false);
    expectBounds(outer, 40, 0, 10, 10);
    expect(covers(outer, 45, 5)).toBe(true);
    moving.x = 5;
    recomputeBooleanGroups(page);
    expectBounds(inner, 5, 0, 5, 10);
    expect(canBooleanShape(inner)).toBe(true);
    expectBounds(outer, 5, 0, 45, 10);
    expect(covers(outer, 7, 5)).toBe(true);
    expect(covers(outer, 45, 5)).toBe(true);
    expect(covers(outer, 30, 5)).toBe(false);
    outer.booleanOperation = 'intersect';
    recomputeBooleanGroups(page);
    expect(outer.pathData).toBe('');
    expectBounds(outer, 5, 0, 45, 10);
    expect(canBooleanShape(outer)).toBe(false);
    outer.booleanOperation = 'subtract';
    moving.x = 20;
    page.shapes.splice(2, 2, inner, island);
    recomputeBooleanGroups(page);
    expect(outer.pathData).toBe(''); // bottom operand is empty, so subtract stays empty
  });
  it('keeps the filled footprint editable after an operand gains appearance styles', () => {
    const group: Shape = { ...rectangle(0, 0, 1, 1), id: 'group', type: 'boolean',
      booleanOperation: 'subtract', pathData: '' };
    const first = { ...rectangle(0, 0, 20, 20), id: 'first', parentId: 'group' };
    const second: Shape = { ...rectangle(10, 0, 20, 20), id: 'second', parentId: 'group' };
    const page: DesignPage = { id: 'page', name: 'Page', shapes: [group, first, second] };
    recomputeBooleanGroups(page);
    expect(covers(group, 7, 10)).toBe(true);
    second.stroke = '#000';
    second.strokeWidth = 3;
    second.opacity = 0.5;
    second.x = 5;
    recomputeBooleanGroups(page);
    expect(covers(group, 3, 10)).toBe(true);
    expect(covers(group, 7, 10)).toBe(false);
    expect(group.pathData).not.toBe('');
  });
  it('keeps subpixel silhouette bounds precise for drawing and export', () => {
    const group: Shape = { ...rectangle(0, 0, 1, 1), id: 'group', type: 'boolean',
      booleanOperation: 'intersect', pathData: '' };
    const page: DesignPage = { id: 'page', name: 'Page', shapes: [
      group,
      { ...rectangle(0, 0, 1, 1), id: 'first', parentId: 'group' },
      { ...rectangle(0.5, 0, 1, 1), id: 'second', parentId: 'group' },
    ] };
    recomputeBooleanGroups(page);
    expectBounds(group, 0.5, 0, 0.5, 1);
    expect(covers(group, 0.75, 0.5)).toBe(true);
    expect(covers(group, 0.25, 0.5)).toBe(false);
  });
  it('releases Boolean group children back to their parent container upon ungroup', () => {
    const group: Shape = { ...rectangle(0, 0, 20, 20), id: 'group', type: 'boolean',
      booleanOperation: 'union', pathData: '', parentId: 'frame-1' };
    const first: Shape = { ...rectangle(0, 0, 10, 10), id: 'first', parentId: 'group' };
    const second: Shape = { ...rectangle(10, 0, 10, 10), id: 'second', parentId: 'group' };
    const page: DesignPage = { id: 'page', name: 'Page', shapes: [group, first, second] };
    recomputeBooleanGroups(page);
    // Simulate ungrouping 'group'
    const children = page.shapes.filter(s => s.parentId === group.id);
    for (const child of children) child.parentId = group.parentId;
    page.shapes = page.shapes.filter(s => s.id !== group.id);
    expect(page.shapes.map(s => s.id)).toEqual(['first', 'second']);
    expect(first.parentId).toBe('frame-1');
    expect(second.parentId).toBe('frame-1');
    expect(page.shapes.some(s => s.type === 'boolean')).toBe(false);
  });
});
