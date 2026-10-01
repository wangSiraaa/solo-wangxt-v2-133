/**
 * 几何源模型（source of truth）。
 *
 * 设计要点：
 * - 所有长度单位恒为毫米（mm）。显示单位（mm/in）只在格式化层换算，永不进入模型。
 * - 特征身份（省尖、省口、剪切交点、记号）使用稳定字符串 id，转移/重建不重新绑定。
 * - 曲线方向由边的 from/to 与记号的 normalSide 显式承载；重新离散只影响派生层。
 */

export interface Vec {
  x: number;
  y: number;
}

/** 边在边界环向上的引用；reversed=true 表示环按与边存储方向相反的方向穿过它。 */
export interface LoopEdgeRef {
  edgeId: string;
  reversed: boolean;
}

/** 闭合边界环。pointIds[i] -> pointIds[i+1] 由 edges[i] 承载（末点回首点闭合成环）。 */
export interface Loop {
  pointIds: string[];
  edges: LoopEdgeRef[];
}

export type SourcePointKind =
  | 'corner'
  | 'dartApex'
  | 'dartMouth'
  | 'cut'
  | 'merged';

export interface SourcePoint {
  id: string;
  pos: Vec;
  kind: SourcePointKind;
  /** 当本点由转移重合而来：被并入点的 id 列表（身份保留，位置相同）。 */
  aliases?: string[];
  /** 本点已并入另一个点时记录。 */
  mergedInto?: string;
}

export type EdgeRole = 'seam' | 'dartLeg';

interface BaseEdge {
  id: string;
  from: string;
  to: string;
  role: EdgeRole;
  dartId?: string;
}

export interface LineEdge extends BaseEdge {
  curve: 'line';
}

/**
 * 三次贝塞尔。控制点为绝对坐标：对线段做刚体旋转时，c1/c2 随段一起旋转，
 * 因此不需要重新拟合，曲线方向（from/to）也不变。
 */
export interface CubicEdge extends BaseEdge {
  curve: 'cubic';
  c1: Vec;
  c2: Vec;
}

export type Edge = LineEdge | CubicEdge;

/**
 * 边界记号（剪口）。t 沿边【存储方向】from->to 测量，与环如何穿过该边无关。
 * normalSide 表示记号相对存储方向的法向侧（+1 左 / -1 右），永远不被隐式翻转。
 */
export interface Notch {
  id: string;
  edgeId: string;
  t: number;
  normalSide: 1 | -1;
  kind: 'single' | 'drill';
  /** 当记号恰好落在特征点上时绑定该点（端点记号）；否则为空（区间记号）。 */
  pointId?: string;
}

/** 剪线（结构线）命中：由省尖沿固定方向发出的射线与边的交点，提升为持久特征。 */
export interface SlashMark {
  id: string;
  apexId: string;
  /** 当前存活的绑定边与参数（分裂后指向含交点的半段，t 为端点 0/1）。 */
  edgeId: string;
  t: number;
  /** 命中点提升为源点后的 id（主身份，重投影失败时仍可靠它定位）。 */
  pointId: string;
  /** 首次命中的原始边 id（转移后可能已被分裂删除，仅作来源审计）。 */
  sourceEdgeId?: string;
  /** 首次命中时相对原始边的参数。 */
  sourceT?: number;
  /** 射线方向（弧度），方向记号，参与方向校验。 */
  angle: number;
}

export interface Grainline {
  id: string;
  at: Vec;
  /** 方向角（弧度）。 */
  angle: number;
  length: number;
}

export interface Dart {
  id: string;
  name: string;
  /** 省尖（枢轴点），转移前后 id 不变。 */
  apex: string;
  /** 环正向穿行时【抵达】省尖的腿。 */
  legIn: string;
  /** 环正向穿行时【离开】省尖的腿。 */
  legOut: string;
  /** 闭合后的省（已转移）：双腿保留为内缝线，不再位于边界环上。 */
  closed?: boolean;
  /** 钻孔点距省尖向省口方向的距离（mm），钻孔记号。 */
  drillOffset?: number;
}

export interface Piece {
  id: string;
  name: string;
  loop: Loop;
  dartIds: string[];
  slashIds: string[];
  /** 缝份宽度 mm。 */
  seamAllowance: number;
  grainline: Grainline;
}

export interface ProjectData {
  seq: number;
  points: Record<string, SourcePoint>;
  edges: Record<string, Edge>;
  notches: Record<string, Notch>;
  slashes: Record<string, SlashMark>;
  darts: Record<string, Dart>;
  pieces: Record<string, Piece>;
}

/** 显式数值容差（mm），全部校验与 UI 提示共用，避免"看着闭合"。 */
export interface Tolerance {
  /** 环闭合间隙。 */
  closure: number;
  /** 自交最小穿透距离。 */
  selfIntersect: number;
  /** 退化零边长度。 */
  zeroEdge: number;
  /** 省双腿长度差。 */
  legLength: number;
  /** 记号参数/位置漂移（重新绑定判定）。 */
  reattach: number;
  /** UI 剪线命中旧记号的吸附距离。 */
  hitMerge: number;
}

export const DEFAULT_TOLERANCE: Tolerance = {
  closure: 0.01,
  selfIntersect: 0.02,
  zeroEdge: 0.01,
  legLength: 0.05,
  reattach: 0.5,
  hitMerge: 0.8,
};

export type DegeneracyCode =
  | 'LOOP_NOT_CLOSED'
  | 'SELF_INTERSECTION'
  | 'ZERO_LENGTH_EDGE'
  | 'DART_LEG_LENGTH_MISMATCH'
  | 'DART_LEGS_NOT_FOUND'
  | 'NOTCH_OFF_EDGE'
  | 'NOTCH_T_OUT_OF_RANGE'
  | 'NOTCH_DIRECTION_INVALID'
  | 'SLASH_DIRECTION_INVALID'
  | 'SLASH_MISSED_EDGE'
  | 'INTERSECTION_DRIFT'
  | 'CUT_ON_DART_LEG'
  | 'DUPLICATE_FEATURE_POINT'
  | 'NON_RIGID_MERGE_DRIFT'
  | 'PIECE_NOT_FOUND'
  | 'DART_NOT_FOUND'
  | 'CURVED_DART_LEG'
  | 'ROTATION_FOLD'
  | 'LEG_CLOSURE_GAP'
  | 'INVALID_HIT_PARAMETER';

export interface ValidationIssue {
  code: DegeneracyCode;
  message: string;
  refs: string[];
  /** 本次使用的容差 mm。 */
  tolerance: number;
  /** 实测量 mm（或 t 偏差时为参数差）。 */
  measured: number;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
  checkedAt: number;
  tolerance: Tolerance;
}

export interface SelectionState {
  kind: 'point' | 'edge' | 'notch' | 'dart' | 'piece' | 'slash';
  id: string;
}

export interface VersionSnapshot {
  version: number;
  parentVersion: number | null;
  timestamp: number;
  label: string;
  data: ProjectData;
  report: ValidationReport;
}

/** 无法从旧格式迁移的对象：原样保留、只读可见，绝不静默丢弃。 */
export interface ReadonlyObject {
  id: string;
  origin: string;
  reason: string;
  raw: unknown;
}

export interface Project {
  id: string;
  name: string;
  /** 当前工程格式版本。 */
  formatVersion: number;
  createdAt: number;
  updatedAt: number;
  versions: VersionSnapshot[];
  head: number;
  readonlyObjects: ReadonlyObject[];
  /** 迁移过程记录，供用户审计。 */
  migrationLog: string[];
}

/** 坐标以 0.01mm 为单位在 worker 边界传输。 */
export const INTEGER_SCALE = 100;
export const CURRENT_FORMAT_VERSION = 3;
