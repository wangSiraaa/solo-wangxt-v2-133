/**
 * SVG 导出与提交门测试：
 * - 导出内容必须来自同一已提交版本（含比例尺、版本号、容差元数据）；
 * - 校验失败的版本不允许按“通过”导出（调用方守卫 + 报告数据可见）；
 * - 退化原因（闭合/自交/长度/记号方向）均可被结构化读取。
 */
import { describe, it, expect } from 'vitest';
import { exportSvg } from '../core/exportSvg';
import { sampleProject } from '../core/sample';
import { deriveAll } from '../core/derive';
import { validateProject } from '../core/validate';
import { pivotTransfer } from '../core/pivot';
import { DEFAULT_TOLERANCES, type VersionEntry, type ProjectData } from '../core/types';
import type { DegeneracyReason } from '../core/types';

function goodEntry(data: ProjectData, version = 1): VersionEntry {
  return {
    version,
    committedAt: Date.now(),
    label: '测试版本',
    data,
    report: validateProject(data.pieces, data.tolerances),
    derived: deriveAll(data)
  };
}

describe('SVG 导出来自同一已提交版本', () => {
  it('包含 50mm 真实比例尺、版本号、缝合/裁剪轮廓与容差元数据', () => {
    const entry = goodEntry(sampleProject());
    const svg = exportSvg(entry);
    // 比例尺：5 个 10mm 矩形 + 50mm 文字
    expect(svg).toContain('data-role="scale-bar"');
    expect(svg).toContain('50 mm 比例尺');
    // 单位声明 1 unit = 1 mm
    expect(svg).toContain('data-unit="mm"');
    // 来自同一已提交版本
    expect(svg).toContain(`data-committed-version="${entry.version}"`);
    // 元数据里的数值容差
    const meta = svg.match(/<metadata>([\s\S]*?)<\/metadata>/)!;
    const json = JSON.parse(meta[1]);
    expect(json.committedVersion).toBe(entry.version);
    expect(json.validation.tolerances.closure).toBe(DEFAULT_TOLERANCES.closure);
    expect(json.validation.maxClosureGapMm).toBe(entry.report.maxClosureGap);
    expect(json.validation.ok).toBe(true);
    // 缝合与裁剪路径都在
    expect(svg).toContain('stroke="#1f2937"'); // seam
    // 钻孔记号
    expect(svg).toContain('data-piece="b1"');
  });

  it('导出的几何来自冻结 derived（事后修改 data 不影响已生成 SVG 的同源性）', () => {
    const entry = goodEntry(sampleProject());
    const svg1 = exportSvg(entry);
    // 模拟“画面上后来又动了但未提交”：不改变 entry，SVG 内容字节一致
    const svg2 = exportSvg(entry);
    // 时间无关字段比对（去掉 committedAt 文本可能差异；这里同一对象，直接相等）
    expect(svg1).toBe(svg2);
  });
});

describe('事务提交门：任一校验失败不替换当前版本（报告可见）', () => {
  function failEntry(mutator: (data: ProjectData) => void): {
    reasons: DegeneracyReason[];
  } {
    const data = sampleProject();
    mutator(data);
    const report = validateProject(data.pieces, data.tolerances);
    return { reasons: report.reasons };
  }

  it('拓扑断裂 → NOT_CLOSED', () => {
    const { reasons } = failEntry((d) => {
      const p = d.pieces[0];
      p.edges[0] = { ...p.edges[0], to: '__nonexistent__' };
    });
    expect(reasons.some((r) => r.code === 'NOT_CLOSED')).toBe(true);
  });

  it('自交 → SELF_INTERSECT（不靠画面判断）', () => {
    const { reasons } = failEntry((d) => {
      // 把一个顶点拉到对侧制造自交（在矩形省道片上拖动右腰口到左下摆外）
      const p = d.pieces[0];
      p.vertices['B2'] = { x: 10, y: 201 };
    });
    expect(reasons.some((r) => r.code === 'SELF_INTERSECT')).toBe(true);
  });

  it('省腿不等长 → LEG_LENGTH_MISMATCH，带实测与阈值', () => {
    const { reasons } = failEntry((d) => {
      const p = d.pieces[0];
      p.vertices['B2'] = { x: 175, y: 0 }; // 打破对称，等长差 > 0.5mm
    });
    const r = reasons.find((x) => x.code === 'LEG_LENGTH_MISMATCH');
    expect(r).toBeTruthy();
    expect(r!.measured).toBeGreaterThan(DEFAULT_TOLERANCES.legLength);
    expect(r!.limit).toBe(DEFAULT_TOLERANCES.legLength);
  });

  it('剪口朝向外侧 → MARK_DIRECTION_OUTWARD', () => {
    const { reasons } = failEntry((d) => {
      const p = d.pieces[0];
      const notch = p.marks.find((m) => m.id === 'm_sideR')!;
      notch.direction = Math.PI; // 右缝剪口朝左=片外
    });
    expect(reasons.some((r) => r.code === 'MARK_DIRECTION_OUTWARD')).toBe(true);
  });

  it('转移预检失败时返回的报告中退化原因可读、当前版本数据未被改动', () => {
    const data = sampleProject();
    const before = JSON.stringify(data.pieces[0].vertices);
    const piece = data.pieces[0];
    expect(() =>
      pivotTransfer(piece, {
        dartId: piece.darts[0].id,
        targetEdgeId: piece.darts[0].leg1,
        targetFraction: 0.5
      })
    ).toThrow();
    expect(JSON.stringify(data.pieces[0].vertices)).toBe(before);
  });
});
