import type { Project } from '../model/types';
import { migrateProject } from './migrate';

const DB_NAME = 'pattern-cad';
const DB_VERSION = 1;
const STORE = 'projects';
const META = 'meta';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface StoredProject {
  id: string;
  name: string;
  formatVersion: number;
  updatedAt: number;
  project: Project;
}

export class ProjectStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDB();
    return this.dbPromise;
  }

  async list(): Promise<Array<{ id: string; name: string; updatedAt: number; formatVersion: number; versions: number }>> {
    const db = await this.db();
    const all = await tx<StoredProject[]>(db, STORE, 'readonly', (s) => s.getAll() as IDBRequest<StoredProject[]>);
    return all.map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      formatVersion: p.formatVersion,
      versions: p.project.versions.length,
    }));
  }

  async load(id: string) {
    const db = await this.db();
    const stored = await tx<StoredProject | undefined>(db, STORE, 'readonly', (s) => s.get(id) as IDBRequest<StoredProject | undefined>);
    if (!stored) return null;
    // 即使本地保存的是旧版本，也走显式迁移
    return migrateProject(stored.project);
  }

  async save(project: Project): Promise<void> {
    const db = await this.db();
    const record: StoredProject = {
      id: project.id,
      name: project.name,
      formatVersion: project.formatVersion,
      updatedAt: project.updatedAt,
      project,
    };
    await tx(db, STORE, 'readwrite', (s) => s.put(record));
  }

  async remove(id: string): Promise<void> {
    const db = await this.db();
    await tx(db, STORE, 'readwrite', (s) => s.delete(id));
  }

  /** 导入外部 JSON（任意版本）：显式迁移；失败返回原因，不覆盖任何现有工程。 */
  async importRaw(raw: unknown) {
    const result = migrateProject(raw);
    if (result.project) {
      result.project.id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      result.project.updatedAt = Date.now();
      await this.save(result.project);
    }
    return result;
  }

  async exportProject(id: string): Promise<Project | null> {
    const r = await this.load(id);
    return r?.project ?? null;
  }
}
