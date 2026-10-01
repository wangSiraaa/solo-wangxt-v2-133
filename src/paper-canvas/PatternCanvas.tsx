import { useEffect, useRef, useState } from 'react';
import paper from 'paper';
import type { ProjectData, SelectionState, Vec } from '../model/types';
import { rebuildPiece, type DerivedPiece } from '../geometry/rebuild';
import { applySpec, buildScreenPath } from './buildPath';
import type { OffsetResult } from '../worker/client';

export interface SlashAim {
  apexId: string;
  angle: number;
  length: number;
}

interface Props {
  data: ProjectData;
  pieceId: string;
  selection: SelectionState | null;
  allowances?: Record<string, OffsetResult>;
  aim?: SlashAim | null;
  onPick?: (sel: SelectionState | null) => void;
}

interface HitInfo {
  id: string;
  kind: SelectionState['kind'];
}

/**
 * 纯派生渲染：每次 data/version 变化，从源模型完全重建 Paper 场景，
 * 不保留任何可变几何状态——稳定身份通过 feature id 承载，不随离散漂移。
 */
export function PatternCanvas({ data, pieceId, selection, allowances, aim, onPick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scopeRef = useRef<paper.PaperScope | null>(null);
  const [canvasError, setCanvasError] = useState(false);
  const layersRef = useRef<{
    root: paper.Group;
    seam?: paper.Path;
    cut?: paper.Group;
    dart?: paper.Group;
    notches?: paper.Group;
    marks?: paper.Group;
    aim?: paper.Group;
    hit: Map<paper.Item, HitInfo>;
  } | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const selRef = useRef(selection);
  selRef.current = selection;

  // 初始化 scope
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let scope: paper.PaperScope;
    try {
      if (!canvas.getContext('2d')) throw new Error('no 2d context');
      scope = new paper.PaperScope();
      scope.setup(canvas);
    } catch {
      // 无 Canvas 2D 后端（如 jsdom）时降级，不影响其余 UI 与命令逻辑
      setCanvasError(true);
      return;
    }
    scopeRef.current = scope;
    render();
    return () => {
      try { scope.project?.remove(); } catch { /* noop */ }
      scopeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 视图居中
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    const piece = data.pieces[pieceId];
    if (!piece) return;
    const dp = rebuildPiece(data, piece);
    const bb = dp.bbox;
    scope.view.update();
    // 简单自适应：按画布尺寸缩放到 ~80%
    const fit = () => {
      const w = (canvasRef.current?.clientWidth ?? 800) - 80;
      const h = (canvasRef.current?.clientHeight ?? 600) - 80;
      const gw = Math.max(bb.max.x - bb.min.x, 1);
      const gh = Math.max(bb.max.y - bb.min.y, 1);
      const s = Math.min(w / gw, h / gh, 2);
      scope.view.zoom = s;
      scope.view.center = new scope.Point((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2);
    };
    fit();
    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieceId]);

  // 渲染
  useEffect(() => {
    render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, pieceId, selection, allowances, aim]);

  const render = () => {
    const scope = scopeRef.current;
    const canvas = canvasRef.current;
    if (!scope || !canvas) return;
    scope.activate();
    scope.project?.clear();
    const piece = data.pieces[pieceId];
    if (!piece) return;
    const dp = rebuildPiece(data, piece);
    const hit = new Map<paper.Item, HitInfo>();
    const root = new scope.Group();

    // 裁剪轮廓（缝份外轮廓，若 worker 已返回）
    const off = allowances?.[pieceId];
    if (off) {
      const cutGroup = new scope.Group({ parent: root });
      for (const poly of off.outer) drawPolygon(scope, cutGroup, poly, { strokeColor: '#b23b3b', dash: [6, 4] }, hit, 'edge', piece.id);
      for (const poly of off.holes) drawPolygon(scope, cutGroup, poly, { strokeColor: '#b23b3b', dash: [3, 3] }, hit, 'edge', piece.id);
    }

    // 缝线（精确曲线）
    const spec = buildScreenPath(data, piece);
    const seam = applySpec(scope, new scope.Path(), spec);
    seam.strokeColor = new scope.Color('#111827');
    seam.strokeWidth = 0.4;
    seam.fillColor = new scope.Color(17, 24, 39, 0.04);
    seam.parent = root;
    hit.set(seam, { id: piece.id, kind: 'piece' });

    // 省腿（内缝，闭合省虚线）
    const dartGroup = new scope.Group({ parent: root });
    for (const leg of dp.dartLegs) {
      const p = new scope.Path({
        segments: leg.polyline.map((q) => [q.x, q.y]),
        strokeColor: '#7c3aed',
        strokeWidth: 0.3,
        dashArray: [2, 2],
      });
      p.parent = dartGroup;
      hit.set(p, { id: leg.dartId, kind: 'dart' });
    }

    // 记号：沿法向的剪口短线 + 钻孔圆点
    const markGroup = new scope.Group({ parent: root });
    for (const n of dp.notches) {
      const tip = { x: n.pos.x + n.normal.x * 4, y: n.pos.y + n.normal.y * 4 };
      const tick = new scope.Path.Line({
        from: [n.pos.x, n.pos.y],
        to: [tip.x, tip.y],
        strokeColor: '#0f766e',
        strokeWidth: 0.5,
      });
      tick.parent = markGroup;
      hit.set(tick, { id: n.id, kind: 'notch' });
      if (n.kind === 'drill') {
        const c = new scope.Path.Circle({ center: [n.pos.x, n.pos.y], radius: 1.2, strokeColor: '#0f766e', fillColor: '#0f766e' });
        c.parent = markGroup;
        hit.set(c, { id: n.id, kind: 'notch' });
      }
    }

    // 丝缕线
    const g = piece.grainline;
    const half = g.length / 2;
    const dx = Math.cos(g.angle) * half;
    const dy = Math.sin(g.angle) * half;
    const grain = new scope.Path.Line({
      from: [g.at.x - dx, g.at.y - dy],
      to: [g.at.x + dx, g.at.y + dy],
      strokeColor: '#374151',
      strokeWidth: 0.3,
    });
    grain.parent = markGroup;

    // 特征点
    const pointGroup = new scope.Group({ parent: root });
    for (const pid of piece.loop.pointIds) {
      const pt = data.points[pid];
      if (!pt) continue;
      const isApex = pt.kind === 'dartApex';
      const c = new scope.Path.Circle({
        center: [pt.pos.x, pt.pos.y],
        radius: isApex ? 2.0 : 1.3,
        fillColor: isApex ? '#dc2626' : '#2563eb',
      });
      c.parent = pointGroup;
      hit.set(c, { id: pid, kind: 'point' });
    }

    // 剪线瞄准预览
    if (aim) {
      const apex = data.points[aim.apexId]?.pos;
      if (apex) {
        const end = { x: apex.x + Math.cos(aim.angle) * aim.length, y: apex.y + Math.sin(aim.angle) * aim.length };
        const ray = new scope.Path.Line({
          from: [apex.x, apex.y],
          to: [end.x, end.y],
          strokeColor: '#ea580c',
          strokeWidth: 0.4,
          dashArray: [4, 3],
        });
        ray.parent = new scope.Group({ parent: root, name: 'aim' });
      }
    }

    // 选中高亮
    if (selRef.current) {
      const s = selRef.current;
      if (s.kind === 'point') {
        const pt = data.points[s.id]?.pos;
        if (pt) {
          const ring = new scope.Path.Circle({ center: [pt.x, pt.y], radius: 3.2, strokeColor: '#f59e0b', strokeWidth: 0.5 });
          ring.parent = root;
        }
      }
    }

    layersRef.current = { root, seam, hit };
    scope.view.update();
  };

  // 交互：点击命中
  useEffect(() => {
    const scope = scopeRef.current;
    const canvas = canvasRef.current;
    if (!scope || !canvas) return;
    const tool = new scope.Tool();
    tool.onMouseDown = (ev: paper.ToolEvent) => {
      const layers = layersRef.current;
      if (!layers) return;
      let picked: HitInfo | null = null;
      const pt = ev.point;
      let best = Infinity;
      for (const [item, info] of layers.hit) {
        try {
          if ('bounds' in item && (item as paper.Path).contains?.(pt)) {
            // piece 区域命中优先级低：找最近的细对象
            if (info.kind === 'piece') {
              const d = (item as paper.Path).position.getDistance(pt);
              if (d < best && d < 60) { best = d; picked = info; }
              continue;
            }
          }
          // 统一用最近距离判定（细线条/点）
          const anyItem = item as unknown as { position?: paper.Point; segments?: { point: paper.Point }[] };
          let dd = Infinity;
          if ('segments' in item && (item as paper.Path).segments) {
            const pp = item as paper.Path;
            dd = pp.getNearestPoint(pt).getDistance(pt);
          } else if (anyItem.position) {
            dd = anyItem.position.getDistance(pt);
          }
          if (dd < 6 && dd < best) { best = dd; picked = info; }
        } catch {
          // ignore
        }
      }
      pickRef.current?.(picked ? { kind: picked.kind, id: picked.id } : null);
    };
    return () => tool.remove();
  }, []);

  return (
    <div className="canvas-host" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} className="pattern-canvas" data-testid="pattern-canvas" />
      {canvasError && (
        <div className="canvas-fallback" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: 12 }}>
          当前环境无 Canvas 2D 后端，仅显示面板与命令（几何引擎与校验仍在运行）
        </div>
      )}
    </div>
  );
}

function drawPolygon(
  scope: paper.PaperScope,
  parent: paper.Group,
  poly: Vec[],
  style: { strokeColor: string; dash?: number[] },
  hit: Map<paper.Item, HitInfo>,
  _kind: SelectionState['kind'],
  pieceId: string,
) {
  if (poly.length < 3) return;
  const p = new scope.Path({
    segments: poly.map((q) => [q.x, q.y]),
    closed: true,
    strokeColor: style.strokeColor,
    strokeWidth: 0.35,
    dashArray: style.dash,
  });
  p.parent = parent;
  hit.set(p, { id: pieceId, kind: 'piece' });
}

export type { DerivedPiece };
