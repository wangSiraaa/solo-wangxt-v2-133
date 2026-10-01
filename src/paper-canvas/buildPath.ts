import type { Edge, Piece, ProjectData, Vec } from '../model/types';

/** applySpec 只需要这些结构成员，避免 paper 的 export= 命名空间导入差异。 */
interface PathLike {
  moveTo(p: { x: number; y: number }): void;
  lineTo(p: { x: number; y: number }): void;
  cubicCurveTo(h1: { x: number; y: number }, h2: { x: number; y: number }, to: { x: number; y: number }): void;
  closePath(): void;
}
interface ScopeLike {
  Point: new (x: number, y: number) => { x: number; y: number };
}

export type ScreenSeg =
  | { kind: 'line'; to: Vec; pointId: string }
  | { kind: 'cubic'; to: Vec; c1: Vec; c2: Vec; pointId: string };

export interface ScreenPathSpec {
  startId: string;
  start: Vec;
  segs: ScreenSeg[];
}

/**
 * 由源模型直接构造精确曲线路径规格（Paper moveTo/cubicCurveTo 的输入）。
 * 不经过折线离散：屏幕路径是纯派生层，任何时刻都能从源模型精确重建。
 *
 * 反向穿行三次贝塞尔 A(..c1,c2..)B 时，B→A 段控制点反射为：
 *   c1' = 2B − c2，c2' = 2A − c1（绝对坐标）。
 */
export function buildScreenPath(data: ProjectData, piece: Piece): ScreenPathSpec {
  const segs: ScreenSeg[] = [];
  const firstRef = piece.loop.edges[0];
  const firstEdge = data.edges[firstRef.edgeId];
  const startId = firstRef.reversed ? firstEdge.to : firstEdge.from;
  const start = data.points[startId].pos;

  piece.loop.edges.forEach((ref, i) => {
    const e: Edge = data.edges[ref.edgeId];
    const a = data.points[e.from].pos;
    const b = data.points[e.to].pos;
    const nextPointId = piece.loop.pointIds[(i + 1) % piece.loop.pointIds.length];
    if (!ref.reversed) {
      if (e.curve === 'line') {
        segs.push({ kind: 'line', to: b, pointId: nextPointId });
      } else {
        segs.push({ kind: 'cubic', to: b, c1: e.c1, c2: e.c2, pointId: nextPointId });
      }
    } else {
      if (e.curve === 'line') {
        segs.push({ kind: 'line', to: a, pointId: nextPointId });
      } else {
        segs.push({
          kind: 'cubic',
          to: a,
          c1: { x: 2 * b.x - e.c2.x, y: 2 * b.y - e.c2.y },
          c2: { x: 2 * a.x - e.c1.x, y: 2 * a.y - e.c1.y },
          pointId: nextPointId,
        });
      }
    }
  });
  return { startId, start, segs };
}

export function applySpec<P extends PathLike>(scope: ScopeLike, path: P, spec: ScreenPathSpec): P {
  path.moveTo(new scope.Point(spec.start.x, spec.start.y));
  for (const s of spec.segs) {
    if (s.kind === 'line') {
      path.lineTo(new scope.Point(s.to.x, s.to.y));
    } else {
      const b = new scope.Point(s.to.x, s.to.y);
      path.cubicCurveTo(
        new scope.Point(s.c1.x, s.c1.y),
        new scope.Point(s.c2.x, s.c2.y),
        b,
      );
    }
  }
  path.closePath();
  return path;
}
