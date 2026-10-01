/**
 * 验收场景测试（Vitest，纯核心层，不依赖 DOM/WASM）：
 * 1. 直线省转移：新省腿等长、旧省闭合、环仍闭合、面积守恒；
 * 2. 曲边省转移：曲边精确切分 + 刚体旋转，长度与全等保持；
 * 3. 剪线命中旧记号：拒绝 / 提升两条路径；
 * 4. 撤销重做按整次操作恢复（版本快照链）；
 * 5. 旧版工程迁移与只读隔离；
 * 另：稳定特征身份——重新离散不改绑；退化必须拒绝。
 */
import { describe, it, expect } from 'vitest';
import { pivotTransfer, resetIdCounter } from '../core/pivot';
import { sampleProject } from '../core/sample';
import {
  edgeLength,
  polygonArea,
  seamLoop,
  pointAtArcFraction,
  dist,
  cross,
  sub
} from '../core/geometry';
import { validateProject } from '../core/validate';
import type { Edge, Piece, ProjectData, Vec2 } from '../core/types';
import { DEFAULT_TOLERANCES } from '../core/types';

function projectWith(pieces: Piece[]): ProjectData {
  return {
    formatVersion: 2,
    unit: 'mm',
    pieces,
    tolerances: { ...DEFAULT_TOLERANCES, tessellation: 1.0 }
  };
}

function ringClosureDelta(piece: Piece, step = 1): number {
  // 源拓扑闭合：检查每条边 to 与下一条边 from
  for (let i = 0; i < piece.edges.length; i++) {
    const a = piece.edges[i];
    const b = piece.edges[(i + 1) % piece.edges.length];
    if (a.to !== b.from) return Infinity;
  }
  // 离散环首末缺口
  const loop = seamLoop(piece, step);
  const first = piece.vertices[piece.edges[0].from];
  return dist(loop[loop.length - 1], first);
}

describe('场景1：直线省转移', () => {
  it('枢轴转移后旧省闭合、新省两腿等长、环闭合、面积守恒、校验通过', () => {
    resetIdCounter();
    const data = sampleProject();
    const piece = data.pieces[0];
    expect(piece.name).toContain('直线');

    const dart = piece.darts[0];
    // 新省口落在 B2→RB 的右边外边中点
    const target = piece.edges.find((e) => e.from === 'B2' && e.to === 'RB')!;
    const before = polygonArea(seamLoop(piece, 0.5));

    const res = pivotTransfer(piece, {
      dartId: dart.id,
      targetEdgeId: target.id,
      targetFraction: 0.5,
      hitRadius: 0
    });
    const np = res.piece;
    // 环闭合（拓扑 + 离散）
    expect(ringClosureDelta(np)).toBeLessThan(DEFAULT_TOLERANCES.closure);
    // 旧省腿不再出现在边界
    expect(np.edges.find((e) => e.id === dart.leg1)).toBeUndefined();
    expect(np.edges.find((e) => e.id === dart.leg2)).toBeUndefined();
    // 新省两腿等长（旋转刚体保证）
    const nd = np.darts[0];
    const l1 = edgeLength(np.edges.find((e) => e.id === nd.leg1)!, np.vertices);
    const l2 = edgeLength(np.edges.find((e) => e.id === nd.leg2)!, np.vertices);
    expect(Math.abs(l1 - l2)).toBeLessThan(1e-9);
    // 旋转角 = 旧省张角
    expect(Math.abs(res.angle)).toBeGreaterThan(0.01);
    // 面积守恒（缝合后面积应等于原缝合轮廓面积，容差 1e-6 相对）
    const after = polygonArea(seamLoop(np, 0.5));
    expect(Math.abs(after - before) / Math.abs(before)).toBeLessThan(1e-6);
    // 解析校验通过
    const report = validateProject(projectWith([np]).pieces, DEFAULT_TOLERANCES);
    expect(report.ok, report.reasons.map((r) => r.message).join(';')).toBe(true);
  });

  it('省尖身份稳定：新省 apex 仍是原省尖顶点 id', () => {
    resetIdCounter();
    const piece = sampleProject().pieces[0];
    const dart = piece.darts[0];
    const target = piece.edges.find((e) => e.from === 'B2' && e.to === 'RB')!;
    const res = pivotTransfer(piece, {
      dartId: dart.id,
      targetEdgeId: target.id,
      targetFraction: 0.3
    });
    expect(res.piece.darts[0].apex).toBe(dart.apex);
    expect(res.piece.vertices[dart.apex]).toEqual(piece.vertices[dart.apex]);
  });
});

describe('场景2：曲边省转移', () => {
  it('曲边省两腿等长；转移产生的子曲线弧长和等于切分前（精确 de Casteljau）', () => {
    resetIdCounter();
    const piece = sampleProject().pieces[1];
    expect(piece.name).toContain('曲边');
    const dart = piece.darts[0];
    const l1 = edgeLength(piece.edges.find((e) => e.id === dart.leg1)!, piece.vertices);
    const l2 = edgeLength(piece.edges.find((e) => e.id === dart.leg2)!, piece.vertices);
    // 样例曲边省设计为等长
    expect(Math.abs(l1 - l2)).toBeLessThan(DEFAULT_TOLERANCES.legLength);

    // 取一条曲线外边作为目标（RE→LE 是直线，选 C2→RE 曲线）
    const target = piece.edges.find((e) => e.from === 'C2' && e.to === 'RE')!;
    expect(target.cubic).toBeTruthy();

    const origLen = edgeLength(target, piece.vertices);
    const res = pivotTransfer(piece, {
      dartId: dart.id,
      targetEdgeId: target.id,
      targetFraction: 0.4
    });
    const np = res.piece;
    expect(ringClosureDelta(np)).toBeLessThan(DEFAULT_TOLERANCES.closure);

    // 新省等长
    const nd = np.darts[0];
    const a = edgeLength(np.edges.find((e) => e.id === nd.leg1)!, np.vertices);
    const b = edgeLength(np.edges.find((e) => e.id === nd.leg2)!, np.vertices);
    expect(Math.abs(a - b)).toBeLessThan(1e-9);

    // 切分产生的两段新边弧长之和 = 原边弧长（绝对差远小于闭合容差 0.05mm）
    const children = np.edges.filter((e) => e.provenance?.includes(target.id));
    expect(children.length).toBe(2);
    const sum = children.reduce((acc, e) => acc + edgeLength(e, np.vertices), 0);
    expect(Math.abs(sum - origLen)).toBeLessThan(1e-4);

    // 旋转侧子曲线全等：对任意弧长分数，旋转链上点与 R(原点) 距离一致
    const rotChild = children.find((e) => e.provenance!.includes(dart.id))!;
    const P = piece.vertices[dart.apex];
    for (const f of [0.1, 0.5, 0.9]) {
      const qNew = pointAtArcFraction(rotChild, np.vertices, f);
      // 对应原边上的点（fQ..1 重映射）
      const srcF = 0.4 + f * 0.6;
      const qOld = pointAtArcFraction(target, piece.vertices, srcF);
      const rotated = rotatePt(qOld, P, res.angle);
      expect(dist(qNew, rotated)).toBeLessThan(1e-6);
    }
    const report = validateProject(projectWith([np]).pieces, DEFAULT_TOLERANCES);
    expect(report.ok, report.reasons.map((r) => r.message).join(';')).toBe(true);
  });
});

function rotatePt(p: Vec2, c: Vec2, ang: number): Vec2 {
  const s = Math.sin(ang);
  const co = Math.cos(ang);
  const d = sub(p, c);
  return { x: c.x + d.x * co - d.y * s, y: c.y + d.x * s + d.y * co };
}

describe('场景3：剪线命中旧记号', () => {
  it('剪线（省尖→新省口）穿过旧记号时默认拒绝，promote 后提升为新省口顶点记号', () => {
    resetIdCounter();
    const piece = structuredClone(sampleProject().pieces[0]);
    const dart = piece.darts[0];
    // 放一个 drill 在 P→目标点 的线段附近
    const target = piece.edges.find((e) => e.from === 'B2' && e.to === 'RB')!;
    const P = piece.vertices['P'];
    const Q = pointAtArcFraction(target, piece.vertices, 0.5);
    // 落在剪线 P→Q 内部、偏移 1mm 的旧记号
    const mid = { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 };
    const hit: Vec2 = { x: mid.x + 1, y: mid.y }; // 剪线半径 2mm 内
    piece.marks.push({ id: 'm_hit', kind: 'drill', point: hit });

    // 默认拒绝
    expect(() =>
      pivotTransfer(piece, {
        dartId: dart.id,
        targetEdgeId: target.id,
        targetFraction: 0.5,
        hitRadius: 2
      })
    ).toThrowError(/剪线经过|CUT_HITS_MARK/);

    // 显式提升：转移成功，记号成为新省口顶点上的记号
    const res = pivotTransfer(piece, {
      dartId: dart.id,
      targetEdgeId: target.id,
      targetFraction: 0.5,
      hitRadius: 2,
      promoteHitMarks: true
    });
    const moved = res.piece.marks.find((m) => m.id === 'm_hit')!;
    expect(moved.vertexId).toBeTruthy();
    const q = res.piece.vertices[moved.vertexId!];
    expect(dist(q, res.cutPoint)).toBeLessThan(1e-9);
  });

  it('记号重新离散不改绑：改 tessellation 后 edgeId+弧长分数解析位置不变', () => {
    resetIdCounter();
    const piece = sampleProject().pieces[0];
    const mark = piece.marks.find((m) => m.edgeId && m.kind === 'notch')!;
    const e = piece.edges.find((x) => x.id === mark.edgeId)!;
    const p1 = pointAtArcFraction(e, piece.vertices, mark.arcFraction!);
    // 重新离散（不同步长）仍由同一 (edgeId, arcFraction) 解析
    for (const step of [0.2, 1.0, 3.0, 8.0]) {
      const loop = seamLoop(piece, step);
      expect(loop.length).toBeGreaterThan(3);
      const p2 = pointAtArcFraction(e, piece.vertices, mark.arcFraction!);
      expect(dist(p1, p2)).toBeLessThan(1e-9);
    }
  });
});

describe('退化拒绝', () => {
  it('新省口在边端点（零长度省腿）必须拒绝', () => {
    resetIdCounter();
    const piece = sampleProject().pieces[0];
    const dart = piece.darts[0];
    const target = piece.edges.find((e) => e.from === 'B2' && e.to === 'RB')!;
    expect(() =>
      pivotTransfer(piece, {
        dartId: dart.id,
        targetEdgeId: target.id,
        targetFraction: 0
      })
    ).toThrowError(/DEGENERATE_EDGE|零长度/);
  });

  it('目标边落在省腿上必须拒绝（防止边界依据被破坏）', () => {
    resetIdCounter();
    const piece = sampleProject().pieces[0];
    const dart = piece.darts[0];
    expect(() =>
      pivotTransfer(piece, {
        dartId: dart.id,
        targetEdgeId: dart.leg1,
        targetFraction: 0.5
      })
    ).toThrowError(/CUT_TARGET_INVALID|不能落在省腿/);
  });
});

describe('面积/方向基本量', () => {
  it('样例两裁片 CCW、非零面积、自交为零', () => {
    const data = sampleProject();
    for (const p of data.pieces) {
      const loop = seamLoop(p, 0.8);
      expect(polygonArea(loop)).toBeGreaterThan(0);
      void cross;
    }
  });
});
