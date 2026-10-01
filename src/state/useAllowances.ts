import { useEffect, useRef, useState } from 'react';
import type { ProjectData } from '../model/types';
import { rebuildPiece, geometryFingerprint } from '../geometry/rebuild';
import { ClipperClient, type JobHandle, type OffsetResult } from '../worker/client';

interface AllowanceEntry {
  result: OffsetResult;
  fingerprint: string;
  gen: number;
}

/**
 * 派生缝份/裁剪轮廓。
 * - 指纹覆盖几何 + 缝份宽度，只在真正变化时重算；
 * - gen 随版本前进，版本切换/卸载时显式取消在途任务；
 * - 客户端再次核对 gen/fingerprint，迟到或已取消结果绝不覆盖当前几何。
 */
export function useAllowances(
  client: ClipperClient | null,
  data: ProjectData,
  gen: number,
  allowanceOf: (pieceId: string) => number,
): {
  allowances: Record<string, OffsetResult>;
  busy: boolean;
  ms: number | null;
} {
  const [entries, setEntries] = useState<Record<string, AllowanceEntry>>({});
  const [busy, setBusy] = useState(false);
  const [ms, setMs] = useState<number | null>(null);
  const inflight = useRef<Set<string>>(new Set());
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const pendingHandles: Array<Promise<JobHandle<OffsetResult>>> = [];
    const settledHandles: JobHandle<OffsetResult>[] = [];
    const next: Record<string, AllowanceEntry> = { ...readKeep(data, entriesRef.current) };
    let launched = 0;

    const cancelAll = () => {
      for (const h of settledHandles) h.cancel();
      // 在途的 handle：resolve 后立即取消
      for (const p of pendingHandles) void p.then((h) => h.cancel());
    };

    for (const piece of Object.values(data.pieces)) {
      const dp = rebuildPiece(data, piece);
      const fp = geometryFingerprint(data, piece.id, allowanceOf(piece.id));
      const cached = entriesRef.current[piece.id];
      if (cached && cached.fingerprint === fp && cached.gen <= gen) continue;

      inflight.current.add(piece.id);
      launched += 1;
      const hp = client.offsetJob({
        gen,
        fingerprint: fp,
        polygons: [dp.seamPolyline],
        deltaMm: allowanceOf(piece.id),
        join: 'miter',
      });
      pendingHandles.push(hp);
      void hp.then((handle) => {
        if (cancelled) { handle.cancel(); return; }
        settledHandles.push(handle);
        return handle.promise.then(
          (res) => {
            inflight.current.delete(piece.id);
            setBusy(inflight.current.size > 0);
            setEntries((prev) => ({ ...prev, [piece.id]: { result: res, fingerprint: fp, gen } }));
            setMs(res.ms);
          },
          (e: unknown) => {
            inflight.current.delete(piece.id);
            setBusy(inflight.current.size > 0);
            const code = (e as { code?: string })?.code;
            if (code !== 'STALE_RESULT' && code !== 'CANCELLED' && entriesRef.current[piece.id]) {
              setEntries((prev) => ({ ...prev, [piece.id]: entriesRef.current[piece.id] }));
            }
          },
        );
      });
    }
    if (launched > 0) setBusy(true);

    setEntries((prev) => {
      const out: Record<string, AllowanceEntry> = { ...next };
      for (const [k, v] of Object.entries(prev)) if (k in data.pieces && !(k in out)) out[k] = v;
      return out;
    });

    return cancelAll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, data, gen]);

  const allowances: Record<string, OffsetResult> = {};
  for (const [k, v] of Object.entries(entries)) allowances[k] = v.result;
  return { allowances, busy, ms };
}

function readKeep(data: ProjectData, prev: Record<string, AllowanceEntry>): Record<string, AllowanceEntry> {
  const out: Record<string, AllowanceEntry> = {};
  for (const id of Object.keys(data.pieces)) if (prev[id]) out[id] = prev[id];
  return out;
}
