import { describe, expect, it } from 'vitest';
import { appearanceMargin, backdropLayer, effectsFilter, exportFileNames, newEffect, strokeOverlay, visibleStroke } from './appearance';
import { svgForPage, pageBounds } from './editor';
import { canBooleanShape } from './boolean';
import { newPage, parseDesign, newDocument } from './model';
import type { Effect, Shape } from './model';

const rect = (extra: Partial<Shape> = {}): Shape => ({ id: 'r', type: 'rect', name: 'R', x: 10, y: 20, width: 40, height: 30, fill: '#eee', ...extra });
const shadow = (extra: Partial<Effect> = {}): Effect => ({ id: 'e', type: 'dropShadow', visible: true, x: 0, y: 4, blur: 4, spread: 0, color: '#000000', opacity: .25, ...extra });

describe('stroke appearance', () => {
  it('treats hidden, removed and zero-width strokes as absent', () => {
    expect(visibleStroke(rect({ stroke: '#000' }))).toMatchObject({ width: 1, opacity: 1, position: 'center' });
    expect(visibleStroke(rect({ stroke: '#000', strokeHidden: true }))).toBeNull();
    expect(visibleStroke(rect({ stroke: '#000', strokeWidth: 0 }))).toBeNull();
    expect(visibleStroke(rect())).toBeNull();
  });

  it('paints inside strokes as a doubled stroke clipped to the outline and outside strokes through a mask', () => {
    const inside = strokeOverlay(rect({ stroke: '#123456', strokeWidth: 3, strokePosition: 'inside' }), 'a')!;
    expect(inside).toContain('<clipPath id="sk-a"');
    expect(inside).toContain('stroke-width="6"');
    expect(inside).toContain('clip-path="url(#sk-a)"');
    const outside = strokeOverlay(rect({ stroke: '#123456', strokeWidth: 3, strokePosition: 'outside', strokeOpacity: .5 }), 'b')!;
    expect(outside).toContain('<mask id="sk-b"');
    expect(outside).toContain('stroke-opacity="0.5"');
    expect(strokeOverlay(rect({ stroke: '#123456', strokePosition: 'center' }), 'c')).toBeNull();
    expect(strokeOverlay({ ...rect({ stroke: '#123456', strokePosition: 'inside' }), type: 'text' }, 'd')).toBeNull();
  });

  it('exports inside strokes without a plain stroke on the fill element and grows bounds for outside strokes', () => {
    const page = newPage();
    page.shapes.push(rect({ stroke: '#f00', strokeWidth: 4, strokePosition: 'outside' }));
    const svg = svgForPage(page);
    expect(svg).toMatch(/<rect [^>]*fill="#eee"\/>/);
    expect(svg).toContain('mask="url(#sk-0)"');
    expect(pageBounds(page)).toEqual({ x: 6, y: 16, width: 48, height: 38 });
  });
});

describe('effects', () => {
  it('builds drop shadow, inner shadow and blur stages in paint order', () => {
    const filter = effectsFilter(rect({ effects: [shadow(), shadow({ id: 'i', type: 'innerShadow' }), shadow({ id: 'b', type: 'layerBlur', blur: 6 })] }), 'x')!;
    expect(filter.id).toBe('fx-x');
    expect(filter.markup.indexOf('result="fx0"')).toBeLessThan(filter.markup.indexOf('<feMerge'));
    expect(filter.markup).toContain('<feMergeNode in="fx0"/><feMergeNode in="SourceGraphic"/><feMergeNode in="fx1"/>');
    expect(filter.markup).toContain('stdDeviation="3"');
    expect(effectsFilter(rect({ effects: [shadow({ visible: false })] }), 'y')).toBeNull();
  });

  it('keeps shadows pointing the same screen direction when the shape is rotated or mirrored', () => {
    const turned = effectsFilter(rect({ rotation: 90, effects: [shadow({ x: 0, y: 10 })] }), 'r')!;
    expect(turned.markup).toMatch(/dx="10" dy="0"|dx="10" dy="-0"/);
    const flipped = effectsFilter(rect({ flipX: true, effects: [shadow({ x: 6, y: 0 })] }), 'f')!;
    expect(flipped.markup).toContain('dx="-6"');
  });

  it('expands export bounds to include a shadow and wraps the shape in its filter', () => {
    const page = newPage();
    page.shapes.push(rect({ effects: [shadow({ x: 10, y: 0, blur: 0 })] }));
    expect(appearanceMargin(page.shapes[0])).toBe(10);
    expect(svgForPage(page)).toContain('<g filter="url(#fx-0)">');
    expect(pageBounds(page).width).toBe(60);
  });

  it('keeps shapes with visible effects out of Boolean groups', () => {
    expect(canBooleanShape(rect())).toBe(true);
    expect(canBooleanShape(rect({ effects: [shadow()] }))).toBe(false);
    expect(canBooleanShape(rect({ effects: [shadow({ visible: false })] }))).toBe(true);
  });
});

describe('export settings', () => {
  const setting = (scale: number, format: 'png' | 'jpg' | 'webp' | 'svg', suffix = '') => ({ id: `${scale}${format}`, scale, format, suffix });
  it('names files by suffix, then scale, and disambiguates clashes', () => {
    expect(exportFileNames('Card', [setting(1, 'png'), setting(2, 'png'), setting(2, 'svg'), setting(1, 'png')]))
      .toEqual(['Card.png', 'Card@2x.png', 'Card.svg', 'Card-2.png']);
    expect(exportFileNames('Card', [setting(3, 'jpg', '-large'), setting(2, 'webp')])).toEqual(['Card-large.jpg', 'Card@2x.webp']);
  });
});

describe('persistence', () => {
  it('round-trips stroke, effect and export settings and rejects invalid ones', () => {
    const document = newDocument();
    document.pages[0].shapes.push(rect({ stroke: '#000', strokePosition: 'inside', strokeOpacity: .4, strokeHidden: true,
      effects: [shadow()], exports: [{ id: 'x', scale: 2, format: 'jpg', suffix: '' }] }));
    const loaded = parseDesign(JSON.stringify(document));
    expect(loaded.pages[0].shapes[0]).toMatchObject({ strokePosition: 'inside', strokeOpacity: .4, effects: [{ type: 'dropShadow' }], exports: [{ format: 'jpg' }] });
    for (const bad of [{ strokePosition: 'above' }, { strokeOpacity: 2 }, { effects: [{ ...shadow(), blur: -1 }] }, { exports: [{ id: 'x', scale: 0, format: 'png', suffix: '' }] }]) {
      const broken = newDocument();
      broken.pages[0].shapes.push(rect(bad as Partial<Shape>));
      expect(() => parseDesign(JSON.stringify(broken))).toThrow('invalid design structure');
    }
  });
});

describe('noise, texture, glass and background blur', () => {
  it('adds a clipped grain layer for noise and a multiplied relief for texture', () => {
    const noise = effectsFilter(rect({ effects: [newEffect('noise', 'n')] }), 'n')!;
    expect(noise.markup).toContain('<feTurbulence type="fractalNoise"');
    expect(noise.markup).toContain('operator="in" result="fx0"');
    expect(noise.markup).toContain('<feMergeNode in="SourceGraphic"/><feMergeNode in="fx0"/>');
    const texture = effectsFilter(rect({ effects: [newEffect('texture', 't')] }), 't')!;
    expect(texture.markup).toContain('<feDiffuseLighting');
    expect(texture.markup).toContain('mode="multiply"');
  });

  it('draws glass edge light in the shape filter and the frosted backdrop separately', () => {
    const shape = rect({ effects: [{ ...newEffect('glass', 'g'), frost: 10, refraction: 40, dispersion: 2 }] });
    expect(effectsFilter(shape, 'g')!.markup).toContain('flood-color="#ffffff"');
    const layer = backdropLayer(shape, 'g')!;
    expect(layer.defs).toContain('stdDeviation="5"');
    expect(layer.defs).toContain('mode="screen"');
    expect(layer.transform).toContain('scale(1.1)');
    expect(layer.clip).toBe('url(#bk-g)');
  });

  it('blurs only what is painted below the shape when exporting', () => {
    const page = newPage();
    page.shapes.push(
      rect({ id: 'below', fill: '#111111', x: 0, y: 0, width: 100, height: 100 }),
      rect({ id: 'glass', fill: '#ffffff', x: 20, y: 20, width: 40, height: 40, effects: [newEffect('backgroundBlur', 'b')] }));
    const svg = svgForPage(page);
    const blurAt = svg.indexOf('clip-path="url(#bk-1)"');
    expect(blurAt).toBeGreaterThan(svg.indexOf('#111111'));
    expect(svg.indexOf('#ffffff', blurAt)).toBeGreaterThan(blurAt);
    expect(svg.slice(blurAt, svg.indexOf('#ffffff', blurAt))).toContain('#111111');
    const alone = newPage();
    alone.shapes.push(page.shapes[1]);
    expect(svgForPage(alone)).not.toContain('clip-path=');
  });

  it('keeps backdrop effects out of the shape filter and bounds', () => {
    const shape = rect({ effects: [newEffect('backgroundBlur', 'b')] });
    expect(effectsFilter(shape, 'x')).toBeNull();
    expect(appearanceMargin(shape)).toBe(0);
    expect(backdropLayer(rect(), 'x')).toBeNull();
  });

  it('validates the new effect parameters', () => {
    const document = newDocument();
    document.pages[0].shapes.push(rect({ effects: [newEffect('glass', 'g'), newEffect('noise', 'n'), newEffect('texture', 't'), newEffect('backgroundBlur', 'b')] }));
    expect(parseDesign(JSON.stringify(document)).pages[0].shapes[0].effects).toHaveLength(4);
    const broken = newDocument();
    broken.pages[0].shapes.push(rect({ effects: [{ ...newEffect('glass', 'g'), frost: -3 }] }));
    expect(() => parseDesign(JSON.stringify(broken))).toThrow('invalid design structure');
  });
});
