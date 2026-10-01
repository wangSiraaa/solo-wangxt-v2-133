import type {
  Notch,
  Piece,
  ProjectData,
  Tolerance,
  ValidationIssue,
  ValidationReport,
  Vec,
} from '../model/types';
import { edgeLength, edgePointAt } from './bezier';
import { cross, dist } from './vec';
import { flattenEdgeWalk } from './rebuild';

/**
 * 纯 TypeScript 几何校验（不依赖 worker/Canvas，可在 jsdom 单测中运行）。
 * 判定全部基于实测数值与显式容差，返回每条退化原因，禁止以"画面看似闭合"通过。
 */
export function validateProject(
  data: ProjectData,
  tolerance: Tolerance,
  pieceIds?: string[],
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const ids = pieceIds ?? Object.keys(data.pieces);

  for (const pieceId of ids) {
    const piece = data.pieces[pieceId];
    if (!piece) {
      issues.push(issue('PIECE_NOT_FOUND', `裁片 ${pieceId} 不存在`, [pieceId], 0, 0));
      continue;
    }
    issues.push(...validatePiece(data, piece, tolerance));
  }

  return {
    ok: issues.length === 0,
    issues,
    checkedAt: Date.now(),
    tolerance,
  };
}

export function validatePiece(
  data: ProjectData,
  piece: Piece,
  tol: Tolerance,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { loop } = piece;

  if (loop.pointIds.length !== loop.edges.length || loop.edges.length < 3) {
    issues.push(
      issue(
        'LOOP_NOT_CLOSED',
        `${piece.name}: 环的点数(${loop.pointIds.length})与边数(${loop.edges.length})不匹配或少于3`,
        [piece.id],
        tol.closure,
        Infinity,
      ),
    );
    return issues;
  }

  // 拓扑闭合 + 间隙实测
  for (let i = 0; i < loop.edges.length; i++) {
    const ref = loop.edges[i];
    const edge = data.edges[ref.edgeId];
    if (!edge) {
      issues.push(issue('SELF_INTERSECTION', `${piece.name}: 缺少边 ${ref.edgeId}`, [ref.edgeId], 0, Infinity));
      continue;
    }
    const expectedStart = loop.pointIds[i];
    const expectedEnd = loop.pointIds[(i + 1) % loop.pointIds.length];
    const walkFrom = ref.reversed ? edge.to : edge.from;
    const walkTo = ref.reversed ? edge.from : edge.to;
    if (walkFrom !== expectedStart) {
      const gap = dist(data.points[walkFrom]?.pos ?? zero, data.points[expectedStart]?.pos ?? zero);
      issues.push(
        issue(
          'LOOP_NOT_CLOSED',
          `${piece.name}: 边 ${ref.edgeId} 起点与环点 ${expectedStart} 不连续`,
          [ref.edgeId, expectedStart],
          tol.closure,
          gap,
        ),
      );
    }
    if (walkTo !== expectedEnd && i < loop.edges.length - 1) {
      // 最后一条边的终点由首点检查覆盖
      const gap = dist(data.points[walkTo]?.pos ?? zero, data.points[expectedEnd]?.pos ?? zero);
      issues.push(
        issue('LOOP_NOT_CLOSED', `${piece.name}: 边 ${ref.edgeId} 终点不连续`, [ref.edgeId, expectedEnd], tol.closure, gap),
      );
    }
    // 几何闭合间隙（即使 id 拓扑正确也测距离）
    const pA = data.points[walkFrom]?.pos;
    const pB = data.points[walkTo]?.pos;
    const pStart = data.points[expectedStart]?.pos;
    if (pA && pStart && dist(pA, pStart) > tol.closure) {
      issues.push(
        issue('LOOP_NOT_CLOSED', `${piece.name}: 边 ${ref.edgeId} 起点间隙 ${dist(pA, pStart).toFixed(3)}mm`, [ref.edgeId], tol.closure, dist(pA, pStart)),
      );
    }
    void pB;
  }

  // 零长度/退化边
  for (const ref of loop.edges) {
    const edge = data.edges[ref.edgeId];
    if (!edge) continue;
    const a = data.points[edge.from]?.pos;
    const b = data.points[edge.to]?.pos;
    if (!a || !b) continue;
    const L = edgeLength(edge, a, b);
    if (L < tol.zeroEdge) {
      issues.push(
        issue('ZERO_LENGTH_EDGE', `${piece.name}: 边 ${ref.edgeId} 退化，长度 ${L.toFixed(4)}mm`, [ref.edgeId], tol.zeroEdge, L),
      );
    }
  }

  // 自交（离散折线的跨边相交，跳过共享端点的相邻边）
  const poly = walkPolygon(data, piece);
  if (poly.length >= 4) {
    for (const hit of findSelfIntersections(poly, tol.selfIntersect)) {
      issues.push(
        issue(
          'SELF_INTERSECTION',
          `${piece.name}: 轮廓在 (${hit.p.x.toFixed(2)}, ${hit.p.y.toFixed(2)}) 自交，边段 #${hit.i}/#${hit.j}`,
          [piece.id, loop.edges[hit.i]?.edgeId ?? '', loop.edges[hit.j]?.edgeId ?? ''],
          tol.selfIntersect,
          hit.depth,
        ),
      );
    }
  }

  // 省
  for (const dartId of piece.dartIds) {
    const dart = data.darts[dartId];
    if (!dart) {
      issues.push(issue('DART_NOT_FOUND', `${piece.name}: 省 ${dartId} 不存在`, [dartId], 0, 0));
      continue;
    }
    const eIn = data.edges[dart.legIn];
    const eOut = data.edges[dart.legOut];
    if (!eIn || !eOut) {
      issues.push(
        issue('DART_LEGS_NOT_FOUND', `${piece.name}/${dart.name}: 省腿缺失`, [dart.id], 0, 0),
      );
      continue;
    }
    const lin = edgeLength(eIn, data.points[eIn.from].pos, data.points[eIn.to].pos);
    const lout = edgeLength(eOut, data.points[eOut.from].pos, data.points[eOut.to].pos);
    const diff = Math.abs(lin - lout);
    if (diff > tol.legLength) {
      issues.push(
        issue(
          'DART_LEG_LENGTH_MISMATCH',
          `${piece.name}/${dart.name}: 省腿长度差 ${diff.toFixed(3)}mm（${lin.toFixed(2)} vs ${lout.toFixed(2)}）`,
          [dart.id, dart.legIn, dart.legOut],
          tol.legLength,
          diff,
        ),
      );
    }
    // 省腿必须真的汇聚到省尖
    const apexPoint = data.points[dart.apex];
    const inEnds = [eIn.from, eIn.to];
    const outEnds = [eOut.from, eOut.to];
    if (!inEnds.includes(dart.apex) || !outEnds.includes(dart.apex)) {
      issues.push(
        issue('DART_LEGS_NOT_FOUND', `${dart.name}: 省腿未绑定省尖 ${dart.apex}`, [dart.id, dart.apex], 0, 0),
      );
    }
    void apexPoint;
  }

  // 记号
  for (const n of Object.values(data.notches)) {
    if (!piece.loop.edges.some((r) => r.edgeId === n.edgeId)) continue;
    issues.push(...validateNotch(data, n, tol));
  }

  // 剪线方向与命中
  for (const slashId of piece.slashIds) {
    const slash = data.slashes[slashId];
    if (!slash) continue;
    const edge = data.edges[slash.edgeId];
    if (!edge || !data.points[slash.pointId]) {
      issues.push(issue('SLASH_MISSED_EDGE', `${piece.name}: 剪线 ${slashId} 命中丢失`, [slashId], 0, 0));
      continue;
    }
    if (!(slash.t >= -1e-9 && slash.t <= 1 + 1e-9)) {
      issues.push(
        issue('SLASH_DIRECTION_INVALID', `${piece.name}: 剪线 ${slashId} 参数 ${slash.t.toFixed(3)} 越界`, [slashId], 0, slash.t),
      );
    }
    const measured = edgePointAt(edge, data.points[edge.from].pos, data.points[edge.to].pos, slash.t);
    const drift = dist(measured, data.points[slash.pointId].pos);
    if (drift > tol.reattach) {
      issues.push(
        issue('INTERSECTION_DRIFT', `${piece.name}: 剪线交点重投影漂移 ${drift.toFixed(3)}mm`, [slashId, slash.pointId], tol.reattach, drift),
      );
    }
  }

  return issues;
}

function validateNotch(data: ProjectData, n: Notch, tol: Tolerance): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const edge = data.edges[n.edgeId];
  if (!edge) {
    issues.push(issue('NOTCH_OFF_EDGE', `记号 ${n.id} 绑定的边缺失`, [n.id, n.edgeId], 0, 0));
    return issues;
  }
  if (!(n.t >= -1e-9 && n.t <= 1 + 1e-9)) {
    issues.push(
      issue('NOTCH_T_OUT_OF_RANGE', `记号 ${n.id} 参数 ${n.t.toFixed(3)} 超出 [0,1]`, [n.id], 0, n.t),
    );
  }
  if (n.normalSide !== 1 && n.normalSide !== -1) {
    issues.push(issue('NOTCH_DIRECTION_INVALID', `记号 ${n.id} 法向侧非法: ${String(n.normalSide)}`, [n.id], 0, 0));
  }
  const a = data.points[edge.from]?.pos;
  const b = data.points[edge.to]?.pos;
  if (a && b && n.t >= 0 && n.t <= 1) {
    const p = edgePointAt(edge, a, b, n.t);
    if (n.pointId) {
      const anchor = data.points[n.pointId]?.pos;
      if (!anchor) {
        issues.push(issue('NOTCH_OFF_EDGE', `记号 ${n.id} 绑定的特征点 ${n.pointId} 缺失`, [n.id, n.pointId], 0, 0));
      } else {
        const d = dist(p, anchor);
        if (d > tol.reattach) {
          issues.push(
            issue('INTERSECTION_DRIFT', `记号 ${n.id} 与绑定点漂移 ${d.toFixed(3)}mm`, [n.id, n.pointId], tol.reattach, d),
          );
        }
      }
    }
    // 端点记号必须精确落在端点；区间记号退化到端点也要报告
    if (Math.abs(n.t) < 1e-9 && !n.pointId) {
      issues.push(issue('NOTCH_T_OUT_OF_RANGE', `记号 ${n.id} 位于端点但未绑定 pointId`, [n.id], tol.reattach, n.t));
    }
  }
  return issues;
}

export function walkPolygon(data: ProjectData, piece: Piece): Vec[] {
  const poly: Vec[] = [];
  piece.loop.edges.forEach((ref, i) => {
    const { points } = flattenEdgeWalk(data, ref, 0.08);
    points.forEach((p, k) => {
      const isEnd = k === points.length - 1;
      if (isEnd && i < piece.loop.edges.length - 1) return;
      if (isEnd && i === piece.loop.edges.length - 1) return;
      poly.push(p);
    });
  });
  return poly;
}

interface SelfIntersection {
  i: number;
  j: number;
  p: Vec;
  depth: number;
}

/** 检测折线非相邻边段的真正相交（端点接触且共线滑过也算，距离超过 tol 才算穿透）。 */
export function findSelfIntersections(poly: Vec[], tol: number): SelfIntersection[] {
  const hits: SelfIntersection[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent =
        j === i + 1 || (i === 0 && j === n - 1);
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const c = poly[j];
      const d = poly[(j + 1) % n];
      const hit = segmentIntersection(a, b, c, d, tol);
      if (hit && (!adjacent || hit.depth > tol)) {
        hits.push({ i, j, p: hit.p, depth: adjacent ? hit.depth : Math.max(hit.depth, tol) });
      }
    }
  }
  return hits;
}

function segmentIntersection(
  a: Vec,
  b: Vec,
  c: Vec,
  d: Vec,
  tol: number,
): { p: Vec; depth: number } | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const rxs = cross(r, s);
  const cax = { x: c.x - a.x, y: c.y - a.y };
  if (Math.abs(rxs) < 1e-12) {
    // 平行：检测重叠（共线滑过）
    if (Math.abs(cross(cax, r)) > tol) return null;
    const rr = r.x * r.x + r.y * r.y;
    if (rr < 1e-12) return null;
    const t0 = (cax.x * r.x + cax.y * r.y) / rr;
    const t1 = t0 + (s.x * r.x + s.y * r.y) / rr;
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    if (hi - lo > 1e-9) {
      const t = (lo + hi) / 2;
      return { p: { x: a.x + r.x * t, y: a.y + r.y * t }, depth: (hi - lo) * Math.sqrt(rr) };
    }
    return null;
  }
  const t = cross(cax, s) / rxs;
  const u = cross(cax, r) / rxs;
  const eps = tol / Math.max(Math.hypot(r.x, r.y), 1e-9);
  if (t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps) {
    const tc = Math.min(1, Math.max(0, t));
    const uc = Math.min(1, Math.max(0, u));
    // 端点轻微接触不算自交，只有深入线段内部才报
    const inside = Math.min(tc, 1 - tc, uc, 1 - uc) * Math.hypot(r.x, r.y);
    if (inside <= tol && (tc <= tol / Math.hypot(r.x, r.y) || tc >= 1 - tol / Math.hypot(r.x, r.y))) {
      // 仅端点接触
      return null;
    }
    return { p: { x: a.x + r.x * tc, y: a.y + r.y * tc }, depth: inside };
  }
  return null;
}

const zero: Vec = { x: NaN, y: NaN };

function issue(
  code: ValidationIssue['code'],
  message: string,
  refs: string[],
  tolerance: number,
  measured: number,
): ValidationIssue {
  return { code, message, refs, tolerance, measured };
}
