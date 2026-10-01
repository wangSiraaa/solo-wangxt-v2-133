/**
 * 解析校验：不依赖 WASM，任何时候都能跑（命令预检、测试、Worker 不可用时的回退）。
 * 注意：这不是提交的唯一依据 —— 提交门由 Worker 中 Clipper 的权威布尔结果共同把关。
 * 但退化原因、数值容差在这里就可见。
 */
import type {
  DegeneracyReason,
  Mark,
  Piece,
  Tolerances,
  ValidationReport,
  Vec2
} from './types';
import {
  countSelfIntersections,
  dist,
  edgeLength,
  markPointsInward,
  pointAtArcFraction,
  seamLoop,
  topologicalClosure
} from './geometry';

export function resolveMarkPoint(
  piece: Piece,
  mark: Mark
): Vec2 | null {
  if (mark.vertexId) return piece.vertices[mark.vertexId] ?? null;
  if (mark.edgeId && mark.arcFraction !== undefined) {
    const e = piece.edges.find((x) => x.id === mark.edgeId);
    if (!e) return null;
    return pointAtArcFraction(e, piece.vertices, mark.arcFraction);
  }
  return mark.point ?? null;
}

export function validatePiece(
  piece: Piece,
  tol: Tolerances
): { reasons: DegeneracyReason[]; closureGap: number; legDelta: number } {
  const reasons: DegeneracyReason[] = [];
  let closureGap = 0;
  let legDelta = 0;

  if (!topologicalClosure(piece)) {
    reasons.push({
      code: 'NOT_CLOSED',
      pieceId: piece.id,
      message: `${piece.name}: 缝合轮廓拓扑未闭合（边的 to 与下一条边 from 不一致）`,
      measured: Infinity,
      limit: 0
    });
  }

  for (const e of piece.edges) {
    if (!(e.from in piece.vertices) || !(e.to in piece.vertices)) continue;
    const l = edgeLength(e, piece.vertices);
    if (l < tol.selfIntersect) {
      reasons.push({
        code: 'DEGENERATE_EDGE',
        pieceId: piece.id,
        edgeId: e.id,
        message: `${piece.name}: 边 ${e.id} 退化，长度 ${l.toFixed(4)}mm`,
        measured: l,
        limit: tol.selfIntersect
      });
    }
  }

  const loop = seamLoop(piece, tol.tessellation);
  // seamLoop 显式闭合（末点=首边起点），闭合缺口恒 0；
  // 真正的断裂由 topologicalClosure 报 NOT_CLOSED。
  const gap = loop.length >= 2 ? dist(loop[0], loop[loop.length - 1]) : Infinity;
  closureGap = gap;
  if (gap > tol.closure) {
    reasons.push({
      code: 'NOT_CLOSED',
      pieceId: piece.id,
      message: `${piece.name}: 离散环闭合缺口 ${gap.toFixed(4)}mm`,
      measured: gap,
      limit: tol.closure
    });
  }

  const selfX = countSelfIntersections(loop);
  if (selfX > 0) {
    reasons.push({
      code: 'SELF_INTERSECT',
      pieceId: piece.id,
      message: `${piece.name}: 缝合轮廓存在 ${selfX} 处自交（不能以画面看似闭合通过）`,
      measured: selfX,
      limit: 0
    });
  }

  for (const dart of piece.darts) {
    const leg1 = piece.edges.find((e) => e.id === dart.leg1);
    const leg2 = piece.edges.find((e) => e.id === dart.leg2);
    if (
      !leg1 ||
      !leg2 ||
      !(leg1.from in piece.vertices) ||
      !(leg1.to in piece.vertices) ||
      !(leg2.from in piece.vertices) ||
      !(leg2.to in piece.vertices)
    ) {
      reasons.push({
        code: 'TOPOLOGY_BROKEN',
        pieceId: piece.id,
        message: `${piece.name}: 省道 ${dart.id} 的省腿缺失`,
      });
      continue;
    }
    const l1 = edgeLength(leg1, piece.vertices);
    const l2 = edgeLength(leg2, piece.vertices);
    const d = Math.abs(l1 - l2);
    legDelta = Math.max(legDelta, d);
    if (d > tol.legLength) {
      reasons.push({
        code: 'LEG_LENGTH_MISMATCH',
        pieceId: piece.id,
        message: `${piece.name}: 省道 ${dart.id} 两腿不等长 Δ=${d.toFixed(3)}mm（${l1.toFixed(2)} vs ${l2.toFixed(2)}）`,
        measured: d,
        limit: tol.legLength
      });
    }
  }

  for (const mark of piece.marks) {
    const p = resolveMarkPoint(piece, mark);
    if (!p) {
      reasons.push({
        code: 'TOPOLOGY_BROKEN',
        pieceId: piece.id,
        markId: mark.id,
        message: `${piece.name}: 记号 ${mark.id} 无法解析（绑定的边/顶点不存在）`
      });
      continue;
    }
    if (mark.kind === 'notch' && mark.direction !== undefined) {
      const inward = markPointsInward(p, mark.direction, loop);
      if (!inward) {
        reasons.push({
          code: 'MARK_DIRECTION_OUTWARD',
          pieceId: piece.id,
          markId: mark.id,
          message: `${piece.name}: 剪口 ${mark.id} 刃口朝向裁片外侧（角度 ${(
            (mark.direction * 180) /
            Math.PI
          ).toFixed(1)}°）`,
          limit: tol.markDir
        });
      }
    }
  }

  return { reasons, closureGap, legDelta };
}

export function validateProject(
  pieces: Piece[],
  tol: Tolerances
): ValidationReport {
  const reasons: DegeneracyReason[] = [];
  let maxGap = 0;
  let maxLeg = 0;
  for (const piece of pieces) {
    const r = validatePiece(piece, tol);
    reasons.push(...r.reasons);
    maxGap = Math.max(maxGap, r.closureGap);
    maxLeg = Math.max(maxLeg, r.legDelta);
  }
  return {
    ok: reasons.length === 0,
    checkedAt: Date.now(),
    maxClosureGap: maxGap,
    maxLegDelta: maxLeg,
    reasons,
    tolerances: { ...tol }
  };
}
