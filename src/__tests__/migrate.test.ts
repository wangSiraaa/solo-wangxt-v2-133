/**
 * 场景5：旧版工程显式迁移 + 无法迁移对象只读隔离。
 */
import { describe, it, expect } from 'vitest';
import { migrate, MigrationError, type LegacyV1Project } from '../core/migrate';
import { validateProject } from '../core/validate';
import { edgeLength } from '../core/geometry';
import { DEFAULT_TOLERANCES } from '../core/types';

const v1: LegacyV1Project = {
  formatVersion: 1,
  name: '旧版裙片',
  unit: 'mm',
  blocks: [
    {
      id: 'skirt',
      name: '旧裙片',
      seamAllowance: 10,
      pts: [
        [0, 0],    // 0 B1（左腰口）
        [60, 70],  // 1 P（省尖）
        [120, 0],  // 2 B2（右腰口）
        [120, 200],// 3 RB
        [0, 200]   // 4 LB
      ],
      // 缝合环：B1 -> B2 这条在 v1 中展开为“经省尖”：用省描述，outline 走外口
      outline: [0, 2, 3, 4],
      darts: [{ id: 'olddart', apex: 1, leg1: 0, leg2: 2 }],
      notches: [{ id: 'n1', at: 3, dir: 0 }] // 点3在右边，刃口朝片内（+x）
    }
  ]
};

describe('场景5：v1 → v2 显式迁移', () => {
  it('把索引轮廓 + 独立省道重写为有序缝合环，且迁移结果可通过校验', () => {
    const result = migrate(v1);
    expect(result.sourceFormatVersion).toBe(1);
    expect(result.data.formatVersion).toBe(2);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.quarantine).toHaveLength(0);

    const piece = result.data.pieces[0];
    expect(piece).toBeTruthy();
    // 环里应包含两条省腿，共尖于同一 apex
    const dart = piece.darts[0];
    expect(dart).toBeTruthy();
    const leg1 = piece.edges.find((e) => e.id === dart.leg1)!;
    const leg2 = piece.edges.find((e) => e.id === dart.leg2)!;
    expect(leg1.to).toBe(dart.apex);
    expect(leg2.from).toBe(dart.apex);
    expect(leg1.kind).toBe('dartLeg');
    // 两腿等长（迁移构造必须保留可缝性）
    expect(Math.abs(edgeLength(leg1, piece.vertices) - edgeLength(leg2, piece.vertices))).toBeLessThan(
      DEFAULT_TOLERANCES.legLength
    );
    // 拓扑闭合
    for (let i = 0; i < piece.edges.length; i++) {
      expect(piece.edges[i].to).toBe(piece.edges[(i + 1) % piece.edges.length].from);
    }
    const report = validateProject(result.data.pieces, result.data.tolerances);
    expect(report.ok, report.reasons.map((r) => r.message).join(';')).toBe(true);
    // 剪口从点索引迁到稳定顶点身份
    expect(piece.marks[0].vertexId).toBeTruthy();
  });

  it('无法迁移的对象（outline 越界、notch 越界、extras）进入只读隔离区，不静默丢弃', () => {
    const bad: LegacyV1Project = {
      formatVersion: 1,
      blocks: [
        {
          id: 'broken',
          pts: [[0, 0], [10, 0], [10, 10]],
          outline: [0, 9, 2], // 9 越界 → 整块隔离
          extras: [{ mystery: true }]
        },
        {
          id: 'okblock',
          pts: [[0, 0], [10, 0], [10, 10], [0, 10]],
          outline: [0, 1, 2, 3],
          notches: [{ id: 'badnotch', at: 99 }] // 越界剪口隔离
        }
      ]
    };
    const result = migrate(bad);
    expect(result.data.pieces.find((p) => p.id === 'broken')).toBeUndefined();
    expect(result.data.pieces.find((p) => p.id === 'okblock')).toBeTruthy();
    expect(result.quarantine.length).toBeGreaterThanOrEqual(2);
    // 隔离区保留原始副本
    const raw = JSON.stringify(result.quarantine);
    expect(raw).toContain('mystery');
    expect(raw).toContain('badnotch');
  });

  it('未知格式版本抛 MigrationError，不强行导入', () => {
    expect(() => migrate({ formatVersion: 99 })).toThrow(MigrationError);
    expect(() => migrate({ formatVersion: 99 })).toThrow(/未知格式版本/);
  });

  it('隔离对象不参与几何运算：迁移后派生只来自成功的 pieces', () => {
    const result = migrate({
      formatVersion: 1,
      blocks: [
        { id: 'x', pts: 'garbage' as unknown as number[][], outline: [0] },
        { id: 'good', pts: [[0, 0], [20, 0], [20, 20], [0, 20]], outline: [0, 1, 2, 3] }
      ]
    } as unknown as LegacyV1Project);
    expect(result.data.pieces).toHaveLength(1);
    expect(result.quarantine.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result.quarantine.map((q) => q.raw))).toContain('garbage');
  });
});
