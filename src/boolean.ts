import { visibleEffects, visibleStroke } from './appearance';
import paper from 'paper';
import { rotatedBounds } from './geometry';
import type { BooleanGroupOperation, DesignPage, Shape } from './model';
import { pathForShape, roundedRectPath } from './shapes';

export type BooleanOperation = BooleanGroupOperation | 'flatten';

/** Strokes and partial opacity affect appearance, not a closed operand's filled footprint. */
function hasClosedGeometry(shape: Shape): boolean {
  if (shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'polygon' || shape.type === 'star')
    return true;
  if ((shape.type !== 'vector' && shape.type !== 'boolean') || !shape.pathData) return false;
  const contours = shape.pathData.match(/[Mm][^Mm]*/g);
  return !!contours?.length && contours.every(contour => /[Zz]\s*$/.test(contour));
}

/** Only filled, opaque shapes without visible strokes can initially join a Boolean group. */
export function canBooleanShape(shape: Shape): boolean {
  return hasClosedGeometry(shape) && !visibleStroke(shape) && !visibleEffects(shape).length &&
    (shape.opacity === undefined || shape.opacity === 1);
}

let geometryScope: paper.PaperScope | undefined;

function pathForBooleanShape(shape: Shape, scope: paper.PaperScope): paper.PathItem {
  let path: paper.PathItem;
  if (shape.type === 'ellipse') {
    path = new scope.Path.Ellipse(new scope.Rectangle(shape.x, shape.y, shape.width, shape.height));
  } else if (shape.type === 'rect') {
    path = scope.PathItem.create(roundedRectPath(shape));
  } else if (shape.type === 'vector' || shape.type === 'boolean') {
    path = scope.PathItem.create(shape.pathData!);
    if (path instanceof scope.CompoundPath) {
      // SVG even-odd filling toggles at every subpath, regardless of winding.
      // Canonicalize overlapping contours as well as nested holes before Paper's area booleans.
      const contours = [...path.children] as paper.PathItem[];
      let parity = contours[0];
      for (let index = 1; index < contours.length; index++) {
        const combined = parity.exclude(contours[index], { insert: false });
        if (parity !== contours[0]) parity.remove();
        parity = combined;
      }
      path.remove();
      path = parity;
    }
    path.transform(new scope.Matrix().translate(shape.x, shape.y).scale(shape.width, shape.height));
  } else {
    path = scope.PathItem.create(pathForShape(shape));
  }
  // Existing vectors are SVG paths rendered with fillRule="evenodd".
  path.fillRule = 'evenodd';
  if (shape.type !== 'boolean') {
    const center = new scope.Point(shape.x + shape.width / 2, shape.y + shape.height / 2);
    // Mirror in local space first, then rotate, matching shapeTransform().
    if (shape.flipX || shape.flipY) path.scale(shape.flipX ? -1 : 1, shape.flipY ? -1 : 1, center);
    if (shape.rotation) path.rotate(shape.rotation, center);
  }
  return path;
}

type BooleanGeometry = Pick<Shape, 'x' | 'y' | 'width' | 'height' | 'pathData'>;

/** Eliminate CSG float noise at integer and fractional pixel coordinates without quantizing real geometry. */
function stableCoordinate(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Math.abs(value - rounded) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 16
    ? rounded : value;
}

/** The array is in canvas order: subtract removes each higher shape from the bottommost. */
function booleanGeometry(shapes: readonly Shape[], operation: BooleanOperation,
  allowStyledOperands = false): BooleanGeometry | null {
  if (!shapes.length) return null;
  if (shapes.some(shape => !hasClosedGeometry(shape) ||
    (!allowStyledOperands && !canBooleanShape(shape)))) return null;

  // Reuse the scope, not its project. Paper's headless setup accepts null, although its types require a canvas.
  const scope = geometryScope ??= new paper.PaperScope();
  scope.setup(null as unknown as HTMLCanvasElement);
  const project = scope.project;
  try {
    let result = pathForBooleanShape(shapes[0], scope);
    for (let index = 1; index < shapes.length; index++) {
      const next = pathForBooleanShape(shapes[index], scope);
      const combined = operation === 'subtract' ? result.subtract(next, { insert: false })
        : operation === 'intersect' ? result.intersect(next, { insert: false })
          : operation === 'exclude' ? result.exclude(next, { insert: false })
            : result.unite(next, { insert: false }); // Flatten retains the union footprint.
      result.remove();
      next.remove();
      result = combined;
    }

    // Compound paths can have opposite-winding islands whose signed areas cancel.
    const filled = result instanceof scope.CompoundPath
      ? result.children.some(child => child instanceof scope.Path &&
        Number.isFinite(child.area) && Math.abs(child.area) >= 1e-10)
      : result instanceof scope.Path && Number.isFinite(result.area) && Math.abs(result.area) >= 1e-10;
    if (!result.pathData || !filled) return null;
    const bounds = result.bounds;
    const x = stableCoordinate(bounds.x);
    const y = stableCoordinate(bounds.y);
    const width = stableCoordinate(bounds.width) || 1;
    const height = stableCoordinate(bounds.height) || 1;
    // x/y/width/height are world-space; stored path coordinates are local 0..1.
    result.transform(new scope.Matrix().scale(1 / width, 1 / height).translate(-x, -y));
    return { x, y, width, height, pathData: result.pathData };
  } finally {
    project.remove();
  }
}

/** Convert operands to a standalone vector; flatten intentionally discards its sources. */
export function booleanShape(shapes: readonly Shape[], operation: BooleanOperation): Shape | null {
  const geometry = booleanGeometry(shapes, operation);
  if (!geometry) return null;
  const parentId = shapes.every(shape => shape.parentId === shapes[0].parentId)
    ? shapes[0].parentId : undefined;
  return {
    id: crypto.randomUUID(), type: 'vector', name: operation,
    ...geometry, fill: shapes[0].fill, ...(parentId === undefined ? {} : { parentId }),
  };
}

/** Refresh cached world-space outlines in postorder, preserving each source shape and its canvas order. */
export function recomputeBooleanGroups(page: DesignPage): void {
  const children = new Map<string, Shape[]>();
  for (const shape of page.shapes) {
    if (shape.parentId === undefined) continue;
    const siblings = children.get(shape.parentId);
    if (siblings) siblings.push(shape);
    else children.set(shape.parentId, [shape]);
  }
  const completed = new Set<string>();
  const visiting = new Set<string>();
  function recompute(group: Shape): void {
    if (completed.has(group.id)) return;
    if (visiting.has(group.id)) throw new Error('Boolean group hierarchy contains a cycle.');
    visiting.add(group.id);
    const operands = children.get(group.id) ?? [];
    for (const operand of operands) if (operand.type === 'boolean') recompute(operand);
    if (!group.booleanOperation) throw new Error('Boolean group has no operation.');
    if (operands.some(operand => (operand.type !== 'boolean' || !!operand.pathData) &&
      !hasClosedGeometry(operand)))
      throw new Error('Boolean group contains an unsupported operand.');

    let geometry: BooleanGeometry | null = null;
    const nonempty = operands.filter(operand => operand.type !== 'boolean' || !!operand.pathData);
    if (nonempty.length && (group.booleanOperation !== 'intersect' || nonempty.length === operands.length) &&
      (group.booleanOperation !== 'subtract' || nonempty[0] === operands[0])) {
      geometry = booleanGeometry(nonempty, group.booleanOperation, true);
    }
    if (geometry) {
      group.x = geometry.x;
      group.y = geometry.y;
      group.width = geometry.width;
      group.height = geometry.height;
      group.pathData = geometry.pathData;
    } else {
      // Empty intersections remain selectable and can become nonempty after a child edit.
      // Group rotation is already baked into its operands, not applied to its cached bounds.
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (const operand of operands) {
        const box = operand.type === 'boolean' ? operand :
          rotatedBounds(operand, operand.rotation ?? 0);
        left = Math.min(left, box.x);
        top = Math.min(top, box.y);
        right = Math.max(right, box.x + box.width);
        bottom = Math.max(bottom, box.y + box.height);
      }
      if (operands.length) {
        group.x = left;
        group.y = top;
        group.width = right > left ? right - left : 1;
        group.height = bottom > top ? bottom - top : 1;
      }
      group.pathData = '';
    }
    if (operands.length) group.fill = operands[0].fill;
    visiting.delete(group.id);
    completed.add(group.id);
  }
  for (const shape of page.shapes) if (shape.type === 'boolean') recompute(shape);
}
