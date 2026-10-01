import { INTEGER_SCALE } from '../model/types';
import type { Vec } from '../model/types';
import type {
  BoolOp,
  IntPoly,
  JoinKind,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

export interface OffsetParams {
  /** 工程代次：版本切换时递增。 */
  gen: number;
  /** 几何指纹：同一版本+同一缝份参数才视为同一计算。 */
  fingerprint: string;
  polygons: Vec[][];
  deltaMm: number;
  join?: JoinKind;
  miterLimit?: number;
  arcToleranceMm?: number;
}

export interface BooleanParams {
  gen: number;
  fingerprint: string;
  op: BoolOp;
  subjects: Vec[][];
  clips: Vec[][];
}

export interface OffsetResult {
  outer: Vec[][];
  holes: Vec[][];
  ms: number;
}

export interface BooleanResult {
  paths: Vec[][];
  ms: number;
}

export interface JobHandle<T> {
  jobId: number;
  promise: Promise<T>;
  cancel: () => void;
}

const toInt = (polys: Vec[][]): IntPoly[] =>
  polys.map((p) => p.map((q) => ({ x: Math.round(q.x * INTEGER_SCALE), y: Math.round(q.y * INTEGER_SCALE) })));
const toMm = (polys: IntPoly[]): Vec[][] =>
  polys.map((p) => p.map((q) => ({ x: q.x / INTEGER_SCALE, y: q.y / INTEGER_SCALE })));

/**
 * Clipper Worker 客户端。
 *
 * 迟到结果保护（硬性要求）：
 * - 每个请求带 gen + fingerprint；提交后记录当前期望对。
 * - 用户在计算期间继续编辑（版本前进）或取消任务后，回包的 gen/fingerprint
 *   若与最新期望不符，则拒绝并丢弃，绝不把旧几何应用到当前画面/状态。
 */
export class ClipperClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, {
    gen: number;
    fingerprint: string;
    resolve: (v: never) => void;
    reject: (e: Error) => void;
  }>();
  /** 已取消的任务（防止 worker 完成回包在 cancel 消息之前到达）。 */
  private cancelledJobs = new Set<number>();
  private readyResolvers: Array<() => void> = [];
  private ready = false;
  private cache = new Map<string, OffsetResult | BooleanResult>();
  /** 已提交过的最大代次：回包 gen 落后即视为迟到，绝不兑现。 */
  private latestGen = 0;

  constructor(workerFactory?: () => Worker) {
    const factory = workerFactory ?? (() => new Worker(new URL('./clipper.worker.ts', import.meta.url), { type: 'module' }));
    this.worker = factory();
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => this.failAll(ev.message || 'worker error');
  }

  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => this.readyResolvers.push(resolve));
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.type === 'ready') {
      this.ready = true;
      this.readyResolvers.forEach((r) => r());
      this.readyResolvers = [];
      return;
    }
    const job = this.pending.get(msg.jobId);
    if (!job) return; // 已取消或过期
    // 代次/指纹核对：取消、或回包代次落后于已提交的最新代次（用户已继续编辑），
    // 或指纹不符——一律拒绝并丢弃，绝不把旧几何应用到当前状态。
    const staleByGen = msg.gen < this.latestGen;
    if (
      this.cancelledJobs.has(msg.jobId) ||
      job.gen !== msg.gen ||
      job.fingerprint !== msg.fingerprint ||
      staleByGen
    ) {
      this.pending.delete(msg.jobId);
      this.cancelledJobs.delete(msg.jobId);
      job.reject(Object.assign(new Error('结果已过期或任务已取消，已丢弃（未覆盖当前几何）'), { code: 'STALE_RESULT' }));
      return;
    }
    this.pending.delete(msg.jobId);
    if (msg.type === 'error') {
      if (msg.cancelled) job.reject(Object.assign(new Error(msg.message), { code: 'CANCELLED' }));
      else job.reject(Object.assign(new Error(msg.message), { code: msg.code }));
      return;
    }
    if (msg.type === 'offset-result') {
      const out: OffsetResult = { outer: toMm(msg.outer), holes: toMm(msg.holes), ms: msg.ms };
      this.cache.set(msg.fingerprint, out);
      job.resolve(out as never);
    } else if (msg.type === 'boolean-result') {
      const out: BooleanResult = { paths: toMm(msg.paths), ms: msg.ms };
      this.cache.set(msg.fingerprint, out);
      job.resolve(out as never);
    }
  }

  private post(msg: WorkerRequest): void {
    this.worker?.postMessage(msg);
  }

  /** 返回带 jobId 的句柄（调用方可显式取消）；旧 offset() 为其 Promise 快捷形式。 */
  offsetJob(params: OffsetParams): Promise<JobHandle<OffsetResult>> {
    return this.whenReady().then(() => {
      const cached = this.cache.get(params.fingerprint);
      if (cached && 'outer' in cached) {
        return { jobId: -1, promise: Promise.resolve(cached as OffsetResult), cancel: () => {} };
      }
      const jobId = ++this.seq;
      const promise = new Promise<OffsetResult>((resolve, reject) => {
        this.pending.set(jobId, { gen: params.gen, fingerprint: params.fingerprint, resolve: resolve as (v: never) => void, reject });
      });
      this.latestGen = Math.max(this.latestGen, params.gen);
      this.post({
        type: 'offset',
        jobId,
        gen: params.gen,
        fingerprint: params.fingerprint,
        polygons: toInt(params.polygons),
        deltaMm: params.deltaMm,
        join: params.join ?? 'miter',
        miterLimit: params.miterLimit ?? 2.0,
        arcToleranceMm: params.arcToleranceMm ?? 0.02,
      });
      return { jobId, promise, cancel: () => this.cancel(jobId) };
    });
  }

  async offset(params: OffsetParams): Promise<OffsetResult> {
    return (await this.offsetJob(params)).promise;
  }

  async boolean(params: BooleanParams): Promise<BooleanResult> {
    await this.whenReady();
    const cached = this.cache.get(params.fingerprint);
    if (cached && 'paths' in cached) return cached as BooleanResult;
    const jobId = ++this.seq;
    const promise = new Promise<BooleanResult>((resolve, reject) => {
      this.pending.set(jobId, {
        gen: params.gen,
        fingerprint: params.fingerprint,
        resolve: resolve as (v: never) => void,
        reject,
      });
    });
    this.latestGen = Math.max(this.latestGen, params.gen);
    this.post({
      type: 'boolean',
      jobId,
      gen: params.gen,
      fingerprint: params.fingerprint,
      op: params.op,
      subjects: toInt(params.subjects),
      clips: toInt(params.clips),
    });
    return promise;
  }

  cancel(jobId: number): void {
    this.cancelledJobs.add(jobId);
    this.post({ type: 'cancel', jobId });
  }

  private failAll(message: string): void {
    for (const [, job] of this.pending) job.reject(new Error(message));
    this.pending.clear();
  }

  dispose(): void {
    this.post({ type: 'shutdown' });
    this.worker?.terminate();
    this.worker = null;
  }
}
