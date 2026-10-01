/**
 * 画布视图：Paper.js 场景宿主。
 * - 只渲染已提交版本（current）；转移预检后到提交完成期间叠加绿色预览；
 * - 命中选择回传稳定身份；顶点拖拽以鼠标移动做临时显示、mouseup 才作为
 *   一条“移动顶点”命令提交（不产生半截几何）；
 * - 在途计算时显示提示；撤销/重做/取消后由 gen/version 变化触发重绘。
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { PatternScene } from '../render/PatternScene';
import type { Vec2 } from '../core/types';
import { pointAtArcFraction } from '../core/geometry';
import { pivotTransfer } from '../core/pivot';

export interface TransferDraft {
  pieceId: string;
  dartId: string;
  edgeId: string;
  fraction: number;
}

export function CanvasView({
  draft,
  onDraftChange
}: {
  draft: TransferDraft | null;
  onDraftChange: (d: TransferDraft | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PatternScene | null>(null);
  const store = useStore();
  const { current, selection, pending, gen, derived, report } = store;
  const [previewData, setPreviewData] = useState<ReturnType<typeof buildPreview> | null>(null);
  const dragRef = useRef<{ pieceId: string; vertexId: string } | null>(null);
  const dragLive = useRef<{ x: number; y: number } | null>(null);

  // 初始化
  useEffect(() => {
    if (!canvasRef.current || !wrapRef.current) return;
    const scene = new PatternScene(canvasRef.current);
    sceneRef.current = scene;
    const resize = () => {
      const r = wrapRef.current!.getBoundingClientRect();
      scene.resize(r.width, r.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // 已提交版本变化 → 重绘
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.render(current, selection, { pending: !!pending });
    if (previewData && !pending) setPreviewData(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.version, current.committedAt, selection, pending, gen]);

  // 转移草稿实时预览（纯本地构造，不触碰已提交版本）
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (!draft) {
      setPreviewData(null);
      scene.render(current, selection, { pending: !!pending });
      return;
    }
    try {
      const piece = current.data.pieces.find((p) => p.id === draft.pieceId)!;
      const res = pivotTransfer(piece, {
        dartId: draft.dartId,
        targetEdgeId: draft.edgeId,
        targetFraction: draft.fraction,
        hitRadius: current.data.tolerances.cutHit,
        promoteHitMarks: true // 预览阶段允许看形；真正提交由面板复选框决定
      });
      const nextData = {
        ...current.data,
        pieces: current.data.pieces.map((p) =>
          p.id === draft.pieceId ? res.piece : p
        )
      };
      scene.render(current, selection, { pending: !!pending });
      scene.renderPreview(current, nextData);
      setPreviewData(nextData);
    } catch {
      scene.render(current, selection, { pending: !!pending });
      setPreviewData(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, current.version]);

  const onPointerDown = (ev: React.PointerEvent) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const sp = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    const hit = scene.hitTest(sp, current);
    if (!hit || !hit.selection) {
      store.setSelection(null);
      onDraftChange(null);
      return;
    }
    const hitSel = hit.selection;
    store.setSelection(hitSel);
    if (hitSel.kind === 'vertex' && !draft) {
      dragRef.current = {
        pieceId: hitSel.pieceId,
        vertexId: hitSel.vertexId
      };
      (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    }
    if (draft && hitSel.kind === 'edge' && hitSel.pieceId === draft.pieceId) {
      // 选择转移目标外边，并在边上按点击位置定弧长分数
      const piece = current.data.pieces.find((p) => p.id === hitSel.pieceId)!;
      const edge = piece.edges.find((e) => e.id === hitSel.edgeId);
      if (edge && edge.kind === 'outer') {
        const world = scene.screenToWorld(sp);
        const f = nearestArcFraction(world, piece, edge.id);
        if (f !== null) onDraftChange({ ...draft, edgeId: edge.id, fraction: f });
      }
    }
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (!dragRef.current) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const world = scene.screenToWorld({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
    dragLive.current = world;
    // 临时拖动显示：改本地派生显示（把顶点平移），不提交
    const live = cloneWithVertex(current.data, dragRef.current.pieceId, dragRef.current.vertexId, world);
    scene.render(
      { ...current, data: live },
      selection,
      { pending: !!pending }
    );
  };

  const onPointerUp = () => {
    if (dragRef.current && dragLive.current) {
      store.commitMoveVertex(dragRef.current.pieceId, dragRef.current.vertexId, dragLive.current);
    }
    dragRef.current = null;
    dragLive.current = null;
  };

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {pending && (
        <div className="pending-bar">
          <span>
            校验中（gen={pending.gen} · {pending.label}）…
          </span>
          <button onClick={store.cancelPending}>取消任务</button>
        </div>
      )}
      {draft && (
        <div className="pending-bar" style={{ background: '#1e3a8a', color: '#dbeafe', top: 52 }}>
          <span>转移目标边：{draft.edgeId} · 弧长 {(draft.fraction * 100).toFixed(1)}%</span>
          <button onClick={() => onDraftChange(null)}>退出选边</button>
        </div>
      )}
      <Notices />
      <div style={{ position: 'absolute', left: 10, bottom: 8, fontSize: 11, color: '#6b7280' }}>
        已提交 v{current.version} · 派生环点 {derived.reduce((a, d) => a + d.seamLoop.length, 0)} ·
        校验缺口 {report.maxClosureGap.toFixed(4)}mm
      </div>
    </div>
  );
}

function buildPreview() {
  return null as unknown as import('../core/types').ProjectData;
}

function cloneWithVertex(
  data: import('../core/types').ProjectData,
  pieceId: string,
  vertexId: string,
  pos: Vec2
): import('../core/types').ProjectData {
  return {
    ...data,
    pieces: data.pieces.map((p) =>
      p.id === pieceId
        ? { ...p, vertices: { ...p.vertices, [vertexId]: pos } }
        : p
    )
  };
}

/** 屏幕命中点到边的弧长分数（用源曲线逐段距离，避免二次改绑） */
function nearestArcFraction(
  world: Vec2,
  piece: import('../core/types').Piece,
  edgeId: string
): number | null {
  const e = piece.edges.find((x) => x.id === edgeId);
  if (!e) return null;
  let best = 0.5;
  let bestD = Infinity;
  const N = 80;
  for (let i = 0; i <= N; i++) {
    const p = pointAtArcFraction(e, piece.vertices, i / N);
    const d = (p.x - world.x) ** 2 + (p.y - world.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i / N;
    }
  }
  return Math.min(0.999, Math.max(0.001, best));
}

function Notices() {
  const store = useStore();
  return (
    <div className="notices">
      {store.notices.slice(-4).map((n) => (
        <div key={n.at} className={`notice ${n.level}`}>
          <span>{n.text}</span>
          <button className="ghost" onClick={() => store.dismissNotice(n.at)}>×</button>
        </div>
      ))}
    </div>
  );
}
