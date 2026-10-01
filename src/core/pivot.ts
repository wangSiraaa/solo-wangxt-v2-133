/**
 * 省道转移（枢轴法 / pivotal transfer）——源模型上的精确变换。
 *
 * 源模型缝合环（piece.edges 有序）：
 *   B1 →(leg1)→ P →(leg2)→ B2 →(外边链 g, 顺环向)→ … → B1
 * P 为省尖。新省口 Q 在外边链上，把 Q→…→B1 这一段（含 Q）绕 P 旋转 θ，
 * θ 取使 R(B1)=B2 的有向角；于是旧省闭合，Q 的旋转像 Q′ 与 Q 之间张开新省，
 * 省尖仍为 P。
 *
 * 新缝合环（与原环同向）：
 *   Q → P → Q′ →(旋转链, 与原 w 同向)→ B2 →(固定链, w 同向)→ Q
 *
 * 顶点/边一律用显式有序链构造（不做下标推算），避免重新离散改绑：
 * - 新边/新顶点取稳定新 id，provenance 记录源边；
 * - Q/Q′ 在命令执行时一次性固化进源模型；
 * - 曲线用精确 de Casteljau 切分，旋转是刚体全等。
 */
import type { Dart, Edge, Mark, Piece, Vec2 } from './types';
import {
  angleOf,
  arcFractionToT,
  cross,
  dist,
  dot,
  pointAtArcFraction,
  pointInPolygon,
  rotate
} from './geometry';

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function resetIdCounter(): void {
  counter = 0;
}

export class TransferError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface PivotParams {
  dartId: string;
  /** 新省口外边（必须是外边链上的 outer 边） */
  targetEdgeId: string;
  /** 弧长分数（严格 0<f<1） */
  targetFraction: number;
  /** 剪线命中旧记号时 true=提升为新省口顶点记号；缺省 false=拒绝 */
  promoteHitMarks?: boolean;
  hitRadius?: number;
}

export interface PivotResult {
  piece: Piece;
  angle: number;
  cutPoint: Vec2;
  cutPointRotated: Vec2;
  hitMarkIds: string[];
  provenance: Record<string, string[]>;
}

interface AbsCubic {
  p0: Vec2;
  c1: Vec2;
  c2: Vec2;
  p3: Vec2;
}

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t
});

/** de Casteljau 在 t 处切分三次曲线为左右两条 */
function splitCubicAt(c: AbsCubic, t: number): [AbsCubic, AbsCubic] {
  const a1 = lerp(c.p0, c.c1, t);
  const a2 = lerp(c.c1, c.c2, t);
  const a3 = lerp(c.c2, c.p3, t);
  const b1 = lerp(a1, a2, t);
  const b2 = lerp(a2, a3, t);
  const s = lerp(b1, b2, t);
  return [
    { p0: c.p0, c1: a1, c2: b1, p3: s },
    { p0: s, c1: b2, c2: a3, p3: c.p3 }
  ];
}

/** 取原曲线弧长分数区间 [f0,f1] 的精确子曲线（绝对控制点） */
function subCubicAbs(
  e: Edge,
  verts: Record<string, Vec2>,
  f0: number,
  f1: number
): AbsCubic {
  const full: AbsCubic = {
    p0: verts[e.from],
    c1: e.cubic!.c1,
    c2: e.cubic!.c2,
    p3: verts[e.to]
  };
  const t0 = arcFractionToT(e, verts, f0);
  const t1 = arcFractionToT(e, verts, f1);
  const [, right] = splitCubicAt(full, t0);
  const tp = (t1 - t0) / (1 - t0);
  const [mid] = splitCubicAt(right, tp);
  return mid;
}

/** 有序链的一个节点：一个顶点 + 进入该顶点的段（段 null=链头） */
interface Node {
  /** 源顶点 id（Q/Q′ 这类新点用合成键 __cut/__cutrot） */
  srcKey: string;
  /** 新 piece 里的稳定顶点 id */
  newKey: string;
  point: Vec2;
  /** 到达此节点的段（来自上一节点） */
  seg?: {
    sourceEdgeId: string;
    abs: AbsCubic | null;
    /** 段是否随旋转侧一起转动 */
    rotated: boolean;
    f0: number;
    f1: number;
    newEdgeId: string;
  };
}

export function pivotTransfer(piece: Piece, params: PivotParams): PivotResult {
  const dart = piece.darts.find((d) => d.id === params.dartId);
  if (!dart)
    throw new TransferError('TOPOLOGY_BROKEN', `省道 ${params.dartId} 不存在`);

  const n = piece.edges.length;
  const idx1 = piece.edges.findIndex((e) => e.id === dart.leg1);
  const idx2 = piece.edges.findIndex((e) => e.id === dart.leg2);
  if (idx1 < 0 || idx2 < 0)
    throw new TransferError('TOPOLOGY_BROKEN', '省腿边缺失');
  if ((idx2 - idx1 + n) % n !== 1)
    throw new TransferError(
      'TOPOLOGY_BROKEN',
      '省腿在缝合环中不相邻（曲边省也必须两腿共尖且相邻）'
    );

  const leg1 = piece.edges[idx1];
  const leg2 = piece.edges[idx2];
  const P = piece.vertices[leg1.to];
  if (leg2.from !== leg1.to)
    throw new TransferError('TOPOLOGY_BROKEN', '两腿未共省尖');
  const B1 = piece.vertices[leg1.from];
  const B2 = piece.vertices[leg2.to];

  // 外边链 g：顺环向 B2 → … → B1
  const g: Edge[] = [];
  for (let step = 1; step < n - 1; step++) {
    const e = piece.edges[(idx2 + step) % n];
    if (e.id === leg1.id) break;
    g.push(e);
  }
  if (
    g.length === 0 ||
    g[0].from !== leg2.to ||
    g[g.length - 1].to !== leg1.from
  )
    throw new TransferError('TOPOLOGY_BROKEN', '外边链端点与省口不一致');

  const targetGI = g.findIndex((e) => e.id === params.targetEdgeId);
  if (targetGI < 0)
    throw new TransferError(
      'CUT_TARGET_INVALID',
      '新省口必须落在旧省两腿之间的外边链上（不能落在省腿上）'
    );
  const targetEdge = g[targetGI];
  const fQ = params.targetFraction;
  if (!(fQ > 0 && fQ < 1))
    throw new TransferError(
      'DEGENERATE_EDGE',
      '新省口落在边端点会产生零长度省腿（退化），拒绝转移'
    );

  const Q = pointAtArcFraction(targetEdge, piece.vertices, fQ);
  const u: Vec2 = { x: B1.x - P.x, y: B1.y - P.y };
  const wvec: Vec2 = { x: B2.x - P.x, y: B2.y - P.y };
  const theta = Math.atan2(cross(u, wvec), dot(u, wvec));
  if (Math.abs(theta) < 1e-9 || dist(B1, B2) < 1e-9)
    throw new TransferError('DEGENERATE_EDGE', '省道张角为零，无可转移量');

  // 旧省闭合的硬保证：R(B1) 必须 == B2
  const R = (p: Vec2): Vec2 => rotate(p, P, theta);
  if (dist(R(B1), B2) > 1e-6)
    throw new TransferError(
      'TOPOLOGY_BROKEN',
      '枢轴角无法闭合旧省（R(B1)≠B2），拒绝转移'
    );
  const Qr = R(Q);
  const verts = piece.vertices;

  // —— 显式构造三条节点链 ——
  // 固定链 fixNodes：w 序 B2 → … → Q（不含 Q 之后）
  // 旋转链 rotNodes：w 序 Q → … → B1（旋转后端点 B1 并入 B2）
  const fixNodes: Node[] = [];
  const rotNodes: Node[] = [];

  const qKey = newId('v_cut');
  const qRotKey = newId('v_cutrot');

  const absOf = (e: Edge): AbsCubic | null =>
    e.cubic
      ? { p0: verts[e.from], c1: e.cubic.c1, c2: e.cubic.c2, p3: verts[e.to] }
      : null;

  // 固定链头 B2（保留原 id）
  fixNodes.push({ srcKey: leg2.to, newKey: leg2.to, point: { ...B2 } });

  for (let gi = 0; gi <= targetGI; gi++) {
    const e = g[gi];
    if (gi < targetGI) {
      // 整条固定外边：上一节点 → e.to（保留原 id）
      fixNodes.push({
        srcKey: e.to,
        newKey: e.to,
        point: { ...verts[e.to] },
        seg: {
          sourceEdgeId: e.id,
          abs: absOf(e),
          rotated: false,
          f0: 0,
          f1: 1,
          newEdgeId: newId('e_fix')
        }
      });
    } else {
      // target 左段 [0,fQ]：上一节点 → Q
      fixNodes.push({
        srcKey: '__cut',
        newKey: qKey,
        point: { ...Q },
        seg: {
          sourceEdgeId: e.id,
          abs: e.cubic ? subCubicAbs(e, verts, 0, fQ) : null,
          rotated: false,
          f0: 0,
          f1: fQ,
          newEdgeId: newId('e_fix')
        }
      });
    }
  }

  // 旋转链头 Q（源 __cut），新 id qRotKey，坐标 R(Q)
  rotNodes.push({ srcKey: '__cut', newKey: qRotKey, point: { ...Qr } });
  // target 右段 [fQ,1]：Q → e.to（旋转）
  const tgt = targetEdge;
  const pushRotNode = (
    srcKey: string,
    newKey: string,
    point: Vec2,
    seg: Node['seg']
  ): void => {
    rotNodes.push({ srcKey, newKey, point, seg });
  };
  // target.to 的旋转像
  const firstRotTo = g.length - 1 === targetGI ? leg2.to : newId('v_rot');
  pushRotNode(
    tgt.to,
    firstRotTo,
    g.length - 1 === targetGI ? { ...B2 } : R(verts[tgt.to]),
    {
      sourceEdgeId: tgt.id,
      abs: tgt.cubic ? subCubicAbs(tgt, verts, fQ, 1) : null,
      rotated: true,
      f0: fQ,
      f1: 1,
      newEdgeId: newId('e_rot')
    }
  );
  // target 之后的整条外边
  for (let gi = targetGI + 1; gi < g.length; gi++) {
    const e = g[gi];
    const last = gi === g.length - 1;
    const toKey = last ? leg2.to : newId('v_rot'); // B1 的像合并进 B2
    const toPt = last ? { ...B2 } : R(verts[e.to]);
    pushRotNode(last ? leg1.from : e.to, toKey, toPt, {
      sourceEdgeId: e.id,
      abs: absOf(e),
      rotated: true,
      f0: 0,
      f1: 1,
      newEdgeId: newId('e_rot')
    });
  }

  // —— 汇总顶点与边 ——
  const newVerts: Record<string, Vec2> = { [leg1.to]: { ...P } };
  for (const node of [...fixNodes, ...rotNodes]) newVerts[node.newKey] = node.point;

  const newEdges: Edge[] = [];
  const provenance: Record<string, string[]> = {};

  const legAId = newId('e_leg');
  const legBId = newId('e_leg');
  newEdges.push({ id: legAId, kind: 'dartLeg', from: qKey, to: leg1.to, provenance: [dart.id] });
  newEdges.push({ id: legBId, kind: 'dartLeg', from: leg1.to, to: qRotKey, provenance: [dart.id] });
  provenance[legAId] = [dart.id];
  provenance[legBId] = [dart.id];

  const addChainEdges = (nodes: Node[], extraProv: string[]): void => {
    for (let i = 1; i < nodes.length; i++) {
      const seg = nodes[i].seg!;
      let cubic: Edge['cubic'];
      if (seg.abs) {
        const c = seg.rotated
          ? { c1: R(seg.abs.c1), c2: R(seg.abs.c2) }
          : { c1: { ...seg.abs.c1 }, c2: { ...seg.abs.c2 } };
        cubic = c;
      }
      newEdges.push({
        id: seg.newEdgeId,
        kind: 'outer',
        from: nodes[i - 1].newKey,
        to: nodes[i].newKey,
        cubic: cubic!,
        provenance: seg.rotated ? [seg.sourceEdgeId, ...extraProv] : [seg.sourceEdgeId]
      });
      provenance[seg.newEdgeId] = newEdges[newEdges.length - 1].provenance!;
    }
  };
  addChainEdges(rotNodes, [dart.id]); // Q′ → … → B2
  addChainEdges(fixNodes, []); // B2 → … → Q

  // 源顶点 → 新顶点（旋转侧，B1→B2；Q 的旋转像单独处理）
  const rotVertexMap = new Map<string, string>();
  for (let i = 1; i < rotNodes.length; i++) {
    const node = rotNodes[i];
    if (node.srcKey !== '__cut') rotVertexMap.set(node.srcKey, node.newKey);
  }
  // 固定侧顶点映射即原 id（fixNodes 全部保留原 id，除 Q 外）

  // 切分段查找（记号改绑用）
  const segBySource = new Map<string, { node: Node; seg: NonNullable<Node['seg']> }[]>();
  const register = (nodes: Node[]) => {
    for (const nd of nodes) {
      if (nd.seg) {
        const arr = segBySource.get(nd.seg.sourceEdgeId) ?? [];
        arr.push({ node: nd, seg: nd.seg });
        segBySource.set(nd.seg.sourceEdgeId, arr);
      }
    }
  };
  register(rotNodes);
  register(fixNodes);

  // 旋转区域多边形（物理位置，旋转前）：P → Q → 沿右段到 … → B1 → P
  const regionPoly: Vec2[] = [P, Q];
  for (let gi = targetGI + 1; gi < g.length; gi++) regionPoly.push(verts[g[gi].to]);

  const hitMarkIds = new Set<string>();
  const radius = params.hitRadius ?? 2.0;
  const newMarks: Mark[] = [];

  for (const m0 of piece.marks) {
    const m: Mark = { ...m0 };

    if (m0.edgeId && m0.arcFraction !== undefined) {
      const srcEdge = piece.edges.find((e) => e.id === m0.edgeId)!;
      const f = m0.arcFraction;

      if (m0.edgeId === leg1.id) {
        m.point = R(pointAtArcFraction(leg1, verts, f));
        if (m.direction !== undefined) m.direction += theta;
        if (m.kind === 'notch') m.kind = 'drill';
        m.edgeId = undefined;
        m.arcFraction = undefined;
        newMarks.push(m);
        continue;
      }
      if (m0.edgeId === leg2.id) {
        m.point = pointAtArcFraction(leg2, verts, f);
        if (m.kind === 'notch') m.kind = 'drill';
        m.edgeId = undefined;
        m.arcFraction = undefined;
        newMarks.push(m);
        continue;
      }

      const parts = segBySource.get(m0.edgeId);
      if (!parts) {
        newMarks.push(m);
        continue;
      }
      const pos = pointAtArcFraction(srcEdge, verts, f);
      if (parts.length === 2 && Math.abs(f - fQ) <= 1e-9) hitMarkIds.add(m0.id);

      if (parts.length === 1) {
        const { node, seg } = parts[0];
        m.edgeId = seg.newEdgeId;
        m.arcFraction = f;
        m.point = seg.rotated ? R(pos) : { ...pos };
        if (seg.rotated && m.direction !== undefined) m.direction += theta;
        void node;
      } else {
        // 切分边：parts[0]=固定左段(到Q)，parts[1]=旋转右段(从Q)
        const left = parts.find((p) => !p.seg.rotated)!;
        const right = parts.find((p) => p.seg.rotated)!;
        if (f <= fQ) {
          m.edgeId = left.seg.newEdgeId;
          m.arcFraction = fQ > 0 ? f / fQ : 0;
          m.point = { ...pos };
        } else {
          m.edgeId = right.seg.newEdgeId;
          m.arcFraction = (f - fQ) / (1 - fQ);
          m.point = R(pos);
          if (m.direction !== undefined) m.direction += theta;
        }
      }
      newMarks.push(m);
      continue;
    }

    if (m0.vertexId) {
      const key = m0.vertexId;
      if (key === leg1.from) m.vertexId = leg2.to; // B1 并入 B2
      else if (rotVertexMap.has(key)) m.vertexId = rotVertexMap.get(key);
      newMarks.push(m);
      continue;
    }

    if (m0.point) {
      const where = pointInPolygon(m0.point, regionPoly);
      if (where === 'inside' || where === 'on') {
        m.point = R(m0.point);
        if (m.direction !== undefined) m.direction += theta;
      }
      newMarks.push(m);
    }
  }

  // 剪线 P→Q 对旧记号的命中（排除省尖与被拓扑吸收的旧省口）
  const absorbed = new Set([leg1.from, leg2.to]);
  for (const m0 of piece.marks) {
    let mp: Vec2 | null = null;
    if (m0.vertexId) mp = verts[m0.vertexId] ?? null;
    else if (m0.edgeId && m0.arcFraction !== undefined)
      mp = pointAtArcFraction(
        piece.edges.find((e) => e.id === m0.edgeId)!,
        verts,
        m0.arcFraction
      );
    else if (m0.point) mp = m0.point;
    if (!mp) continue;
    if (dist(mp, P) < 1e-9) continue;
    if (m0.vertexId && absorbed.has(m0.vertexId)) continue;
    const ab = { x: Q.x - P.x, y: Q.y - P.y };
    const t = Math.min(1, Math.max(0, dot({ x: mp.x - P.x, y: mp.y - P.y }, ab) / (dot(ab, ab) || 1)));
    const proj = { x: P.x + ab.x * t, y: P.y + ab.y * t };
    if (dist(proj, mp) <= radius) hitMarkIds.add(m0.id);
  }

  const uniqHits = [...hitMarkIds];
  if (uniqHits.length && !params.promoteHitMarks) {
    throw new TransferError(
      'CUT_HITS_MARK',
      `剪线经过 ${uniqHits.length} 个旧记号（${uniqHits.join(', ')}）；显式选择“提升旧记号”才可继续`,
      uniqHits
    );
  }
  const finalMarks = params.promoteHitMarks
    ? newMarks.map((m) =>
        uniqHits.includes(m.id)
          ? { ...m, edgeId: undefined, arcFraction: undefined, vertexId: qKey, point: { ...Q } }
          : m
      )
    : newMarks;

  const newDart: Dart = { id: newId('dart'), apex: leg1.to, leg1: legAId, leg2: legBId };
  const newPiece: Piece = {
    ...piece,
    vertices: newVerts,
    edges: newEdges,
    darts: piece.darts.filter((d) => d.id !== dart.id).concat(newDart),
    marks: finalMarks
  };

  return {
    piece: newPiece,
    angle: theta,
    cutPoint: Q,
    cutPointRotated: Qr,
    hitMarkIds: uniqHits,
    provenance
  };
}

/** 省道张角（弧度，供 UI/测试） */
export function dartAngle(piece: Piece, dart: Dart): number {
  const leg1 = piece.edges.find((e) => e.id === dart.leg1)!;
  const leg2 = piece.edges.find((e) => e.id === dart.leg2)!;
  const P = piece.vertices[dart.apex];
  const a = angleOf({ x: piece.vertices[leg1.from].x - P.x, y: piece.vertices[leg1.from].y - P.y });
  const b = angleOf({ x: piece.vertices[leg2.to].x - P.x, y: piece.vertices[leg2.to].y - P.y });
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
