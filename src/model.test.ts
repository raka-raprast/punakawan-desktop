import { describe, expect, it } from 'vitest';
import { newDocument, newPage, parseDesign } from './model';

describe('design file format', () => {
  it('starts a new document on a blank Canvas page', () => {
    const document = newDocument();
    expect(document.pages).toEqual([{ id: document.pages[0].id, name: 'Canvas', shapes: [] }]);
  });

  it('reads existing version 1 files without frame or direction metadata', () => {
    const document = newDocument();
    document.pages[0].name = 'Page 1';
    document.pages[0].shapes.push({ id: 'legacy', type: 'rect', name: 'Box', x: -10, y: 12,
      width: 40, height: 20, fill: '#fff' });
    expect(parseDesign(JSON.stringify(document))).toEqual(document);
  });

  it('round-trips frames, children, and directional paths without rewriting them', () => {
    const document = newDocument();
    document.pages[0].shapes.push(
      { id: 'frame', type: 'frame', name: 'Board', x: -40, y: -20, width: 480, height: 320, fill: '#fff' },
      { id: 'line', type: 'line', name: 'Line', parentId: 'frame', x: -10, y: 0,
        width: 90, height: 25, fill: '#123', flipX: true, flipY: false },
      { id: 'star', type: 'star', name: 'Star', parentId: 'frame', x: 25, y: 25,
        width: 60, height: 60, fill: '#456' },
    );
    expect(parseDesign(JSON.stringify(document))).toEqual(document);
  });
  it('round-trips a transformed vector and rejects missing or unsafe path data', () => {
    const document = newDocument();
    const vector = { id: 'cutout', type: 'vector' as const, name: 'Subtract', x: 4, y: 8,
      width: 120, height: 90, fill: '#123456', rotation: 25,
      pathData: 'M0,0h1v1h-1zM.2,.2v.6h.6v-.6z' };
    document.pages[0].shapes.push(vector);
    expect(parseDesign(JSON.stringify(document)).pages[0].shapes[0]).toEqual(vector);
    for (const pathData of [undefined, '<script>', 'M0 0" onload="alert(1)', '']) {
      const changed = { ...document, pages: [{ ...document.pages[0],
        shapes: [{ ...vector, pathData }] }] };
      expect(() => parseDesign(JSON.stringify(changed))).toThrow('invalid design structure');
    }
  });

  it('preserves optional object styles without adding defaults to legacy files', () => {
    const document = newDocument();
    const styled = { id: 'styled', type: 'text' as const, name: 'Caption', x: 4, y: 5,
      width: 80, height: 40, fill: '#fff', text: 'Hello world',
      stroke: '#123', strokeWidth: 0, opacity: 0, cornerRadii: [2, 4, 6, 8] as [number, number, number, number],
      textAlign: 'right' as const, lineHeight: 18, letterSpacing: -1.25,
      fontWeight: 650, fontStyle: 'italic' as const, textSizing: 'auto-width' as const,
      styleRuns: [{ start: 0, end: 5, fontWeight: 700 }, { start: 6, end: 11, fontStyle: 'italic' as const,
        fontFamily: 'serif', fontSize: 14, fill: '#f00', letterSpacing: 2 }] };
    document.pages[0].shapes.push(styled);
    expect(parseDesign(JSON.stringify(document)).pages[0].shapes[0]).toEqual(styled);
  });

  it('round-trips linked text only when its vector host is on the same page and offset is valid', () => {
    const document = newDocument();
    const host = { id: 'oval', type: 'ellipse' as const, name: 'Oval',
      x: 0, y: 0, width: 100, height: 50, fill: '#ddd' };
    const text = { id: 'caption', type: 'text' as const, name: 'Caption', x: 0, y: 0,
      width: 80, height: 36, fill: '#111', text: 'Curved', textPathId: 'oval',
      textPathOffset: 27.5, textPathFlip: true };
    document.pages[0].shapes.push(host, text);
    expect(parseDesign(JSON.stringify(document)).pages[0].shapes[1]).toEqual(text);
    for (const invalid of [
      { textPathId: 'missing' }, { textPathId: 'caption' }, { textPathId: 42 },
      { textPathOffset: -1 }, { textPathOffset: 101 }, { textPathOffset: Infinity },
      { textPathFlip: 'yes' },
    ]) {
      const other = { ...document, pages: [{ ...document.pages[0], shapes: [host, { ...text, ...invalid }] }] };
      expect(() => parseDesign(JSON.stringify(other))).toThrow('invalid design structure');
    }
    const other = newDocument();
    other.pages[0].shapes.push(text);
    other.pages.push({ ...newPage(), shapes: [host] });
    expect(() => parseDesign(JSON.stringify(other))).toThrow('invalid design structure');
    const unlinked = { ...document, pages: [{ ...document.pages[0], shapes: [host,
      { ...text, textPathId: undefined, textPathOffset: 30 }] }] };
    expect(() => parseDesign(JSON.stringify(unlinked))).toThrow('invalid design structure');
    const nonVector = { ...document, pages: [{ ...document.pages[0],
      shapes: [{ ...host, type: 'frame' as const }, text] }] };
    expect(() => parseDesign(JSON.stringify(nonVector))).toThrow('invalid design structure');
  });

  it('rejects out-of-bounds, overlapping, unordered, or malformed styleRuns', () => {
    const document = newDocument();
    const shape = { id: 'styled', type: 'text', name: 'Caption', x: 0, y: 0,
      width: 100, height: 50, fill: '#fff', text: 'abcdefghij' };
    for (const invalid of [
      { styleRuns: 'nope' }, { styleRuns: [null] }, { styleRuns: [{ start: 0.5, end: 2 }] },
      { styleRuns: [{ start: -1, end: 2 }] }, { styleRuns: [{ start: 2, end: 2 }] },
      { styleRuns: [{ start: 0, end: 11 }] }, { styleRuns: [{ start: 0, end: 5 }, { start: 3, end: 8 }] },
      { styleRuns: [{ start: 5, end: 8 }, { start: 0, end: 3 }] },
      { styleRuns: [{ start: 0, end: 3, fontWeight: 0 }] }, { styleRuns: [{ start: 0, end: 3, fontWeight: 1001 }] },
      { styleRuns: [{ start: 0, end: 3, fontStyle: 'bold' }] },
      { styleRuns: [{ start: 0, end: 3, fontSize: 0 }] }, { styleRuns: [{ start: 0, end: 3, fontSize: '12' }] },
      { styleRuns: [{ start: 0, end: 3, letterSpacing: '2' }] },
      { styleRuns: [{ start: 0, end: 3, fontFamily: 5 }] }, { styleRuns: [{ start: 0, end: 3, fill: 5 }] },
    ]) {
      const invalidDocument = { ...document, pages: [{ ...document.pages[0], shapes: [{ ...shape, ...invalid }] }] };
      expect(() => parseDesign(JSON.stringify(invalidDocument))).toThrow('invalid design structure');
    }
    const validDocument = { ...document, pages: [{ ...document.pages[0],
      shapes: [{ ...shape, styleRuns: [{ start: 0, end: 3 }, { start: 3, end: 6, fontWeight: 500 }] }] }] };
    expect(() => parseDesign(JSON.stringify(validDocument))).not.toThrow();
  });

  it('rejects invalid stroke, opacity, corner, and text-layout values', () => {
    const document = newDocument();
    const shape = { id: 'styled', type: 'rect', name: 'Box', x: 0, y: 0,
      width: 100, height: 50, fill: '#fff' };
    for (const invalid of [
      { stroke: null }, { strokeWidth: -1 }, { strokeWidth: '2' }, { opacity: -0.1 }, { opacity: 1.01 },
      { cornerRadii: [1, 2, 3] }, { cornerRadii: [1, -1, 3, 4] },
      { cornerRadii: [1, 2, null, 4] }, { textAlign: 'justify' }, { lineHeight: 0 },
      { lineHeight: -2 }, { letterSpacing: null }, { letterSpacing: '3' },
      { fontWeight: 0 }, { fontWeight: 1001 }, { fontWeight: 'bold' }, { fontWeight: null },
      { fontStyle: 'bold' }, { fontStyle: null }, { textSizing: 'stretch' }, { textSizing: null },
    ]) {
      const invalidDocument = { ...document, pages: [{ ...document.pages[0], shapes: [{ ...shape, ...invalid }] }] };
      expect(() => parseDesign(JSON.stringify(invalidDocument))).toThrow('invalid design structure');
    }
  });

  it('keeps legacy text sizing absent and round-trips explicit sizing modes and variable weights', () => {
    const document = newDocument();
    const text = { id: 'legacy-text', type: 'text' as const, name: 'Text', x: 0, y: 0,
      width: 35, height: 24, fill: '#000', text: 'alpha beta', fontSize: 10 };
    document.pages[0].shapes.push(text,
      { ...text, id: 'constrained', textSizing: 'auto-height', fontWeight: 1, fontStyle: 'normal' },
      { ...text, id: 'fixed', textSizing: 'fixed', fontWeight: 1000, fontStyle: 'oblique' },
      { ...text, id: 'variable', textSizing: 'auto-width', fontWeight: 432.5, fontStyle: 'italic' });
    expect(parseDesign(JSON.stringify(document))).toEqual(document);
  });

  it('requires a child parent to be a valid container on its own page', () => {
    const document = newDocument();
    document.pages.push(newPage('Other'));
    document.pages[1].shapes.push({ id: 'frame', type: 'frame', name: 'Frame', x: 0, y: 0,
      width: 40, height: 40, fill: '#fff' });
    const child = { id: 'child', type: 'polygon' as const, name: 'Child', x: 0, y: 0,
      width: 10, height: 10, fill: '#abc', parentId: 'frame' };
    document.pages[0].shapes.push(child);
    expect(() => parseDesign(JSON.stringify(document))).toThrow('invalid design structure');
    document.pages[0].shapes.push({ id: 'frame', type: 'rect', name: 'Not frame', x: 0, y: 0,
      width: 40, height: 40, fill: '#fff' });
    expect(() => parseDesign(JSON.stringify(document))).toThrow('invalid design structure');
    document.pages[0].shapes[1].type = 'frame';
    expect(parseDesign(JSON.stringify(document))).toEqual(document);
  });

  it('rejects frames as children and invalid line flip flags', () => {
    const document = newDocument();
    const frame = { id: 'frame', type: 'frame' as const, name: 'Frame', x: 0, y: 0,
      width: 80, height: 80, fill: '#fff' };
    document.pages[0].shapes.push(frame);
    expect(() => parseDesign(JSON.stringify({
      ...document, pages: [{ ...document.pages[0], shapes: [frame,
        { ...frame, id: 'nested-frame', parentId: frame.id }] }],
    }))).toThrow('invalid design structure');
    const arrow = { id: 'arrow', type: 'arrow', name: 'Arrow', x: 0, y: 0,
      width: 30, height: 1, fill: '#111', parentId: frame.id };
    for (const invalid of [{ flipX: 'true' }, { flipY: 1 }, { flipX: null }]) {
      expect(() => parseDesign(JSON.stringify({
        ...document, pages: [{ ...document.pages[0], shapes: [frame, { ...arrow, ...invalid }] }],
      }))).toThrow('invalid design structure');
    }
  });

  it('round-trips pages and embedded image shapes through a disk payload', () => {
    const document = newDocument('Catalog');
    document.pages.push(newPage('Details'));
    document.pages[1].shapes.push({
      id: crypto.randomUUID(), type: 'image', name: 'Logo', x: 16, y: 24,
      width: 128, height: 64, fill: '#fff', src: 'data:image/png;base64,aGVsbG8=',
    });
    expect(parseDesign(JSON.stringify(document))).toEqual(document);
  });

  it('rejects files without a page or with an image missing its embedded source', () => {
    const document = newDocument();
    document.pages = [];
    expect(() => parseDesign(JSON.stringify(document))).toThrow('invalid design structure');
    document.pages = [newPage()];
    document.pages[0].shapes.push({
      id: 'a', type: 'image', name: 'Missing image', x: 0, y: 0,
      width: 32, height: 32, fill: '#fff',
    });
    expect(() => parseDesign(JSON.stringify(document))).toThrow('invalid design structure');
  });

  it('rejects remote image sources to keep designs portable and offline', () => {
    const document = newDocument();
    document.pages[0].shapes.push({
      id: 'remote', type: 'image', name: 'Tracking image', x: 0, y: 0,
      width: 32, height: 32, fill: '#fff', src: 'https://example.com/tracker.png',
    });
    expect(() => parseDesign(JSON.stringify(document))).toThrow('invalid design structure');
  });

  it('rejects a future file format version instead of silently rewriting it', () => {
    const document = newDocument();
    expect(() => parseDesign(JSON.stringify({ ...document, version: 2 }))).toThrow('invalid design structure');
  });
});

describe('Boolean group serialization', () => {
  const rect = (id: string, parentId?: string) => ({
    id, type: 'rect' as const, name: id, x: 0, y: 0, width: 20, height: 20, fill: '#f00',
    ...(parentId === undefined ? {} : { parentId }),
  });
  const group = (id: string, parentId?: string) => ({
    id, type: 'boolean' as const, name: id, x: 0, y: 0, width: 20, height: 20,
    fill: '#f00', pathData: 'M0 0L1 0L1 1L0 1Z', booleanOperation: 'union' as const,
    ...(parentId === undefined ? {} : { parentId }),
  });

  it('round-trips nested editable groups and empty cached intersections in version 1', () => {
    const document = newDocument();
    document.pages[0].shapes.push(
      { ...rect('frame'), type: 'frame' },
      group('outer', 'frame'), { ...group('inner', 'outer'), pathData: '',
        booleanOperation: 'intersect' }, rect('leaf', 'inner'), rect('second', 'outer'),
    );
    expect(parseDesign(JSON.stringify(document))).toEqual(document);
    expect(document.version).toBe(1);
  });

  it('requires a valid operation, nonempty children, and a parent frame or Boolean on the same page', () => {
    const document = newDocument();
    const valid = [group('outer'), rect('child', 'outer')];
    document.pages[0].shapes = valid;
    expect(parseDesign(JSON.stringify(document))).toEqual(document); // one operand remains editable
    for (const shapes of [
      [group('outer')],
      [{ ...group('outer'), booleanOperation: undefined }, valid[1]],
      [{ ...group('outer'), booleanOperation: 'flatten' }, valid[1]],
      [{ ...group('outer'), booleanOperation: 'or' }, valid[1]],
      [{ ...group('outer'), pathData: '<script>' }, valid[1]],
      [{ ...group('outer'), pathData: 'M0 0L1 0' }, valid[1]],
      [{ ...group('outer'), pathData: undefined }, valid[1]],
      [{ ...rect('outer'), booleanOperation: 'union' }, valid[1]],
      [rect('ordinary'), { ...rect('child'), parentId: 'ordinary' }],
      [group('outer'), { ...rect('child'), parentId: 'missing' }],
      [group('outer'), { ...rect('child', 'outer'), type: 'text' }],
      [group('outer'), { ...rect('child', 'outer'), type: 'line' }],
      [group('outer'), { ...rect('child', 'outer'), type: 'vector', pathData: 'M0 0L1 0' }],
    ]) {
      document.pages[0].shapes = shapes as typeof document.pages[0]['shapes'];
      expect(() => parseDesign(JSON.stringify(document))).toThrow('invalid design structure');
    }
    document.pages = [newPage('First'), newPage('Second')];
    document.pages[0].shapes = [rect('child', 'outer')];
    document.pages[1].shapes = [group('outer'), rect('other', 'outer')];
    expect(() => parseDesign(JSON.stringify(document))).toThrow('invalid design structure');
  });

  it('rejects duplicate IDs and all parent cycles, including self-parented Boolean groups', () => {
    const document = newDocument();
    for (const shapes of [
      [group('same'), rect('same', 'same')],
      [group('self', 'self'), rect('child', 'self')],
      [group('first', 'second'), group('second', 'first')],
    ]) {
      document.pages[0].shapes = shapes;
      expect(() => parseDesign(JSON.stringify(document))).toThrow('invalid design structure');
    }
  });
});
