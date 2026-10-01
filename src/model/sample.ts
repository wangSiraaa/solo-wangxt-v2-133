import type {
  Dart,
  Edge,
  Notch,
  Piece,
  Project,
  ProjectData,
  SourcePoint,
  VersionSnapshot,
  Grainline,
} from '../model/types';
import { CURRENT_FORMAT_VERSION } from '../model/types';
import { validateProject } from '../geometry/validation';
import { DEFAULT_TOLERANCE } from '../model/types';

/**
 * 示例：前裙片（y 向下为正，环为 CCW 正面积）。
 *
 * 顶边（腰线）y=0：A(0,0) -- MIn -- X(省尖在顶边下 80) -- MOut -- B
 * 右侧边（曲边，便于验证曲边上的剪线命中）B->C
 * 底边 C->D，左侧边 D->A。
 * 腰省 X 为直线省，双腿等长。
 */
export function createSkirtProject(): Project {
  const seq = { v: 0 };
  const nid = (p: string) => (seq.v += 1, `${p}${seq.v}`);

  const points: Record<string, SourcePoint> = {};
  const edges: Record<string, Edge> = {};
  const notches: Record<string, Notch> = {};

  const P = (id: string, x: number, y: number, kind: SourcePoint['kind'] = 'corner') => {
    points[id] = { id, pos: { x, y }, kind };
  };

  const X = nid('p'); // 省尖
  const MIn = nid('p');
  const MOut = nid('p');
  const A = nid('p');
  const B = nid('p');
  const C = nid('p');
  const D = nid('p');

  P(X, 100, 80, 'dartApex');
  P(MIn, 90, 0, 'dartMouth');
  P(MOut, 110, 0, 'dartMouth');
  P(A, 0, 0);
  P(B, 200, 0);
  P(C, 200, 300);
  P(D, 0, 300);

  const line = (from: string, to: string, role: Edge['role'] = 'seam', dartId?: string): Edge => {
    const id = nid('e');
    const e: Edge = { id, from, to, role, curve: 'line', dartId };
    edges[id] = e;
    return e;
  };

  const legIn = line(MIn, X, 'dartLeg'); // 抵达省尖
  const legOut = line(X, MOut, 'dartLeg'); // 离开省尖
  const eB_MOut = line(B, MOut); // 右侧边 -> MOut（顶边右段）
  const eA_MIn = line(MIn, A); // MIn -> A（顶边左段）
  const eD_A = line(D, A); // 左侧边
  const eC_D = line(C, D); // 底边
  // 右侧边做成轻微外凸的三次贝塞尔（曲边省转移验证目标）
  const rightId = nid('e');
  edges[rightId] = {
    id: rightId,
    from: B,
    to: C,
    role: 'seam',
    curve: 'cubic',
    c1: { x: 212, y: 90 },
    c2: { x: 218, y: 210 },
  };

  const dartId = nid('d');
  legIn.dartId = dartId;
  legOut.dartId = dartId;

  // 环正向（CCW, y-down）：A -> MIn -> X -> MOut -> B ->(曲边) C -> D -> A
  const loopPointIds = [A, MIn, X, MOut, B, C, D];
  const loopEdges = [
    { edgeId: eA_MIn.id, reversed: true }, // A -> MIn（边存储 MIn->A）
    { edgeId: legIn.id, reversed: false }, // MIn -> X
    { edgeId: legOut.id, reversed: false }, // X -> MOut
    { edgeId: eB_MOut.id, reversed: true }, // MOut -> B（边存储 B->MOut）
    { edgeId: rightId, reversed: false }, // B -> C
    { edgeId: eC_D.id, reversed: false }, // C -> D
    { edgeId: eD_A.id, reversed: false }, // D -> A
  ];

  // 记号：顶边右段中间一个剪口（供"剪线命中旧记号"验证）
  const nWaist = nid('n');
  notches[nWaist] = { id: nWaist, edgeId: eB_MOut.id, t: 0.55, normalSide: 1, kind: 'single' };
  // 底边中点记号（区间记号，验证随刚体旋转不改绑）
  const nHem = nid('n');
  notches[nHem] = { id: nHem, edgeId: eC_D.id, t: 0.5, normalSide: 1, kind: 'single' };
  // 侧缝对位记号（端点式）
  const nSide = nid('n');
  notches[nSide] = { id: nSide, edgeId: rightId, t: 0, normalSide: 1, kind: 'single', pointId: B };

  const grain: Grainline = { id: nid('g'), at: { x: 100, y: 150 }, angle: Math.PI / 2, length: 60 };

  const pieceId = nid('pc');
  const piece: Piece = {
    id: pieceId,
    name: '前裙片',
    loop: { pointIds: loopPointIds, edges: loopEdges },
    dartIds: [dartId],
    slashIds: [],
    seamAllowance: 10,
    grainline: grain,
  };

  const dart: Dart = {
    id: dartId,
    name: '腰省',
    apex: X,
    legIn: legIn.id,
    legOut: legOut.id,
    drillOffset: 12,
  };

  const data: ProjectData = {
    seq: seq.v,
    points,
    edges,
    notches,
    slashes: {},
    darts: { [dartId]: dart },
    pieces: { [pieceId]: piece },
  };

  const report = validateProject(data, DEFAULT_TOLERANCE);
  const snapshot: VersionSnapshot = {
    version: 1,
    parentVersion: null,
    timestamp: Date.now(),
    label: '初始样板：前裙片（直线腰省 + 曲侧缝）',
    data,
    report,
  };

  return {
    id: `proj-${Date.now()}`,
    name: '前裙片工程',
    formatVersion: CURRENT_FORMAT_VERSION,
    createdAt: snapshot.timestamp,
    updatedAt: snapshot.timestamp,
    versions: [snapshot],
    head: 0,
    readonlyObjects: [],
    migrationLog: [],
  };
}
