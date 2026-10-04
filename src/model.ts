export type StyleRun = {
  start: number;
  end: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic' | 'oblique';
  fill?: string;
  letterSpacing?: number;
};

export type TextRunStyle = {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic' | 'oblique';
  fill: string;
  letterSpacing: number;
};

export type BooleanGroupOperation = 'union' | 'subtract' | 'intersect' | 'exclude';

export type Effect = {
  id: string;
  type: 'dropShadow' | 'innerShadow' | 'layerBlur' | 'backgroundBlur' | 'noise' | 'texture' | 'glass';
  visible: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  opacity: number;
  /** Noise grain / texture cell size in px. */
  size?: number;
  /** Noise coverage, 0-100%. */
  density?: number;
  /** Texture relief strength. */
  radius?: number;
  /** Glass: magnification of what is behind (0-100), edge highlight width px, RGB split px, frost blur px, highlight %. */
  refraction?: number;
  depth?: number;
  dispersion?: number;
  frost?: number;
  light?: number;
};
export type ExportFormat = 'png' | 'jpg' | 'webp' | 'svg';
export type ExportSetting = { id: string; scale: number; format: ExportFormat; suffix: string };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const effectTypes = ['dropShadow', 'innerShadow', 'layerBlur', 'backgroundBlur', 'noise', 'texture', 'glass'];
const optionalAmount = (value: unknown): boolean => value === undefined || (finite(value) && value >= 0);
function validEffect(effect: Effect): boolean {
  return !!effect && typeof effect.id === 'string' &&
    effectTypes.includes(effect.type) && typeof effect.visible === 'boolean' &&
    finite(effect.x) && finite(effect.y) && finite(effect.blur) && effect.blur >= 0 && finite(effect.spread) &&
    typeof effect.color === 'string' && finite(effect.opacity) && effect.opacity >= 0 && effect.opacity <= 1 &&
    [effect.size, effect.density, effect.radius, effect.refraction, effect.depth, effect.dispersion, effect.frost, effect.light]
      .every(optionalAmount);
}
function validExportSetting(setting: ExportSetting): boolean {
  return !!setting && typeof setting.id === 'string' && finite(setting.scale) && setting.scale > 0 && setting.scale <= 16 &&
    ['png', 'jpg', 'webp', 'svg'].includes(setting.format) && typeof setting.suffix === 'string';
}

export type Shape = {
  id: string;
  type: 'rect' | 'ellipse' | 'text' | 'image' | 'frame' | 'line' | 'arrow' | 'polygon' | 'star' | 'vector' | 'boolean';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  /** SVG path in unit-box coordinates; scaled into the vector's bounds when drawn. */
  pathData?: string;
  /** The operation used to recompute a Boolean group's cached outline from its children. */
  booleanOperation?: BooleanGroupOperation;
  parentId?: string;
  flipX?: boolean;
  flipY?: boolean;
  text?: string;
  /** Same-page vector host for curved text; coordinates remain as a usable detached text box. */
  textPathId?: string;
  textPathOffset?: number;
  textPathFlip?: boolean;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic' | 'oblique';
  textSizing?: 'auto-width' | 'auto-height' | 'fixed';
  src?: string;
  stroke?: string;
  strokeWidth?: number;
  /** 0-1 opacity of the stroke paint only. */
  strokeOpacity?: number;
  /** Where the stroke sits relative to the outline of closed shapes. Defaults to center. */
  strokePosition?: 'center' | 'inside' | 'outside';
  /** Keeps the stroke settings but stops drawing and exporting it. */
  strokeHidden?: boolean;
  effects?: Effect[];
  exports?: ExportSetting[];
  opacity?: number;
  cornerRadii?: [number, number, number, number];
  textAlign?: 'left' | 'center' | 'right';
  lineHeight?: number;
  letterSpacing?: number;
  styleRuns?: StyleRun[];
  rotation?: number;
  lockAspect?: boolean;
  /** Auto-created helper path for text on path; hidden from Layers and removed with its text. */
  guide?: boolean;
  /** Hidden shapes are not drawn, exported, or hit-tested; their descendants are hidden too. */
  hidden?: boolean;
  /** Locked shapes cannot be selected on canvas or transformed; descendants are locked too. */
  locked?: boolean;
};

export type FontFamily = {
  family: string;
  styles: { label: string; weight: number; style: 'normal' | 'italic' | 'oblique' }[];
};

export type DesignPage = { id: string; name: string; shapes: Shape[] };
export type DesignFile = { format: 'punakawan-design'; version: 1; id: string; name: string; pages: DesignPage[] };
export type Session = { document: DesignFile; path: string | null; dirty: boolean; revision: number; savedRevision: number };
export type Preferences = { theme: 'light' | 'dark' | 'system'; autosave: boolean; shortcuts: Record<string, string> };
export type AppState = { recent: string[]; preferences: Preferences };
export type RecoveryEntry = { id: string; content: string };
export type ImportedAsset = { name: string; mime: string; dataUrl: string };

export const newPage = (name = 'Canvas'): DesignPage => ({ id: crypto.randomUUID(), name, shapes: [] });
export const newDocument = (name = 'Untitled'): DesignFile => ({
  format: 'punakawan-design', version: 1, id: crypto.randomUUID(), name, pages: [newPage()],
});

export function parseDesign(content: string): DesignFile {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object') throw new Error('Not a Punakawan design file.');
  const doc = value as Partial<DesignFile>;
  if (doc.format !== 'punakawan-design' || doc.version !== 1 || typeof doc.id !== 'string' ||
    typeof doc.name !== 'string' || !Array.isArray(doc.pages) || doc.pages.length === 0 ||
    !doc.pages.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' &&
      Array.isArray(p.shapes) && p.shapes.every(s => s && typeof s.id === 'string' &&
        ['rect', 'ellipse', 'text', 'image', 'frame', 'line', 'arrow', 'polygon', 'star', 'vector', 'boolean'].includes(s.type) &&
        typeof s.name === 'string' &&
        [s.x, s.y, s.width, s.height].every(n => typeof n === 'number' && Number.isFinite(n)) &&
        typeof s.fill === 'string' &&
        (!['vector', 'boolean'].includes(s.type) || (s.width > 0 && s.height > 0 &&
          typeof s.pathData === 'string' && (s.type === 'boolean' && s.pathData === '' ||
            /^M[\d\s,.\-+eEaAcChHlLmMqQsStTvVzZ]+$/.test(s.pathData)))) &&
        (s.type !== 'boolean' || !s.pathData ||
          !!s.pathData.match(/[Mm][^Mm]*/g)?.every(contour => /[Zz]\s*$/.test(contour))) &&
        (s.pathData === undefined || s.type === 'vector' || s.type === 'boolean') &&
        (s.booleanOperation === undefined ? s.type !== 'boolean' :
          s.type === 'boolean' && ['union', 'subtract', 'intersect', 'exclude'].includes(s.booleanOperation)) &&
        (s.flipX === undefined || typeof s.flipX === 'boolean') &&
        (s.flipY === undefined || typeof s.flipY === 'boolean') &&
        (s.textPathId === undefined || (s.type === 'text' && typeof s.textPathId === 'string' &&
          s.textPathId !== s.id && p.shapes.some(host => host.id === s.textPathId &&
            ['line', 'arrow', 'rect', 'ellipse', 'polygon', 'star'].includes(host.type)))) &&
        (s.textPathOffset === undefined || (s.textPathId !== undefined &&
          typeof s.textPathOffset === 'number' && Number.isFinite(s.textPathOffset) &&
          s.textPathOffset >= 0 && s.textPathOffset <= 100)) &&
        (s.textPathFlip === undefined || (s.textPathId !== undefined && typeof s.textPathFlip === 'boolean')) &&
        (s.fontWeight === undefined || (typeof s.fontWeight === 'number' &&
          Number.isFinite(s.fontWeight) && s.fontWeight >= 1 && s.fontWeight <= 1000)) &&
        (s.fontStyle === undefined || ['normal', 'italic', 'oblique'].includes(s.fontStyle)) &&
        (s.textSizing === undefined || ['auto-width', 'auto-height', 'fixed'].includes(s.textSizing)) &&
        (s.stroke === undefined || typeof s.stroke === 'string') &&
        (s.strokeWidth === undefined || (typeof s.strokeWidth === 'number' &&
          Number.isFinite(s.strokeWidth) && s.strokeWidth >= 0)) &&
        (s.strokeOpacity === undefined || (typeof s.strokeOpacity === 'number' &&
          Number.isFinite(s.strokeOpacity) && s.strokeOpacity >= 0 && s.strokeOpacity <= 1)) &&
        (s.strokePosition === undefined || ['center', 'inside', 'outside'].includes(s.strokePosition)) &&
        (s.strokeHidden === undefined || typeof s.strokeHidden === 'boolean') &&
        (s.effects === undefined || (Array.isArray(s.effects) && s.effects.every(validEffect))) &&
        (s.exports === undefined || (Array.isArray(s.exports) && s.exports.every(validExportSetting))) &&
        (s.opacity === undefined || (typeof s.opacity === 'number' &&
          Number.isFinite(s.opacity) && s.opacity >= 0 && s.opacity <= 1)) &&
        (s.cornerRadii === undefined || (Array.isArray(s.cornerRadii) && s.cornerRadii.length === 4 &&
          s.cornerRadii.every(radius => typeof radius === 'number' && Number.isFinite(radius) && radius >= 0))) &&
        (s.textAlign === undefined || ['left', 'center', 'right'].includes(s.textAlign)) &&
        (s.lineHeight === undefined || (typeof s.lineHeight === 'number' &&
          Number.isFinite(s.lineHeight) && s.lineHeight > 0)) &&
        (s.letterSpacing === undefined || (typeof s.letterSpacing === 'number' &&
          Number.isFinite(s.letterSpacing))) &&
        (s.styleRuns === undefined || (Array.isArray(s.styleRuns) && s.styleRuns.every((run, i, runs) =>
          run && typeof run.start === 'number' && Number.isInteger(run.start) && run.start >= 0 &&
          typeof run.end === 'number' && Number.isInteger(run.end) && run.end > run.start &&
          run.end <= (s.text?.length ?? 0) && (i === 0 || run.start >= runs[i - 1].end) &&
          (run.fontFamily === undefined || typeof run.fontFamily === 'string') &&
          (run.fontSize === undefined || (typeof run.fontSize === 'number' &&
            Number.isFinite(run.fontSize) && run.fontSize > 0)) &&
          (run.fontWeight === undefined || (typeof run.fontWeight === 'number' &&
            Number.isFinite(run.fontWeight) && run.fontWeight >= 1 && run.fontWeight <= 1000)) &&
          (run.fontStyle === undefined || ['normal', 'italic', 'oblique'].includes(run.fontStyle)) &&
          (run.fill === undefined || typeof run.fill === 'string') &&
          (run.letterSpacing === undefined || (typeof run.letterSpacing === 'number' &&
            Number.isFinite(run.letterSpacing)))))) &&
        (s.rotation === undefined || (typeof s.rotation === 'number' && Number.isFinite(s.rotation))) &&
        (s.lockAspect === undefined || typeof s.lockAspect === 'boolean') &&
        (s.guide === undefined || typeof s.guide === 'boolean') &&
        (s.hidden === undefined || typeof s.hidden === 'boolean') &&
        (s.locked === undefined || typeof s.locked === 'boolean') &&
        (s.parentId === undefined || (s.type !== 'frame' && typeof s.parentId === 'string' &&
          p.shapes.some(parent => parent.id === s.parentId &&
            (parent.type === 'frame' || (parent.type === 'boolean' &&
              ['rect', 'ellipse', 'polygon', 'star', 'vector', 'boolean'].includes(s.type) &&
              (s.type !== 'vector' || !!s.pathData?.match(/[Mm][^Mm]*/g)
                ?.every(contour => /[Zz]\s*$/.test(contour)))))))) &&
        (s.type !== 'image' || (typeof s.src === 'string' &&
          /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(s.src)))) &&
      new Set(p.shapes.map(s => s.id)).size === p.shapes.length &&
      p.shapes.every(shape => shape.type !== 'boolean' ||
        p.shapes.some(child => child.parentId === shape.id)) &&
      p.shapes.every(shape => {
        const seen = new Set<string>([shape.id]);
        let parentId = shape.parentId;
        while (parentId !== undefined) {
          if (seen.has(parentId)) return false;
          seen.add(parentId);
          parentId = p.shapes.find(parent => parent.id === parentId)?.parentId;
        }
        return true;
      }))) {
    throw new Error('This file has an invalid design structure.');
  }
  return doc as DesignFile;
}
