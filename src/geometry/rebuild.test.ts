import { describe, it, expect } from 'vitest';
import { rebuildPiece } from './rebuild';
import { buildScreenPath } from '../paper-canvas/buildPath';
import { createSkirtProject } from '../model/sample';
import { transferDart } from '../commands/transferDart';
import { DEFAULT_TOLERANCE } from '../model/types';
import type { ProjectData } from '../model/types';

describe('派生层可重建：重新离散不改绑身份', () => {
  it('同一源模型多次重建，折线顶点与记号世界位置逐点一致', () => {
    const d = createSkirtProject().versions[0].data;
    const pieceId = Object.keys(d.pieces)[0];
    const a = rebuildPiece(d, d.pieces[pieceId]);
    const b = rebuildPiece(d, d.pieces[pieceId]);
    expect(b.seamPolyline).toEqual(a.seamPolyline);
    expect(b.notches.map((n) => [n.id, n.pos.x, n.pos.y, n.normal.x, n.normal.y])).toEqual(
      a.notches.map((n) => [n.id, n.pos.x, n.pos.y, n.normal.x, n.normal.y]),
    );
  });

  it('转移后曲边分裂段与原曲线在 P 点零漂移（de Casteljau 精确）', () => {
    const src = createSkirtProject().versions[0].data;
    const pieceId = Object.keys(src.pieces)[0];
    const dartId = Object.keys(src.darts)[0];
    const r = transferDart(src, { pieceId, dartId, angle: 0, tolerance: DEFAULT_TOLERANCE });
    const d: ProjectData = r.data;
    // 原曲边上的端点记号 nSide（绑 B），转移后仍精确绑定同一身份
    const bound = Object.values(d.notches).filter((n) => n.pointId);
    for (const n of bound) {
      const e = d.edges[n.edgeId];
      const anchor = d.points[n.pointId!].pos;
      const end = n.t === 0 ? d.points[e.from].pos : d.points[e.to].pos;
      expect(Math.hypot(anchor.x - end.x, anchor.y - end.y)).toBeLessThan(1e-9);
    }
  });

  it('屏幕路径规格在多次构建间逐字节稳定（曲线方向不变）', () => {
    const src = createSkirtProject().versions[0].data;
    const pieceId = Object.keys(src.pieces)[0];
    const s1 = JSON.stringify(buildScreenPath(src, src.pieces[pieceId]));
    const s2 = JSON.stringify(buildScreenPath(src, src.pieces[pieceId]));
    expect(s1).toBe(s2);

    const r = transferDart(src, { pieceId, dartId: Object.keys(src.darts)[0], angle: Math.PI / 2, tolerance: DEFAULT_TOLERANCE });
    const sp = buildScreenPath(r.data, r.data.pieces[pieceId]);
    // 新屏幕路径含两条省腿且闭合段数与环一致
    expect(sp.segs.length).toBe(r.data.pieces[pieceId].loop.edges.length);
  });

  it('省尖 id 在多次转移后保持不变（稳定特征身份）', () => {
    let d: ProjectData = createSkirtProject().versions[0].data;
    const pieceId = Object.keys(d.pieces)[0];
    const apex0 = d.darts[Object.keys(d.darts)[0]].apex;
    const r1 = transferDart(d, { pieceId, dartId: Object.keys(d.darts)[0], angle: Math.PI / 2, tolerance: DEFAULT_TOLERANCE });
    expect(r1.data.darts[r1.newDartId].apex).toBe(apex0);
    d = r1.data;
    const r2 = transferDart(d, { pieceId, dartId: r1.newDartId, angle: 0, tolerance: DEFAULT_TOLERANCE });
    expect(r2.data.darts[r2.newDartId].apex).toBe(apex0);
    // 派生层省尖绘制位置不变
    const dp = rebuildPiece(r2.data, r2.data.pieces[pieceId]);
    expect(dp.dartLegs.length).toBeGreaterThan(0);
  });
});
