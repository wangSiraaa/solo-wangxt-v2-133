/**
 * 内置样例：
 * - block_bodice：直线省（腰省，省腿为直线）
 * - block_curve：曲边省（两条省腿为三次曲线，检验曲线刚体旋转与全等）
 */
import type { Edge, Mark, Piece, ProjectData, Vec2 } from './types';
import { DEFAULT_TOLERANCES, CURRENT_FORMAT_VERSION } from './types';

interface RingSpec {
  kind: 'out' | 'leg';
  to: string;
  /** 绝对控制点（世界坐标）；buildPiece 内部换算为源模型的相对控制点 */
  cubicAbs?: { c1: Vec2; c2: Vec2 };
  sa?: number;
}

/**
 * 按环序列构造裁片。
 * spec: [顶点key, 边, 顶点key, 边, ...]，最后一条边回到起点。
 * 省通过 'dart' 段声明：[B1,'leg',apexKey,'leg',B2]，两条边顺序相邻共尖。
 */
export function buildPiece(opts: {
  id: string;
  name: string;
  points: Record<string, Vec2>;
  sequence: Array<
    | string
    | RingSpec
    | { dart: string; leg1c?: { c1: Vec2; c2: Vec2 }; leg2c?: { c1: Vec2; c2: Vec2 } }
  >;
  marks?: Mark[];
  seamAllowance?: number;
}): Piece {
  const vertices: Record<string, Vec2> = {};
  for (const [k, p] of Object.entries(opts.points)) vertices[k] = { ...p };

  const edges: Edge[] = [];
  const darts: Piece['darts'] = [];
  let edgeCounter = 0;
  const mkEdgeId = (kind: string): string => `${opts.id}_${kind}_${edgeCounter++}`;

  // sequence: ['A', {kind:'out',to:'B'}, 'B', ...]
  let prev: string | null = null;
  for (let i = 0; i < opts.sequence.length; i++) {
    const item = opts.sequence[i];
    if (typeof item === 'string') {
      prev = item;
      continue;
    }
    if ('dart' in item) {
      // 前一顶点应是 B1；随后序列必须是 apex、B2 两个字符串
      const b1 = prev!;
      const apexKey = opts.sequence[i + 1] as string;
      const b2 = opts.sequence[i + 2] as string;
      const l1 = mkEdgeId('leg');
      const l2 = mkEdgeId('leg');
      const relCubic = (c: { c1: Vec2; c2: Vec2 } | undefined): Edge['cubic'] =>
        c ? { c1: { ...c.c1 }, c2: { ...c.c2 } } : undefined;
      edges.push({
        id: l1,
        kind: 'dartLeg',
        from: b1,
        to: apexKey,
        cubic: relCubic(item.leg1c)
      });
      edges.push({
        id: l2,
        kind: 'dartLeg',
        from: apexKey,
        to: b2,
        cubic: relCubic(item.leg2c)
      });
      darts.push({ id: item.dart, apex: apexKey, leg1: l1, leg2: l2 });
      prev = b2;
      i += 2;
      continue;
    }
    const spec = item as RingSpec;
    edges.push({
      id: mkEdgeId(spec.kind === 'leg' ? 'leg' : 'e'),
      kind: spec.kind === 'leg' ? 'dartLeg' : 'outer',
      from: prev!,
      to: spec.to,
      cubic: spec.cubicAbs ? { c1: { ...spec.cubicAbs.c1 }, c2: { ...spec.cubicAbs.c2 } } : undefined
    });
    prev = spec.to;
  }

  return {
    id: opts.id,
    name: opts.name,
    vertices,
    edges,
    darts,
    marks: opts.marks ?? [],
    seamAllowance: opts.seamAllowance ?? 10,
    grain: { x: 0, y: 0, angle: Math.PI / 2 }
  };
}

const notch = (id: string, edgeId: string, f: number, direction: number): Mark => ({
  id,
  kind: 'notch',
  edgeId,
  arcFraction: f,
  direction
});

export function sampleProject(): ProjectData {
  // —— 裁片 1：直线腰省的基础片（mm，y 向上；CCW 环）——
  // 腰口 B1 → P → B2 在上方，省道向下凹入
  const bodice = buildPiece({
    id: 'b1',
    name: '直线省基础片',
    seamAllowance: 10,
    points: {
      LB: { x: 0, y: 200 },
      RB: { x: 180, y: 200 },
      B2: { x: 120, y: 0 },
      P: { x: 90, y: 70 },
      B1: { x: 60, y: 0 }
    },
    sequence: [
      'B1',
      { dart: 'd_waist' },
      'P',
      'B2',
      { kind: 'out', to: 'RB' },
      'RB',
      { kind: 'out', to: 'LB' },
      'LB',
      { kind: 'out', to: 'B1' }
    ],
    marks: [
      // 右侧缝剪口；右边向下走，片内在右侧（+x，角 0）
      { id: 'm_sideR', kind: 'notch', arcFraction: 0.82, direction: 0 }
    ]
  });

  // 修正 marks 的 edgeId（buildPiece 生成的 id 对外不可见，这里按端点找边）
  const sideREdge = bodice.edges.find((e) => e.to === 'RB' && e.from === 'B2')!;
  bodice.marks[0].edgeId = sideREdge.id;
  // 左边剪口（边上），朝向片内（向下 -π/2）
  const leftEdge = bodice.edges.find((e) => e.to === 'B1' && e.from === 'LB')!;
  bodice.marks.push(notch('m_hemL', leftEdge.id, 0.8, -Math.PI / 2));
  // 省尖钻孔
  bodice.marks.push({ id: 'm_apex', kind: 'drill', vertexId: 'P', point: { ...bodice.vertices.P } });

  // —— 裁片 2：曲边省。先按“省尖→省口”设计左腿三次曲线，镜像得右腿，
  // 存储时左腿反向（控制点交换，弧长严格保持）。——
  const P2: Vec2 = { x: 120, y: 150 };
  const C1: Vec2 = { x: 30, y: 40 };
  const C2: Vec2 = { x: 210, y: 40 };
  const mirrorX = (p: Vec2): Vec2 => ({ x: 2 * P2.x - p.x, y: p.y });
  // 省尖 → C1 的控制点（绝对）
  const apexToC1_c1: Vec2 = { x: 104, y: 122 };
  const apexToC1_c2: Vec2 = { x: 52, y: 52 };
  // 存储的腿1 方向是 C1 → P2：反向后控制点交换
  const leg1c: { c1: Vec2; c2: Vec2 } = {
    c1: apexToC1_c2,
    c2: apexToC1_c1
  };
  // 腿2 方向 P2 → C2：左腿镜像
  const leg2c: { c1: Vec2; c2: Vec2 } = {
    c1: mirrorX(apexToC1_c1),
    c2: mirrorX(apexToC1_c2)
  };
  const curve = buildPiece({
    id: 'b2',
    name: '曲边省裁片',
    seamAllowance: 12,
    points: {
      C1,
      P: P2,
      C2,
      RE: { x: 230, y: 220 },
      LE: { x: 10, y: 220 }
    },
    sequence: [
      'C1',
      { dart: 'd_curve', leg1c, leg2c },
      'P',
      'C2',
      {
        kind: 'out',
        to: 'RE',
        cubicAbs: { c1: { x: 245, y: 110 }, c2: { x: 240, y: 170 } }
      },
      'RE',
      { kind: 'out', to: 'LE' },
      'LE',
      {
        kind: 'out',
        to: 'C1',
        cubicAbs: { c1: { x: -5, y: 170 }, c2: { x: 15, y: 110 } }
      }
    ],
    marks: [
      { id: 'm_capex', kind: 'drill', vertexId: 'P', point: { ...P2 } },
      { id: 'm_botr', kind: 'notch', arcFraction: 0.5, direction: Math.PI * 0.75 }
    ]
  });
  const bottomEdge = curve.edges.find((e) => e.from === 'RE' && e.to === 'LE')!;
  curve.marks.find((m) => m.id === 'm_botr')!.edgeId = bottomEdge.id;

  return {
    formatVersion: CURRENT_FORMAT_VERSION,
    unit: 'mm',
    pieces: [bodice, curve],
    tolerances: { ...DEFAULT_TOLERANCES }
  };
}
