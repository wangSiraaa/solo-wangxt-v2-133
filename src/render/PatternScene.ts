/**
 * Paper.js 渲染层 —— 纯派生。
 * 每次以已提交（或预览）ProjectData + DerivedPiece[] 重建整个场景；
 * 场景中的图形只承载显示与命中，选择状态以 (kind,id) 回传到 React，
 * 绝不把屏幕上的 Path 当几何源。
 */
import paper from 'paper';
import type {
  Edge,
  Piece,
  ProjectData,
  Selection,
  Vec2,
  VersionEntry
} from '../core/types';
import { cubicPoint, seamLoop } from '../core/geometry';
import { resolveMarkPoint } from '../core/validate';

export interface ViewTransform {
  /** 世界(mm) → 屏幕 */
  scale: number;
  offsetX: number;
  offsetY: number;
}

const COL = {
  seam: '#1f2937',
  cut: '#b45309',
  leg: '#7c3aed',
  mark: '#0e7490',
  markBad: '#dc2626',
  drill: '#0369a1',
  apex: '#be123c',
  grain: '#65a30d',
  selected: '#2563eb',
  preview: '#16a34a',
  previewLeg: '#15803d'
};

export interface HitResult {
  selection: Selection;
  /** 命中点世界坐标（顶点拖动用） */
  worldPoint?: Vec2;
}

export class PatternScene {
  private scope: paper.PaperScope;
  private view: ViewTransform;
  private hitLayer: paper.Item[] = [];
  private pieceOffsets = new Map<string, Vec2>();

  constructor(canvas: HTMLCanvasElement) {
    this.scope = new paper.PaperScope();
    this.scope.setup(canvas);
    this.view = { scale: 3, offsetX: 80, offsetY: 0 };
  }

  get paperScope(): paper.PaperScope {
    return this.scope;
  }

  get transform(): ViewTransform {
    return this.view;
  }

  setTransform(t: ViewTransform): void {
    this.view = t;
  }

  resize(w: number, h: number): void {
    const c = this.scope.view;
    if (c) c.viewSize = new paper.Size(w, h);
  }

  worldToScreen(p: Vec2): Vec2 {
    return {
      x: p.x * this.view.scale + this.view.offsetX,
      y: -p.y * this.view.scale + this.view.offsetY
    };
  }

  screenToWorld(p: Vec2): Vec2 {
    return {
      x: (p.x - this.view.offsetX) / this.view.scale,
      y: -(p.y - this.view.offsetY) / this.view.scale
    };
  }

  private w2s(p: Vec2): paper.Point {
    return new paper.Point(
      p.x * this.view.scale + this.view.offsetX,
      -p.y * this.view.scale + this.view.offsetY
    );
  }

  clear(): void {
    this.scope.project?.clear();
    this.hitLayer = [];
  }

  private edgePath(piece: Piece, e: Edge, offset: Vec2): paper.Path {
    const start = this.w2s({
      x: piece.vertices[e.from].x + offset.x,
      y: piece.vertices[e.from].y + offset.y
    });
    const path = new paper.Path({ strokeColor: COL.seam, strokeWidth: 1.4, closed: false });
    path.moveTo(start);
    if (e.cubic) {
      const p3 = piece.vertices[e.to];
      path.cubicCurveTo(
        this.w2s({ x: e.cubic.c1.x + offset.x, y: e.cubic.c1.y + offset.y }),
        this.w2s({ x: e.cubic.c2.x + offset.x, y: e.cubic.c2.y + offset.y }),
        this.w2s({ x: p3.x + offset.x, y: p3.y + offset.y })
      );
    } else {
      path.lineTo(
        this.w2s({
          x: piece.vertices[e.to].x + offset.x,
          y: piece.vertices[e.to].y + offset.y
        })
      );
    }
    return path;
  }

  /** 布局：裁片按顺序横排，避免重叠（纯显示偏移，不改源模型） */
  private layoutPieces(entry: VersionEntry): void {
    this.pieceOffsets.clear();
    let cursor = 0;
    const gap = 60;
    for (const piece of entry.data.pieces) {
      const loop = seamLoop(piece, entry.data.tolerances.tessellation);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of loop) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      const w = maxX - minX || 100;
      const h = maxY - minY || 100;
      const offset: Vec2 = { x: cursor - minX, y: 220 - maxY };
      this.pieceOffsets.set(piece.id, offset);
      cursor += w + gap;
      void h;
    }
  }

  render(
    entry: VersionEntry,
    selection: Selection,
    opts?: { pending?: boolean }
  ): void {
    this.clear();
    this.layoutPieces(entry);
    const s = this.scope;

    // 裁剪轮廓（派生：worker 提交版本里缓存）
    for (const piece of entry.data.pieces) {
      const offset = this.pieceOffsets.get(piece.id)!;
      const d = entry.derived.find((x) => x.pieceId === piece.id);
      for (const cut of d?.cutPaths ?? []) {
        const path = new paper.Path({
          strokeColor: new paper.Color(COL.cut),
          strokeWidth: 1,
          dashArray: [5, 3],
          closed: true
        });
        for (const p of cut) path.add(this.w2s({ x: p.x + offset.x, y: p.y + offset.y }));
      }

      // 缝线（源模型曲线，逐边画，保留贝塞尔）
      for (const e of piece.edges) {
        const isLeg = e.kind === 'dartLeg';
        const path = this.edgePath(piece, e, offset);
        path.strokeColor = new paper.Color(isLeg ? COL.leg : COL.seam);
        path.strokeWidth = 1.4;
        if (
          selection?.kind === 'edge' &&
          selection.pieceId === piece.id &&
          selection.edgeId === e.id
        ) {
          path.strokeColor = new paper.Color(COL.selected);
          path.strokeWidth = 2.6;
        }
        this.hitLayer.push(path);
      }

      // 省尖
      for (const dart of piece.darts) {
        const ap = piece.vertices[dart.apex];
        const c = new paper.Path.Circle({
          center: this.w2s({ x: ap.x + offset.x, y: ap.y + offset.y }),
          radius: 5,
          fillColor:
            selection?.kind === 'dart' && selection.dartId === dart.id
              ? COL.selected
              : COL.apex
        });
        this.hitLayer.push(c);
      }

      // 顶点
      for (const [id, p] of Object.entries(piece.vertices)) {
        const isApex = piece.darts.some((d) => d.apex === id);
        if (isApex) continue;
        const c = new paper.Path.Circle({
          center: this.w2s({ x: p.x + offset.x, y: p.y + offset.y }),
          radius: 3.2,
          fillColor:
            selection?.kind === 'vertex' && selection.vertexId === id
              ? COL.selected
              : '#374151'
        });
        this.hitLayer.push(c);
      }

      // 记号
      for (const mark of piece.marks) {
        const p = resolveMarkPoint(piece, mark);
        if (!p) continue;
        const center = { x: p.x + offset.x, y: p.y + offset.y };
        const resolved = d?.resolvedMarks.find((r) => r.markId === mark.id);
        if (mark.kind === 'drill') {
          const cross = new paper.Path({
            strokeColor: COL.drill,
            strokeWidth: 1.4
          });
          cross.moveTo(this.w2s({ x: center.x - 3, y: center.y - 3 }));
          cross.lineTo(this.w2s({ x: center.x + 3, y: center.y + 3 }));
          cross.moveTo(this.w2s({ x: center.x + 3, y: center.y - 3 }));
          cross.lineTo(this.w2s({ x: center.x - 3, y: center.y + 3 }));
          this.hitLayer.push(cross);
        } else if (mark.kind === 'notch') {
          const dir = mark.direction ?? 0;
          const tip: Vec2 = {
            x: center.x + Math.cos(dir) * 7 / this.view.scale,
            y: center.y + Math.sin(dir) * 7 / this.view.scale
          };
          const arrow = new paper.Path({
            strokeColor: resolved?.pointsInward === false ? COL.markBad : COL.mark,
            strokeWidth: 1.6
          });
          arrow.moveTo(this.w2s(center));
          arrow.lineTo(this.w2s(tip));
          const head = new paper.Path.Circle({
            center: this.w2s(center),
            radius: 2.4,
            fillColor: resolved?.pointsInward === false ? COL.markBad : COL.mark
          });
          this.hitLayer.push(arrow, head);
        }
      }

      // 布纹线
      const grain = new paper.Path({
        strokeColor: COL.grain,
        strokeWidth: 1,
        dashArray: [2, 3]
      });
      grain.moveTo(this.w2s({ x: offset.x + piece.grain.x, y: offset.y + piece.grain.y }));
      grain.lineTo(
        this.w2s({ x: offset.x + piece.grain.x, y: offset.y + piece.grain.y + 30 })
      );
    }

    // 预览覆盖由 renderPreview 独立叠加
    if (opts?.pending) {
      const txt = new paper.PointText({
        point: new paper.Point(16, 22),
        content: '校验进行中…（可继续编辑或取消；迟到结果不会覆盖新几何）',
        fillColor: COL.preview,
        fontFamily: 'sans-serif',
        fontSize: 13
      });
      void txt;
    }

    s.view?.update();
  }

  /** 绘制临时预览几何（预检通过、Worker 校验期间显示） */
  renderPreview(entry: VersionEntry, previewData: ProjectData): void {
    // 在当前场景基础上，用绿色虚线把预览裁片的缝合环叠加出来
    for (const piece of previewData.pieces) {
      const offset = this.pieceOffsets.get(piece.id) ?? { x: 0, y: 0 };
      const loop = seamLoop(piece, previewData.tolerances.tessellation);
      const path = new paper.Path({
        strokeColor: COL.preview,
        strokeWidth: 1.6,
        dashArray: [6, 4],
        closed: true,
        opacity: 0.9
      });
      for (const p of loop) path.add(this.w2s({ x: p.x + offset.x, y: p.y + offset.y }));
    }
    this.scope.view?.update();
  }

  /** 命中测试：返回对应的稳定身份（顶点优先，其次边） */
  hitTest(screen: Vec2, entry: VersionEntry): HitResult | null {
    const pt = new paper.Point(screen.x, screen.y);
    // 顶点圆
    for (const piece of entry.data.pieces) {
      const offset = this.pieceOffsets.get(piece.id)!;
      for (const [vertexId, p] of Object.entries(piece.vertices)) {
        const sp = this.w2s({ x: p.x + offset.x, y: p.y + offset.y });
        if (Math.hypot(sp.x - pt.x, sp.y - pt.y) <= 6) {
          return {
            selection: { kind: 'vertex', pieceId: piece.id, vertexId },
            worldPoint: this.screenToWorld(screen)
          };
        }
      }
      // 省尖命中（dart 选择）
      for (const dart of piece.darts) {
        const ap = piece.vertices[dart.apex];
        const sp = this.w2s({ x: ap.x + offset.x, y: ap.y + offset.y });
        if (Math.hypot(sp.x - pt.x, sp.y - pt.y) <= 7) {
          return { selection: { kind: 'dart', pieceId: piece.id, dartId: dart.id } };
        }
      }
      // 边（按贝塞尔采样距离）
      const shifted = shiftedVerts(piece.vertices, offset);
      for (const e of piece.edges) {
        for (let t = 0; t <= 1.0001; t += 0.04) {
          const wp = cubicPoint(e, shifted, t);
          const sp = this.w2s(wp);
          if (Math.hypot(sp.x - pt.x, sp.y - pt.y) <= 5) {
            return { selection: { kind: 'edge', pieceId: piece.id, edgeId: e.id } };
          }
        }
      }
      // 记号
      for (const mark of piece.marks) {
        const p = resolveMarkPoint(piece, mark);
        if (!p) continue;
        const sp = this.w2s({ x: p.x + offset.x, y: p.y + offset.y });
        if (Math.hypot(sp.x - pt.x, sp.y - pt.y) <= 6) {
          return { selection: { kind: 'mark', pieceId: piece.id, markId: mark.id } };
        }
      }
    }
    return null;
  }
}

function shiftedVerts(v: Record<string, Vec2>, off: Vec2): Record<string, Vec2> {
  const out: Record<string, Vec2> = {};
  for (const [k, p] of Object.entries(v)) out[k] = { x: p.x + off.x, y: p.y + off.y };
  return out;
}
