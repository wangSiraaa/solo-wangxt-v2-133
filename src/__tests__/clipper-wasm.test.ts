/**
 * 以 Node 环境直接实例化 Clipper2 WASM（模拟 worker 的加载路径），
 * 验证 inflate/self-intersection/area 三个关键布尔能力真实可用。
 */
import { describe, it, expect } from 'vitest';
import Clipper2ZFactory from 'clipper2-wasm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const wasmPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/clipper2-wasm/dist/es/clipper2z.wasm'
);

describe('Clipper2 WASM 运行时能力', () => {
  it('加载模块并完成缝份外偏（面积应增大）', async () => {
    const wasmBinary = readFileSync(wasmPath);
    const mod = await Clipper2ZFactory({ wasmBinary });
    expect(typeof mod.InflatePaths64).toBe('function');

    const scale = 10000;
    // 100x100 mm 正方形（CCW in y-up）
    const pts = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100]
    ];
    const subj = new mod.Paths64();
    const p64 = new mod.Path64();
    for (const [x, y] of pts)
      p64.push_back(new mod.Point64(BigInt(x * scale), BigInt(y * scale), 0n));
    subj.push_back(p64);

    const area0 = Number(mod.AreaPath64(p64)) / scale ** 2;
    const inflated = mod.InflatePaths64(
      subj,
      10 * scale,
      mod.JoinType.Round,
      mod.EndType.Polygon,
      4,
      0.05 * scale
    );
    expect(inflated.size()).toBe(1);
    const out = inflated.get(0);
    const area1 = Number(mod.AreaPath64(out)) / scale ** 2;
    expect(area1).toBeGreaterThan(area0);
    // 外偏 10mm（圆接合约 14312mm²，介于方形外偏 14400 与保守界 12100 之间）
    expect(area1).toBeGreaterThan(110 * 110);

    // 自交检测：SimplifyPath64 返回单条 Path64（简化后），
    // worker 以“简化后点数显著塌缩/面积变化”作为叠边信号；自交分裂用 UnionSelf。
    const epsilon = 0.02 * scale;
    const simplified = mod.SimplifyPath64(p64, epsilon, true);
    expect(simplified.size()).toBeGreaterThanOrEqual(4); // 未塌缩
    const simpArea = Number(mod.AreaPath64(simplified)) / scale ** 2;
    expect(Math.abs(simpArea - area0)).toBeLessThan(1);

    // UnionSelf：自交轮廓会被拆成多条；正常正方形仍是 1 条
    const united = mod.UnionSelf64(subj, mod.FillRule.NonZero);
    expect(united.size()).toBe(1);
  });
});
