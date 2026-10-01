/**
 * 右侧工作台：选择检视、省道转移命令、校验报告（数值/退化原因）、
 * 版本历史（撤销/重做/跳转）、容差、导入导出、迁移隔离区。
 */
import { useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { migrate } from '../core/migrate';
import { downloadSvg } from '../core/exportSvg';
import { formatMm, formatAngle } from '../core/units';
import { edgeLength } from '../core/geometry';
import type { Piece, ProjectData } from '../core/types';
import type { TransferDraft } from './CanvasView';

export function Sidebar({
  draft,
  setDraft
}: {
  draft: TransferDraft | null;
  setDraft: (d: TransferDraft | null) => void;
}) {
  const store = useStore();
  const piece = store.selectedPiece;

  return (
    <div className="sidebar">
      <PendingCard />
      <TransferCard draft={draft} setDraft={setDraft} />
      <ValidationCard />
      <InspectorCard piece={piece} />
      <TolerancesCard />
      <HistoryCard />
      <ProjectIoCard />
      <QuarantineCard />
    </div>
  );
}

function PendingCard() {
  const store = useStore();
  if (!store.pending) {
    return (
      <div className="card">
        <span className={`badge ${store.backend === 'clipper2-wasm' ? 'ok' : 'warn'}`}>
          布尔后端：{store.backend === 'pending' ? '等待首次校验' : store.backend}
        </span>{' '}
        <span className={`badge ${store.report.ok ? 'ok' : 'bad'}`}>
          {store.report.ok ? '当前版本校验通过' : '当前版本存在退化'}
        </span>
      </div>
    );
  }
  return (
    <div className="card">
      <span className="badge info">计算中 gen={store.pending.gen}</span>
      <div className="muted" style={{ marginTop: 4 }}>
        可继续编辑或取消；迟到结果将按 requestId + 工程代次核对后丢弃。
      </div>
    </div>
  );
}

function TransferCard({
  draft,
  setDraft
}: {
  draft: TransferDraft | null;
  setDraft: (d: TransferDraft | null) => void;
}) {
  const store = useStore();
  const current = store.current;
  const [pieceId, setPieceId] = useState(current.data.pieces[0]?.id ?? '');
  const [dartId, setDartId] = useState('');
  const [edgeId, setEdgeId] = useState('');
  const [fraction, setFraction] = useState(0.5);
  const [promote, setPromote] = useState(false);

  const pieces = current.data.pieces;
  const activePieceId = pieceId || pieces[0]?.id;
  const piece: Piece | undefined = pieces.find((p) => p.id === activePieceId);
  const darts = piece?.darts ?? [];
  const activeDartId = dartId || darts[0]?.id;
  const outerEdges = (piece?.edges ?? []).filter((e) => e.kind === 'outer');

  const startPicking = () => {
    if (!piece || !activeDartId) return;
    setDraft({ pieceId: piece.id, dartId: activeDartId, edgeId: edgeId || outerEdges[0]?.id || '', fraction });
  };

  const submit = () => {
    if (!piece || !activeDartId) return;
    const targetEdge = draft?.edgeId || edgeId;
    const f = draft?.fraction ?? fraction;
    store.requestTransfer(piece.id, {
      dartId: activeDartId,
      targetEdgeId: targetEdge,
      targetFraction: f,
      promoteHitMarks: promote
    });
    setDraft(null);
  };

  return (
    <div className="card">
      <h3>省道转移（事务命令）</h3>
      <div className="row">
        <label>裁片</label>
        <select
          value={activePieceId}
          onChange={(e) => {
            setPieceId(e.target.value);
            setDartId('');
            setEdgeId('');
            setDraft(null);
          }}
        >
          {pieces.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>省道（省尖）</label>
        <select value={activeDartId} onChange={(e) => setDartId(e.target.value)}>
          {darts.map((d) => (
            <option key={d.id} value={d.id}>{d.id} → {d.apex}</option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>新省口外边</label>
        <select
          value={draft?.edgeId || edgeId}
          onChange={(e) => {
            setEdgeId(e.target.value);
            if (draft) setDraft({ ...draft, edgeId: e.target.value });
          }}
        >
          {outerEdges.map((e) => (
            <option key={e.id} value={e.id}>
              {e.id} ({e.from}→{e.to}){e.cubic ? ' 曲线' : ' 直线'}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>弧长位置 {(draft?.fraction ?? fraction * 1).toFixed(3)}</label>
        <input
          type="range"
          min={0.001}
          max={0.999}
          step={0.001}
          value={draft?.fraction ?? fraction}
          onChange={(e) => {
            const v = Number(e.target.value);
            setFraction(v);
            if (draft) setDraft({ ...draft, fraction: v });
          }}
        />
      </div>
      <div className="row">
        <label>剪线命中旧记号</label>
        <label style={{ flex: 1, fontSize: 12 }}>
          <input type="checkbox" checked={promote} onChange={(e) => setPromote(e.target.checked)} />{' '}
          命中时提升为新省口记号（否则拒绝提交）
        </label>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {!draft ? (
          <button onClick={startPicking}>在画面上点选新省口</button>
        ) : (
          <button className="ghost" onClick={() => setDraft(null)}>退出选边</button>
        )}
        <button className="primary" onClick={submit} disabled={store.pending !== null}>
          提交转移（事务）
        </button>
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        任一闭合/自交/省腿长度/记号方向校验失败，当前版本都不会被替换。
      </div>
    </div>
  );
}

function ValidationCard() {
  const store = useStore();
  const r = store.report;
  return (
    <div className="card">
      <h3>校验（数值容差可见）</h3>
      <div className="kv">
        <span className="k">结果</span>
        <span className={`badge ${r.ok ? 'ok' : 'bad'}`}>{r.ok ? '通过' : '失败'}</span>
        <span className="k">最大闭合缺口</span>
        <span className="mono">{r.maxClosureGap === Infinity ? '∞' : r.maxClosureGap.toFixed(4)} mm / {r.tolerances.closure} mm</span>
        <span className="k">最大省腿长度差</span>
        <span className="mono">{r.maxLegDelta.toFixed(3)} mm / {r.tolerances.legLength} mm</span>
        <span className="k">自交容差</span>
        <span className="mono">{r.tolerances.selfIntersect} mm</span>
        <span className="k">记号方向容差</span>
        <span className="mono">{formatAngle(r.tolerances.markDir)}</span>
      </div>
      {!r.ok && (
        <div style={{ marginTop: 8 }}>
          {r.reasons.map((reason, i) => (
            <div className="reason" key={i}>
              <div><strong>[{reason.code}]</strong> {reason.message}</div>
              {reason.measured !== undefined && (
                <div className="measured">
                  实测 {reason.measured === Infinity ? '∞' : reason.measured}
                  {reason.limit !== undefined ? ` / 允许 ${reason.limit}` : ''}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        通过依据是解析 + Clipper 布尔数值判定，不是“画面看起来闭合”。
      </div>
    </div>
  );
}

function InspectorCard({ piece }: { piece: Piece | null }) {
  const store = useStore();
  const sel = store.selection;
  if (!sel || !piece) {
    return (
      <div className="card">
        <h3>检视</h3>
        <div className="muted">点击顶点 / 边 / 省尖 / 记号查看身份与数值。可直接拖拽顶点（mouseup 时按整条命令提交）。</div>
      </div>
    );
  }
  const unit = store.unit;
  return (
    <div className="card">
      <h3>检视 · {sel.kind}</h3>
      {sel.kind === 'vertex' && (
        <VertexInspector piece={piece} vertexId={sel.vertexId} />
      )}
      {sel.kind === 'edge' && <EdgeInspector piece={piece} edgeId={sel.edgeId} />}
      {sel.kind === 'dart' && <DartInspector piece={piece} dartId={sel.dartId} />}
      {sel.kind === 'mark' && (
        <div>
          <div>mark id: <code>{sel.markId}</code></div>
          {piece.marks.filter((m) => m.id === sel.markId).map((m) => (
            <div key={m.id} className="kv" style={{ marginTop: 6 }}>
              <span className="k">类型</span><span>{m.kind}</span>
              <span className="k">绑定</span>
              <span>{m.edgeId ? `边 ${m.edgeId} @ ${(m.arcFraction ?? 0).toFixed(4)}（弧长分数，重新离散不改绑）` : m.vertexId ? `顶点 ${m.vertexId}` : '世界坐标'}</span>
              <span className="k">方向</span><span>{m.direction !== undefined ? formatAngle(m.direction) : '—'}</span>
            </div>
          ))}
        </div>
      )}
      <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
        裁片：{piece.name} · 显示单位 {unit}（内部恒 mm）
      </div>
    </div>
  );
}

function VertexInspector({ piece, vertexId }: { piece: Piece; vertexId: string }) {
  const p = piece.vertices[vertexId];
  const store = useStore();
  return (
    <div className="kv">
      <span className="k">稳定 id</span><span><code>{vertexId}</code></span>
      <span className="k">X</span>
      <EditableNum
        value={p.x}
        onCommit={(x) => store.commitMoveVertex(piece.id, vertexId, { ...p, x })}
      />
      <span className="k">Y</span>
      <EditableNum
        value={p.y}
        onCommit={(y) => store.commitMoveVertex(piece.id, vertexId, { ...p, y })}
      />
    </div>
  );
}

function EditableNum({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(value.toFixed(3));
  return (
    <input
      type="number"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(Number(v))}
      onKeyDown={(e) => e.key === 'Enter' && onCommit(Number(v))}
    />
  );
}

function EdgeInspector({ piece, edgeId }: { piece: Piece; edgeId: string }) {
  const e = piece.edges.find((x) => x.id === edgeId)!;
  const l = edgeLength(e, piece.vertices);
  return (
    <div className="kv">
      <span className="k">稳定 id</span><span><code>{e.id}</code></span>
      <span className="k">类型</span><span>{e.kind === 'dartLeg' ? '省腿' : '外边'}{e.cubic ? ' · 三次曲线' : ' · 直线'}</span>
      <span className="k">端点</span><span>{e.from} → {e.to}</span>
      <span className="k">弧长</span><span className="mono">{l.toFixed(3)} mm</span>
      {e.provenance && <><span className="k">溯源</span><span>{e.provenance.join(' ← ')}</span></>}
    </div>
  );
}

function DartInspector({ piece, dartId }: { piece: Piece; dartId: string }) {
  const d = piece.darts.find((x) => x.id === dartId)!;
  const l1 = piece.edges.find((e) => e.id === d.leg1)!;
  const l2 = piece.edges.find((e) => e.id === d.leg2)!;
  const a = edgeLength(l1, piece.vertices);
  const b = edgeLength(l2, piece.vertices);
  const apex = piece.vertices[d.apex];
  return (
    <div className="kv">
      <span className="k">省道 id</span><span><code>{d.id}</code></span>
      <span className="k">省尖（稳定）</span><span>{d.apex} ({apex.x.toFixed(1)}, {apex.y.toFixed(1)})</span>
      <span className="k">腿1 长度</span><span className="mono">{a.toFixed(3)} mm</span>
      <span className="k">腿2 长度</span><span className="mono">{b.toFixed(3)} mm</span>
      <span className="k">长度差 Δ</span>
      <span className={`mono ${Math.abs(a - b) > piece.seamAllowance ? '' : ''}`}>{Math.abs(a - b).toFixed(4)} mm</span>
    </div>
  );
}

function TolerancesCard() {
  const store = useStore();
  const t = store.projectData.tolerances;
  const field = (key: keyof typeof t, label: string, step: number) => (
    <div className="row">
      <label>{label}</label>
      <input
        type="number"
        step={step}
        defaultValue={t[key]}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            store.updateTolerances({ ...t, [key]: Number((e.target as HTMLInputElement).value) });
          }
        }}
        onBlur={(e) => store.updateTolerances({ ...t, [key]: Number(e.target.value) })}
      />
    </div>
  );
  return (
    <div className="card">
      <h3>数值容差（mm/弧度）</h3>
      {field('closure', '闭合缺口', 0.01)}
      {field('selfIntersect', '自交 epsilon', 0.005)}
      {field('legLength', '省腿等长', 0.05)}
      {field('cutHit', '剪线命中记号', 0.1)}
      {field('tessellation', '离散步长', 0.25)}
      <div className="muted" style={{ fontSize: 11 }}>修改容差本身也作为一次提交，经 Worker 重新校验。</div>
    </div>
  );
}

function HistoryCard() {
  const store = useStore();
  return (
    <div className="card">
      <h3>版本历史（撤销/重做按整次操作）</h3>
      <div className="row">
        <button onClick={store.undo} disabled={!store.canUndo || store.pending !== null}>↶ 撤销</button>
        <button onClick={store.redo} disabled={!store.canRedo || store.pending !== null}>↷ 重做</button>
        <span className="muted">gen={store.gen}</span>
      </div>
      <div style={{ maxHeight: 170, overflowY: 'auto' }}>
        {store.versions.map((v, i) => (
          <div
            key={v.version}
            className={`history-item ${i === store.versions.indexOf(store.current) ? 'current' : ''}`}
            onClick={() => {
              const cur = store.versions.indexOf(store.current);
              if (i < cur) for (let k = 0; k < cur - i; k++) store.undo();
              else for (let k = 0; k < i - cur; k++) store.redo();
            }}
          >
            <span>v{v.version} · {v.label}</span>
            <span className={`badge ${v.report.ok ? 'ok' : 'bad'}`}>{v.report.ok ? '✓' : '×'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectIoCard() {
  const store = useStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const onImport = async (f: File) => {
    try {
      const json = JSON.parse(await f.text());
      const result = migrate(json);
      const withQ: ProjectData = {
        ...result.data,
        migratedFrom: result.sourceFormatVersion,
        migrationSteps: result.steps,
        readonlyQuarantine: result.quarantine
      } as ProjectData;
      store.loadData(result.data, {
        name: f.name.replace(/\.json$/, ''),
        quarantine: result.quarantine,
        steps: result.steps,
        migratedFrom: result.sourceFormatVersion
      });
      void withQ;
    } catch (err) {
      alert(`导入失败：${(err as Error).message}`);
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(store.current.data, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `project-v${store.current.version}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card">
      <h3>工程（IndexedDB / 文件）</h3>
      <div className="row">
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
        />
        <button onClick={() => fileRef.current?.click()}>导入旧工程（显式迁移）</button>
        <button onClick={exportJson}>导出 JSON</button>
      </div>
      <div className="row">
        <button className="primary" onClick={() => void store.save()}>保存到本地（带版本）</button>
        <button onClick={() => downloadSvg(store.current)} disabled={!store.report.ok}>
          导出 SVG（比例尺）
        </button>
      </div>
      <div className="row">
        <button onClick={store.newProject}>新建样例工程</button>
        <span className="muted">{store.dirty ? '● 未保存' : '已保存'}</span>
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        SVG 仅在当前已提交版本校验通过时可导出，内容来自同一版本的冻结派生物。
      </div>
    </div>
  );
}

function QuarantineCard() {
  const store = useStore();
  if (!store.quarantine.length && store.migratedFrom === undefined) return null;
  return (
    <div className="card">
      <h3>迁移与只读隔离区</h3>
      {store.migratedFrom !== undefined && (
        <div className="muted" style={{ marginBottom: 6 }}>
          来源格式 v{store.migratedFrom} → v2
        </div>
      )}
      <ol style={{ margin: 0, paddingLeft: 16 }}>
        {store.migrationSteps.map((s, i) => (
          <li key={i} style={{ fontSize: 11 }}>{s}</li>
        ))}
      </ol>
      {store.quarantine.map((q, i) => (
        <div className="quarantine-item" key={i}>
          <div><strong>[{q.kind}]</strong> {q.reason}</div>
          <details>
            <summary>只读原始副本（不参与运算/导出）</summary>
            <pre className="raw">{JSON.stringify(q.raw, null, 2)}</pre>
          </details>
        </div>
      ))}
    </div>
  );
}
