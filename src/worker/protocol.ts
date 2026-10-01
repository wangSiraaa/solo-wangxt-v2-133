/**
 * Worker 协议：所有布尔运算（缝份外偏 = inflate/union、自交权威判定）
 * 都在 Web Worker 内经 Clipper2 WASM 执行。
 *
 * 代次防护（核心）：
 * - 请求携带 requestId 与工程代次 version（= 已提交版本号）；
 * - 主线程只接受「当前仍等待的 requestId」且「version 与当前提交版本一致」的结果；
 * - 用户在计算期间继续编辑（产生新版本）或取消任务后，迟到结果一律丢弃，
 *   绝不覆盖新几何。
 */
import type {
  DerivedPiece,
  DegeneracyReason,
  Piece,
  ProjectData,
  Tolerances,
  ValidationReport,
  Vec2
} from '../core/types';

export interface ComputeRequest {
  kind: 'compute';
  requestId: number;
  /** 工程代次（已提交版本号/代次） */
  version: number;
  data: ProjectData;
  /**
   * commit：校验通过后作为一条新事务版本；
   * refresh：只刷新当前版本的派生缓存/报告/后端（初始打开、导入后），不产生新版本。
   */
  mode: 'commit' | 'refresh';
}

export interface CancelRequest {
  kind: 'cancel';
  requestId: number;
}

export type WorkerRequest = ComputeRequest | CancelRequest;

export interface WorkerFailure extends DegeneracyReason {}

export interface ComputeResponse {
  kind: 'response';
  requestId: number;
  version: number;
  mode: 'commit' | 'refresh';
  ok: boolean;
  report: ValidationReport;
  derived: DerivedPiece[];
  /** Worker 实际后端（出现在 UI/导出元数据中，可审计） */
  backend: 'clipper2-wasm' | 'fallback-ts';
  /** 处理耗时 ms */
  elapsedMs: number;
}

export interface WorkerErrorResponse {
  kind: 'error';
  requestId: number;
  version: number;
  mode: 'commit' | 'refresh';
  message: string;
}

export type WorkerResponse = ComputeResponse | WorkerErrorResponse;

/** 把离散 mm 多边形转成 Clipper int64（1e4 缩放：0.0001mm 分辨率） */
export const CLIPPER_SCALE = 10_000;

export interface PieceInput {
  piece: Piece;
  seamLoop: Vec2[];
}

export interface BooleanBackend {
  readonly name: 'clipper2-wasm' | 'fallback-ts';
  /**
   * 缝合环 + 缝份 → 裁剪轮廓（外偏闭合路径，已做 union）。
   * 返回多路径时表示产生了分离岛/退化。
   */
  inflateCutline(
    loop: Vec2[],
    seamAllowance: number,
    tol: Tolerances
  ): Vec2[][];
  /** 权威自交/有效性：返回非 0 即非法（union-self 面积应与原面积一致） */
  hasSelfIntersection(loop: Vec2[], tol: Tolerances): boolean;
  /** 多边形面积（mm²，带符号） */
  signedArea(loop: Vec2[]): number;
}
