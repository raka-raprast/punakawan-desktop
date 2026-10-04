import { describe, expect, it } from 'vitest';
import { pathForShape, resolveTextStyle, roundedRectPath, textHeight, textLines, textPathForShape, textRunLines, textSize } from './shapes';

describe('shared SVG paths', () => {
  it('keeps normalized bounds but preserves line drag direction', () => {
    const shape = { type: 'line' as const, x: -40, y: -20, width: 100, height: 60 };
    expect(pathForShape(shape)).toBe('M -40 -20 L 60 40');
    expect(pathForShape({ ...shape, flipX: true })).toBe('M 60 -20 L -40 40');
    expect(pathForShape({ ...shape, flipX: true, flipY: true })).toBe('M 60 40 L -40 -20');
  });

  it('draws exact horizontal and vertical strokes for single-pixel bounds', () => {
    expect(pathForShape({ type: 'line', x: 10, y: 20, width: 100, height: 1 }))
      .toBe('M 10 20.5 L 110 20.5');
    expect(pathForShape({ type: 'line', x: 10, y: 20, width: 1, height: 60, flipY: true }))
      .toBe('M 10.5 80 L 10.5 20');
  });

  it('points arrow heads at the dragged endpoint even when both axes reverse', () => {
    const arrow = pathForShape({ type: 'arrow', x: -30, y: 10, width: 60, height: 20,
      flipX: true, flipY: true });
    expect(arrow.startsWith('M 30 30 L -30 10 M ')).toBe(true);
    expect(arrow).toContain(' L -30 10 L ');
    expect(arrow).not.toContain('NaN');
  });

  it.each([['polygon', 3], ['star', 10]] as const)('traces a closed %s inside its bounds', (type, count) => {
    const path = pathForShape({ type, x: -50, y: -25, width: 200, height: 100 });
    const points = [...path.matchAll(/[ML] (-?[\d.e+-]+) (-?[\d.e+-]+)/g)];
    expect(points).toHaveLength(count);
    expect(path.endsWith(' Z')).toBe(true);
    for (const [, x, y] of points) {
      expect(Number(x)).toBeGreaterThanOrEqual(-50);
      expect(Number(x)).toBeLessThanOrEqual(150);
      expect(Number(y)).toBeGreaterThanOrEqual(-25);
      expect(Number(y)).toBeLessThanOrEqual(75);
    }
  });
});

describe('text path geometry', () => {
  it('uses only the arrow shaft and reverses its traversal without reversing the arrowhead', () => {
    const arrow = { id: 'arrow', type: 'arrow' as const, name: 'Arrow', x: 10, y: 20,
      width: 80, height: 40, fill: '#000', flipX: true };
    expect(textPathForShape(arrow)).toBe('M 90 20 L 10 60');
    expect(textPathForShape(arrow, true)).toBe('M 10 60 L 90 20');
  });

  it('reverses closed ellipse and rounded-rectangle outlines with the same corners and bounds', () => {
    const ellipse = { id: 'oval', type: 'ellipse' as const, name: 'Oval',
      x: 5, y: 10, width: 80, height: 50, fill: '#000' };
    expect(textPathForShape(ellipse)).toBe('M 5 35 A 40 25 0 1 1 85 35 A 40 25 0 1 1 5 35 A 40 25 0 1 1 85 35 A 40 25 0 1 1 5 35 Z');
    expect(textPathForShape(ellipse, true)).toBe('M 5 35 A 40 25 0 1 0 85 35 A 40 25 0 1 0 5 35 A 40 25 0 1 0 85 35 A 40 25 0 1 0 5 35 Z');
    const rectangle = { ...ellipse, type: 'rect' as const, cornerRadii: [12, 4, 8, 0] as [number, number, number, number] };
    const single = roundedRectPath(rectangle);
    expect(textPathForShape(rectangle)).toContain(single.replace(/ Z$/, ''));
    const reversed = textPathForShape(rectangle, true);
    expect(reversed).toContain('M 17 10 A 12 12 0 0 0 5 22');
  });

  it.each(['polygon', 'star'] as const)('reverses the same %s vertices', type => {
    const host = { id: type, type, name: type, x: 5, y: 10, width: 90, height: 60, fill: '#000' };
    const vertices = (path: string) => [...path.matchAll(/[ML] ([\d.e+-]+) ([\d.e+-]+)/g)].map(([, x, y]) => `${x},${y}`);
    const forward = vertices(textPathForShape(host));
    const reversed = vertices(textPathForShape(host, true));
    // Both loop twice, starting at the same initial vertex
    expect(reversed[0]).toBe(forward[0]);
    expect(reversed.length).toBe(forward.length);
    const singleLen = (forward.length - 1) / 2;
    const forwardFirstLoop = forward.slice(0, singleLen);
    const reversedFirstLoop = reversed.slice(0, singleLen);
    expect(reversedFirstLoop).toEqual([forwardFirstLoop[0], ...forwardFirstLoop.slice(1).reverse()]);
  });
});

describe('rounded outlines and text layout', () => {
  it('scales adjoining corner radii together so no edge overlaps', () => {
    const path = roundedRectPath({ x: 10, y: 20, width: 100, height: 40,
      cornerRadii: [80, 40, 20, 0] });
    expect(path).toBe('M 50 20 H 90 A 20 20 0 0 1 110 40 V 50 ' +
      'A 10 10 0 0 1 100 60 H 10 L 10 60 V 60 A 40 40 0 0 1 50 20 Z');
    expect(roundedRectPath({ x: -5, y: 2, width: 60, height: 30,
      cornerRadii: [90, 90, 90, 90] })).toContain('A 15 15');
    expect(roundedRectPath({ x: 0, y: 0, width: 20, height: 10 })).not.toContain(' A ');
  });

  it('leaves auto-width text unwrapped and preserves explicit blank lines and whitespace', () => {
    const shape = { text: '  alpha beta  \r\n\r\nend\r', width: 1, height: 1,
      fontSize: 10, lineHeight: 17, textSizing: 'auto-width' as const };
    expect(textLines(shape)).toEqual(['  alpha beta  ', '', 'end', '']);
    expect(textSize(shape).height).toBe(68);
    expect(textSize(shape).width).toBeGreaterThan(shape.width);
    expect(textSize({ ...shape, width: 900, height: 900 })).toEqual(textSize(shape));
  });

  it('wraps at word boundaries, preserves spaces, and uses legacy auto-height sizing', () => {
    const metrics = { width: 1, height: 1, fontSize: 10, lineHeight: 17 };
    const width = textSize({ ...metrics, text: 'alpha', textSizing: 'auto-width' }).width + 1;
    const shape = { ...metrics, width, text: 'alpha  alpha\n\nalphaalpha' };
    expect(textLines(shape)).toEqual(['alpha  ', 'alpha', '', 'alpha', 'alpha']);
    expect(textSize(shape)).toEqual({ width, height: 85 });
    expect(textSize({ ...shape, textSizing: 'auto-height' })).toEqual(textSize(shape));
    expect(textLines({ ...shape, width: 1000, text: '  alpha  beta  ' }))
      .toEqual(['  alpha  beta  ']);
  });

  it('changes dimensions according to sizing mode without truncating fixed-box overflow', () => {
    const shape = { text: 'ABCD', width: 1, height: 9, fontSize: 10, lineHeight: 17 };
    expect(textSize({ ...shape, textSizing: 'auto-height' })).toEqual({ width: 1, height: 68 });
    expect(textSize({ ...shape, textSizing: 'fixed' })).toEqual({ width: 1, height: 9 });
    expect(textLines({ ...shape, textSizing: 'fixed' })).toEqual(['A', 'B', 'C', 'D']);
    expect(textHeight({ ...shape, textSizing: 'fixed' })).toBe(68);
    const automatic = textSize({ ...shape, textSizing: 'auto-width' });
    expect(automatic.width).toBeGreaterThan(shape.width);
    expect(automatic.height).toBe(17);
    expect(textSize({ ...shape, ...automatic, textSizing: 'auto-height' })).toEqual(automatic);
  });

  it('keeps combining marks, emoji joiners, and flags intact when a grapheme exceeds the width', () => {
    const shape = { text: 'e\u0301👩‍💻🇫🇷', width: 1, fontSize: 10, lineHeight: 17 };
    expect(textLines(shape)).toEqual(['e\u0301', '👩‍💻', '🇫🇷']);
    expect(textHeight(shape)).toBe(51);
    expect(textHeight({ ...shape, text: '' })).toBe(17);
  });

  it('includes letter spacing in both automatic width and constrained wrapping', () => {
    const shape = { text: 'AA', width: 1, height: 1, fontSize: 10, letterSpacing: 4 };
    const width = textSize({ ...shape, textSizing: 'auto-width' }).width;
    expect(textLines({ ...shape, width, text: 'AAAAAA', textSizing: 'auto-height' }))
      .toEqual(['AA', 'AA', 'AA']);
    expect(width).toBeGreaterThan(textSize({ ...shape, letterSpacing: 0, textSizing: 'auto-width' }).width);
  });
});

describe('rich per-character text styling', () => {
  it('merges shape-level defaults with the single styleRun covering an index', () => {
    const shape = { fontFamily: 'Arial', fontSize: 12, fontWeight: 400, fontStyle: 'normal' as const,
      fill: '#000', letterSpacing: 1,
      styleRuns: [{ start: 2, end: 5, fontWeight: 700, fill: '#f00' }] };
    expect(resolveTextStyle(shape, 0)).toEqual({ fontFamily: 'Arial', fontSize: 12, fontWeight: 400,
      fontStyle: 'normal', fill: '#000', letterSpacing: 1 });
    expect(resolveTextStyle(shape, 2)).toEqual({ fontFamily: 'Arial', fontSize: 12, fontWeight: 700,
      fontStyle: 'normal', fill: '#f00', letterSpacing: 1 });
    expect(resolveTextStyle(shape, 4)).toEqual(resolveTextStyle(shape, 2));
    expect(resolveTextStyle(shape, 5)).toEqual(resolveTextStyle(shape, 0));
    expect(resolveTextStyle({ fill: '#123' }, 0)).toEqual({ fontFamily: 'sans-serif', fontSize: 36,
      fontWeight: 400, fontStyle: 'normal', fill: '#123', letterSpacing: 0 });
  });

  it('splits a word into style-homogeneous segments at a mid-word styleRun boundary', () => {
    const shape = { text: 'ABCDEF', width: 1000, fontSize: 10, fill: '#000',
      styleRuns: [{ start: 2, end: 4, fontWeight: 700 }] };
    const lines = textRunLines(shape);
    expect(lines).toHaveLength(1);
    expect(lines[0].map(segment => segment.text)).toEqual(['AB', 'CD', 'EF']);
    expect(lines[0].map(segment => segment.style.fontWeight)).toEqual([400, 700, 400]);
    expect(textLines(shape)).toEqual(['ABCDEF']);
  });

  it('keeps every character styled and reachable when a styleRun straddles a wrapped line break', () => {
    const shape = { text: 'alpha beta', width: 35, fontSize: 10,
      styleRuns: [{ start: 3, end: 8, fontWeight: 700 }] };
    const lines = textRunLines(shape);
    expect(lines.map(line => line.map(segment => segment.text))).toEqual([['alp', 'ha '], ['be', 'ta']]);
    expect(lines[0].map(segment => segment.style.fontWeight)).toEqual([400, 700]);
    expect(lines[1].map(segment => segment.style.fontWeight)).toEqual([700, 400]);
    expect(textLines(shape)).toEqual(['alpha ', 'beta']);
  });

  it('keeps auto-width text on one line per paragraph with one segment per styleRun', () => {
    const shape = { text: 'Hello World', width: 1, height: 1, fontSize: 10, fill: '#000',
      textSizing: 'auto-width' as const,
      styleRuns: [{ start: 6, end: 11, fontWeight: 700, fill: '#f00' }] };
    const lines = textRunLines(shape);
    expect(lines).toHaveLength(1);
    expect(lines[0].map(segment => segment.text)).toEqual(['Hello ', 'World']);
    expect(lines[0][0].style).toEqual({ fontFamily: 'sans-serif', fontSize: 10, fontWeight: 400,
      fontStyle: 'normal', fill: '#000', letterSpacing: 0 });
    expect(lines[0][1].style.fontWeight).toBe(700);
    expect(lines[0][1].style.fill).toBe('#f00');
    expect(textSize(shape).width).toBe(lines[0].reduce((total, segment) => total + segment.width, 0));
  });

  it('ignores styleRuns entirely when absent, keeping textLines/textSize/textHeight at prior fixture values', () => {
    const shape = { text: 'ABCD', width: 1, height: 9, fontSize: 10, lineHeight: 17 };
    expect(textLines({ ...shape, textSizing: 'fixed' })).toEqual(['A', 'B', 'C', 'D']);
    expect(textHeight({ ...shape, textSizing: 'fixed' })).toBe(68);
    expect(textSize({ ...shape, textSizing: 'auto-height' })).toEqual({ width: 1, height: 68 });
  });
});
