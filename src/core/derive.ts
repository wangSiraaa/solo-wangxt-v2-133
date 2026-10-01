/**
 * 派生层（屏幕路径、缝份、裁剪轮廓、记号解析）。
 * 派生物可从任意已提交 ProjectData 完全重建，绝不回写源模型。
 */
import type {
  DerivedPiece,
  Piece,
  ProjectData,
  ResolvedMark,
  Tolerances,
  Vec2
} from './types';
import {
  angleOf,
  markPointsInward,
  pointAtArcFraction,
  polygonArea,
  seamLoop
} from './geometry';
import { resolveMarkPoint } from './validate';

/** 不依赖 Clipper 的派生：缝合环、记号世界坐标、面积 */
export function derivePiece(piece: Piece, tol: Tolerances): Omit<DerivedPiece, 'cutPaths'> & { cutPaths?: Vec2[][] } {
  const loop = seamLoop(piece, tol.tessellation);
  const resolvedMarks: ResolvedMark[] = piece.marks.map((m) => {
    const p = resolveMarkPoint(piece, m);
    let inward: boolean | null = null;
    if (p && m.kind === 'notch' && m.direction !== undefined) {
      inward = markPointsInward(p, m.direction, loop);
    }
    return {
      markId: m.id,
      kind: m.kind,
      point: p ?? { x: 0, y: 0 },
      direction: m.direction ?? null,
      pointsInward: inward,
      text: m.text
    };
  });
  return {
    pieceId: piece.id,
    seamLoop: loop,
    resolvedMarks,
    area: Math.abs(polygonArea(loop)),
    cutPaths: []
  };
}

export function deriveAll(data: ProjectData): DerivedPiece[] {
  return data.pieces.map((p) => ({
    ...derivePiece(p, data.tolerances),
    cutPaths: []
  }));
}
