import { describe, it, expect } from 'vitest';
import { migrateProject } from '../storage/migrate';
import { transferDart } from '../commands/transferDart';
import { validateProject } from '../geometry/validation';
import { DEFAULT_TOLERANCE } from '../model/types';

describe('旧版工程恢复', () => {
  it('v2 工程迁移后可立即执行转移，且校验通过', () => {
    // 构造一个带腰省的 v2 方形前片
    const P = (id: string, x: number, y: number) => ({ id, pos: { x, y }, kind: 'corner' as const });
    const raw = {
      formatVersion: 2,
      id: 'legacy',
      name: '旧版',
      createdAt: 1,
      updatedAt: 2,
      head: 0,
      readonlyObjects: [],
      migrationLog: [],
      versions: [{
        version: 1,
        parentVersion: null,
        timestamp: 2,
        label: 'v2',
        data: {
          seq: 20,
          points: {
            a: P('a', 0, 0), b: P('b', 40, 0), x: { id: 'x', pos: { x: 100, y: 80 }, kind: 'dartApex' },
            c: P('c', 160, 0), d: P('d', 200, 0), e: P('e', 200, 200), f: P('f', 0, 200),
          },
          edges: {
            ab: { id: 'ab', from: 'a', to: 'b', role: 'seam', curve: 'line' },
            bx: { id: 'bx', from: 'b', to: 'x', role: 'dartLeg', dartId: 'da', curve: 'line' },
            xc: { id: 'xc', from: 'x', to: 'c', role: 'dartLeg', dartId: 'da', curve: 'line' },
            cd: { id: 'cd', from: 'c', to: 'd', role: 'seam', curve: 'line' },
            de: { id: 'de', from: 'd', to: 'e', role: 'seam', curve: 'line' },
            ef: { id: 'ef', from: 'e', to: 'f', role: 'seam', curve: 'line' },
            fa: { id: 'fa', from: 'f', to: 'a', role: 'seam', curve: 'line' },
          },
          notches: { n1: { id: 'n1', edgeId: 'ef', t: 0.5, normal: 1, kind: 'single' } },
          slashes: {},
          darts: { da: { id: 'da', name: '旧省', apex: 'x', legA: 'bx', legB: 'xc' } },
          pieces: {
            pc: {
              id: 'pc', name: '旧片',
              loop: {
                pointIds: ['a', 'b', 'x', 'c', 'd', 'e', 'f'],
                edges: [
                  { edgeId: 'ab', reversed: false },
                  { edgeId: 'bx', reversed: false },
                  { edgeId: 'xc', reversed: false },
                  { edgeId: 'cd', reversed: false },
                  { edgeId: 'de', reversed: false },
                  { edgeId: 'ef', reversed: false },
                  { edgeId: 'fa', reversed: false },
                ],
              },
              dartIds: ['da'], slashIds: [], seamAllowance: 10,
              grainline: { id: 'g', at: { x: 100, y: 100 }, angle: Math.PI / 2, length: 50 },
            },
          },
        },
      }],
    };
    const r = migrateProject(raw);
    expect(r.migrated).toBe(true);
    expect(r.project).toBeTruthy();
    const snap = r.project!.versions[0];
    expect(snap.report.ok).toBe(true);
    // 旧字段已规范化
    const d = snap.data;
    expect(d.darts.da.legIn).toBe('bx');
    expect(d.darts.da.legOut).toBe('xc');
    expect(d.notches.n1.normalSide).toBe(1);
    // 在恢复的工程上直接执行转移（命中底边）
    const tr = transferDart(d, { pieceId: 'pc', dartId: 'da', angle: Math.PI / 2, tolerance: DEFAULT_TOLERANCE });
    expect(validateProject(tr.data, DEFAULT_TOLERANCE).ok).toBe(true);
    expect(tr.data.darts[tr.newDartId].apex).toBe('x');
  });
});
