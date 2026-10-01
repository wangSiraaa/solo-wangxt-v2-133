/**
 * 显式格式迁移。
 *
 * 规则：
 * - 导入旧工程必须经过 migrate()，每一步迁移都是命名、显式、可测试的函数；
 * - 无法迁移的对象不丢弃：作为 readonlyQuarantine 保留在工程里（只读副本），
 *   UI 中标为“隔离对象”，不参与放码与布尔运算；
 * - 单位 mm/in 不属于格式：内部恒为 mm，单位只影响显示。
 */
import {
  CURRENT_FORMAT_VERSION,
  DEFAULT_TOLERANCES,
  type Piece,
  type ProjectData,
  type Tolerances
} from './types';

export interface QuarantinedObject {
  /** 原对象类型（尽力解析） */
  kind: string;
  reason: string;
  /** 原始 JSON 只读副本 */
  raw: unknown;
}

export interface MigrationResult {
  data: ProjectData;
  /** 每一步迁移的审计记录 */
  steps: string[];
  quarantine: QuarantinedObject[];
  sourceFormatVersion: number;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** v1 旧格式：坐标 [x,y] 数组、seam 与 dart 分离描述 */
export interface LegacyV1Project {
  formatVersion: 1;
  name?: string;
  unit?: string;
  blocks: Array<{
    id: string;
    name?: string;
    seamAllowance?: number;
    pts: Array<[number, number]>;
    /** 闭合缝线路径（pts 的索引序列） */
    outline: number[];
    /** v1 省道：尖 + 两个省口点（在 outline 上的索引） */
    darts?: Array<{ id: string; apex: number; leg1: number; leg2: number }>;
    notches?: Array<{ id: string; at: number; dir?: number }>;
    /** v1 中偶发的脏数据：outline 索引越界等 */
    extras?: unknown[];
  }>;
}

function isNumPair(x: unknown): x is [number, number] {
  return (
    Array.isArray(x) &&
    x.length === 2 &&
    typeof x[0] === 'number' &&
    typeof x[1] === 'number' &&
    Number.isFinite(x[0]) &&
    Number.isFinite(x[1])
  );
}

/** v1 → v2：把“点索引轮廓 + 独立省道”重写为“有序缝合环（省道以 V 形下凹入环）” */
function migrateV1ToV2(
  legacy: LegacyV1Project,
  quarantine: QuarantinedObject[],
  steps: string[]
): ProjectData {
  const pieces: Piece[] = [];

  for (const block of legacy.blocks) {
    const q = (reason: string, raw: unknown): void => {
      quarantine.push({ kind: 'v1.blockPart', reason, raw });
    };

    if (!Array.isArray(block.pts) || !block.pts.every(isNumPair)) {
      q(`裁片 ${block.id}: pts 不是合法的数值点数组，整块隔离`, block);
      continue;
    }    if (
      !Array.isArray(block.outline) ||
      block.outline.some((i) => !Number.isInteger(i) || i < 0 || i >= block.pts.length)
    ) {
      q(`裁片 ${block.id}: outline 索引越界或非整数，整块隔离`, block);
      continue;
    }

    // 去重 outline 相邻重复索引
    const outline = block.outline.filter(
      (i, k, arr) => k === 0 || i !== arr[k - 1]
    );
    if (outline.length < 3) {
      q(`裁片 ${block.id}: outline 有效点数 < 3，整块隔离`, block);
      continue;
    }

    const vertices: Piece['vertices'] = {};
    const vid = (i: number): string => `${block.id}_p${i}`;
    for (const i of outline) {
      vertices[vid(i)] = { x: block.pts[i][0], y: block.pts[i][1] };
    }

    const usedDarts = new Set<number>();
    const darts: Piece['darts'] = [];
    type PendingEdge = { id: string; from: string; to: string; kind: 'outer' | 'dartLeg' };
    const edgePlan: PendingEdge[] = [];

    for (let k = 0; k < outline.length; k++) {
      const a = outline[k];
      const b = outline[(k + 1) % outline.length];
      const dartHere = (block.darts ?? []).findIndex(
        (d) =>
          (d.leg1 === a && d.leg2 === b) ||
          (d.leg1 === b && d.leg2 === a)
      );
      if (dartHere >= 0) {
        const d = (block.darts ?? [])[dartHere];
        if (
          usedDarts.has(dartHere) ||
          !Number.isInteger(d.apex) ||
          d.apex < 0 ||
          d.apex >= block.pts.length
        ) {
          q(`裁片 ${block.id}: 省道 ${d?.id ?? dartHere} 引用非法或重复，按外边直连处理`, d);
          edgePlan.push({ id: `${block.id}_e${edgePlan.length}`, from: vid(a), to: vid(b), kind: 'outer' });
          continue;
        }
        usedDarts.add(dartHere);
        const apexId = `${block.id}_apex${dartHere}`;
        vertices[apexId] = { x: block.pts[d.apex][0], y: block.pts[d.apex][1] };
        const dartId = `${block.id}_dart${dartHere}`;
        darts.push({
          id: dartId,
          apex: apexId,
          leg1: `${dartId}_l1`,
          leg2: `${dartId}_l2`
        });
        const l1From = d.leg1 === a ? vid(a) : vid(b);
        const l2To = d.leg1 === a ? vid(b) : vid(a);
        edgePlan.push({ id: `${dartId}_l1`, from: l1From, to: apexId, kind: 'dartLeg' });
        edgePlan.push({ id: `${dartId}_l2`, from: apexId, to: l2To, kind: 'dartLeg' });
      } else {
        edgePlan.push({ id: `${block.id}_e${edgePlan.length}`, from: vid(a), to: vid(b), kind: 'outer' });
      }
    }

    const edges: Piece['edges'] = edgePlan.map((p) => ({
      id: p.id,
      kind: p.kind,
      from: p.from,
      to: p.to
    }));

    // 未被轮廓引用的省道 → 隔离
    (block.darts ?? []).forEach((d, di) => {
      if (!usedDarts.has(di)) {
        q(`裁片 ${block.id}: 省道 ${d.id} 的省口不在 outline 上，隔离该省道`, d);
      }
    });

    const marks: Piece['marks'] = [];
    for (const nc of block.notches ?? []) {
      if (!Number.isInteger(nc.at) || nc.at < 0 || nc.at >= block.pts.length) {
        q(`裁片 ${block.id}: 剪口 ${nc.id} 引用越界，隔离`, nc);
        continue;
      }
      marks.push({
        id: `${block.id}_mark_${nc.id}`,
        kind: 'notch',
        vertexId: vid(nc.at),
        direction: nc.dir
      });
    }

    for (const extra of block.extras ?? []) {
      q(`裁片 ${block.id}: extras 中的对象无法迁移，保留只读副本`, extra);
    }

    pieces.push({
      id: block.id,
      name: block.name ?? block.id,
      vertices,
      edges,
      darts,
      marks,
      seamAllowance: block.seamAllowance ?? 10,
      grain: { x: 0, y: 0, angle: Math.PI / 2 }
    });
  }

  const tolerances: Tolerances = { ...DEFAULT_TOLERANCES };
  return {
    formatVersion: CURRENT_FORMAT_VERSION,
    unit: legacy.unit === 'in' ? 'in' : 'mm',
    pieces,
    tolerances
  };
}

/** 任意 JSON → ProjectData（显式迁移链） */
export function migrate(input: unknown): MigrationResult {
  if (typeof input !== 'object' || input === null)
    throw new MigrationError('不是工程文件（根节点非对象）');
  const raw = input as { formatVersion?: unknown };
  const steps: string[] = [];
  const quarantine: QuarantinedObject[] = [];

  const fv = raw.formatVersion;
  if (fv === CURRENT_FORMAT_VERSION) {
    const data = input as ProjectData;
    if (!Array.isArray(data.pieces)) throw new MigrationError('v2 工程缺少 pieces');
    steps.push('已是当前格式（v2），仅做只读校验');
    return { data: structuredClone(data), steps, quarantine, sourceFormatVersion: 2 };
  }
  if (fv === 1) {
    steps.push('v1 → v2：索引轮廓重写为有序缝合环，省道以下凹 V 形入环');
    steps.push('v1 → v2：剪口绑定从点索引改为稳定顶点身份，越界对象进入只读隔离区');
    const data = migrateV1ToV2(input as LegacyV1Project, quarantine, steps);
    return { data, steps, quarantine, sourceFormatVersion: 1 };
  }
  throw new MigrationError(
    `未知格式版本 ${String(fv)}；无法迁移。当前支持版本：1 → ${CURRENT_FORMAT_VERSION}`
  );
}

/** 隔离区会持久化进工程文件（只读副本），但永远不进入几何运算 */
export interface ProjectWithQuarantine extends ProjectData {
  /** 迁移来源版本；本地新建为当前版本 */
  migratedFrom?: number;
  migrationSteps?: string[];
  readonlyQuarantine?: QuarantinedObject[];
}
