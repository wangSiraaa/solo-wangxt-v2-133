import type {
  Dart,
  Edge,
  LineEdge,
  LoopEdgeRef,
  Notch,
  Piece,
  ProjectData,
  SlashMark,
  Tolerance,
  ValidationIssue,
  Vec,
} from '../model/types';
import { cross, dist, dot, rotateAbout, sub } from '../geometry/vec';
import { edgePointAt } from '../geometry/bezier';
import { rayCubicIntersection, rayLineIntersection, splitCubic } from '../geometry/intersection';
import { IdGen } from '../model/idgen';
import { validateProject } from '../geometry/validation';

export interface TransferOptions {
  pieceId: string;
  dartId: string;
  /** 剪切射线角度（弧度，屏幕坐标 y 向下）。 */
  angle: number;
  /** 命中旧记号则在新省双腿生成端点记号。 */
  mergeHitNotch?: boolean;
  tolerance: Tolerance;
}

export interface TransferResult {
  data: ProjectData;
  report: ReturnType<typeof validateProject>;
  newDartId: string;
  hitEdgeId: string;
  hitT: number;
  slashId: string;
  audit: {
    rotationAngleDeg: number;
    legClosureGap: number;
    newLegLength: number;
    hitDistanceFromApex: number;
    mergedNotchIds: string[];
  };
}

interface DirEdge {
  edgeId: string;
  reversed: boolean;
  wf: string;
  wt: string;
}

/**
 * 一次省道转移 = 一个事务。
 *
 * 统一约定（全部基于环【穿行】方向）：
 *   环正向 … mIn --legIn(穿行 mIn→apex)--> apex --legOut(穿行 apex→mOut)--> mOut …
 *
 * 省尖射线命中外边 E 于 P，E 把外环分成：
 *   旋转侧 R：mOut 沿环正向走到 P（theta 把 vOut 转到 vIn，闭合旧省）
 *   固定侧 F：mIn 沿环另一侧走到 P（不动）
 * 刚体旋转后 mOut≡mIn（mOut 身份并入 mIn），P 旋转到 P'，P-P' 张开为新省。
 *
 * 身份稳定：apex 不动；P/P' 新特征点；曲边 de Casteljau 精确分裂；
 * 记号按精确参数公式改绑；合并省口时其剪线/记号 pointId 同步改绑，杜绝重投影漂移。
 */
export function transferDart(src: ProjectData, opts: TransferOptions): TransferResult {
  const data: ProjectData = JSON.parse(JSON.stringify(src));
  const idg = new IdGen(data);

  const piece = data.pieces[opts.pieceId];
  const dart = data.darts[opts.dartId];
  if (!piece) throw fail('PIECE_NOT_FOUND', '裁片不存在', [opts.pieceId]);
  if (!dart) throw fail('DART_NOT_FOUND', '省不存在', [opts.dartId]);

  const apexId = dart.apex;
  const apexPt = data.points[apexId];

  // 已有的边内剪线点先提升为环顶点
  for (const sm of Object.values(data.slashes)) {
    splitEdgeAtExistingSlash(data, piece, sm, idg);
  }

  const legIn = data.edges[dart.legIn];
  const legOut = data.edges[dart.legOut];
  if (!legIn || !legOut) throw fail('DART_LEGS_NOT_FOUND', `${dart.name}: 省腿缺失`, [dart.id]);
  if (legIn.curve !== 'line' || legOut.curve !== 'line') {
    throw fail('CURVED_DART_LEG', `${dart.name}: 曲边省腿不能用直线枢轴闭合（轮廓曲边不受此限）。`, [dart.id]);
  }

  const nL = piece.loop.edges.length;
  const idxLegIn = piece.loop.edges.findIndex((r) => r.edgeId === legIn.id);
  const idxLegOut = piece.loop.edges.findIndex((r) => r.edgeId === legOut.id);
  if (idxLegIn < 0 || idxLegOut < 0) throw fail('DART_LEGS_NOT_FOUND', '省腿不在裁片环上', [dart.id]);

  const walkOf = (idx: number): DirEdge => {
    const ref = piece.loop.edges[(((idx % nL) + nL) % nL)];
    const e = data.edges[ref.edgeId];
    return ref.reversed
      ? { edgeId: e.id, reversed: true, wf: e.to, wt: e.from }
      : { edgeId: e.id, reversed: false, wf: e.from, wt: e.to };
  };
  const wIn = walkOf(idxLegIn);
  const wOut = walkOf(idxLegOut);
  if (wIn.wt !== apexId || wOut.wf !== apexId) {
    throw fail('DART_LEGS_NOT_FOUND', `${dart.name}: 省腿环向关系非法（legIn 须抵达省尖，legOut 须离开）`, [dart.id, apexId]);
  }
  const mInId = wIn.wf;
  const mOutId = wOut.wt;
  if (mInId === apexId || mOutId === apexId || mInId === mOutId) {
    throw fail('DART_LEGS_NOT_FOUND', `${dart.name}: 省腿未正确汇聚到省尖`, [dart.id, apexId]);
  }
  const mIn = data.points[mInId];
  const mOut = data.points[mOutId];

  // ---- 1. 剪切射线命中外边 ----
  const d: Vec = { x: Math.cos(opts.angle), y: Math.sin(opts.angle) };
  let hit: { edgeId: string; t: number; point: Vec } | null = null;
  let hitDist = Infinity;
  for (const ref of piece.loop.edges) {
    const e = data.edges[ref.edgeId];
    if (!e || e.id === legIn.id || e.id === legOut.id) continue;
    const a = data.points[e.from].pos;
    const b = data.points[e.to].pos;
    const h = e.curve === 'line'
      ? rayLineIntersection(apexPt.pos, d, a, b)
      : rayCubicIntersection(apexPt.pos, d, a, e.c1, e.c2, b);
    if (h && h.s < hitDist) {
      hitDist = h.s;
      hit = { edgeId: e.id, t: h.t, point: h.point };
    }
  }
  if (!hit) throw fail('SLASH_MISSED_EDGE', '剪切射线未命中任何外边（方向角非法）', [dart.id]);
  if (!(hit.t > 1e-9 && hit.t < 1 - 1e-9)) {
    throw fail('INVALID_HIT_PARAMETER', `剪切命中参数 ${hit.t.toFixed(4)} 不在开区间 (0,1)`, [hit.edgeId]);
  }
  const hitEdge = data.edges[hit.edgeId];
  const idxHit = piece.loop.edges.findIndex((r) => r.edgeId === hit.edgeId);
  const wHit = walkOf(idxHit);
  const rotEntryId = wHit.wf; // 命中边穿行起点：与 mOut 同侧（旋转侧入口）
  const fixedEntryId = wHit.wt; // 穿行终点：与 mIn 同侧（固定侧入口）
  // 旋转半段与 rotEntry 相邻：rotEntry==edge.from 时旋转半段是前半 [from..P]
  const rotatingIsFirst = rotEntryId === hitEdge.from;

  // 命中旧记号？（分裂前按世界距离判定）
  const hitA = data.points[hitEdge.from].pos;
  const hitB = data.points[hitEdge.to].pos;
  const mergedNotchIds: string[] = [];
  let hitNotchId: string | null = null;
  if (opts.mergeHitNotch) {
    let best = Infinity;
    for (const nn of Object.values(data.notches)) {
      if (nn.edgeId !== hitEdge.id) continue;
      const dd = dist(edgePointAt(hitEdge, hitA, hitB, nn.t), hit.point);
      if (dd <= opts.tolerance.hitMerge && dd < best) {
        best = dd;
        hitNotchId = nn.id;
      }
    }
    if (hitNotchId) mergedNotchIds.push(hitNotchId);
  }

  // ---- 2. 两条外边链（按顶点连续性收集，边内剪线插入点不影响行走） ----
  const collectFwd = (startVertex: string, fromIdx: number, stopIdx: number): DirEdge[] => {
    const out: DirEdge[] = [];
    let cur = startVertex;
    let i = (((fromIdx % nL) + nL) % nL);
    const stop = ((stopIdx % nL) + nL) % nL;
    for (let guard = 0; guard <= nL && i !== stop; guard++) {
      const w = walkOf(i);
      if (w.wf !== cur) {
        throw fail('LOOP_NOT_CLOSED', `环分区在边 ${w.edgeId} 处断链（期望 ${cur}，实际 ${w.wf}）`, [w.edgeId]);
      }
      out.push(w);
      cur = w.wt;
      i = (i + 1) % nL;
    }
    return out;
  };
  // 旋转侧（旧环正向）：mOut → … → rotEntry
  const rotatingFwd = collectFwd(mOutId, idxLegOut + 1, idxHit);
  // 固定侧（旧环正向）：fixedEntry → … → mIn
  const fixedFwd = collectFwd(fixedEntryId, idxHit + 1, idxLegIn);
  if (rotatingFwd.length + fixedFwd.length + 3 > nL + 4) {
    throw fail('ROTATION_FOLD', '剪切点对环的分区异常', [piece.id]);
  }

  // ---- 3. 精确分裂命中边：first=[from..P], second=[P..to] ----
  const pId = idg.point();
  data.points[pId] = { id: pId, pos: hit.point, kind: 'cut' };
  const pPrimeId = idg.point();
  data.points[pPrimeId] = { id: pPrimeId, pos: { ...hit.point }, kind: 'dartMouth' };
  const firstHalfId = idg.edge();
  const secondHalfId = idg.edge();
  splitInHalves(data, hitEdge, pId, firstHalfId, secondHalfId, hit.t);
  const rotHalfId = rotatingIsFirst ? firstHalfId : secondHalfId;
  const fixedHalfId = rotatingIsFirst ? secondHalfId : firstHalfId;
  const rotHalf = data.edges[rotHalfId];

  for (const nn of Object.values(data.notches)) {
    if (nn.edgeId === hitEdge.id) retargetNotch(nn, hit.t, firstHalfId, secondHalfId);
  }
  for (const sm of Object.values(data.slashes)) {
    if (sm.edgeId !== hitEdge.id) continue;
    if (sm.t <= 0.5) { sm.edgeId = firstHalfId; sm.t = 0; }
    else { sm.edgeId = secondHalfId; sm.t = 1; }
  }
  delete data.edges[hitEdge.id];

  // ---- 4. 旋转角 theta：vOut(mOut-apex) -> vIn(mIn-apex) ----
  const apex = apexPt.pos;
  const vIn = sub(mIn.pos, apex);
  const vOut = sub(mOut.pos, apex);
  const theta = Math.atan2(cross(vOut, vIn), dot(vOut, vIn));
  if (!Number.isFinite(theta) || Math.abs(theta) < 1e-12) {
    throw fail('ROTATION_FOLD', '旋转角为零或退化（省腿共线）', [dart.id]);
  }
  const legGap = dist(rotateAbout(mOut.pos, apex, theta), mIn.pos);
  if (legGap > opts.tolerance.closure) {
    const dl = Math.abs(Math.hypot(vOut.x, vOut.y) - Math.hypot(vIn.x, vIn.y));
    throw fail(
      'LEG_CLOSURE_GAP',
      `旧省闭合间隙 ${legGap.toFixed(4)}mm > 容差 ${opts.tolerance.closure}mm；省腿长度差 ${dl.toFixed(4)}mm。事务中止，版本未替换。`,
      [dart.id, legIn.id, legOut.id],
    );
  }

  // ---- 5. 刚体旋转旋转侧 ----
  // 旋转顶点 = rotatingFwd 各边起点（含 mOut 之前的路径点，不含 mOut 自身——它精确并入 mIn）
  const rotVertices = new Set<string>();
  for (const w of rotatingFwd) rotVertices.add(w.wf);
  rotVertices.add(rotEntryId);
  rotVertices.delete(apexId);
  rotVertices.delete(mOutId); // 旋转后恰好等于 mIn，直接并入
  rotVertices.delete(pId); // P 在固定侧
  for (const pid of rotVertices) {
    data.points[pid].pos = rotateAbout(data.points[pid].pos, apex, theta);
  }
  const rotEdgeIds = new Set<string>(rotatingFwd.map((w) => w.edgeId));
  rotEdgeIds.add(rotHalfId);
  for (const eid of rotEdgeIds) {
    const e = data.edges[eid];
    if (e.curve === 'cubic') {
      e.c1 = rotateAbout(e.c1, apex, theta);
      e.c2 = rotateAbout(e.c2, apex, theta);
    }
  }
  // 旋转半段的 P 端换成 P'（其控制点已随边旋转），P' = rotate(P)
  if (rotHalf.from === pId) rotHalf.from = pPrimeId;
  if (rotHalf.to === pId) rotHalf.to = pPrimeId;
  data.points[pPrimeId].pos = rotateAbout(data.points[pId].pos, apex, theta);

  // ---- 5b. mOut 并入 mIn：边端点、剪线点、记号点全部改绑 ----
  data.points[mOutId].mergedInto = mInId;
  data.points[mInId].aliases = [...(data.points[mInId].aliases ?? []), mOutId];
  // 旋转侧旧环正向第一条边以 mOut 为起点
  if (rotatingFwd.length > 0) {
    const firstE = data.edges[rotatingFwd[0].edgeId];
    if (firstE.from === mOutId) firstE.from = mInId;
    if (firstE.to === mOutId) firstE.to = mInId;
  } else {
    if (rotHalf.from === mOutId) rotHalf.from = mInId;
    if (rotHalf.to === mOutId) rotHalf.to = mInId;
  }
  for (const sm of Object.values(data.slashes)) {
    if (sm.pointId === mOutId) sm.pointId = mInId;
  }
  for (const nn of Object.values(data.notches)) {
    if (nn.pointId === mOutId) nn.pointId = mInId;
  }

  // ---- 6. 新省双腿 ----
  // 正面积环顺序：mIn →旋转侧→ P' → apex → P →固定侧→ mIn。
  // 抵达省尖的穿行 P'→apex = Dart.legIn（存储 apex→P'，环反向引用）；
  // 离开省尖的穿行 apex→P = Dart.legOut（存储 P→apex，环反向引用）。
  const legArriveId = idg.edge();
  const legLeaveId = idg.edge();
  const newDartId = idg.dart();
  data.edges[legArriveId] = { id: legArriveId, from: apexId, to: pPrimeId, role: 'dartLeg', dartId: newDartId, curve: 'line' };
  data.edges[legLeaveId] = { id: legLeaveId, from: pId, to: apexId, role: 'dartLeg', dartId: newDartId, curve: 'line' };
  const newLegInId = legArriveId;
  const newLegOutId = legLeaveId;

  // ---- 7. 组装新环（从 mIn 起，与旧环同向，正面积） ----
  const dirs: DirEdge[] = [];
  // 旋转外侧：旧环正向穿行（首边 mOut 已并入 mIn）
  for (const w of rotatingFwd) {
    dirs.push({
      ...w,
      wf: w.wf === mOutId ? mInId : w.wf,
      wt: w.wt === mOutId ? mInId : w.wt,
    });
  }
  const rotEntryAfterId = rotEntryId === mOutId ? mInId : rotEntryId;
  dirs.push(directEdge(data, rotHalfId, rotEntryAfterId, pPrimeId));
  dirs.push({ edgeId: newLegInId, reversed: true, wf: pPrimeId, wt: apexId });
  dirs.push({ edgeId: newLegOutId, reversed: true, wf: apexId, wt: pId });
  dirs.push(directEdge(data, fixedHalfId, pId, fixedEntryId));
  for (const w of fixedFwd) dirs.push(w);

  const pointIds = dirs.map((x) => x.wf);
  const edges: LoopEdgeRef[] = dirs.map((x) => ({ edgeId: x.edgeId, reversed: x.reversed }));
  const tail = dirs[dirs.length - 1];
  if (tail.wt !== pointIds[0]) {
    throw fail('LOOP_NOT_CLOSED', `环重建失败：末点 ${tail.wt} ≠ 首点 ${pointIds[0]}`, [piece.id]);
  }
  piece.loop = { pointIds, edges };

  // ---- 8. 新省 / 剪线 / 旧省闭合（内缝保留） ----
  const newDart: Dart = {
    id: newDartId,
    name: `${dart.name}·转移`,
    apex: apexId,
    legIn: newLegInId,
    legOut: newLegOutId,
    drillOffset: dart.drillOffset,
  };
  data.darts[newDartId] = newDart;
  dart.closed = true;
  const oldIdx = piece.dartIds.indexOf(dart.id);
  if (oldIdx >= 0) piece.dartIds[oldIdx] = newDartId;
  else piece.dartIds.push(newDartId);
  if (!piece.dartIds.includes(dart.id)) piece.dartIds.push(dart.id);

  const slashId = idg.slash();
  data.slashes[slashId] = {
    id: slashId,
    apexId,
    edgeId: fixedHalfId,
    t: fixedHalfOfT(data, fixedHalfId, pId),
    pointId: pId,
    sourceEdgeId: hit.edgeId,
    sourceT: hit.t,
    angle: opts.angle,
  };
  piece.slashIds.push(slashId);
  data.points[pId].kind = 'dartMouth';

  // ---- 9. 命中旧记号 -> 端点记号 + 对侧省腿复制件 ----
  if (hitNotchId) {
    const nn = data.notches[hitNotchId];
    const onRotHalf = nn.edgeId === rotHalfId;
    nn.pointId = onRotHalf ? pPrimeId : pId;
    nn.t = data.edges[nn.edgeId].from === nn.pointId ? 0 : 1;
    const twinId = idg.notch();
    // 原记号在旋转半段(绑 P')：复制到固定省口 P，落在 legOut（存储 P→apex，P 为 t=0）；
    // 在固定半段(绑 P)：复制到旋转省口 P'，落在 legIn（存储 apex→P'，P' 为 t=1）。
    const twinLeg = onRotHalf ? newLegOutId : newLegInId;
    const twinPoint = onRotHalf ? pId : pPrimeId;
    data.notches[twinId] = {
      id: twinId,
      edgeId: twinLeg,
      t: (data.edges[twinLeg] as LineEdge).from === twinPoint ? 0 : 1,
      normalSide: 1,
      kind: nn.kind,
      pointId: twinPoint,
    };
  }

  // ---- 10. 全量事务校验；任一失败不替换当前版本 ----
  const report = validateProject(data, opts.tolerance, [piece.id]);
  if (!report.ok) {
    const first = report.issues[0];
    throw fail(
      first.code,
      `事务校验失败，版本未被替换。共 ${report.issues.length} 项，首项：${first.message}`,
      report.issues.flatMap((x: ValidationIssue) => x.refs),
      report.issues,
    );
  }
  apexPt.kind = 'dartApex';

  return {
    data,
    report,
    newDartId,
    hitEdgeId: hit.edgeId,
    hitT: hit.t,
    slashId,
    audit: {
      rotationAngleDeg: (theta * 180) / Math.PI,
      legClosureGap: legGap,
      newLegLength: dist(data.points[pId].pos, apex),
      hitDistanceFromApex: hitDist,
      mergedNotchIds,
    },
  };
}

function fixedHalfOfT(data: ProjectData, edgeId: string, pId: string): number {
  const e = data.edges[edgeId];
  return e.from === pId ? 0 : 1;
}


function directEdge(data: ProjectData, edgeId: string, wantFrom: string, wantTo: string): DirEdge {
  const e = data.edges[edgeId];
  if (e.from === wantFrom && e.to === wantTo) return { edgeId, reversed: false, wf: wantFrom, wt: wantTo };
  if (e.to === wantFrom && e.from === wantTo) return { edgeId, reversed: true, wf: wantFrom, wt: wantTo };
  throw fail('LOOP_NOT_CLOSED', `分裂边 ${edgeId} 端点(${e.from},${e.to})无法匹配 ${wantFrom}->${wantTo}`, [edgeId]);
}

function splitInHalves(data: ProjectData, edge: Edge, pId: string, firstId: string, secondId: string, t0: number): void {
  const aId = edge.from;
  const bId = edge.to;
  if (edge.curve === 'line') {
    data.edges[firstId] = { id: firstId, from: aId, to: pId, role: 'seam', curve: 'line' };
    data.edges[secondId] = { id: secondId, from: pId, to: bId, role: 'seam', curve: 'line' };
    return;
  }
  const a = data.points[aId].pos;
  const b = data.points[bId].pos;
  const sp = splitCubic(a, edge.c1, edge.c2, b, t0);
  data.edges[firstId] = { id: firstId, from: aId, to: pId, role: 'seam', curve: 'cubic', c1: sp.first.c1, c2: sp.first.c2 };
  data.edges[secondId] = { id: secondId, from: pId, to: bId, role: 'seam', curve: 'cubic', c1: sp.second.c1, c2: sp.second.c2 };
}

function retargetNotch(n: Notch, t0: number, firstId: string, secondId: string): void {
  if (n.t <= t0 + 1e-12) {
    n.edgeId = firstId;
    n.t = t0 > 1e-9 ? n.t / t0 : 0;
  } else {
    n.edgeId = secondId;
    n.t = (n.t - t0) / (1 - t0);
  }
}

/** 边内剪线交点（t∈(0,1)）提升为环顶点；端点剪线若已真实成顶点则不处理。 */
function splitEdgeAtExistingSlash(data: ProjectData, piece: Piece, sm: SlashMark, idg: IdGen): void {
  const refIdx = piece.loop.edges.findIndex((r) => r.edgeId === sm.edgeId);
  if (refIdx < 0) return;
  const ref = piece.loop.edges[refIdx];
  const edge = data.edges[sm.edgeId];
  const atStart = sm.t <= 1e-9;
  const atEnd = sm.t >= 1 - 1e-9;
  if ((atStart && edge.from === sm.pointId) || (atEnd && edge.to === sm.pointId)) return;
  if (atStart || atEnd) return;

  const firstId = idg.edge();
  const secondId = idg.edge();
  splitInHalves(data, edge, sm.pointId, firstId, secondId, sm.t);
  for (const n of Object.values(data.notches)) {
    if (n.edgeId === edge.id) retargetNotch(n, sm.t, firstId, secondId);
  }
  for (const other of Object.values(data.slashes)) {
    if (other.id === sm.id || other.edgeId !== edge.id) continue;
    if (other.t <= sm.t + 1e-12) {
      other.edgeId = firstId;
      other.t = sm.t > 1e-9 ? other.t / sm.t : 0;
    } else {
      other.edgeId = secondId;
      other.t = (other.t - sm.t) / (1 - sm.t);
    }
  }
  sm.edgeId = firstId;
  sm.t = 1;
  delete data.edges[edge.id];
  piece.loop.edges.splice(refIdx, 1,
    { edgeId: firstId, reversed: ref.reversed },
    { edgeId: secondId, reversed: ref.reversed },
  );
  piece.loop.pointIds.splice(refIdx + 1, 0, sm.pointId);
}

export interface TransferError extends Error {
  code: string;
  refs: string[];
  issues?: ValidationIssue[];
  detail?: unknown;
}

function fail(code: string, message: string, refs: string[], detail?: unknown): TransferError {
  const err = new Error(message) as TransferError;
  err.code = code;
  err.refs = refs;
  err.detail = detail;
  if (Array.isArray(detail)) err.issues = detail as ValidationIssue[];
  return err;
}

export function isTransferError(x: unknown): x is TransferError {
  return x instanceof Error && typeof (x as TransferError).code === 'string';
}
