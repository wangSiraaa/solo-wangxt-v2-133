import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from './state/editor';
import { createSkirtProject } from './model/sample';
import { ClipperClient } from './worker/client';
import { useAllowances } from './state/useAllowances';
import { PatternCanvas, type SlashAim } from './paper-canvas/PatternCanvas';
import { exportSvg, downloadSvg } from './paper-canvas/svgExport';
import { ProjectStore } from './storage/idb';
import { formatLength } from './ui/units';
import type { SelectionState } from './model/types';
import type { UnitMode } from './state/editor';

function SeamAllowanceInput({ unit, valueMm, onCommit }: { unit: UnitMode; valueMm: number; onCommit: (mm: number) => void }) {
  const display = unit === 'in' ? (valueMm / 25.4).toFixed(3) : String(valueMm);
  const [text, setText] = useState(display);
  useEffect(() => setText(display), [display]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && v >= 0) onCommit(unit === 'in' ? v * 25.4 : v);
    else setText(display);
  };
  return (
    <label className="row">
      缝份宽（{unit}）
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </label>
  );
}

export function App() {
  const editor = useEditor(useMemo(() => createSkirtProject(), []));
  const { state, data, report } = editor;
  const [client] = useState(() => {
    try {
      return new ClipperClient();
    } catch {
      return null;
    }
  });
  const [workerStatus, setWorkerStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    client?.whenReady().then(() => setWorkerStatus('ready')).catch(() => setWorkerStatus('failed'));
  }, [client]);

  const pieceId = Object.keys(data.pieces)[0];
  const { allowances, busy: allowBusy, ms: allowMs } = useAllowances(
    client,
    data,
    state.gen,
    (pid) => data.pieces[pid]?.seamAllowance ?? 10,
  );

  const [angleDeg, setAngleDeg] = useState('90');
  const [mergeNotch, setMergeNotch] = useState(true);
  const [aim, setAim] = useState<SlashAim | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [store] = useState(() => new ProjectStore());
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedDart = state.selection?.kind === 'dart' ? data.darts[state.selection.id] : null;
  const activeDartId = selectedDart?.id ?? Object.values(data.darts).find((d) => !d.closed)?.id ?? null;

  // 剪线瞄准预览
  useEffect(() => {
    if (!activeDartId) { setAim(null); return; }
    const dart = data.darts[activeDartId];
    const a = (Number(angleDeg) * Math.PI) / 180;
    setAim({ apexId: dart.apex, angle: a, length: 400 });
  }, [activeDartId, angleDeg, state.gen, data]);

  const doTransfer = () => {
    if (!activeDartId) {
      setFeedback({ kind: 'err', text: '请先选择一个未闭合的省' });
      return;
    }
    const angle = (Number(angleDeg) * Math.PI) / 180;
    if (!Number.isFinite(angle)) {
      setFeedback({ kind: 'err', text: '剪切角不是有效数值' });
      return;
    }
    const r = editor.commitTransfer({ pieceId, dartId: activeDartId, angle, mergeHitNotch: mergeNotch });
    if (r.ok) {
      const a = r.audit!;
      setFeedback({
        kind: 'ok',
        text: `转移已提交（版本 ${state.head + 2}）：旋转 ${a.rotationAngleDeg.toFixed(2)}°，闭合间隙 ${a.legClosureGap.toExponential(1)}mm，新省腿 ${a.newLegLength.toFixed(2)}mm${a.mergedNotchIds.length ? `，命中旧记号 ${a.mergedNotchIds.join(',')}` : ''}`,
      });
    } else {
      setFeedback({ kind: 'err', text: r.error!.message });
    }
  };

  const doExportSvg = () => {
    const snap = state.project.versions[state.head];
    if (!snap.report.ok) {
      setFeedback({ kind: 'err', text: `当前版本存在 ${snap.report.issues.length} 项校验问题，仍可导出用于审阅，但 SVG 元数据会如实标注未通过` });
    }
    const svg = exportSvg({ version: snap, allowances, tolerance: state.tolerance, unit: state.unit });
    downloadSvg(`${state.project.name.replace(/\s+/g, '_')}_v${snap.version}.svg`, svg);
  };

  const doSave = async () => {
    setSaved('saving');
    try {
      await store.save(state.project);
      setSaved('saved');
      setTimeout(() => setSaved('idle'), 1500);
    } catch {
      setSaved('error');
    }
  };

  const doImport = async (file: File) => {
    const text = await file.text();
    try {
      const raw = JSON.parse(text);
      const r = await store.importRaw(raw);
      if (r.project) {
        editor.replaceProject(r.project);
        setFeedback({
          kind: 'ok',
          text: `已导入并迁移（${r.fromVersion} → v3）。${r.log.join('；')}${r.readonlyObjects.length ? `；${r.readonlyObjects.length} 个对象无法迁移，已保留只读副本` : ''}`,
        });
      } else {
        setFeedback({ kind: 'err', text: `导入失败：${r.fatal}；${r.readonlyObjects.length} 个对象已保留为只读` });
      }
    } catch (e) {
      setFeedback({ kind: 'err', text: `文件不是有效 JSON：${(e as Error).message}` });
    }
  };

  const piece = data.pieces[pieceId];
  const snap = state.project.versions[state.head];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">纸样工程 · Pattern CAD</div>
        <div className="top-actions">
          <span className={`worker-dot ${workerStatus}`} title={`Clipper worker: ${workerStatus}`} />
          <button onClick={editor.undo} disabled={!state.canUndo}>撤销</button>
          <button onClick={editor.redo} disabled={!state.canRedo}>重做</button>
          <span className="sep" />
          <button className={state.unit === 'mm' ? 'active' : ''} onClick={() => editor.setUnit('mm')}>毫米</button>
          <button className={state.unit === 'in' ? 'active' : ''} onClick={() => editor.setUnit('in')}>英寸</button>
          <span className="sep" />
          <button onClick={doSave}>{saved === 'saving' ? '保存中…' : '保存到本地'}</button>
          <button onClick={() => fileRef.current?.click()}>导入旧工程</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.currentTarget.value = ''; }}
          />
          <button onClick={doExportSvg} disabled={!report.ok && !snap}>导出 SVG（已提交版本 v{snap.version}）</button>
        </div>
      </header>

      <main className="main">
        <aside className="panel left">
          <section>
            <h3>省道转移（事务）</h3>
            <label className="row">
              剪切角（度）
              <input value={angleDeg} onChange={(e) => setAngleDeg(e.target.value)} />
            </label>
            <label className="row check">
              <input type="checkbox" checked={mergeNotch} onChange={(e) => setMergeNotch(e.target.checked)} />
              剪线命中旧记号时复制端点记号
            </label>
            <div className="hint">
              当前省：{activeDartId ? data.darts[activeDartId]?.name : '（无未闭合省）'}
              {activeDartId ? `（尖 ${data.darts[activeDartId].apex}）` : ''}
            </div>
            <button className="primary" onClick={doTransfer} disabled={!activeDartId}>提交一次转移</button>
            {feedback && <div className={`feedback ${feedback.kind}`}>{feedback.text}</div>}
          </section>

          <section>
            <h3>裁片 / 缝份</h3>
            <div className="hint">{piece.name} · 缝份</div>
            <SeamAllowanceInput
              unit={state.unit}
              valueMm={piece.seamAllowance}
              onCommit={(mm) => {
                const next: typeof data = JSON.parse(JSON.stringify(data));
                next.pieces[pieceId].seamAllowance = mm;
                editor.commitSnapshot(next, `缝份宽度 → ${mm.toFixed(1)}mm`);
              }}
            />
            <div className="hint">worker: {workerStatus === 'ready' ? `就绪${allowMs ? `（上次 ${allowMs.toFixed(1)}ms）` : ''}` : workerStatus === 'loading' ? 'WASM 加载中…' : '不可用（仅缝线显示）'} {allowBusy ? '· 计算中' : ''}</div>
          </section>

          <section>
            <h3>数值容差（mm）</h3>
            {([
              ['closure', '闭合间隙'],
              ['selfIntersect', '自交穿透'],
              ['zeroEdge', '退化零边'],
              ['legLength', '省腿长度差'],
              ['reattach', '记号/交点漂移'],
              ['hitMerge', '剪线吸附'],
            ] as const).map(([k, label]) => (
              <label className="row" key={k}>
                {label}
                <input
                  value={state.tolerance[k]}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 0) editor.setTolerance({ ...state.tolerance, [k]: v });
                  }}
                />
              </label>
            ))}
          </section>
        </aside>

        <section className="canvas-wrap">
          <PatternCanvas
            data={data}
            pieceId={pieceId}
            selection={state.selection}
            allowances={allowances}
            aim={aim}
            onPick={(sel: SelectionState | null) => editor.setSelection(sel)}
          />
          <div className="canvas-hud">
            代次 gen={state.gen} · 版本 v{snap.version} · 单位 {state.unit === 'mm' ? '毫米' : '英寸（仅显示）'} ·
            {' '}选中：{state.selection ? `${state.selection.kind} ${state.selection.id}` : '无'}
          </div>
        </section>

        <aside className="panel right">
          <section>
            <h3>校验结论</h3>
            <div className={`verdict ${report.ok ? 'ok' : 'bad'}`}>
              {report.ok ? '通过：闭合 / 无自交 / 长度 / 记号方向 全部满足' : `未通过：${report.issues.length} 项`}
            </div>
            <ul className="issues">
              {report.issues.map((iss, i) => (
                <li key={i} className={`sev sev-${iss.code}`}>
                  <code>{iss.code}</code>
                  <div>{iss.message}</div>
                  <div className="meta">
                    容差 {formatLength(iss.tolerance, state.unit, 3)} · 实测 {formatLength(iss.measured, state.unit, 3)} · refs {iss.refs.join(',')}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>版本（撤销/重做按整次操作）</h3>
            <ul className="versions">
              {state.project.versions.map((sn, i) => (
                <li key={sn.version} className={i === state.head ? 'current' : ''}>
                  <button className="vbtn" onClick={() => editor.jumpToVersion(i)} title="恢复到该版本">
                    v{sn.version} {i === state.head ? '●' : '○'}
                  </button>
                  <span>{sn.label}</span>
                  <span className={`badge ${sn.report.ok ? 'ok' : 'bad'}`}>{sn.report.ok ? 'valid' : `${sn.report.issues.length} 问题`}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>无法迁移的只读对象</h3>
            {state.project.readonlyObjects.length === 0 ? (
              <div className="hint">无</div>
            ) : (
              <ul className="readonly">
                {state.project.readonlyObjects.map((ro) => (
                  <li key={ro.id}>
                    <div><code>{ro.id}</code> · {ro.origin}</div>
                    <div className="hint">{ro.reason}</div>
                    <pre>{JSON.stringify(ro.raw).slice(0, 200)}</pre>
                  </li>
                ))}
              </ul>
            )}
            {state.project.migrationLog.length > 0 && (
              <div className="hint">迁移记录：{state.project.migrationLog.join(' → ')}</div>
            )}
          </section>

          <section>
            <h3>审计</h3>
            {state.lastAudit ? (
              <div className="hint">
                {state.lastAudit.label} · 旋转 {state.lastAudit.rotationAngleDeg.toFixed(3)}° ·
                闭合间隙 {state.lastAudit.legClosureGap.toExponential(1)}mm ·
                新省腿 {formatLength(state.lastAudit.newLegLength, state.unit)}
              </div>
            ) : <div className="hint">尚无操作</div>}
          </section>
        </aside>
      </main>
    </div>
  );
}
