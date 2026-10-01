/**
 * IndexedDB 本地工程库。
 *
 * 保存的是「带版本的工程」：
 * - root store: 工程元数据 + 当前版本号 + 撤销/重做指针；
 * - versions store: 每个已提交版本的完整快照（含冻结的 report 与 derived）；
 * - 撤销/重做恢复的是整次操作的快照，不做字段级回放；
 * - 快照链按工程设置上限（默认 50）裁剪，裁剪不可达的旧版本。
 *
 * 无法迁移对象（readonlyQuarantine）随当前版本持久化，但不参与运算。
 */
import type { ProjectMeta, VersionEntry } from '../core/types';
import type { ProjectWithQuarantine } from '../core/migrate';

const DB_NAME = 'pattern-studio';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_VERSIONS = 'versions';

export interface StoredProject {
  meta: ProjectMeta;
  currentVersion: number;
  /** 撤销栈顶指针（可回到的最小版本） */
  undoFloor: number;
  /** 重做栈（已被新命令分叉作废的版本仍保留，直到链裁剪） */
  redoStack: number[];
  headVersion: number;
  /** 每份工程保留的版本上限 */
  cap: number;
  quarantine: ProjectWithQuarantine['readonlyQuarantine'];
  migrationSteps?: string[];
  migratedFrom?: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS))
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'meta.id' });
      if (!db.objectStoreNames.contains(STORE_VERSIONS)) {
        const vs = db.createObjectStore(STORE_VERSIONS, { keyPath: 'versionKey' });
        vs.createIndex('projectId', 'projectId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  fn: (stores: Record<string, IDBObjectStore>) => IDBRequest<T> | Promise<T> | void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const map: Record<string, IDBObjectStore> = {};
    for (const s of stores) map[s] = t.objectStore(s);
    let result: T;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    const r = fn(map);
    if (r instanceof IDBRequest) {
      r.onsuccess = () => {
        result = r.result as T;
      };
    } else if (r instanceof Promise) {
      r.then((v) => (result = v)).catch(reject);
    }
  });
}

const versionKey = (projectId: string, version: number): string =>
  `${projectId}#${version}`;

export async function listProjects(): Promise<StoredProject[]> {
  const db = await openDb();
  try {
    return await tx<StoredProject[]>(db, [STORE_PROJECTS], 'readonly', (s) =>
      s[STORE_PROJECTS].getAll() as unknown as IDBRequest<StoredProject[]>
    );
  } finally {
    db.close();
  }
}

export async function loadProjectVersions(
  projectId: string
): Promise<VersionEntry[]> {
  const db = await openDb();
  try {
    const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const t = db.transaction(STORE_VERSIONS, 'readonly');
      const req = t.objectStore(STORE_VERSIONS).index('projectId').getAll(projectId);
      req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>);
      req.onerror = () => reject(req.error);
    });
    return rows
      .map((r) => {
        const { projectId: _p, versionKey: _k, ...rest } = r;
        void _p;
        void _k;
        return rest as unknown as VersionEntry;
      })
      .sort((a, b) => a.version - b.version);
  } finally {
    db.close();
  }
}

export async function createProject(stored: StoredProject): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, [STORE_PROJECTS], 'readwrite', (s) =>
      s[STORE_PROJECTS].put(stored)
    );
  } finally {
    db.close();
  }
}

export async function putVersion(entry: VersionEntry, projectId: string): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, [STORE_VERSIONS], 'readwrite', (s) =>
      s[STORE_VERSIONS].put({ ...entry, versionKey: versionKey(projectId, entry.version), projectId })
    );
  } finally {
    db.close();
  }
}

export async function updateProject(stored: StoredProject): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, [STORE_PROJECTS], 'readwrite', (s) =>
      s[STORE_PROJECTS].put(stored)
    );
  } finally {
    db.close();
  }
}

export async function deleteVersion(projectId: string, version: number): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, [STORE_VERSIONS], 'readwrite', (s) =>
      s[STORE_VERSIONS].delete(versionKey(projectId, version))
    );
  } finally {
    db.close();
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, [STORE_PROJECTS, STORE_VERSIONS], 'readwrite', async (s) => {
      s[STORE_PROJECTS].delete(projectId);
      const idx = s[STORE_VERSIONS].index('projectId');
      const rows = (await reqToPromise(idx.getAllKeys(projectId))) as string[];
      for (const k of rows) s[STORE_VERSIONS].delete(k);
    });
  } finally {
    db.close();
  }
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
