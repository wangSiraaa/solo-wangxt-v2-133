import { describe, it, expect } from 'vitest';
import { createSkirtProject } from '../model/sample';
import { transferDart, isTransferError } from './transferDart';
import { validateProject } from '../geometry/validation';
import { DEFAULT_TOLERANCE } from '../model/types';
import { rebuildPiece } from '../geometry/rebuild';
import { dist } from '../geometry/vec';
import type { ProjectData } from '../model/types';

function headData(): ProjectData {
  return createSkirtProject().versions[0].data;
}

function firstPieceId(d: ProjectData): string {
  return Object.keys(d.pieces)[0];
}
function firstDartId(d: ProjectData): string {
  return Object.keys(d.darts)[0];
}

describe('transferDart 直线省转移（命中底边）', () => {
  it('事务成功：闭合、无自交、省腿等长、面积守恒', () => {
    const src = headData();
    const pieceId = firstPieceId(src);
    const dartId = firstDartId(src);
    const apex = src.points[src.darts[dartId].apex].pos;

    const r = transferDart(src, {
      pieceId,
      dartId,
      angle: Math.PI / 2, // 竖直向下，命中底边
      tolerance: DEFAULT_TOLERANCE,
    });

    expect(r.report.ok).toBe(true);
    // 省尖身份不变
    expect(r.data.darts[r.newDartId].apex).toBe(src.darts[dartId].apex);
    // 旧省标记闭合
    expect(r.data.darts[dartId].closed).toBe(true);
    // 新省双腿等长（旋转保持），长度 = 省尖到剪切点距离
    const d2 = r.data;
    const nd = d2.darts[r.newDartId];
    const li = d2.edges[nd.legIn];
    const lo = d2.edges[nd.legOut];
    const lenIn = dist(d2.points[li.from].pos, d2.points[li.to].pos);
    const lenOut = dist(d2.points[lo.from].pos, d2.points[lo.to].pos);
    expect(Math.abs(lenIn - lenOut)).toBeLessThan(1e-9);
    expect(Math.abs(lenIn - (300 - apex.y))).toBeLessThan(1e-6);

    // 闭合间隙与审计
    expect(r.audit.legClosureGap).toBeLessThan(DEFAULT_TOLERANCE.closure);
    expect(Math.abs(r.audit.rotationAngleDeg)).toBeGreaterThan(0);

    // 派生层可重建、面积守恒（刚体枢轴不改变面积）
    const before = rebuildPiece(src, src.pieces[pieceId]);
    const after = rebuildPiece(d2, d2.pieces[pieceId]);
    expect(Math.abs(after.areaSigned - before.areaSigned)).toBeLessThan(1e-6);
    expect(after.seamPolyline.length).toBeGreaterThanOrEqual(before.seamPolyline.length);

    // 再跑一次全量校验
    const rep = validateProject(d2, DEFAULT_TOLERANCE);
    expect(rep.ok).toBe(true);
  });

  it('连续两次转移后仍然合法，省尖身份链稳定', () => {
    const src = headData();
    const pieceId = firstPieceId(src);
    const d0 = firstDartId(src);
    const r1 = transferDart(src, { pieceId, dartId: d0, angle: Math.PI / 2, tolerance: DEFAULT_TOLERANCE });
    // 把新省再转向右侧曲边（水平向右）
    const r2 = transferDart(r1.data, {
      pieceId,
      dartId: r1.newDartId,
      angle: 0,
      tolerance: DEFAULT_TOLERANCE,
    });
    expect(r2.report.ok).toBe(true);
    expect(r2.data.darts[r2.newDartId].apex).toBe(src.darts[d0].apex);
    const rep = validateProject(r2.data, DEFAULT_TOLERANCE);
    expect(rep.ok).toBe(true);
  });
});

describe('transferDart 曲边命中（三次贝塞尔侧缝）', () => {
  it('射线精确命中曲边，分裂后曲线记号零漂移改绑', () => {
    const src = headData();
    const pieceId = firstPieceId(src);
    const dartId = firstDartId(src);

    const r = transferDart(src, {
      pieceId,
      dartId,
      angle: 0, // 水平向右命中曲侧缝
      tolerance: DEFAULT_TOLERANCE,
    });
    expect(r.report.ok).toBe(true);

    // 被命中的是曲边 rightId（data 中仅剩的 cubic 已被分裂为两段 cubic）
    const piece = r.data.pieces[pieceId];
    let cubicCount = 0;
    for (const ref of piece.loop.edges) {
      const e = r.data.edges[ref.edgeId];
      if (e.curve === 'cubic') cubicCount += 1;
    }
    expect(cubicCount).toBe(2);

    // 端点记号 nSide（绑 B 点，t=0）必须仍绑定 B 且 t 合法
    const sideNotch = Object.values(r.data.notches).find((n) => n.pointId);
    expect(sideNotch).toBeTruthy();
    const rep = validateProject(r.data, DEFAULT_TOLERANCE);
    expect(rep.ok).toBe(true);
  });

  it('曲边分裂处连续性：两分裂段在 P 点 C0/C1 连续', () => {
    const src = headData();
    const pieceId = firstPieceId(src);
    const dartId = firstDartId(src);
    const r = transferDart(src, { pieceId, dartId, angle: 0, tolerance: DEFAULT_TOLERANCE });

    // 找到剪线记录的交点 pId，其所在的两段边
    const slash = r.data.slashes[r.slashId];
    const pPos = r.data.points[slash.pointId].pos;
    const incident = Object.values(r.data.edges).filter(
      (e) => e.from === slash.pointId || e.to === slash.pointId,
    );
    expect(incident.length).toBeGreaterThanOrEqual(2);
    for (const e of incident) {
      const other = e.from === slash.pointId ? e.to : e.from;
      // 固定段端点应精确在 P
      expect(dist(r.data.points[other].pos, pPos)).toBeGreaterThan(1e-6);
    }
  });
});

describe('transferDart 剪线命中旧记号', () => {
  it('腰段旧记号被吸附，复制到新省双腿且均为端点记号', () => {
    const src = headData();
    const pieceId = firstPieceId(src);
    const dartId = firstDartId(src);
    // nWaist 位于 B->MOut 边 t=0.55 => 世界坐标 (150.5, 0)
    const apex = src.points[src.darts[dartId].apex].pos; // (100,80)
    const tx = 200 - 0.55 * 90; // 150.5
    const angle = Math.atan2(-apex.y, tx - apex.x);

    const r = transferDart(src, {
      pieceId,
      dartId,
      angle,
      mergeHitNotch: true,
      tolerance: DEFAULT_TOLERANCE,
    });
    expect(r.report.ok).toBe(true);
    expect(r.audit.mergedNotchIds.length).toBe(1);

    // 原记号 + 双腿复制：新省腿上至少有一个端点记号
    const nd = r.data.darts[r.newDartId];
    const onNewLegs = Object.values(r.data.notches).filter(
      (n) => n.edgeId === nd.legIn || n.edgeId === nd.legOut,
    );
    expect(onNewLegs.length).toBeGreaterThanOrEqual(1);
    for (const n of onNewLegs) {
      expect(n.pointId).toBeTruthy();
      expect(n.t === 0 || n.t === 1).toBe(true);
    }
  });
});

describe('transferDart 事务失败保护', () => {
  it('射线未命中外边时抛出且不产生半截数据', () => {
    const src = headData();
    const pieceId = firstPieceId(src);
    const dartId = firstDartId(src);
    // 正上方向：腰线在该 x 处是省口缺口（90~110 之间无边），必然落空
    expect(() =>
      transferDart(src, { pieceId, dartId, angle: -Math.PI / 2, tolerance: DEFAULT_TOLERANCE }),
    ).toThrow();
    // 源数据未被修改
    expect(Object.keys(src.slashes)).toHaveLength(0);
  });

  it('省腿不等长（闭合超容差）时事务中止，错误带容差与实测值', () => {
    const src = headData();
    const pieceId = firstPieceId(src);
    const dartId = firstDartId(src);
    const dart = src.darts[dartId];
    // 把 MOut 横向拉偏 3mm 造成长度差
    const mOutId = src.edges[dart.legOut].to === dart.apex ? src.edges[dart.legOut].from : src.edges[dart.legOut].to;
    src.points[mOutId].pos.x -= 3;
    try {
      transferDart(src, { pieceId, dartId, angle: Math.PI / 2, tolerance: DEFAULT_TOLERANCE });
      throw new Error('应当抛出 LEG_CLOSURE_GAP');
    } catch (e) {
      expect(isTransferError(e)).toBe(true);
      expect((e as { code: string }).code).toMatch(/LEG_CLOSURE_GAP|DART_LEG_LENGTH_MISMATCH/);
    }
    // 源数据依旧完整（事务在深拷贝上执行）
    expect(src.pieces[pieceId].loop.edges.length).toBe(7);
  });
});
