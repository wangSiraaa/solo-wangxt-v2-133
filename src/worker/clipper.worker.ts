/// <reference lib="webworker" />
import Clipper2Z from 'clipper2-wasm/dist/es/clipper2z.js';
import wasmUrl from 'clipper2-wasm/dist/es/clipper2z.wasm?url';
import { offsetPolygons, booleanPolygons } from './clipperCore';
import { INTEGER_SCALE } from '../model/types';
import type { Vec } from '../model/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** Worker 边界是 0.01mm 整数；核心层统一用毫米浮点，这里转换。 */
const toMm = (polys: { x: number; y: number }[][]): Vec[][] =>
  polys.map((p) => p.map((q) => ({ x: q.x / INTEGER_SCALE, y: q.y / INTEGER_SCALE })));
const toInt = (polys: Vec[][]) =>
  polys.map((p) => p.map((q) => ({ x: Math.round(q.x * INTEGER_SCALE), y: Math.round(q.y * INTEGER_SCALE) })));

type CModule = Awaited<ReturnType<typeof Clipper2Z>>;
let modulePromise: Promise<CModule> | null = null;
const cancelled = new Set<number>();

function getModule(): Promise<CModule> {
  if (!modulePromise) modulePromise = Clipper2Z({ locateFile: () => wasmUrl });
  return modulePromise!;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.jobId);
    return;
  }
  if (msg.type === 'shutdown') {
    ctx.close();
    return;
  }
  const start = performance.now();
  try {
    const C = await getModule();
    if (cancelled.has(msg.jobId)) {
      cancelled.delete(msg.jobId);
      ctx.postMessage({ type: 'error', jobId: msg.jobId, gen: msg.gen, fingerprint: msg.fingerprint, ms: performance.now() - start, code: 'CANCELLED', cancelled: true, message: '任务已取消' } satisfies WorkerResponse);
      return;
    }
    let res: WorkerResponse;
    if (msg.type === 'offset') {
      const r = offsetPolygons(C, toMm(msg.polygons), msg.deltaMm, msg.join, msg.miterLimit, msg.arcToleranceMm);
      res = { type: 'offset-result', jobId: msg.jobId, gen: msg.gen, fingerprint: msg.fingerprint, ms: r.ms, outer: toInt(r.outer), holes: toInt(r.holes) };
    } else {
      const pathsMm = booleanPolygons(C, msg.op, toMm(msg.subjects), toMm(msg.clips));
      res = { type: 'boolean-result', jobId: msg.jobId, gen: msg.gen, fingerprint: msg.fingerprint, ms: performance.now() - start, paths: toInt(pathsMm) };
    }
    if (cancelled.has(msg.jobId)) {
      cancelled.delete(msg.jobId);
      ctx.postMessage({ type: 'error', jobId: msg.jobId, gen: msg.gen, fingerprint: msg.fingerprint, ms: performance.now() - start, code: 'CANCELLED', cancelled: true, message: '任务已取消' } satisfies WorkerResponse);
      return;
    }
    ctx.postMessage(res);
  } catch (e) {
    ctx.postMessage({
      type: 'error',
      jobId: msg.jobId,
      gen: msg.gen,
      fingerprint: msg.fingerprint,
      ms: performance.now() - start,
      code: 'WORKER_FAILED',
      message: e instanceof Error ? e.message : String(e),
    } satisfies WorkerResponse);
  }
};

void getModule().then(() => ctx.postMessage({ type: 'ready' } as WorkerResponse));
