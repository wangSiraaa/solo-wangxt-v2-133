/**
 * Worker 通信协议。所有几何坐标以 0.01mm 整数传输（INTEGER_SCALE）。
 * 每个计算请求携带工程代次 gen 与几何指纹 fingerprint；
 * 主线程在收到结果时核对二者，迟到结果一律丢弃，绝不覆盖新几何。
 */

export interface IntPoint {
  x: number;
  y: number;
}

export type IntPoly = IntPoint[];

export type BoolOp = 'union' | 'difference' | 'intersection' | 'xor';
export type JoinKind = 'square' | 'round' | 'miter';

export type WorkerRequest =
  | { type: 'offset'; jobId: number; gen: number; fingerprint: string; polygons: IntPoly[]; deltaMm: number; join: JoinKind; miterLimit: number; arcToleranceMm: number }
  | { type: 'boolean'; jobId: number; gen: number; fingerprint: string; op: BoolOp; subjects: IntPoly[]; clips: IntPoly[] }
  | { type: 'cancel'; jobId: number }
  | { type: 'shutdown' };

export interface WorkerResponseBase {
  jobId: number;
  gen: number;
  fingerprint: string;
  ms: number;
}

export type WorkerResponse =
  | ({ type: 'ready' })
  | ({ type: 'offset-result'; outer: IntPoly[]; holes: IntPoly[] } & WorkerResponseBase)
  | ({ type: 'boolean-result'; paths: IntPoly[] } & WorkerResponseBase)
  | ({ type: 'error'; message: string; code: string; cancelled?: boolean } & WorkerResponseBase);
