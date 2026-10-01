/**
 * 场景4：连续快速撤销/重做按整次操作恢复；
 * Worker 代次防护：迟到结果不得覆盖新几何（纯逻辑模拟）。
 */
import { describe, it, expect } from 'vitest';
import {
  initStack,
  commit,
  undo,
  redo,
  undoN,
  canUndo,
  canRedo,
  current,
  prune
} from '../core/history';
import { sampleProject } from '../core/sample';
import { pivotTransfer } from '../core/pivot';
import { deriveAll } from '../core/derive';
import { validateProject } from '../core/validate';
import type { ProjectData, ValidationReport, VersionEntry } from '../core/types';

function entry(data: ProjectData, version: number, label: string): VersionEntry {
  const report: ValidationReport = validateProject(data.pieces, data.tolerances);
  return { version, committedAt: version, label, data, report, derived: deriveAll(data) };
}

function buildChain(): { stack: ReturnType<typeof initStack>; labels: string[] } {
  let data = sampleProject();
  let stack = initStack(entry(data, 1, '初始'));
  const labels = ['初始'];
  // 在第 1 个裁片上连续做 3 次转移（每次目标边取当前一条外边）
  for (let k = 0; k < 3; k++) {
    const piece = data.pieces[0];
    const dart = piece.darts[0];
    const target = piece.edges.find(
      (e) => e.kind === 'outer' && e.from !== piece.edges[0].from
    )!;
    const res = pivotTransfer(piece, {
      dartId: dart.id,
      targetEdgeId: target.id,
      targetFraction: 0.3 + 0.1 * k,
      hitRadius: 0
    });
    data = { ...data, pieces: data.pieces.map((p) => (p.id === piece.id ? res.piece : p)) };
    stack = commit(stack, entry(data, k + 2, `转移${k + 1}`));
    labels.push(`转移${k + 1}`);
  }
  return { stack, labels };
}

describe('场景4：撤销/重做按整次操作快照', () => {
  it('连续快速撤销 3 步精确回到初始版本，再重做到头', () => {
    const { stack, labels } = buildChain();
    expect(stack.versions).toHaveLength(4);
    expect(current(stack).label).toBe(labels[3]);

    // 快速连续撤销（无任何等待）
    const back = undoN(stack, 3);
    expect(back.head).toBe(0);
    expect(current(back).version).toBe(1);
    expect(current(back).label).toBe('初始');
    expect(canUndo(back)).toBe(false);

    // 快照恢复：数据对象与当时完全一致（按 version 与几何坐标）
    const restored = current(back).data;
    const fresh = sampleProject();
    expect(JSON.stringify(restored.pieces[0].vertices)).toBe(
      JSON.stringify(fresh.pieces[0].vertices)
    );

    // 重做
    let f = back;
    f = redo(f);
    expect(current(f).label).toBe('转移1');
    f = redo(f);
    expect(current(f).label).toBe('转移2');
    f = redo(f);
    expect(current(f).label).toBe('转移3');
    expect(canRedo(f)).toBe(false);
  });

  it('撤销后提交新命令会截断旧 redo 分支', () => {
    const { stack } = buildChain();
    let s = undoN(stack, 2); // 回到 转移1
    expect(current(s).version).toBe(2);
    // 提交一个新版本（从 v2 分叉）
    const data = structuredClone(current(s).data);
    s = commit(s, entry(data, 99, '分叉'));
    expect(s.versions).toHaveLength(3); // v1,v2,分叉
    expect(canRedo(s)).toBe(false);
    expect(current(s).label).toBe('分叉');
  });

  it('undo/redo 在边界处幂等不越界', () => {
    const { stack } = buildChain();
    const bottom = undoN(stack, 10);
    expect(bottom.head).toBe(0);
    const top = (() => {
      let x = bottom;
      for (let i = 0; i < 10; i++) x = redo(x);
      return x;
    })();
    expect(top.head).toBe(top.versions.length - 1);
  });

  it('版本裁剪不破坏当前可达性', () => {
    const { stack } = buildChain();
    const p = prune(stack, 2);
    expect(p.versions).toHaveLength(2);
    expect(p.head).toBe(stack.head - 2);
    expect(current(p).label).toBe('转移3');
  });
});

/**
 * Worker 代次防护的纯逻辑模型：
 * store 只在 (requestId 仍等待) 且 (响应代次 === 当前 gen) 时接受结果。
 */
interface GenState {
  gen: number;
  waiting: number | null;
  appliedVersion: number;
  log: string[];
}
function dispatch(s: GenState, reqId: number, gen: number): void {
  s.gen = gen;
  s.waiting = reqId;
  s.log.push(`dispatch#${reqId}@${gen}`);
}
function receive(s: GenState, reqId: number, gen: number, version: number): void {
  if (s.waiting !== reqId || s.gen !== gen) {
    s.log.push(`drop#${reqId}@${gen}（迟到）`);
    return;
  }
  s.appliedVersion = version;
  s.waiting = null;
  s.log.push(`apply#${reqId}@${gen}->v${version}`);
}
function editDuringCompute(s: GenState): void {
  s.gen += 1; // 用户继续编辑 → 代次前进
}
function cancel(s: GenState): void {
  s.waiting = null;
  s.gen += 1;
}

describe('Worker 代次防护：迟到结果不得覆盖新几何', () => {
  it('计算期间继续编辑：旧结果被丢弃，新几何不被覆盖', () => {
    const s: GenState = { gen: 1, waiting: null, appliedVersion: 1, log: [] };
    dispatch(s, 10, 2); // 发起 v2 校验
    editDuringCompute(s); // 用户继续编辑（例如快速撤销）-> gen=3
    receive(s, 10, 2, 2); // 旧结果迟到
    expect(s.log).toContain('drop#10@2（迟到）');
    expect(s.appliedVersion).toBe(1); // 未被覆盖
  });

  it('取消任务后到达的结果被丢弃', () => {
    const s: GenState = { gen: 5, waiting: null, appliedVersion: 3, log: [] };
    dispatch(s, 20, 6);
    cancel(s);
    receive(s, 20, 6, 4);
    expect(s.appliedVersion).toBe(3);
    expect(s.log.some((l) => l.startsWith('drop'))).toBe(true);
  });

  it('匹配 requestId 且代次一致时才提交并递增已应用版本', () => {
    const s: GenState = { gen: 8, waiting: null, appliedVersion: 7, log: [] };
    dispatch(s, 30, 9);
    receive(s, 30, 9, 8);
    expect(s.appliedVersion).toBe(8);
    // 再次收到重复响应（理论上 worker 不会发，但逻辑必须幂等丢弃）
    receive(s, 30, 9, 8);
    expect(s.log.filter((l) => l.startsWith('apply')).length).toBe(1);
  });

  it('连续快速撤销使多个在途结果接连作废，只接受最后一次匹配', () => {
    const s: GenState = { gen: 1, waiting: null, appliedVersion: 1, log: [] };
    dispatch(s, 1, 2);
    editDuringCompute(s); // gen 3
    dispatch(s, 2, 4); // 新任务（实际 store 禁止并发，这里仅验证代次比较）
    receive(s, 1, 2, 2); // 第一个迟到
    expect(s.appliedVersion).toBe(1);
    cancel(s); // gen 5, waiting null
    receive(s, 2, 4, 3); // 第二个在取消后到达
    expect(s.appliedVersion).toBe(1);
  });
});
