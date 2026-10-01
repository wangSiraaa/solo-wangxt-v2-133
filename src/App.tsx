import { useState } from 'react';
import { StoreProvider, useStore } from './state/store';
import { CanvasView } from './ui/CanvasView';
import type { TransferDraft } from './ui/CanvasView';
import { Sidebar } from './ui/Sidebar';
import { downloadSvg } from './core/exportSvg';
import { MM_PER_IN } from './core/units';

function Toolbar({
  draft,
  setDraft
}: {
  draft: TransferDraft | null;
  setDraft: (d: TransferDraft | null) => void;
}) {
  const store = useStore();
  return (
    <div className="toolbar">
      <span className="title">纸样工程工具</span>
      <button onClick={store.undo} disabled={!store.canUndo || store.pending !== null}>撤销</button>
      <button onClick={store.redo} disabled={!store.canRedo || store.pending !== null}>重做</button>
      <span className="muted">
        v{store.current.version} / {store.versions.length}
      </span>
      <div style={{ flex: 1 }} />
      <span className="muted">{store.meta.name}</span>
      <select
        value={store.unit}
        onChange={(e) => store.setUnit(e.target.value as 'mm' | 'in')}
        title="单位只影响显示，内部恒为毫米"
      >
        <option value="mm">mm（内部单位）</option>
        <option value="in">英寸 in（仅显示）</option>
      </select>
      <span className="muted" title="当前显示换算">
        1in = {MM_PER_IN}mm
      </span>
      <button onClick={() => void store.save()}>保存</button>
      <button
        className="primary"
        onClick={() => downloadSvg(store.current)}
        disabled={!store.report.ok}
        title={store.report.ok ? '从当前已提交版本导出（含比例尺）' : '当前版本校验未通过，禁止导出'}
      >
        导出 SVG
      </button>
      {draft && <button className="danger" onClick={() => setDraft(null)}>取消选边</button>}
    </div>
  );
}

function Workspace() {
  const [draft, setDraft] = useState<TransferDraft | null>(null);
  return (
    <div className="app">
      <Toolbar draft={draft} setDraft={setDraft} />
      <CanvasView draft={draft} onDraftChange={setDraft} />
      <Sidebar draft={draft} setDraft={setDraft} />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Workspace />
    </StoreProvider>
  );
}
