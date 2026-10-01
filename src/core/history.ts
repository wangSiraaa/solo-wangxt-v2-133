/**
 * 版本栈：纯数据结构，撤销/重做恢复的是整次操作快照。
 * 命令提交时截断 redo 分支；在途 Worker 结果的作废由 gen 防护（store 层），
 * 本结构只保证历史指针语义。
 */
import type { VersionEntry } from './types';

export interface VersionStack {
  versions: VersionEntry[];
  head: number;
}

export function initStack(first: VersionEntry): VersionStack {
  return { versions: [first], head: 0 };
}

/** 提交一条已完成事务的版本；截断当前 head 之后的 redo 分支 */
export function commit(stack: VersionStack, entry: VersionEntry): VersionStack {
  const kept = stack.versions.slice(0, stack.head + 1);
  kept.push(entry);
  return { versions: kept, head: kept.length - 1 };
}

export function canUndo(stack: VersionStack): boolean {
  return stack.head > 0;
}

export function canRedo(stack: VersionStack): boolean {
  return stack.head < stack.versions.length - 1;
}

export function undo(stack: VersionStack): VersionStack {
  if (!canUndo(stack)) return stack;
  return { ...stack, head: stack.head - 1 };
}

export function redo(stack: VersionStack): VersionStack {
  if (!canRedo(stack)) return stack;
  return { ...stack, head: stack.head + 1 };
}

export function current(stack: VersionStack): VersionEntry {
  return stack.versions[stack.head];
}

/** 连续快速撤销 N 步（等价 N 次 undo，不依赖任何异步计算） */
export function undoN(stack: VersionStack, n: number): VersionStack {
  let s = stack;
  for (let i = 0; i < n; i++) s = undo(s);
  return s;
}

/** 裁剪超过 cap 的最老版本（仍从 0 开始时才裁剪，保护可到达链） */
export function prune(stack: VersionStack, cap: number): VersionStack {
  if (stack.versions.length <= cap) return stack;
  const drop = stack.versions.length - cap;
  return {
    versions: stack.versions.slice(drop),
    head: stack.head - drop
  };
}
