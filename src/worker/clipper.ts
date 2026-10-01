/**
 * Clipper2 WASM 后端。
 * - wasm 通过 Vite 的 ?url 作为资源发出，locateFile 显式定位，不依赖脚本目录猜测；
 * - 坐标 1e4 缩放（0.0001mm 分辨率），64 位整数路径；
 * - 缝份 = InflatePaths64（RoundJoin + Polygon 闭合）；
 * - 权威自交：SimplifyPath64 去自交后面积必须与原面积一致，否则判自交；
 * - 同时用 UnionSelf 检测自交轮廓是否会分裂。
 */
import type { BooleanBackend } from './protocol';
import { CLIPPER_SCALE } from './protocol';
import type { Tolerances, Vec2 } from '../core/types';
import Clipper2ZFactory from 'clipper2-wasm';
import wasmUrl from 'clipper2-wasm/dist/es/clipper2z.wasm?url';

type ClipperModule = Awaited<ReturnType<typeof Clipper2ZFactory>>;

let modulePromise: Promise<ClipperModule> | null = null;

export function loadClipper(): Promise<ClipperModule> {
  if (!modulePromise) {
    modulePromise = Clipper2ZFactory({
      locateFile: (path: string) => {
        if (path.endsWith('.wasm')) return wasmUrl;
        return path;
      }
    });
  }
  return modulePromise;
}

function toPath64(
  mod: ClipperModule,
  pts: Vec2[],
  scale: number
): InstanceType<ClipperModule['Path64']> {
  const p = new mod.Path64();
  for (const q of pts) {
    p.push_back(
      new mod.Point64(
        BigInt(Math.round(q.x * scale)),
        BigInt(Math.round(q.y * scale)),
        0n
      )
    );
  }
  return p;
}

function paths64ToArrays(mod: ClipperModule, paths: unknown): Vec2[][] {
  const out: Vec2[][] = [];
  const ps = paths as InstanceType<ClipperModule['Paths64']>;
  for (let i = 0; i < ps.size(); i++) {
    const p = ps.get(i);
    const ring: Vec2[] = [];
    for (let j = 0; j < p.size(); j++) {
      const q = p.get(j);
      ring.push({ x: Number(q.x) / CLIPPER_SCALE, y: Number(q.y) / CLIPPER_SCALE });
    }
    out.push(ring);
  }
  return out;
}

export async function createClipperBackend(): Promise<BooleanBackend> {
  const mod = await loadClipper();

  return {
    name: 'clipper2-wasm',

    inflateCutline(loop, seamAllowance) {
      const subject = new mod.Paths64();
      subject.push_back(toPath64(mod, loop, CLIPPER_SCALE));
      // 外偏：圆弧接合 + 多边形闭合端；miterLimit 4，arcTolerance 0.05mm
      const inflated = mod.InflatePaths64(
        subject,
        seamAllowance * CLIPPER_SCALE,
        mod.JoinType.Round,
        mod.EndType.Polygon,
        4,
        0.05 * CLIPPER_SCALE
      );
      const result = paths64ToArrays(mod, inflated);
      subject.delete();
      inflated.delete();
      if (result.length === 0) throw new Error('Clipper 外偏返回空路径（退化）');
      return result;
    },

    hasSelfIntersection(loop, tol: Tolerances) {
      const subject = new mod.Paths64();
      subject.push_back(toPath64(mod, loop, CLIPPER_SCALE));
      const origArea = Math.abs(
        Number(mod.AreaPaths64(subject)) / CLIPPER_SCALE ** 2
      );
      // UnionSelf 是自交权威判定：简单轮廓 → 1 条路径；自交/叠边会分裂为多条，
      // 或面积发生变化。epsilon 以容差缩放。
      const united = mod.UnionSelf64(subject, mod.FillRule.NonZero);
      let unionArea = 0;
      for (let i = 0; i < united.size(); i++) {
        unionArea += Math.abs(Number(mod.AreaPath64(united.get(i))));
      }
      unionArea /= CLIPPER_SCALE ** 2;
      const tolArea =
        tol.selfIntersect * Math.max(1, Math.sqrt(origArea)) * 10; // 面积容差随尺度
      const selfX = united.size() !== 1 || Math.abs(unionArea - origArea) > tolArea;
      subject.delete();
      united.delete();
      return selfX;
    },

    signedArea(loop) {
      const path = toPath64(mod, loop, CLIPPER_SCALE);
      const a = Number(mod.AreaPath64(path)) / (CLIPPER_SCALE * CLIPPER_SCALE);
      path.delete();
      return a;
    }
  };
}
