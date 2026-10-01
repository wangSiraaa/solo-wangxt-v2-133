/**
 * 命令与选择状态（React + TS）。
 *
 * 事务语义：
 * - 一次省道转移 = 一条命令。先解析预检（同步，立刻给反馈），再提交 Worker 做
 *   Clipper 权威布尔校验；任一闭合/自交/长度/记号方向失败都不产生新版本；
 * - 撤销/重做恢复的是整次操作的完整快照（VersionEntry）；
 * - 连续快速撤销：每次撤销只是指针移动 + gen++ 使在途 Worker 结果作废，
 *   不等待计算；
 * - Worker 返回时核对 requestId 与工程代次（gen），计算期间继续编辑或取消后，
 *   迟到结果不得覆盖新几何。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type { ReactNode } from 'react';
import type {
  DerivedPiece,
  Piece,
  ProjectData,
  Selection,
  Tolerances,
  ValidationReport,
  Vec2,
  VersionEntry
} from '../core/types';
import { deriveAll } from '../core/derive';
import { pivotTransfer, TransferError } from '../core/pivot';
import type { PivotParams } from '../core/pivot';
import { validateProject } from '../core/validate';
import { sampleProject } from '../core/sample';
import type {
  ComputeResponse,
  WorkerRequest,
  WorkerResponse
} from '../worker/protocol';
import type { QuarantinedObject } from '../core/migrate';
import * as db from './db';

export type { Selection };

export interface PendingJob {
  requestId: number;
  gen: number;
  label: string;
  startedAt: number;
  mode: 'commit' | 'refresh';
}

export interface Notice {
  level: 'info' | 'error' | 'warn';
  text: string;
  at: number;
}

interface StoreState {
  meta: { id: string; name: string; createdAt: number; updatedAt: number };
  versions: VersionEntry[];
  headIndex: number;
  /** 每次提交/撤销/重做/取消都递增：Worker 代次核对依据 */
  gen: number;
  selection: Selection;
  unit: 'mm' | 'in';
  pending: PendingJob | null;
  backend: 'clipper2-wasm' | 'fallback-ts' | 'pending';
  notices: Notice[];
  dirty: boolean;
  quarantine: QuarantinedObject[];
  migrationSteps: string[];
  migratedFrom?: number;
}

interface StoreApi extends StoreState {
  current: VersionEntry;
  projectData: ProjectData;
  derived: DerivedPiece[];
  report: ValidationReport;
  selectedPiece: Piece | null;
  // 命令
  requestTransfer: (pieceId: string, params: PivotParams) => void;
  commitMoveVertex: (pieceId: string, vertexId: string, pos: Vec2) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  cancelPending: () => void;
  // 编辑
  setSelection: (s: Selection) => void;
  setUnit: (u: 'mm' | 'in') => void;
  updateTolerances: (t: Tolerances) => void;
  loadData: (
    data: ProjectData,
    info: { name?: string; quarantine?: QuarantinedObject[]; steps?: string[]; migratedFrom?: number }
  ) => void;
  newProject: () => void;
  save: () => Promise<void>;
  persistNow: boolean;
  dismissNotice: (at: number) => void;
}

const Ctx = createContext<StoreApi | null>(null);

function makeInitialEntry(data: ProjectData, label: string, version = 1): VersionEntry {
  const derived = deriveAll(data);
  return {
    version,
    committedAt: Date.now(),
    label,
    data,
    report: validateProject(data.pieces, data.tolerances),
    derived
  };
}

function freshState(): StoreState {
  const data = sampleProject();
  const entry = makeInitialEntry(data, '初始版本');
  return {
    meta: {
      id: `proj_${Date.now().toString(36)}`,
      name: '未命名工程',
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    versions: [entry],
    headIndex: 0,
    gen: 1,
    selection: null,
    unit: data.unit,
    pending: null,
    backend: 'pending',
    notices: [],
    dirty: false,
    quarantine: [],
    migrationSteps: []
  };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState>(freshState);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(1);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Worker 初始化（vite 原生 ESM worker）
  useEffect(() => {
    const worker = new Worker(new URL('../worker/worker.ts', import.meta.url), {
      type: 'module'
    });
    workerRef.current = worker;
    const onMsg = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const s = stateRef.current;
      // —— 代次 + requestId 双重核对：迟到结果一律丢弃 ——
      const pending = s.pending;
      if (!pending || pending.requestId !== msg.requestId || pending.gen !== s.gen) {
        // 迟到（用户继续编辑/撤销/取消）：明确忽略，绝不覆盖新几何
        return;
      }
      if (msg.kind === 'error') {
        setState((p) => ({
          ...p,
          pending: null,
          gen: p.gen + 1,
          backend: 'pending',
          notices: [
            ...p.notices,
            { level: 'error', text: `Worker 失败：${msg.message}（当前版本未替换）`, at: Date.now() }
          ]
        }));
        return;
      }
      applyWorkerResponse(msg);
    };
    worker.onmessage = onMsg;
    return () => worker.terminate();
  }, []);

  const postToWorker = useCallback((req: WorkerRequest) => {
    workerRef.current?.postMessage(req);
  }, []);

  const dispatchCompute = useCallback(
    (nextData: ProjectData, label: string, mode: 'commit' | 'refresh' = 'commit'): { id: number; gen: number } | null => {
      const s = stateRef.current;
      if (s.pending) return null;
      const id = reqIdRef.current++;
      const gen = s.gen + 1;
      const pending: PendingJob = { requestId: id, gen, label, startedAt: Date.now(), mode };
      pendingDataRef.current.set(id, { data: nextData, mode });
      setState((p) => ({ ...p, pending, gen }));
      postToWorker({ kind: 'compute', requestId: id, version: gen, data: nextData, mode });
      return { id, gen };
    },
    [postToWorker]
  );

  /** 只重算当前版本派生（缝份/裁剪轮廓），不产生新事务版本 */
  const requestRefresh = useCallback(() => {
    const s = stateRef.current;
    if (s.pending) return;
    const entry = s.versions[s.headIndex];
    dispatchCompute(entry.data, '刷新派生', 'refresh');
  }, [dispatchCompute]);

  // 挂载后用 Worker 计算初始版本派生（填充缝份/裁剪轮廓与后端标识）
  const [refreshNonce, setRefreshNonce] = useState(0);
  useEffect(() => {
    if (refreshNonce > 0) requestRefresh();
  }, [refreshNonce, requestRefresh]);
  useEffect(() => {
    requestRefresh();
  }, [requestRefresh]);

  const applyWorkerResponse = useCallback((msg: ComputeResponse) => {
    setState((p) => {
      if (!p.pending || p.pending.requestId !== msg.requestId || p.pending.gen !== p.gen)
        return p;
      if (!msg.ok) {
        // 任一校验失败：不替换当前版本
        return {
          ...p,
          pending: null,
          gen: p.gen + 1,
          backend: msg.backend,
          dirty: false,
          notices: [
            ...p.notices,
            {
              level: 'error',
              text: `「${p.pending.label}」校验失败，当前版本未替换：${msg.report.reasons.length} 项退化原因`,
              at: Date.now()
            }
          ]
        };
      }
      const current = p.versions[p.headIndex];
      const payload = pendingDataRef.current.get(msg.requestId);
      const mode = msg.mode;
      if (mode === 'refresh') {
        // 只刷新当前版本的派生/报告与后端，不产生新版本（初始打开、导入后）
        pendingDataRef.current.delete(msg.requestId);
        const refreshed: VersionEntry = {
          ...current,
          data: payload?.data ?? current.data,
          report: msg.report,
          derived: msg.derived
        };
        const versions = p.versions.slice();
        versions[p.headIndex] = refreshed;
        return {
          ...p,
          versions,
          pending: null,
          gen: p.gen + 1,
          backend: msg.backend,
          notices: [
            ...p.notices,
            {
              level: msg.ok ? 'info' : 'warn',
              text: msg.ok
                ? `派生已由 ${msg.backend} 计算（缝份/裁剪轮廓）· ${msg.elapsedMs.toFixed(0)}ms`
                : `派生刷新发现 ${msg.report.reasons.length} 项退化（未替换版本）`,
              at: Date.now()
            }
          ]
        };
      }
      const nextVersionNumber = Math.max(...p.versions.map((v) => v.version)) + 1;
      // 待提交数据按 requestId 索引；理论上双重核对保证其存在
      const committedData = payload?.data ?? current.data;
      const entry: VersionEntry = {
        version: nextVersionNumber,
        committedAt: Date.now(),
        label: p.pending.label,
        data: committedData,
        report: msg.report,
        derived: msg.derived
      };
      pendingDataRef.current.delete(msg.requestId);
      const truncated = p.versions.slice(0, p.headIndex + 1);
      return {
        ...p,
        versions: [...truncated, entry],
        headIndex: truncated.length,
        pending: null,
        gen: p.gen + 1,
        backend: msg.backend,
        dirty: true,
        notices: [
          ...p.notices,
          {
            level: 'info',
            text: `已提交 v${nextVersionNumber} · ${p.pending.label} · ${msg.backend} · ${msg.elapsedMs.toFixed(0)}ms`,
            at: Date.now()
          }
        ]
      };
    });
  }, []);

  const pendingDataRef = useRef<Map<number, { data: ProjectData; mode: 'commit' | 'refresh' }>>(new Map());

  const requestTransfer = useCallback(
    (pieceId: string, params: PivotParams) => {
      const s = stateRef.current;
      if (s.pending) {
        setState((p) => ({
          ...p,
          notices: [
            ...p.notices,
            { level: 'warn', text: '上一任务仍在校验中，请先等待或取消', at: Date.now() }
          ]
        }));
        return;
      }
      const entry = s.versions[s.headIndex];
      const piece = entry.data.pieces.find((x) => x.id === pieceId);
      if (!piece) return;

      // —— 同步解析预检（几何构造层面的硬错误，不进 Worker 也能判定）——
      let result;
      try {
        result = pivotTransfer(piece, {
          ...params,
          hitRadius: entry.data.tolerances.cutHit
        });
      } catch (err) {
        if (err instanceof TransferError) {
          setState((p) => ({
            ...p,
            notices: [
              ...p.notices,
              {
                level: 'error',
                text: `转移被拒绝（${err.code}）：${err.message}`,
                at: Date.now()
              }
            ]
          }));
          return;
        }
        throw err;
      }
      const nextData: ProjectData = {
        ...entry.data,
        pieces: entry.data.pieces.map((p) => (p.id === pieceId ? result.piece : p))
      };
      const pre = validateProject(nextData.pieces, nextData.tolerances);
      if (!pre.ok) {
        setState((p) => ({
          ...p,
          notices: [
            ...p.notices,
            {
              level: 'error',
              text: `转移预检失败，未提交：${pre.reasons.map((r) => r.message).join('；')}`,
              at: Date.now()
            }
          ]
        }));
        return;
      }
      dispatchCompute(nextData, `省道转移 → 边 ${params.targetEdgeId}`);
    },
    [dispatchCompute]
  );

  const commitMoveVertex = useCallback(
    (pieceId: string, vertexId: string, pos: Vec2) => {
      const s = stateRef.current;
      if (s.pending) return;
      const entry = s.versions[s.headIndex];
      const piece = entry.data.pieces.find((x) => x.id === pieceId);
      if (!piece || !(vertexId in piece.vertices)) return;
      const nextPiece: Piece = {
        ...piece,
        vertices: { ...piece.vertices, [vertexId]: pos }
      };
      const nextData: ProjectData = {
        ...entry.data,
        pieces: entry.data.pieces.map((p) => (p.id === pieceId ? nextPiece : p))
      };
      const pre = validateProject(nextData.pieces, nextData.tolerances);
      if (!pre.ok) {
        setState((p) => ({
          ...p,
          notices: [
            ...p.notices,
            {
              level: 'error',
              text: `顶点编辑校验失败，未提交：${pre.reasons.map((r) => r.message).join('；')}`,
              at: Date.now()
            }
          ]
        }));
        return;
      }
      dispatchCompute(nextData, `移动顶点 ${vertexId}`);
    },
    [dispatchCompute]
  );

  const restoreVersion = useCallback(
    (index: number, label: string) => {
      const s = stateRef.current;
      if (index < 0 || index >= s.versions.length || index === s.headIndex) return;
      // 在途结果立刻作废（gen 变化），不等待
      pendingDataRef.current.clear();
      const reqId = s.pending?.requestId;
      setState((p) => ({
        ...p,
        headIndex: index,
        gen: p.gen + 1,
        pending: null,
        dirty: true,
        unit: p.versions[index].data.unit,
        notices: [
          ...p.notices,
          { level: 'info', text: `${label} v${p.versions[index].version}（整次操作快照恢复）`, at: Date.now() }
        ]
      }));
      if (reqId !== undefined) postToWorker({ kind: 'cancel', requestId: reqId });
    },
    [postToWorker]
  );

  const undo = useCallback(() => {
    restoreVersion(stateRef.current.headIndex - 1, '撤销到');
  }, [restoreVersion]);

  const redo = useCallback(() => {
    restoreVersion(stateRef.current.headIndex + 1, '重做到');
  }, [restoreVersion]);

  const cancelPending = useCallback(() => {
    const s = stateRef.current;
    if (!s.pending) return;
    const id = s.pending.requestId;
    pendingDataRef.current.delete(id);
    postToWorker({ kind: 'cancel', requestId: id });
    setState((p) => ({
      ...p,
      pending: null,
      gen: p.gen + 1,
      dirty: false,
      notices: [...p.notices, { level: 'warn', text: '已取消校验任务，当前版本未改动', at: Date.now() }]
    }));
  }, [postToWorker]);

  const setSelection = useCallback((selection: Selection) => {
    setState((p) => ({ ...p, selection }));
  }, []);

  const setUnit = useCallback((unit: 'mm' | 'in') => {
    // 单位只改显示：数据内部恒 mm，这里只改 UI 偏好与版本头标记
    setState((p) => ({ ...p, unit }));
  }, []);

  const updateTolerances = useCallback((tolerances: Tolerances) => {
    const s = stateRef.current;
    if (s.pending) return;
    const entry = s.versions[s.headIndex];
    const nextData: ProjectData = { ...entry.data, tolerances };
    dispatchCompute(nextData, '修改容差并重新校验');
  }, [dispatchCompute]);

  const loadData = useCallback<StoreApi['loadData']>(
    (data, info) => {
      const entry = makeInitialEntry(data, '导入基线');
      setState((p) => ({
        ...p,
        meta: {
          ...p.meta,
          name: info.name ?? p.meta.name,
          updatedAt: Date.now()
        },
        versions: [entry],
        headIndex: 0,
        gen: p.gen + 1,
        unit: data.unit,
        selection: null,
        pending: null,
        dirty: true,
        quarantine: info.quarantine ?? [],
        migrationSteps: info.steps ?? [],
        migratedFrom: info.migratedFrom,
        notices: [
          ...p.notices,
          {
            level: info.quarantine?.length ? 'warn' : 'info',
            text: info.quarantine?.length
              ? `导入完成，${info.quarantine.length} 个无法迁移对象已保留为只读副本`
              : '导入完成（已通过显式格式迁移）',
            at: Date.now()
          }
        ]
      }));
      pendingDataRef.current.clear();
      setRefreshNonce((n) => n + 1);
    },
    []
  );

  const newProject = useCallback(() => {
    const fresh = freshState();
    pendingDataRef.current.clear();
    setState((p) => ({
      ...fresh,
      backend: p.backend,
      notices: [
        { level: 'info', text: '已创建新工程（样例：直线省 + 曲边省）', at: Date.now() }
      ]
    }));
    setRefreshNonce((n) => n + 1);
  }, []);

  const save = useCallback(async () => {
    const s = stateRef.current;
    const entry = s.versions[s.headIndex];
    const stored: db.StoredProject = {
      meta: { ...s.meta, updatedAt: Date.now() },
      currentVersion: entry.version,
      undoFloor: s.versions[0].version,
      redoStack: s.versions.slice(s.headIndex + 1).map((v) => v.version),
      headVersion: entry.version,
      cap: 50,
      quarantine: s.quarantine,
      migrationSteps: s.migrationSteps,
      migratedFrom: s.migratedFrom
    };
    const exists = (await db.listProjects()).some((x) => x.meta.id === s.meta.id);
    if (!exists) await db.createProject(stored);
    else await db.updateProject(stored);
    // 全量版本快照持久化（带版本）
    for (const v of s.versions) await db.putVersion(v, s.meta.id);
    setState((p) => ({ ...p, dirty: false, meta: stored.meta }));
  }, []);

  const dismissNotice = useCallback((at: number) => {
    setState((p) => ({ ...p, notices: p.notices.filter((n) => n.at !== at) }));
  }, []);

  const current = state.versions[state.headIndex];
  const selectedPiece = state.selection
    ? current.data.pieces.find((p) => p.id === state.selection?.pieceId) ?? null
    : null;

  const api: StoreApi = useMemo(
    () => ({
      ...state,
      current,
      projectData: current.data,
      derived: current.derived,
      report: current.report,
      selectedPiece,
      requestTransfer,
      commitMoveVertex,
      undo,
      redo,
      canUndo: state.headIndex > 0,
      canRedo: state.headIndex < state.versions.length - 1,
      cancelPending,
      setSelection,
      setUnit,
      updateTolerances,
      loadData,
      newProject,
      save,
      persistNow: false,
      dismissNotice
    }),
    [
      state,
      current,
      selectedPiece,
      requestTransfer,
      commitMoveVertex,
      undo,
      redo,
      cancelPending,
      setSelection,
      setUnit,
      updateTolerances,
      loadData,
      newProject,
      save,
      dismissNotice
    ]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useStore(): StoreApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}

export { DEFAULT_TOLERANCES } from '../core/types';
