/**
 * 几何源模型（source of truth）。
 *
 * 设计取舍：
 * - 源模型只保存稳定特征身份（稳定 id、弧长分数 anchor、绝对三次贝塞尔控制点）。
 * - 屏幕路径、缝份、裁剪轮廓全部是派生物，任何时刻都能从某个已提交版本重建，
 *   绝不把派生物回写成绑定依据。
 * - 重新离散时（改 tessellation 精度、重建场景），省尖/剪切交点/记号只通过
 *   edgeId + arcFraction（弧长分数）解析，因此不会改绑。
 *
 * 内部单位恒为毫米（mm）。英寸仅在显示层换算。
 */

export type Vec2 = { x: number; y: number };

/** 选择状态：只持稳定特征身份，不持屏幕对象 */
export type Selection =
  | { kind: 'vertex'; pieceId: string; vertexId: string }
  | { kind: 'edge'; pieceId: string; edgeId: string }
  | { kind: 'mark'; pieceId: string; markId: string }
  | { kind: 'dart'; pieceId: string; dartId: string }
  | { kind: 'piece'; pieceId: string }
  | null;

export type Unit = 'mm' | 'in';

export type EdgeKind = 'outer' | 'dartLeg';

export interface CubicBezier {
  /** 第一控制点（绝对世界坐标 mm） */
  c1: Vec2;
  /** 第二控制点（绝对世界坐标 mm） */
  c2: Vec2;
}

export interface Edge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  /** 缺省 = 直线段 */
  cubic?: CubicBezier;
  /** 溯源：派生边由哪些源边生成（转移后审计/记号改绑用） */
  provenance?: string[];
}

export type MarkKind = 'notch' | 'drill' | 'label';

export interface Mark {
  id: string;
  kind: MarkKind;
  /** 边上记号：绑定边身份 + 弧长分数 [0,1]，重新离散不改绑 */
  edgeId?: string;
  arcFraction?: number;
  /** 顶点记号（如剪口落在接缝交点） */
  vertexId?: string;
  /** drill / label 的世界坐标；edge 记号也缓存显示坐标，但权威是 edgeId+arcFraction */
  point?: Vec2;
  /** 记号方向（弧度，世界系，逆时针为正）。剪口表示刃口朝向，校验必须指向裁片内侧 */
  direction?: number;
  text?: string;
}

export interface Dart {
  id: string;
  /** 省尖（顶点 id，绝对稳定身份） */
  apex: string;
  /** 两条省腿边 id（kind=dartLeg），按 loop 中遇到顺序 */
  leg1: string;
  leg2: string;
}

export interface Piece {
  id: string;
  name: string;
  /** 所有顶点（含省尖与接缝交点） */
  vertices: Record<string, Vec2>;
  /** 有序循环边（缝合轮廓 loop：省道以 V 形下凹方式进入 loop） */
  edges: Edge[];
  darts: Dart[];
  marks: Mark[];
  /** 默认缝份宽 mm；边上可单独覆盖（当前模型统一缝份） */
  seamAllowance: number;
  grain: { x: number; y: number; angle: number };
}

/** 数值容差，数值本身进入导出报告，禁止以视觉闭合判定通过 */
export interface Tolerances {
  /** 闭合缺口上限 mm */
  closure: number;
  /** 自交检测的合并容差 mm（Clipper scale 下的 epsilon） */
  selfIntersect: number;
  /** 省腿等长容差 mm（缝合可行性） */
  legLength: number;
  /** 记号方向必须指向内侧：方向射线与内点夹角判定容差（弧度） */
  markDir: number;
  /** 剪线命中旧记号的命中半径 mm */
  cutHit: number;
  /** 离散弧长步长 mm */
  tessellation: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  closure: 0.05,
  selfIntersect: 0.02,
  legLength: 0.5,
  markDir: 0.17,
  cutHit: 2.0,
  tessellation: 1.5
};

export const CURRENT_FORMAT_VERSION = 2;

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

/** 已提交版本：命令事务的产物。derived 是 worker 校验通过后缓存的派生物 */
export interface ProjectData {
  formatVersion: number;
  unit: Unit;
  pieces: Piece[];
  tolerances: Tolerances;
}

export interface DerivedPiece {
  pieceId: string;
  /** 缝合轮廓离散环（屏幕路径与校验共用同一来源） */
  seamLoop: Vec2[];
  /** 裁剪轮廓（缝份外偏后 Clipper 产出） */
  cutPaths: Vec2[][];
  /** 解析后的记号世界坐标与朝向 */
  resolvedMarks: ResolvedMark[];
  /** 面积 mm² */
  area: number;
}

export interface ResolvedMark {
  markId: string;
  kind: MarkKind;
  point: Vec2;
  direction: number | null;
  pointsInward: boolean | null;
  text?: string;
}

export interface VersionEntry {
  /** 单调递增版本号（也是“工程代次”，worker 核对用） */
  version: number;
  committedAt: number;
  label: string;
  data: ProjectData;
  /** 校验报告，提交时冻结 */
  report: ValidationReport;
  /** 派生缓存（worker 产物，与 data/report 同属一次提交） */
  derived: DerivedPiece[];
}

export type FailureCode =
  | 'NOT_CLOSED'
  | 'SELF_INTERSECT'
  | 'LEG_LENGTH_MISMATCH'
  | 'MARK_DIRECTION_OUTWARD'
  | 'DEGENERATE_EDGE'
  | 'CUT_OFFSET_FAILED'
  | 'TOPOLOGY_BROKEN'
  | 'CUT_HITS_MARK'
  | 'UNMIGRATABLE';

export interface DegeneracyReason {
  code: FailureCode;
  pieceId?: string;
  edgeId?: string;
  markId?: string;
  message: string;
  /** 实际数值（缺口、长度差…） */
  measured?: number;
  /** 允许阈值 */
  limit?: number;
}

export interface ValidationReport {
  ok: boolean;
  checkedAt: number;
  /** 闭合最大缺口 mm（全部裁片） */
  maxClosureGap: number;
  /** 省腿最大长度差 mm */
  maxLegDelta: number;
  reasons: DegeneracyReason[];
  /** 生成该报告时使用的容差快照 */
  tolerances: Tolerances;
}
