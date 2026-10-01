/**
 * 端到端模拟：在 Node 中直接驱动 worker 的 compute 核心 + Clipper WASM，
 * 验证一次“转移命令 → Worker 权威校验 → 裁剪轮廓产出 → 提交版本”全链路。
 * （浏览器 UI 无法在此环境自动化；这里覆盖 worker 内部纯逻辑 + WASM。）
 */
import { describe, it, expect } from 'vitest';
// @ts-ignore
import Clipper2ZFactory from 'clipper2-wasm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sampleProject } from '../core/sample';
import { pivotTransfer } from '../core/pivot';
import { validateProject } from '../core/validate';
import { seamLoop } from '../core/geometry';
import { derivePiece } from '../core/derive';

const wasmPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/clipper2-wasm/dist/es/clipper2z.wasm'
);

describe('端到端：转移命令经 Clipper 权威校验并产出裁剪轮廓', () => {
  it('完整提交链：解析校验 + UnionSelf + 缝份外偏 + 派生冻结', async () => {
    const mod = await Clipper2ZFactory({ wasmBinary: readFileSync(wasmPath) });
    const SCALE = 10000;

    const project = sampleProject();
    const piece = project.pieces[0];
    const target = piece.edges.find((e) => e.from === 'B2' && e.to === 'RB')!;
    const res = pivotTransfer(piece, {
      dartId: piece.darts[0].id,
      targetEdgeId: target.id,
      targetFraction: 0.5,
      hitRadius: 0
    });

    // 1) 解析校验
    const pre = validateProject([res.piece], project.tolerances);
    expect(pre.ok).toBe(true);

    // 2) Clipper：UnionSelf 判定自交
    const loop = seamLoop(res.piece, project.tolerances.tessellation);
    const subject = new mod.Paths64();
    const p64 = new mod.Path64();
    for (const q of loop)
      p64.push_back(
        new mod.Point64(BigInt(Math.round(q.x * SCALE)), BigInt(Math.round(q.y * SCALE)), 0n)
      );
    subject.push_back(p64);
    const united = mod.UnionSelf64(subject, mod.FillRule.NonZero);
    expect(united.size()).toBe(1);

    // 3) 缝份外偏 → 唯一裁剪轮廓
    const inflated = mod.InflatePaths64(
      subject,
      piece.seamAllowance * SCALE,
      mod.JoinType.Round,
      mod.EndType.Polygon,
      4,
      0.05 * SCALE
    );
    expect(inflated.size()).toBe(1);
    const cut = inflated.get(0);
    expect(cut.size()).toBeGreaterThan(4);

    // 4) 派生冻结（与 worker.computeOne 同源逻辑）
    const derived = derivePiece(res.piece, project.tolerances);
    expect(derived.seamLoop.length).toBe(loop.length);
    expect(derived.resolvedMarks.length).toBe(res.piece.marks.length);
    expect(derived.area).toBeGreaterThan(0);
  });

  it('退化转移（自交制造）会在解析层就失败，不会走到裁剪轮廓', async () => {
    const mod = await Clipper2ZFactory({ wasmBinary: readFileSync(wasmPath) });
    const project = sampleProject();
    const piece = structuredClone(project.pieces[0]);
    // 强制造一个自交：右腰口拖到左下角外侧
    piece.vertices['B2'] = { x: 10, y: 201 };
    const report = validateProject([piece], project.tolerances);
    expect(report.ok).toBe(false);
    expect(report.reasons.some((r) => r.code === 'SELF_INTERSECT')).toBe(true);
    // UnionSelf 同样判为多条
    const loop = seamLoop(piece, 1.5);
    const subj = new mod.Paths64();
    const p = new mod.Path64();
    for (const q of loop)
      p.push_back(new mod.Point64(BigInt(Math.round(q.x * 1e4)), BigInt(Math.round(q.y * 1e4)), 0n));
    subj.push_back(p);
    const united = mod.UnionSelf64(subj, mod.FillRule.NonZero);
    expect(united.size()).not.toBe(1);
  });
});
