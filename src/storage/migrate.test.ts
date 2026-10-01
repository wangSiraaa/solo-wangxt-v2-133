import { describe, it, expect } from 'vitest';
import { migrateProject } from './migrate';

describe('显式格式迁移', () => {
  it('v1 → v3：顶点/线段/曲边/省/记号迁移成功', () => {
    const v1 = {
      formatVersion: 1,
      id: 'old1',
      name: 'v1工程',
      updatedAt: 1000,
      pieces: [
        {
          id: 'pcA',
          name: 'A',
          sa: 12,
          vertices: [
            { id: 'a', x: 0, y: 0 },
            { id: 'b', x: 100, y: 0 },
            { id: 'c', x: 100, y: 100 },
            { id: 'd', x: 0, y: 100 },
          ],
          segments: [
            { id: 's1', a: 'a', b: 'b' },
            { id: 's2', a: 'b', b: 'c', ctrl: { c1x: 110, c1y: 30, c2x: 110, c2y: 70 } },
            { id: 's3', a: 'c', b: 'd' },
            { id: 's4', a: 'd', b: 'a' },
          ],
          outline: ['s1', 's2', 's3', 's4'],
          notches: [{ id: 'n1', seg: 's1', u: 0.3, dir: 'out' }],
          darts: [],
        },
      ],
    };
    const r = migrateProject(v1);
    expect(r.migrated).toBe(true);
    expect(r.project).toBeTruthy();
    expect(r.project!.formatVersion).toBe(3);
    const d = r.project!.versions[0].data;
    expect(Object.keys(d.points)).toHaveLength(4);
    const s2 = d.edges.s2;
    expect(s2.curve).toBe('cubic');
    if (s2.curve === 'cubic') expect(s2.c1).toEqual({ x: 110, y: 30 });
    expect(d.notches.n1.normalSide).toBe(1);
    expect(d.pieces.pcA.seamAllowance).toBe(12);
  });

  it('v2 → v3：normal/legA/legB 字段规范化', () => {
    const project = {
      formatVersion: 2,
      id: 'p2',
      name: 'v2',
      createdAt: 1,
      updatedAt: 2,
      head: 0,
      readonlyObjects: [],
      migrationLog: [],
      versions: [
        {
          version: 1,
          parentVersion: null,
          timestamp: 2,
          label: 'x',
          data: {
            seq: 9,
            points: {
              a: { id: 'a', pos: { x: 0, y: 0 }, kind: 'corner' },
              b: { id: 'b', pos: { x: 10, y: 0 }, kind: 'dartMouth' },
              x: { id: 'x', pos: { x: 5, y: 10 }, kind: 'dartApex' },
            },
            edges: {
              la: { id: 'la', from: 'a', to: 'x', role: 'dartLeg', curve: 'line' },
              lb: { id: 'lb', from: 'x', to: 'b', role: 'dartLeg', curve: 'line' },
            },
            notches: { n: { id: 'n', edgeId: 'la', t: 0, normal: -1, kind: 'single' } },
            slashes: { s: { id: 's', apexId: 'x', edgeId: 'la', t: 0, hitPoint: 'a', angle: 0 } },
            darts: { da: { id: 'da', name: 'd', apex: 'x', legA: 'la', legB: 'lb' } },
            pieces: {},
          },
        },
      ],
    };
    const r = migrateProject(project);
    expect(r.migrated).toBe(true);
    const d = r.project!.versions[0].data;
    expect(d.notches.n.normalSide).toBe(-1);
    expect((d.notches.n as unknown as { normal?: number }).normal).toBeUndefined();
    expect(d.darts.da.legIn).toBe('la');
    expect(d.darts.da.legOut).toBe('lb');
    expect(d.slashes.s.pointId).toBe('a');
  });

  it('无法迁移的对象保留为只读副本，工程整体不丢失', () => {
    const v1 = {
      formatVersion: 1,
      id: 'bad',
      name: 'bad',
      pieces: [
        {
          id: 'pc',
          vertices: [{ id: 'a', x: 0, y: 0 }],
          segments: [{ id: 's1', a: 'a', b: 'missing' }],
          outline: ['s1'],
          notches: [{ id: 'n1', seg: 'ghost', u: 0.5 }],
        },
      ],
    };
    const r = migrateProject(v1);
    expect(r.project).toBeTruthy();
    expect(r.readonlyObjects.length).toBeGreaterThanOrEqual(2);
    expect(r.readonlyObjects.every((ro) => ro.raw !== undefined)).toBe(true);
  });

  it('未知格式版本返回 fatal，不构造工程', () => {
    const r = migrateProject({ formatVersion: 99, id: 'x' });
    expect(r.project).toBeNull();
    expect(r.fatal).toContain('v99');
  });
});
