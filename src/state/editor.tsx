import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  Project,
  ProjectData,
  SelectionState,
  Tolerance,
  ValidationReport,
  VersionSnapshot,
} from '../model/types';
import { DEFAULT_TOLERANCE } from '../model/types';
import { validateProject } from '../geometry/validation';
import { transferDart, isTransferError } from '../commands/transferDart';
import type { TransferOptions, TransferResult } from '../commands/transferDart';
import { reconcileSeq } from '../model/idgen';

export type UnitMode = 'mm' | 'in';

export interface CommitOutcome {
  ok: boolean;
  error?: { code: string; message: string; issues?: import('../model/types').ValidationIssue[] };
  audit?: TransferResult['audit'];
  newDartId?: string;
  slashId?: string;
}

export interface EditorState {
  project: Project;
  head: number;
  canUndo: boolean;
  canRedo: boolean;
  selection: SelectionState | null;
  tolerance: Tolerance;
  unit: UnitMode;
  /** 工程代次：每次提交/撤销/重做/迁移都产生新代次，用于 worker 迟到结果核对。 */
  gen: number;
  busy: boolean;
  lastAudit?: TransferResult['audit'] & { label: string; at: number };
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function snapshotOf(data: ProjectData, parent: number | null, label: string, tol: Tolerance): VersionSnapshot {
  return {
    version: 0,
    parentVersion: parent,
    timestamp: Date.now(),
    label,
    data,
    report: validateProject(data, tol),
  };
}

/**
 * 事务命令 + 版本历史。
 *
 * - 转移在深拷贝上执行；只有全部校验通过才把新快照追加到 versions 并移动 head。
 * - 失败时当前版本不变（事务原子性），错误（含容差/退化原因）回传给 UI。
 * - 撤销/重做按整次操作恢复（每次提交是一个不可分割的版本）。
 * - 重做后又提交新操作会截断 redo 支线。
 * - gen 单调递增，worker 回包按 gen 核对。
 */
export function useEditor(initial: Project) {
  const [project, setProject] = useState<Project>(() => ({ ...initial, head: Math.min(initial.head, initial.versions.length - 1) }));
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [tolerance, setTolerance] = useState<Tolerance>(DEFAULT_TOLERANCE);
  const [unit, setUnit] = useState<UnitMode>('mm');
  const [gen, setGen] = useState(1);
  const [busy, setBusy] = useState(false);
  const [lastAudit, setLastAudit] = useState<EditorState['lastAudit']>();
  const genRef = useRef(gen);
  genRef.current = gen;

  const head = project.head;
  const current: VersionSnapshot = project.versions[head];

  const bumpGen = () => setGen((g) => g + 1);

  const commitSnapshot = useCallback((next: ProjectData, label: string, report?: ValidationReport): { project: Project; head: number; snap: VersionSnapshot } => {
    const parent = project.versions[head].version;
    const snap: VersionSnapshot = {
      version: parent + 1,
      parentVersion: parent,
      timestamp: Date.now(),
      label,
      data: next,
      report: report ?? validateProject(next, tolerance),
    };
    // 截断 redo 支线
    const versions = [...project.versions.slice(0, head + 1), snap];
    const np: Project = { ...project, versions, head: versions.length - 1, updatedAt: snap.timestamp };
    setProject(np);
    bumpGen();
    return { project: np, head: np.head, snap };
  }, [project, head, tolerance]);

  const commitTransfer = useCallback((opts: Omit<TransferOptions, 'tolerance'>): CommitOutcome => {
    const data: ProjectData = current.data;
    let result: TransferResult;
    try {
      result = transferDart(data, { ...opts, tolerance });
    } catch (e) {
      if (isTransferError(e)) {
        return { ok: false, error: { code: e.code, message: e.message, issues: e.issues } };
      }
      throw e;
    }
    reconcileSeq(result.data);
    commitSnapshot(result.data, `省道转移：${opts.dartId} → ${result.hitEdgeId}`, result.report);
    setLastAudit({ ...result.audit, label: '省道转移', at: Date.now() });
    return {
      ok: true,
      audit: result.audit,
      newDartId: result.newDartId,
      slashId: result.slashId,
    };
  }, [commitSnapshot, current.data, tolerance]);

  const undo = useCallback(() => {
    if (head <= 0) return false;
    const p = clone(project);
    p.head = head - 1;
    p.updatedAt = Date.now();
    setProject(p);
    bumpGen();
    return true;
  }, [head, project]);

  const redo = useCallback(() => {
    if (head >= project.versions.length - 1) return false;
    const p = clone(project);
    p.head = head + 1;
    p.updatedAt = Date.now();
    setProject(p);
    bumpGen();
    return true;
  }, [head, project]);

  const jumpToVersion = useCallback((index: number) => {
    if (index < 0 || index >= project.versions.length) return false;
    const p = clone(project);
    p.head = index;
    p.updatedAt = Date.now();
    setProject(p);
    bumpGen();
    return true;
  }, [project]);

  const replaceProject = useCallback((np: Project) => {
    setProject({ ...np, head: Math.min(np.head, np.versions.length - 1) });
    bumpGen();
  }, []);

  const state: EditorState = useMemo(() => ({
    project,
    head,
    canUndo: head > 0,
    canRedo: head < project.versions.length - 1,
    selection,
    tolerance,
    unit,
    gen,
    busy,
    lastAudit,
  }), [project, head, selection, tolerance, unit, gen, busy, lastAudit]);

  return {
    state,
    current,
    data: current.data as ProjectData,
    report: current.report,
    setSelection,
    setTolerance,
    setUnit,
    setBusy,
    commitTransfer,
    commitSnapshot: (d: ProjectData, label: string) => commitSnapshot(d, label),
    undo,
    redo,
    jumpToVersion,
    replaceProject,
  };
}

export type EditorApi = ReturnType<typeof useEditor>;

export { snapshotOf };
