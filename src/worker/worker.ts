/// <reference lib="webworker" />
/**
 * 几何 Worker：
 * 1) 解析级校验（闭合/退化边/省腿等长/记号朝向）；
 * 2) Clipper 权威校验（自交、缝份外偏、裁剪轮廓分裂）；
 * 3) 冻结派生缓存（屏幕缝合环、裁剪轮廓、记号世界坐标）。
 *
 * 迟到防护：
 * - 维护 activeId；新 compute 到来后旧任务的结果不再回发；
 * - cancel 显式移除；
 * - 回发时再核对一次 activeId（任务完成但期间用户已继续编辑/撤销/取消）。
 */
import {
  derivePiece
} from '../core/derive';
import { seamLoop } from '../core/geometry';
import { validatePiece } from '../core/validate';
import type {
  DegeneracyReason,
  DerivedPiece,
  ProjectData,
  Tolerances,
  ValidationReport,
  Vec2
} from '../core/types';
import { createClipperBackend } from './clipper';
import { createFallbackBackend } from './fallback';
import type {
  BooleanBackend,
  ComputeRequest,
  ComputeResponse,
  WorkerRequest
} from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let backendPromise: Promise<BooleanBackend> | null = null;
let activeId: number | null = null;

async function getBackend(): Promise<BooleanBackend> {
  if (!backendPromise) {
    backendPromise = createClipperBackend().catch((err) => {
      console.warn('[pattern-worker] Clipper2 WASM 不可用，回退纯 TS 后端', err);
      return createFallbackBackend();
    });
  }
  return backendPromise;
}

function computeOne(
  data: ProjectData,
  backend: BooleanBackend
): { report: ValidationReport; derived: DerivedPiece[] } {
  const tol = data.tolerances;
  const reasons: DegeneracyReason[] = [];
  let maxGap = 0;
  let maxLeg = 0;
  const derived: DerivedPiece[] = [];

  for (const piece of data.pieces) {
    // —— 解析层 ——
    const ana = validatePiece(piece, tol);
    reasons.push(...ana.reasons);
    maxGap = Math.max(maxGap, ana.closureGap);
    maxLeg = Math.max(maxLeg, ana.legDelta);

    const loop = seamLoop(piece, tol.tessellation);
    const base = derivePiece(piece, tol);

    // —— Clipper 权威层 ——
    let cutPaths: Vec2[][] = [];
    try {
      if (backend.hasSelfIntersection(loop, tol)) {
        reasons.push({
          code: 'SELF_INTERSECT',
          pieceId: piece.id,
          message: `${piece.name}: Clipper 布尔判定缝合轮廓自交/叠边（非视觉判定）`
        });
      }
      cutPaths = backend.inflateCutline(loop, piece.seamAllowance, tol);
      if (cutPaths.length !== 1) {
        reasons.push({
          code: 'CUT_OFFSET_FAILED',
          pieceId: piece.id,
          message: `${piece.name}: 缝份外偏产生 ${cutPaths.length} 条分离路径（裁剪轮廓分裂/退化）`,
          measured: cutPaths.length,
          limit: 1
        });
      } else if (cutPaths[0].length < 4) {
        reasons.push({
          code: 'CUT_OFFSET_FAILED',
          pieceId: piece.id,
          message: `${piece.name}: 裁剪轮廓点数 ${cutPaths[0].length}，退化`
        });
      }
    } catch (err) {
      reasons.push({
        code: 'CUT_OFFSET_FAILED',
        pieceId: piece.id,
        message: `${piece.name}: 缝份布尔运算失败：${(err as Error).message}`
      });
    }

    derived.push({ ...base, cutPaths });
  }

  const report: ValidationReport = {
    ok: reasons.length === 0,
    checkedAt: Date.now(),
    maxClosureGap: maxGap,
    maxLegDelta: maxLeg,
    reasons,
    tolerances: { ...tol }
  };
  return { report, derived };
}

async function handle(req: ComputeRequest): Promise<void> {
  const started = performance.now();
  try {
    const backend = await getBackend();
    // await 之后先核对：期间有新任务或取消
    if (activeId !== req.requestId) return;
    const { report, derived } = computeOne(req.data, backend);
    if (activeId !== req.requestId) return; // 完成后再核对一次
    const res: ComputeResponse = {
      kind: 'response',
      requestId: req.requestId,
      version: req.version,
      mode: req.mode,
      ok: report.ok,
      report,
      derived,
      backend: backend.name,
      elapsedMs: performance.now() - started
    };
    ctx.postMessage(res);
  } catch (err) {
    if (activeId !== req.requestId) return;
    ctx.postMessage({
      kind: 'error',
      requestId: req.requestId,
      version: req.version,
      mode: req.mode,
      message: (err as Error).message
    });
  }
}

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.kind === 'cancel') {
    if (activeId === msg.requestId) activeId = null;
    return;
  }
  if (msg.kind === 'compute') {
    activeId = msg.requestId; // 旧任务结果即时失效
    void handle(msg);
  }
};
