import type {
  Project,
  ProjectData,
  ReadonlyObject,
  VersionSnapshot,
} from '../model/types';
import { CURRENT_FORMAT_VERSION } from '../model/types';
import { DEFAULT_TOLERANCE } from '../model/types';
import { validateProject } from '../geometry/validation';
import { reconcileSeq } from '../model/idgen';

/**
 * 显式格式迁移。每个版本只负责迁移到紧邻的下一版本，链式执行；
 * 无法识别/无法迁移的对象原样收进 readonlyObjects（只读副本），绝不静默丢弃。
 */

interface MigrationStep {
  from: number;
  to: number;
  migrate: (raw: Record<string, unknown>, log: string[], readonlyObjects: ReadonlyObject[]) => Record<string, unknown>;
}

const STEPS: MigrationStep[] = [
  {
    from: 1,
    to: 2,
    migrate: (raw, log, ro) => migrateV1ToV2(raw, log, ro),
  },
  {
    from: 2,
    to: 3,
    migrate: (raw, log, ro) => migrateV2ToV3(raw, log, ro),
  },
];

export interface MigrationResult {
  project: Project | null;
  fromVersion: number | null;
  migrated: boolean;
  log: string[];
  readonlyObjects: ReadonlyObject[];
  fatal?: string;
}

export function migrateProject(raw: unknown): MigrationResult {
  const log: string[] = [];
  const ro: ReadonlyObject[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { project: null, fromVersion: null, migrated: false, log, readonlyObjects: ro, fatal: '工程不是对象' };
  }
  const root = raw as Record<string, unknown>;
  const fromVersion = typeof root.formatVersion === 'number' ? root.formatVersion : 0;
  if (fromVersion === CURRENT_FORMAT_VERSION) {
    return { project: raw as Project, fromVersion, migrated: false, log, readonlyObjects: [] };
  }

  let version = fromVersion;
  if (version > CURRENT_FORMAT_VERSION) {
    ro.push({ id: `root-v${version}`, origin: `format v${version}`, reason: `工程格式 v${version} 比本应用支持的 v${CURRENT_FORMAT_VERSION} 更新，无法降级迁移`, raw: root });
    return { project: null, fromVersion, migrated: false, log, readonlyObjects: ro, fatal: `工程格式 v${version} 不受支持（当前支持 ≤ v${CURRENT_FORMAT_VERSION}）` };
  }
  let cur: Record<string, unknown> = root;
  while (version < CURRENT_FORMAT_VERSION) {
    const step = STEPS.find((s) => s.from === version);
    if (!step) {
      ro.push({ id: `root-v${version}`, origin: `format v${version}`, reason: `没有从 v${version} 出发的迁移路径`, raw: root });
      return { project: null, fromVersion, migrated: false, log, readonlyObjects: ro, fatal: `不支持的格式版本 v${version}` };
    }
    log.push(`v${step.from} → v${step.to}`);
    cur = step.migrate(cur, log, ro);
    cur.formatVersion = step.to;
    version = step.to;
  }

  try {
    const project = cur as unknown as Project;
    project.readonlyObjects = ro;
    project.migrationLog = log;
    // 迁移后做一次 seq 对齐与校验（不阻断：结果写入快照 report 供查看）
    for (const snap of project.versions ?? []) {
      reconcileSeq(snap.data);
      snap.report = validateProject(snap.data, DEFAULT_TOLERANCE);
    }
    return { project, fromVersion, migrated: true, log, readonlyObjects: ro };
  } catch (e) {
    return {
      project: null,
      fromVersion,
      migrated: false,
      log,
      readonlyObjects: ro,
      fatal: `迁移结果结构无效：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ---- v1 → v2 ----
// v1：piece 用 vertices/segments/outline；dart 用 tip/leg1/leg2；notch 用 seg/u/dir。
function migrateV1ToV2(
  raw: Record<string, unknown>,
  log: string[],
  ro: ReadonlyObject[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const piecesIn = (raw.pieces ?? []) as Record<string, unknown>[];
  const points: ProjectData['points'] = {};
  const edges: ProjectData['edges'] = {};
  const notches: ProjectData['notches'] = {};
  const darts: ProjectData['darts'] = {};
  const piecesOut: ProjectData['pieces'] = {};
  let seq = 0;

  for (const pc of piecesIn) {
    const pid = String(pc.id ?? `pc${seq + 1}`);
    const vertices = (pc.vertices ?? []) as Array<{ id?: string; x?: number; y?: number; kind?: string }>;
    const segments = (pc.segments ?? []) as Array<Record<string, unknown>>;
    for (const v of vertices) {
      const id = String(v.id ?? `p${++seq}`);
      if (typeof v.x !== 'number' || typeof v.y !== 'number') {
        ro.push({ id: `${pid}:${id}`, origin: `v1 piece ${pid} vertex`, reason: '顶点缺少数值坐标', raw: v });
        continue;
      }
      points[id] = { id, pos: { x: v.x, y: v.y }, kind: (v.kind as never) ?? 'corner' };
    }
    for (const s of segments) {
      const id = String(s.id);
      const a = String(s.a);
      const b = String(s.b);
      if (!points[a] || !points[b]) {
        ro.push({ id: `${pid}:${id}`, origin: `v1 piece ${pid} segment`, reason: '线段端点缺失', raw: s });
        continue;
      }
      const ctrl = s.ctrl as { c1x?: number; c1y?: number; c2x?: number; c2y?: number } | undefined;
      edges[id] = ctrl && [ctrl.c1x, ctrl.c1y, ctrl.c2x, ctrl.c2y].every((n) => typeof n === 'number')
        ? { id, from: a, to: b, role: 'seam', curve: 'cubic', c1: { x: ctrl.c1x!, y: ctrl.c1y! }, c2: { x: ctrl.c2x!, y: ctrl.c2y! } }
        : { id, from: a, to: b, role: 'seam', curve: 'line' };
    }
    const outline = (pc.outline ?? []) as Array<string | { id: string; rev?: boolean }>;
    const loopEdges: { edgeId: string; reversed: boolean }[] = [];
    for (const item of outline) {
      const sid = typeof item === 'string' ? item : String(item.id);
      const rev = typeof item === 'object' ? Boolean(item.rev) : false;
      if (!edges[sid]) {
        ro.push({ id: `${pid}:outline:${sid}`, origin: `v1 piece ${pid} outline`, reason: '轮廓引用的线段缺失或未能迁移，已从环中剔除', raw: item });
        continue;
      }
      loopEdges.push({ edgeId: sid, reversed: rev });
    }
    const pointIds: string[] = [];
    for (let i = 0; i < loopEdges.length; i++) {
      const ref = loopEdges[i];
      const e = edges[ref.edgeId];
      pointIds.push(ref.reversed ? e.to : e.from);
    }
    piecesOut[pid] = {
      id: pid,
      name: String(pc.name ?? pid),
      loop: { pointIds, edges: loopEdges },
      dartIds: [],
      slashIds: [],
      seamAllowance: typeof pc.sa === 'number' ? pc.sa : 10,
      grainline: { id: `g${pid}`, at: { x: 0, y: 0 }, angle: Math.PI / 2, length: 50 },
    };
    for (const n of ((pc.notches ?? []) as Array<Record<string, unknown>>)) {
      const id = String(n.id);
      const edgeId = String(n.seg);
      if (!edges[edgeId]) {
        ro.push({ id, origin: `v1 piece ${pid} notch`, reason: '记号引用的线段不存在', raw: n });
        continue;
      }
      notches[id] = {
        id,
        edgeId,
        t: Number(n.u ?? 0),
        normalSide: n.dir === 'out' ? 1 : n.dir === 'in' ? -1 : 1,
        kind: 'single',
      };
    }
    for (const dd of ((pc.darts ?? []) as Array<Record<string, unknown>>)) {
      const id = String(dd.id);
      const leg1 = String(dd.leg1);
      const leg2 = String(dd.leg2);
      if (!edges[leg1] || !edges[leg2]) {
        ro.push({ id, origin: `v1 piece ${pid} dart`, reason: '省腿缺失', raw: dd });
        continue;
      }
      edges[leg1].role = 'dartLeg';
      edges[leg1].dartId = id;
      edges[leg2].role = 'dartLeg';
      edges[leg2].dartId = id;
      darts[id] = {
        id,
        name: String(dd.name ?? id),
        apex: String(dd.tip),
        legIn: leg1,
        legOut: leg2,
      };
      piecesOut[pid].dartIds.push(id);
    }
    log.push(`v1 裁片 ${pid}: ${Object.keys(points).length} 点 / ${Object.keys(edges).length} 边`);
  }

  const data: ProjectData = { seq, points, edges, notches, slashes: {}, darts, pieces: piecesOut };
  const snapshot: VersionSnapshot = {
    version: 1,
    parentVersion: null,
    timestamp: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    label: '从 v1 迁移',
    data,
    report: { ok: false, issues: [], checkedAt: Date.now(), tolerance: DEFAULT_TOLERANCE },
  };
  out.data = undefined;
  out.versions = [snapshot];
  out.head = 0;
  out.name = String(raw.name ?? '迁移工程');
  return out;
}

// ---- v2 → v3 ----
// v2 与当前几乎相同：notch 用 normal(±1)、dart 用 legA/legB、slash 无 sourceEdgeId/pointId。
function migrateV2ToV3(
  raw: Record<string, unknown>,
  log: string[],
  ro: ReadonlyObject[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const versions = (raw.versions ?? []) as VersionSnapshot[];
  for (const snap of versions) {
    const data = snap.data as unknown as Record<string, unknown>;
    const d = data as unknown as ProjectData;
    for (const n of Object.values(d.notches ?? {})) {
      const legacy = n as unknown as { normal?: number; normalSide?: 1 | -1 };
      if (legacy.normalSide === undefined && typeof legacy.normal === 'number') {
        legacy.normalSide = legacy.normal >= 0 ? 1 : -1;
      }
      delete (legacy as Record<string, unknown>).normal;
    }
    for (const dd of Object.values(d.darts ?? {})) {
      const legacy = dd as unknown as { legA?: string; legB?: string; legIn?: string; legOut?: string };
      if (legacy.legIn === undefined && legacy.legA) legacy.legIn = legacy.legA;
      if (legacy.legOut === undefined && legacy.legB) legacy.legOut = legacy.legB;
      delete legacy.legA;
      delete legacy.legB;
    }
    for (const sm of Object.values(d.slashes ?? {})) {
      const legacy = sm as unknown as { pointId?: string; hitPoint?: string; sourceEdgeId?: string };
      if (!legacy.pointId && legacy.hitPoint) legacy.pointId = legacy.hitPoint;
      if (!legacy.pointId) {
        ro.push({ id: sm.id, origin: 'v2 slash', reason: '剪线缺少交点身份，无法迁移', raw: sm });
      }
      delete legacy.hitPoint;
    }
  }
  log.push(`v2→v3：${versions.length} 个版本的记号/省/剪线字段已规范化`);
  return out;
}
