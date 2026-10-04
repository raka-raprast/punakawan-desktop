import type { Effect, ExportSetting, Shape } from './model';
import { mirrorsViaTransform, pathForShape, roundedRectPath, shapeTransform, textSize } from './shapes';

export type StrokePosition = 'center' | 'inside' | 'outside';
export type ResolvedStroke = { color: string; width: number; opacity: number; position: StrokePosition };

const attr = (value: string): string => value.replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);
const safeId = (value: string): string => value.replace(/[^\w-]/g, '_');
const num = (value: number): number => Math.round(value * 1000) / 1000;

const positionable = new Set<Shape['type']>(['rect', 'frame', 'ellipse', 'polygon', 'star', 'vector', 'boolean']);
/** Closed outlines whose stroke can sit inside or outside the edge. */
export const supportsStrokePosition = (shape: Pick<Shape, 'type'>): boolean => positionable.has(shape.type);

/** The stroke actually painted: absent when removed, hidden, or zero-width. */
export function visibleStroke(shape: Shape): ResolvedStroke | null {
  if (!shape.stroke || shape.stroke === 'none' || shape.strokeHidden) return null;
  const width = shape.strokeWidth ?? 1;
  if (!(width > 0)) return null;
  return { color: shape.stroke, width, opacity: shape.strokeOpacity ?? 1,
    position: supportsStrokePosition(shape) ? shape.strokePosition ?? 'center' : 'center' };
}

export const visibleEffects = (shape: Shape): Effect[] => (shape.effects ?? []).filter(effect => effect.visible);

function closedGeometry(shape: Shape): { d: string; transform?: string } | null {
  if (shape.type === 'rect' || shape.type === 'frame') return { d: roundedRectPath(shape) };
  if (shape.type === 'ellipse') {
    const { x, y, width, height } = shape;
    const rx = width / 2, ry = height / 2, cy = y + ry;
    return { d: `M ${x} ${cy} A ${rx} ${ry} 0 1 0 ${x + width} ${cy} A ${rx} ${ry} 0 1 0 ${x} ${cy} Z` };
  }
  if (shape.type === 'polygon' || shape.type === 'star') return { d: pathForShape(shape) };
  if (shape.type === 'vector' || shape.type === 'boolean')
    return { d: shape.pathData ?? '', transform: `translate(${shape.x} ${shape.y}) scale(${shape.width} ${shape.height})` };
  return null;
}

/**
 * Markup that paints an inside or outside stroke by clipping/masking a double-width centered stroke.
 * Null for centered strokes, which use plain stroke attributes on the shape itself.
 */
export function strokeOverlay(shape: Shape, uid: string): string | null {
  const stroke = visibleStroke(shape);
  if (!stroke || stroke.position === 'center') return null;
  const geometry = closedGeometry(shape);
  if (!geometry) return null;
  const key = `sk-${safeId(uid)}`;
  const vector = shape.type === 'vector' || shape.type === 'boolean';
  const transform = geometry.transform ? ` transform="${geometry.transform}"` : '';
  const outline = `<path d="${attr(geometry.d)}"${transform}`;
  let defs: string;
  let reference: string;
  if (stroke.position === 'inside') {
    defs = `<clipPath id="${key}" clipPathUnits="userSpaceOnUse">${outline}${vector ? ' clip-rule="evenodd"' : ''}/></clipPath>`;
    reference = `clip-path="url(#${key})"`;
  } else {
    const pad = stroke.width + 2;
    defs = `<mask id="${key}" maskUnits="userSpaceOnUse" x="${num(shape.x - pad)}" y="${num(shape.y - pad)}" ` +
      `width="${num(shape.width + pad * 2)}" height="${num(shape.height + pad * 2)}">` +
      `<rect x="${num(shape.x - pad)}" y="${num(shape.y - pad)}" width="${num(shape.width + pad * 2)}" height="${num(shape.height + pad * 2)}" fill="#fff"/>` +
      `${outline} fill="#000"${vector ? ' fill-rule="evenodd"' : ''}/></mask>`;
    reference = `mask="url(#${key})"`;
  }
  return `<defs>${defs}</defs>${outline} fill="none" stroke="${attr(stroke.color)}" stroke-width="${num(stroke.width * 2)}" ` +
    `stroke-opacity="${stroke.opacity}" stroke-linejoin="round"${vector ? ' vector-effect="non-scaling-stroke"' : ''} ${reference}/>`;
}

/** How far painted effects and outside strokes reach past a shape's own bounds. */
export function appearanceMargin(shape: Shape): number {
  let margin = 0;
  const stroke = visibleStroke(shape);
  if (stroke?.position === 'outside') margin = stroke.width;
  for (const effect of visibleEffects(shape)) {
    if (effect.type === 'layerBlur') margin = Math.max(margin, effect.blur * 1.5);
    else if (effect.type === 'dropShadow')
      margin = Math.max(margin, Math.hypot(effect.x, effect.y) + effect.blur * 1.5 + Math.max(0, effect.spread));
  }
  return Math.ceil(margin);
}

const filterTypes = new Set<Effect['type']>(['dropShadow', 'innerShadow', 'layerBlur', 'noise', 'texture', 'glass']);

/** A new effect of `type` with Figma-like starting values. */
export function newEffect(type: Effect['type'], id: string): Effect {
  const base: Effect = { id, type, visible: true, x: 0, y: 0, blur: 0, spread: 0, color: '#000000', opacity: .25 };
  switch (type) {
    case 'dropShadow': case 'innerShadow': return { ...base, y: 4, blur: 4 };
    case 'layerBlur': case 'backgroundBlur': return { ...base, blur: 4 };
    case 'noise': return { ...base, size: 2, density: 50 };
    case 'texture': return { ...base, size: 2, radius: 1 };
    case 'glass': return { ...base, refraction: 40, depth: 20, dispersion: 0, frost: 8, light: 50 };
  }
}

function channels(color: string): [number, number, number] {
  const hex = /^#([\da-f]{6})$/i.exec(color);
  const value = hex ? Number.parseInt(hex[1], 16) : 0;
  return [num(((value >> 16) & 255) / 255), num(((value >> 8) & 255) / 255), num((value & 255) / 255)];
}

/** Glass edge light: a bright rim on the lit sides and a fainter one opposite, drawn as inner shadows. */
function glassRims(effect: Effect): Effect[] {
  const depth = effect.depth ?? 20;
  const light = (effect.light ?? 50) / 100;
  const rim = { ...effect, type: 'innerShadow' as const, color: '#ffffff', spread: 0, blur: depth / 2 };
  return [{ ...rim, x: depth / 2, y: depth / 2, opacity: Math.min(1, light) },
    { ...rim, x: -depth / 2, y: -depth / 2, opacity: Math.min(1, light / 2) }];
}

/**
 * SVG filter for a shape's visible effects, in the shape's own (pre-rotation) coordinates. Offsets are
 * counter-rotated so shadows keep pointing the same way on screen however the shape is turned or mirrored.
 * Background blur and the frosted part of glass are not here: they need what is behind the shape (see backdropLayer).
 */
export function effectsFilter(shape: Shape, uid: string, host?: Shape): { id: string; markup: string } | null {
  const effects = visibleEffects(shape).filter(effect => filterTypes.has(effect.type))
    .flatMap(effect => effect.type === 'glass' ? glassRims(effect) : [effect]);
  if (!effects.length) return null;
  const owner = host ?? shape;
  const angle = -(owner.type === 'boolean' ? 0 : owner.rotation ?? 0) * Math.PI / 180;
  const flipX = !host && mirrorsViaTransform(shape) && !!shape.flipX;
  const flipY = !host && mirrorsViaTransform(shape) && !!shape.flipY;
  const local = (x: number, y: number) => {
    let dx = x * Math.cos(angle) - y * Math.sin(angle);
    let dy = x * Math.sin(angle) + y * Math.cos(angle);
    if (flipX) dx = -dx;
    if (flipY) dy = -dy;
    return { dx: num(dx), dy: num(dy) };
  };
  let box = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  if (host) {
    const padding = shape.fontSize ?? 36;
    box = { x: host.x - padding, y: host.y - padding, width: host.width + padding * 2, height: host.height + padding * 2 };
  } else if (shape.type === 'text') {
    const size = textSize(shape);
    box.width = Math.max(box.width, size.width);
    box.height = Math.max(box.height, size.height);
  }
  let reach = 0;
  for (const effect of effects) {
    if (effect.type === 'dropShadow' || effect.type === 'innerShadow')
      reach = Math.max(reach, Math.hypot(effect.x, effect.y) + effect.blur * 1.5 + Math.abs(effect.spread));
    else if (effect.type === 'layerBlur') reach = Math.max(reach, effect.blur * 1.5);
  }
  reach = Math.ceil(reach) + 2;
  const id = `fx-${safeId(uid)}`;
  let body = '';
  const below: string[] = [];
  const above: string[] = [];
  const multiply: string[] = [];
  const morph = (input: string, spread: number, result: string) => spread === 0 ? input :
    (body += `<feMorphology in="${input}" operator="${spread > 0 ? 'dilate' : 'erode'}" radius="${num(Math.abs(spread))}" result="${result}"/>`, result);
  effects.forEach((effect, n) => {
    if (effect.type === 'dropShadow' || effect.type === 'innerShadow') {
      const { dx, dy } = local(effect.x, effect.y);
      let input = 'SourceAlpha';
      if (effect.type === 'innerShadow') {
        body += `<feComponentTransfer in="SourceAlpha" result="iv${n}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>`;
        input = `iv${n}`;
      }
      const source = morph(input, effect.spread, `sp${n}`);
      body += `<feOffset in="${source}" dx="${dx}" dy="${dy}" result="of${n}"/>` +
        `<feGaussianBlur in="of${n}" stdDeviation="${num(effect.blur / 2)}" result="bl${n}"/>` +
        `<feFlood flood-color="${attr(effect.color)}" flood-opacity="${effect.opacity}" result="fl${n}"/>`;
      if (effect.type === 'dropShadow') {
        body += `<feComposite in="fl${n}" in2="bl${n}" operator="in" result="fx${n}"/>`;
        below.push(`fx${n}`);
      } else {
        body += `<feComposite in="fl${n}" in2="bl${n}" operator="in" result="ic${n}"/>` +
          `<feComposite in="ic${n}" in2="SourceAlpha" operator="in" result="fx${n}"/>`;
        above.push(`fx${n}`);
      }
    } else if (effect.type === 'noise') {
      // Alpha follows the noise value through a steep threshold: higher density lowers the threshold.
      const [red, green, blue] = channels(effect.color);
      const density = Math.min(1, Math.max(0, (effect.density ?? 50) / 100));
      const threshold = 0.5 + (0.5 - density) * 0.5;
      body += `<feTurbulence type="fractalNoise" baseFrequency="${num(Math.min(1, 1 / Math.max(.5, effect.size ?? 2)))}" numOctaves="2" seed="${n + 1}" result="tn${n}"/>` +
        `<feColorMatrix in="tn${n}" type="matrix" values="0 0 0 0 ${red} 0 0 0 0 ${green} 0 0 0 0 ${blue} 12 0 0 0 ${num(-12 * threshold)}" result="tm${n}"/>` +
        `<feComponentTransfer in="tm${n}" result="to${n}"><feFuncA type="linear" slope="${effect.opacity}"/></feComponentTransfer>` +
        `<feComposite in="to${n}" in2="SourceAlpha" operator="in" result="fx${n}"/>`;
      above.push(`fx${n}`);
    } else if (effect.type === 'texture') {
      body += `<feTurbulence type="fractalNoise" baseFrequency="${num(Math.min(1, 1 / Math.max(.5, effect.size ?? 2)))}" numOctaves="3" seed="${n + 7}" result="tt${n}"/>` +
        `<feDiffuseLighting in="tt${n}" surfaceScale="${num((effect.radius ?? 1) * 2)}" diffuseConstant="1.2" lighting-color="#ffffff" result="tl${n}">` +
        `<feDistantLight azimuth="225" elevation="55"/></feDiffuseLighting>` +
        `<feComposite in="tl${n}" in2="SourceAlpha" operator="in" result="fx${n}"/>`;
      multiply.push(`fx${n}`);
    }
  });
  const blur = effects.filter(effect => effect.type === 'layerBlur').reduce((total, effect) => total + effect.blur, 0);
  let current = 'SourceGraphic';
  if (below.length || above.length) {
    body += `<feMerge result="stack">${[...below, 'SourceGraphic', ...above].map(name => `<feMergeNode in="${name}"/>`).join('')}</feMerge>`;
    current = 'stack';
  }
  multiply.forEach((name, index) => {
    body += `<feBlend in="${name}" in2="${current}" mode="multiply" result="tx${index}"/>`;
    current = `tx${index}`;
  });
  if (blur > 0) body += `<feGaussianBlur in="${current}" stdDeviation="${num(blur / 2)}"/>`;
  return { id, markup: `<filter id="${id}" filterUnits="userSpaceOnUse" x="${num(box.x - reach)}" y="${num(box.y - reach)}" ` +
    `width="${num(box.width + reach * 2)}" height="${num(box.height + reach * 2)}" color-interpolation-filters="sRGB">${body}</filter>` };
}

export type BackdropLayer = { defs: string; clip: string; filter: string; transform?: string };

/**
 * What a Background blur or Glass effect does to the artwork behind a shape: blur (frost), a slight
 * magnification (refraction) and an RGB split (dispersion), all clipped to the shape's own outline.
 */
export function backdropLayer(shape: Shape, uid: string): BackdropLayer | null {
  if (shape.textPathId || shape.type === 'line' || shape.type === 'arrow') return null;
  let blur = 0, zoom = 1, dispersion = 0, active = false;
  for (const effect of visibleEffects(shape)) {
    if (effect.type === 'backgroundBlur') { blur += effect.blur; active = true; }
    else if (effect.type === 'glass') {
      blur += effect.frost ?? 0;
      zoom *= 1 + (effect.refraction ?? 0) / 400;
      dispersion += effect.dispersion ?? 0;
      active = true;
    }
  }
  if (!active) return null;
  const key = safeId(uid);
  const transform = shapeTransform(shape);
  const geometry = closedGeometry(shape);
  const clipTransform = [transform, geometry?.transform].filter(Boolean).join(' ');
  const clipShape = geometry
    ? `<path d="${attr(geometry.d)}"${clipTransform ? ` transform="${clipTransform}"` : ''}${shape.type === 'vector' || shape.type === 'boolean' ? ' clip-rule="evenodd"' : ''}/>`
    : `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}"${transform ? ` transform="${transform}"` : ''}/>`;
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const radius = Math.ceil(Math.hypot(shape.width, shape.height) / 2 * Math.max(1, zoom) + blur * 3 + dispersion + 10);
  let body = blur > 0
    ? `<feGaussianBlur in="SourceGraphic" stdDeviation="${num(blur / 2)}" result="bb"/>`
    : `<feOffset in="SourceGraphic" dx="0" dy="0" result="bb"/>`;
  if (dispersion > 0) {
    body += `<feColorMatrix in="bb" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="cr"/>` +
      `<feOffset in="cr" dx="${num(-dispersion)}" dy="0" result="cro"/>` +
      `<feColorMatrix in="bb" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="cg"/>` +
      `<feColorMatrix in="bb" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="cb"/>` +
      `<feOffset in="cb" dx="${num(dispersion)}" dy="0" result="cbo"/>` +
      `<feBlend in="cro" in2="cg" mode="screen" result="crg"/><feBlend in="crg" in2="cbo" mode="screen"/>`;
  }
  return {
    defs: `<clipPath id="bk-${key}" clipPathUnits="userSpaceOnUse">${clipShape}</clipPath>` +
      `<filter id="bf-${key}" filterUnits="userSpaceOnUse" x="${num(cx - radius)}" y="${num(cy - radius)}" ` +
      `width="${radius * 2}" height="${radius * 2}" color-interpolation-filters="sRGB">${body}</filter>`,
    clip: `url(#bk-${key})`,
    filter: `url(#bf-${key})`,
    transform: zoom !== 1 ? `translate(${cx} ${cy}) scale(${num(zoom)}) translate(${-cx} ${-cy})` : undefined,
  };
}

/** Backdrop markup: `content` (everything painted below the shape) blurred/refracted and clipped to the shape. */
export function backdropMarkup(layer: BackdropLayer, content: string): string {
  return `<defs>${layer.defs}</defs><g clip-path="${layer.clip}"><g filter="${layer.filter}"` +
    `${layer.transform ? ` transform="${layer.transform}"` : ''}>${content}</g></g>`;
}

/** Unique output file names for a set of export settings: suffix, else `@Nx` when scaled, then `-2`, `-3` on clashes. */
export function exportFileNames(base: string, settings: readonly ExportSetting[]): string[] {
  const used = new Set<string>();
  return settings.map(setting => {
    const suffix = setting.suffix || (setting.format !== 'svg' && setting.scale !== 1 ? `@${setting.scale}x` : '');
    let name = `${base}${suffix}.${setting.format}`;
    for (let count = 2; used.has(name.toLowerCase()); count++) name = `${base}${suffix}-${count}.${setting.format}`;
    used.add(name.toLowerCase());
    return name;
  });
}
