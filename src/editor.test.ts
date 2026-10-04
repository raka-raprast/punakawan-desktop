import { describe, expect, it, vi } from 'vitest';
import { exportBase64, pageBounds, svgForPage } from './editor';
import { recomputeBooleanGroups } from './boolean';
import { newPage, parseDesign } from './model';

describe('SVG export', () => {
  it('exports the actual shape extent, including negative world positions, without a white page', () => {
    const page = newPage();
    page.shapes.push(
      { id: 'left', type: 'ellipse', name: 'Left', x: -75, y: -30,
        width: 35, height: 45, fill: '#f00' },
      { id: 'right', type: 'image', name: 'Right', x: 25, y: 30,
        width: 80, height: 50, fill: '#000', src: 'data:image/png;base64,aW1hZ2U=' },
    );

    expect(pageBounds(page)).toEqual({ x: -75, y: -30, width: 180, height: 110 });
    const exported = svgForPage(page);
    expect(exported).toContain('width="180" height="110" viewBox="-75 -30 180 110"');
    expect(exported).toContain('<ellipse cx="-57.5" cy="-7.5" rx="17.5" ry="22.5" fill="#f00"/>');
    expect(exported).toContain('href="data:image/png;base64,aW1hZ2U="');
    expect(exported).not.toContain('<rect');
  });

  it('does not extend a page at negative coordinates toward an implicit origin', () => {
    const page = newPage();
    page.shapes.push({ id: 'shape', type: 'rect', name: 'Shape',
      x: -100, y: -80, width: 20, height: 10, fill: '#333' });
    expect(pageBounds(page)).toEqual({ x: -100, y: -80, width: 20, height: 10 });
    expect(svgForPage(page)).toContain('viewBox="-100 -80 20 10"');
  });
  it('omits hidden shapes and mirrors flipped ones about their own center', () => {
    const page = newPage();
    page.shapes.push(
      { id: 'gone', type: 'rect', name: 'Gone', x: 0, y: 0, width: 10, height: 10, fill: '#111', hidden: true },
      { id: 'shown', type: 'rect', name: 'Shown', x: 20, y: 0, width: 10, height: 10, fill: '#222', flipX: true });
    const svg = svgForPage(page);
    expect(svg).not.toContain('#111');
    expect(svg).toContain('#222');
    expect(svg).toContain('scale(-1 1)');
    expect(pageBounds(page).x).toBe(20);
  });
  it('exports resized compound vectors with their cutout and rotation intact', () => {
    const page = newPage();
    page.shapes.push({ id: 'vector', type: 'vector', name: 'Subtract',
      x: 20, y: 30, width: 80, height: 60, rotation: 30, fill: '#123456',
      pathData: 'M0 0H1V1H0ZM.25 .25V.75H.75V.25Z' });
    const markup = svgForPage(page);
    expect(markup).toContain('transform="rotate(30 60 60)"');
    expect(markup).toContain('d="M0 0H1V1H0ZM.25 .25V.75H.75V.25Z"');
    expect(markup).toContain('transform="translate(20 30) scale(80 60)" fill="#123456" fill-rule="evenodd"');
  });

  it('exports an empty page as a transparent one-pixel SVG', () => {
    const page = newPage();
    expect(pageBounds(page)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(svgForPage(page)).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>');
  });

  it('exports only the selected object at its own coordinates and escapes user text', () => {
    const page = newPage();
    const selected = {
      id: 'title', type: 'text' as const, name: 'Title', x: 42, y: 55,
      width: 180, height: 60, fill: '#223344', text: 'A&B <layout>',
      fontFamily: 'A "special" font', fontSize: 24, textSizing: 'fixed' as const,
    };
    page.shapes.push({ id: 'other', type: 'rect', name: 'Other', x: 5, y: 5,
      width: 20, height: 20, fill: '#f00' }, selected);
    const exported = svgForPage(page, selected);
    expect(exported).toContain('viewBox="42 55 180 60"');
    expect(exported).toContain('A&amp;B &lt;layout&gt;');
    expect(exported).toContain('font-family="A &quot;special&quot; font"');
    expect(exported).not.toContain('fill="#f00"');
    expect(exported).not.toContain('fill="#ffffff"');
  });

  it('keeps linked rich text attached through host edits, rotation, flip and selected export', () => {
    const page = newPage();
    const host = { id: 'oval', type: 'ellipse' as const, name: 'Oval', x: 10, y: 20,
      width: 160, height: 80, fill: '#eee', rotation: 30 };
    const caption = { id: 'caption', type: 'text' as const, name: 'Caption', x: -200, y: -200,
      width: 10, height: 20, fill: '#111', text: 'A&B', textPathId: 'oval', textPathOffset: 25,
      textPathFlip: false, fontSize: 20, styleRuns: [{ start: 2, end: 3, fill: '#f00', fontWeight: 700 }] };
    page.shapes.push(host, caption);
    const first = svgForPage(page, caption);
    expect(first).toContain('<path id="text-path-0" d="M 10 60 A 80 40 0 1 1 170 60 A 80 40 0 1 1 10 60 A 80 40 0 1 1 170 60 A 80 40 0 1 1 10 60 Z"/>');
    expect(first).toContain('transform="rotate(30 90 60)"');
    expect(first).toContain('<textPath href="#text-path-0" xlink:href="#text-path-0" startOffset="12.5%">');
    expect(first).toContain('A&amp;</tspan><tspan');
    expect(first).toContain('font-weight="700" font-style="normal" fill="#f00"');
    expect(first).not.toContain('<ellipse');
    expect(pageBounds(page).x).toBeGreaterThan(-200);
    host.x += 40;
    host.rotation = 75;
    caption.textPathFlip = true;
    const next = svgForPage(page, caption);
    expect(next).toContain('d="M 50 60 A 80 40 0 1 0 210 60 A 80 40 0 1 0 50 60 A 80 40 0 1 0 210 60 A 80 40 0 1 0 50 60 Z"');
    expect(next).toContain('transform="rotate(75 130 60)"');
    expect(next).not.toContain('transform="rotate(30');
  });

  it('exports a selected host with its attached caption, or just the detached text afterward', () => {
    const page = newPage();
    const host = { id: 'line', type: 'line' as const, name: 'Line',
      x: 0, y: 0, width: 180, height: 1, fill: '#555' };
    const caption = { id: 'caption', type: 'text' as const, name: 'Caption',
      x: 0, y: 0, width: 80, height: 20, fill: '#333', text: 'Along',
      textPathId: 'line', textPathOffset: 10 };
    page.shapes.push(host, caption);
    expect(svgForPage(page, host)).toContain('<textPath href="#text-path-1" xlink:href="#text-path-1" startOffset="10%">');
    const detached = { ...caption, textPathId: undefined, textPathOffset: undefined };
    page.shapes[1] = detached;
    expect(svgForPage(page, detached)).not.toContain('<textPath');
    expect(svgForPage(page, detached)).toContain('<tspan x="0" y="36"');
  });
  it('exports a selected frame behind its direct children and includes overflow in its bounds', () => {
    const page = newPage();
    const frame = { id: 'frame', type: 'frame' as const, name: 'Frame', x: -20, y: -10,
      width: 100, height: 80, fill: '#fff' };
    page.shapes.push(
      { id: 'child', type: 'polygon', name: 'Outside', parentId: 'frame', x: 70, y: 40,
        width: 40, height: 50, fill: '#f0f' },
      { id: 'unrelated', type: 'rect', name: 'Unrelated', x: -80, y: -80,
        width: 20, height: 20, fill: '#a00' },
      frame,
      { id: 'line', type: 'line', name: 'Edge', parentId: 'frame', x: -10, y: 0,
        width: 20, height: 5, fill: '#0f0', flipX: true },
    );
    const exported = svgForPage(page, frame);
    expect(exported).toContain('width="130" height="100" viewBox="-20 -10 130 100"');
    expect(exported.indexOf('<rect x="-20"')).toBeLessThan(exported.indexOf('fill="#f0f"'));
    expect(exported).toContain('fill="#f0f"');
    expect(exported).toContain('d="M 10 0 L -10 5" fill="none" stroke="#0f0" stroke-width="2" stroke-linecap="round"');
    expect(exported).not.toContain('fill="#a00"');
  });

  it('exports arrows with rounded strokes and filled stars through shared path geometry', () => {
    const page = newPage();
    page.shapes.push(
      { id: 'arrow', type: 'arrow', name: 'Arrow', x: -20, y: -10,
        width: 40, height: 20, fill: '#123', flipX: true, flipY: true },
      { id: 'star', type: 'star', name: 'Star', x: 0, y: 0,
        width: 20, height: 20, fill: '#abc' },
    );
    const exported = svgForPage(page);
    expect(exported).toContain('d="M 20 10 L -20 -10 M ');
    expect(exported).toContain('stroke="#123" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"');
    expect(exported).toMatch(/<path d="M [^"]+ Z" fill="#abc"\/>/);
  });

  it('keeps line fill as its color while honoring optional width and opacity', () => {
    const page = newPage();
    page.shapes.push({ id: 'edge', type: 'line', name: 'Edge',
      x: 0, y: 0, width: 20, height: 1, fill: '#f00', stroke: '#00f',
      strokeWidth: 4, opacity: 0.25 });
    const exported = svgForPage(page);
    expect(exported).toContain('<g opacity="0.25"><path d="M 0 0.5 L 20 0.5" fill="none" stroke="#f00" stroke-width="4"');
    expect(exported).not.toContain('stroke="#00f"');
  });

  it('exports per-corner frame paths, object styles, and selected frame children', () => {
    const page = newPage();
    const frame = { id: 'frame', type: 'frame' as const, name: 'Board',
      x: 0, y: 0, width: 80, height: 40, fill: '#fff',
      cornerRadii: [12, 3, 7, 0] as [number, number, number, number],
      stroke: '#111', strokeWidth: 3, opacity: 0.8 };
    page.shapes.push(frame,
      { id: 'circle', type: 'ellipse', name: 'Circle', parentId: 'frame',
        x: 5, y: 5, width: 12, height: 12, fill: '#0f0', stroke: '#f00', opacity: 0 },
      { id: 'triangle', type: 'polygon', name: 'Triangle', parentId: 'frame',
        x: 20, y: 10, width: 12, height: 12, fill: '#00f', stroke: '#fff', strokeWidth: 2 },
      { id: 'unrelated', type: 'star', name: 'Outside', x: 100, y: 100,
        width: 20, height: 20, fill: '#999' },
    );
    const exported = svgForPage(page, frame);
    expect(exported).toContain('<g opacity="0.8"><path d="M 12 0 H 77 A 3 3');
    expect(exported).toContain('fill="#fff" stroke="#111" stroke-width="3"');
    expect(exported).toContain('<g opacity="0"><ellipse');
    expect(exported).toContain('fill="#0f0" stroke="#f00" stroke-width="1"');
    expect(exported).toContain('fill="#00f" stroke="#fff" stroke-width="2"');
    expect(exported).not.toContain('fill="#999"');
  });

  it('center-crops embedded images inside rounded bounds and clips the overlaid border', async () => {
    const page = newPage();
    page.shapes.push(
      { id: 'one', type: 'image', name: 'One', x: 10, y: 20, width: 100, height: 60,
        fill: '#fff', src: 'data:image/png;base64,aW1hZ2U=',
        cornerRadii: [20, 0, 15, 5], stroke: '#123', strokeWidth: 4, opacity: 0.4 },
      { id: 'two', type: 'image', name: 'Two', x: 110, y: 20, width: 30, height: 60,
        fill: '#fff', src: 'data:image/png;base64,aW1hZ2U=' },
    );
    const exported = svgForPage(page);
    expect(exported).toContain('<g opacity="0.4"><defs><clipPath id="image-clip-0" clipPathUnits="userSpaceOnUse">');
    expect(exported).toContain('d="M 30 20 H 110 L 110 20 V 65 A 15 15');
    expect(exported).toContain('clip-path="url(#image-clip-0)"><image x="10" y="20" width="100" height="60" preserveAspectRatio="xMidYMid slice"');
    expect(exported).toContain('fill="none" stroke="#123" stroke-width="4"/></g></g>');
    expect(exported).toContain('clip-path="url(#image-clip-1)"');
    expect(exported).not.toContain('xMidYMid meet');
    const base64 = await exportBase64(page, 'svg');
    expect(new TextDecoder().decode(Uint8Array.from(atob(base64), char => char.charCodeAt(0)))).toBe(exported);
  });

  it('wraps and aligns SVG text with explicit line spacing and letter spacing', () => {
    const page = newPage();
    page.shapes.push({ id: 'copy', type: 'text', name: 'Copy', x: 10, y: 20,
      width: 35, height: 60, fill: '#abc', text: 'alpha beta\n',
      fontSize: 10, textAlign: 'center', lineHeight: 17, letterSpacing: 0,
      stroke: '#321', strokeWidth: 1.5, opacity: 0.75 });
    const exported = svgForPage(page);
    expect(exported).toContain('<g opacity="0.75"><text fill="#abc" stroke="#321" stroke-width="1.5" text-anchor="middle" paint-order="stroke" xml:space="preserve">');
    expect(exported).toContain('<tspan x="27.5" y="30" font-family="sans-serif" font-size="10" font-weight="400" font-style="normal" fill="#abc" letter-spacing="0">alpha</tspan>' +
      '<tspan x="27.5" y="47" font-family="sans-serif" font-size="10" font-weight="400" font-style="normal" fill="#abc" letter-spacing="0">beta</tspan>' +
      '<tspan x="27.5" y="64" font-family="sans-serif" font-size="10" font-weight="400" font-style="normal" fill="#abc" letter-spacing="0"> </tspan>');
    page.shapes[0].textAlign = 'right';
    expect(svgForPage(page)).toContain('text-anchor="end" paint-order="stroke" xml:space="preserve"><tspan x="45" y="30"');
  });

  it('splits a mid-word styleRun boundary into separate tspans with only the first segment positioned', () => {
    const page = newPage();
    page.shapes.push({ id: 'rich', type: 'text', name: 'Rich', x: 0, y: 0,
      width: 200, height: 40, fill: '#000', text: 'AB', fontSize: 10, textSizing: 'auto-width',
      styleRuns: [{ start: 1, end: 2, fontFamily: 'serif', fontSize: 20, fontWeight: 700,
        fontStyle: 'italic', fill: '#f00', letterSpacing: 2 }] });
    const exported = svgForPage(page);
    const tspans = [...exported.matchAll(/<tspan([^>]*)>(.*?)<\/tspan>/g)];
    expect(tspans.map(match => match[2])).toEqual(['A', 'B']);
    expect(tspans[0][1]).toContain('x="0" y="20"');
    expect(tspans[0][1]).toContain('font-family="sans-serif" font-size="10" font-weight="400" font-style="normal" fill="#000" letter-spacing="0"');
    expect(tspans[1][1]).not.toContain('x=');
    expect(tspans[1][1]).not.toContain('dy=');
    expect(tspans[1][1]).toContain('font-family="serif" font-size="20" font-weight="700" font-style="italic" fill="#f00" letter-spacing="2"');
  });

  it('keeps a single native SVG text-anchor chunk per line when alignment mixes styleRun widths', () => {
    const page = newPage();
    page.shapes.push({ id: 'label', type: 'text', name: 'Label', x: 10, y: 0,
      width: 1, height: 5, fill: '#111', text: 'Hi!', fontSize: 10,
      textSizing: 'auto-width', textAlign: 'right',
      styleRuns: [{ start: 2, end: 3, fontWeight: 700, fontSize: 20 }] });
    const exported = svgForPage(page);
    const bounds = pageBounds(page);
    expect(exported).toContain(`<text fill="#111" text-anchor="end" paint-order="stroke" xml:space="preserve"><tspan x="${10 + bounds.width}" y="20"`);
    const tspans = [...exported.matchAll(/<tspan([^>]*)>(.*?)<\/tspan>/g)];
    expect(tspans.map(match => match[2])).toEqual(['Hi', '!']);
    expect(tspans[0][1]).toContain(`x="${10 + bounds.width}" y="20"`);
    expect(tspans[1][1]).not.toContain('x=');
  });

  it('accounts for a wider styleRun when computing fixed-box overflow bounds', () => {
    const page = newPage();
    page.shapes.push({ id: 'copy', type: 'text', name: 'Copy', x: 0, y: 0,
      width: 10, height: 9, fill: '#123', text: 'AB', fontSize: 10, lineHeight: 17,
      textSizing: 'fixed', styleRuns: [{ start: 1, end: 2, fontSize: 30 }] });
    expect(pageBounds(page)).toEqual({ x: 0, y: 0, width: 18, height: 34 });
  });

  it('exports auto-width typography and explicit lines instead of wrapping to a stale box', () => {
    const page = newPage();
    page.shapes.push({ id: 'title', type: 'text', name: 'Title', x: 10, y: 20,
      width: 1, height: 5, fill: '#123', text: 'A&B title\nSecond', fontFamily: 'serif',
      fontSize: 10, lineHeight: 20, fontWeight: 700, fontStyle: 'oblique',
      textSizing: 'auto-width', textAlign: 'right' });
    const exported = svgForPage(page);
    const bounds = pageBounds(page);
    expect(bounds.height).toBe(40);
    expect(bounds.width).toBeGreaterThan(1);
    expect(exported).toContain('font-family="serif" font-size="10" font-weight="700" font-style="oblique"');
    expect([...exported.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/g)].map(match => match[1]))
      .toEqual(['A&amp;B title', 'Second']);
    expect(exported).toContain(`<text fill="#123" text-anchor="end" paint-order="stroke" xml:space="preserve"><tspan x="${10 + bounds.width}" y="30"`);
  });

  it('exports all fixed-box overflow without changing its supplied dimensions', () => {
    const page = newPage();
    const shape = { id: 'copy', type: 'text' as const, name: 'Copy', x: 0, y: 0,
      width: 35, height: 9, fill: '#123', text: 'alpha beta', fontSize: 10, lineHeight: 17,
      textSizing: 'fixed' as const, fontWeight: 400, fontStyle: 'italic' as const };
    page.shapes.push(shape);
    expect(pageBounds(page)).toEqual({ x: 0, y: 0, width: 35, height: 34 });
    const exported = svgForPage(page);
    expect([...exported.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/g)].map(match => match[1]))
      .toEqual(['alpha', 'beta']);
    expect(exported).not.toContain('clip-path');
    expect(shape.width).toBe(35);
    expect(shape.height).toBe(9);
  });

  it('keeps rotated fixed-text overflow visible around the original box pivot', () => {
    const page = newPage();
    page.shapes.push({ id: 'rotated-copy', type: 'text', name: 'Copy', x: 0, y: 0,
      width: 100, height: 10, fill: '#123', text: 'A\nB\nC', fontSize: 20,
      lineHeight: 20, textSizing: 'fixed', rotation: 90 });
    const bounds = pageBounds(page);
    expect(bounds.x).toBeCloseTo(-5);
    expect(bounds.y).toBeCloseTo(-45);
    expect(bounds.width).toBeCloseTo(60);
    expect(bounds.height).toBeCloseTo(100);
    expect(svgForPage(page)).toContain('transform="rotate(90 50 5)"');
  });

  it('uses the complete page extent for PNG but only the selected shape for object PNG', async () => {
    const page = newPage();
    const imageShape = { id: 'image', type: 'image' as const, name: 'Image', x: -40, y: -25,
      width: 20, height: 12, fill: '#000', src: 'data:image/png;base64,aW1hZ2U=',
      cornerRadii: [3, 0, 2, 0] as [number, number, number, number], stroke: '#777' };
    const selected = { id: 'selected', type: 'rect' as const, name: 'Selected',
      x: 10, y: 20, width: 50, height: 55, fill: '#123456' };
    page.shapes.push(imageShape, selected);
    const canvases: Array<{ width: number; height: number }> = [];
    const rendered: Array<{ width: number; height: number; source: string }> = [];
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', {
      createObjectURL(blob: Blob) {
        blobs.push(blob);
        return `blob:export-${blobs.length}`;
      },
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal('Image', class {
      src = '';
      async decode() {}
    });
    vi.stubGlobal('document', {
      createElement(tag: string) {
        expect(tag).toBe('canvas');
        const canvas = {
          width: 0, height: 0,
          getContext(type: string) {
            expect(type).toBe('2d');
            return {
              drawImage(image: { src: string }, x: number, y: number, width: number, height: number) {
                expect([x, y]).toEqual([0, 0]);
                rendered.push({ width, height, source: image.src });
              },
            };
          },
          toDataURL() { return 'data:image/png;base64,cG5n'; },
        };
        canvases.push(canvas);
        return canvas;
      },
    });

    try {
      await exportBase64(page, 'png');
      await exportBase64(page, 'png', selected);
      await exportBase64(newPage(), 'png');
      const framed = newPage();
      const frame = { id: 'frame', type: 'frame' as const, name: 'Frame',
        x: -15, y: -10, width: 20, height: 20, fill: '#fff' };
      framed.shapes.push(frame, { id: 'child', type: 'rect', name: 'Outside',
        parentId: 'frame', x: 20, y: 10, width: 11, height: 12, fill: '#ff0' });
      await exportBase64(framed, 'png', frame);
      const grouped = newPage();
      const booleanGroup = { id: 'boolean', type: 'boolean' as const, name: 'Intersection',
        x: 0, y: 0, width: 1, height: 1, fill: '#456',
        booleanOperation: 'intersect' as const, pathData: '' };
      grouped.shapes.push(booleanGroup,
        { id: 'source', type: 'rect', name: 'Source', x: 0, y: 0,
          width: 10, height: 10, fill: '#456', parentId: 'boolean' },
        { id: 'second', type: 'rect', name: 'Second', x: 5, y: 0,
          width: 100, height: 10, fill: '#f00', parentId: 'boolean' },
        { id: 'other', type: 'rect', name: 'Other', x: 40, y: 0,
          width: 5, height: 5, fill: '#0f0' });
      recomputeBooleanGroups(grouped);
      expect(booleanGroup.width).toBe(5);
      await exportBase64(grouped, 'png');
      await exportBase64(grouped, 'png', booleanGroup);
      expect(canvases.map(({ width, height }) => ({ width, height }))).toEqual([
        { width: 100, height: 100 },
        { width: 50, height: 55 },
        { width: 1, height: 1 },
        { width: 46, height: 32 },
        { width: 40, height: 10 },
        { width: 5, height: 10 },
      ]);
      expect(rendered).toEqual([
        { width: 100, height: 100, source: 'blob:export-1' },
        { width: 50, height: 55, source: 'blob:export-2' },
        { width: 1, height: 1, source: 'blob:export-3' },
        { width: 46, height: 32, source: 'blob:export-4' },
        { width: 40, height: 10, source: 'blob:export-5' },
        { width: 5, height: 10, source: 'blob:export-6' },
      ]);
      const fullSvg = await blobs[0].text();
      expect(fullSvg).toContain('viewBox="-40 -25 100 100"');
      expect(fullSvg).toContain('href="data:image/png;base64,aW1hZ2U="');
      expect(fullSvg).toContain('preserveAspectRatio="xMidYMid slice"');
      expect(fullSvg).toContain('clip-path="url(#image-clip-0)"');
      expect(fullSvg).toContain('stroke="#777" stroke-width="1"');
      expect(fullSvg).not.toContain('width="960" height="640"');
      const selectedSvg = await blobs[1].text();
      expect(selectedSvg).toContain('viewBox="10 20 50 55"');
      expect(selectedSvg).not.toContain('href="data:image/png');
      const emptySvg = await blobs[2].text();
      expect(emptySvg).toContain('viewBox="0 0 1 1"></svg>');
      const frameSvg = await blobs[3].text();
      expect(frameSvg).toContain('viewBox="-15 -10 46 32"');
      expect(frameSvg.indexOf('fill="#fff"')).toBeLessThan(frameSvg.indexOf('fill="#ff0"'));
      const groupedSvg = await blobs[4].text();
      expect(groupedSvg).toContain('viewBox="5 0 40 10"');
      expect(groupedSvg).not.toContain('fill="#f00"');
      const selectedGroupSvg = await blobs[5].text();
      expect(selectedGroupSvg).toContain('viewBox="5 0 5 10"');
      expect(selectedGroupSvg).not.toContain('<rect');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('exports only cached Boolean silhouettes, not operands, in page, frame and group scopes', async () => {
    const page = newPage();
    const frame = { id: 'frame', type: 'frame' as const, name: 'Frame',
      x: -10, y: -10, width: 40, height: 40, fill: '#fff' };
    const group = { id: 'group', type: 'boolean' as const, name: 'Subtract',
      x: 0, y: 0, width: 1, height: 1, fill: '#123',
      booleanOperation: 'subtract' as const, pathData: '', parentId: 'frame', rotation: 45 };
    page.shapes.push(frame, group,
      { id: 'base', type: 'rect', name: 'Base', x: 0, y: 0,
        width: 20, height: 20, fill: '#123', parentId: 'group' },
      { id: 'far', type: 'rect', name: 'Far operand', x: 100, y: 0,
        width: 20, height: 20, fill: '#f00', parentId: 'group' },
      { id: 'outside', type: 'rect', name: 'Outside', x: 60, y: 0,
        width: 5, height: 5, fill: '#0f0' });
    recomputeBooleanGroups(page);
    expect(pageBounds(page)).toEqual({ x: -10, y: -10, width: 75, height: 40 });
    const groupPath = `<path d="${group.pathData}"`;
    const full = svgForPage(page);
    expect(full.split(groupPath)).toHaveLength(2);
    expect(full).not.toContain('x="100"');
    expect(full).not.toContain('fill="#f00"');
    expect(full).not.toContain('rotate(45');
    const selectedFrame = svgForPage(page, frame);
    expect(selectedFrame).toContain('viewBox="-10 -10 40 40"');
    expect(selectedFrame.split(groupPath)).toHaveLength(2);
    expect(selectedFrame).not.toContain('fill="#0f0"');
    expect(selectedFrame).not.toContain('fill="#f00"');
    const selectedGroup = svgForPage(page, group);
    expect(selectedGroup).toContain('viewBox="0 0 20 20"');
    expect(selectedGroup.split(groupPath)).toHaveLength(2);
    expect(selectedGroup).not.toContain('<rect');
    expect(atob(await exportBase64(page, 'svg', group))).toBe(selectedGroup);
    const selectedOperand = svgForPage(page, page.shapes[2]);
    expect(selectedOperand).toContain('<rect x="0" y="0" width="20" height="20" fill="#123"/>');
    expect(selectedOperand).not.toContain(groupPath);
    expect(parseDesign(JSON.stringify({ format: 'punakawan-design', version: 1,
      id: 'doc', name: 'Doc', pages: [page] })).pages[0].shapes).toEqual(page.shapes);
    page.shapes[2].x = 100;
    recomputeBooleanGroups(page);
    expect(group.pathData).toBe('');
    expect(pageBounds(page)).toEqual({ x: -10, y: -10, width: 75, height: 40 });
    expect(svgForPage(page, group)).toContain('viewBox="100 0 20 20"');
    expect(svgForPage(page)).not.toContain('fill="#f00"');
  });
});
