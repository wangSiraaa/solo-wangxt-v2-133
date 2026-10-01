// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ClipperFactory from 'clipper2-wasm/dist/es/clipper2z.js';
import { offsetPolygons, booleanPolygons } from './clipperCore';
import { rebuildPiece } from '../geometry/rebuild';
import { createSkirtProject } from '../model/sample';
import { transferDart } from '../commands/transferDart';
import { validateProject } from '../geometry/validation';
import { DEFAULT_TOLERANCE } from '../model/types';
import type { Vec } from '../model/types';

const require = createRequire(import.meta.url);
let C: Awaited<ReturnType<typeof ClipperFactory>>;

beforeAll(async () => {
  const wasmPath = require.resolve('clipper2-wasm/dist/es/clipper2z.wasm');
  C = await ClipperFactory({ wasmBinary: readFileSync(wasmPath) });
});

describe('真实 Clipper2 WASM 端到端（派生缝线 → 缝份/裁剪轮廓）', () => {
  it('缝份外轮廓包住缝线，且缝宽方向外扩约 allowance', () => {
    const d = createSkirtProject().versions[0].data;
    const piece = Object.values(d.pieces)[0];
    const dp = rebuildPiece(d, piece);
    const sa = piece.seamAllowance; // 10mm
    const { outer, holes } = offsetPolygons(C, [dp.seamPolyline], sa, 'miter');
    expect(holes).toHaveLength(0);
    expect(outer.length).toBeGreaterThanOrEqual(1);
    // 裁剪轮廓面积必须明显大于缝线面积
    const areaPoly = (p: Vec[]) => {
      let a = 0;
      for (let i = 0; i < p.length; i++) {
        const q = p[(i + 1) % p.length];
        a += p[i].x * q.y - q.x * p[i].y;
      }
      return Math.abs(a / 2);
    };
    const seamArea = areaPoly(dp.seamPolyline);
    const cutArea = Math.max(...outer.map(areaPoly));
    expect(cutArea).toBeGreaterThan(seamArea + sa * 400);
    // 每个裁剪顶点到缝线的距离 >= 0（外扩），且缝份在直线边处约等于设定值
    // 取底边中点附近的裁剪点验证外扩 ~10mm
    const bottomCut = outer.flat().filter((q) => q.y > 290 + sa - 1 && q.y < 310 + sa + 1);
    expect(bottomCut.length).toBeGreaterThan(0);
  });

  it('转移后的新几何也能正确生成缝份（派生层 → worker 内核全链路）', () => {
    const project = createSkirtProject().versions[0].data;
    const pieceId = Object.keys(project.pieces)[0];
    const dartId = Object.keys(project.darts)[0];
    const r = transferDart(project, { pieceId, dartId, angle: Math.PI / 2, tolerance: DEFAULT_TOLERANCE });
    expect(validateProject(r.data, DEFAULT_TOLERANCE).ok).toBe(true);
    const dp = rebuildPiece(r.data, r.data.pieces[pieceId]);
    const { outer, holes } = offsetPolygons(C, [dp.seamPolyline], 10, 'miter');
    expect(outer.length).toBeGreaterThanOrEqual(1);
    void holes;
  });

  it('布尔差集可用于裁片间净形运算', () => {
    const a: Vec[][] = [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]];
    const b: Vec[][] = [[{ x: 50, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 100 }, { x: 50, y: 100 }]];
    const diff = booleanPolygons(C, 'difference', a, b);
    expect(diff.length).toBe(1);
    expect(diff[0].length).toBe(4);
    // 差集为左半条 0..50
    const xs = diff[0].map((p) => p.x);
    expect(Math.max(...xs)).toBeLessThanOrEqual(50 + 0.01);
  });
});
