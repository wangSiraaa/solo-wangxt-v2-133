/**
 * SVG 导出。
 * 硬性约束：
 * - 只能导出一个已提交 VersionEntry（缝合环、裁剪轮廓、记号、比例尺全部来自
 *   同一份快照与其冻结的 derived/worker 产物），禁止从“画面当前看起来的样子”拼；
 * - 比例尺真实长度（50mm）以几何坐标绘制，1 user unit = 1mm；
 * - 校验数值（闭合缺口、省腿差、容差、后端、版本号、提交时间）写入 <metadata>；
 * - 隔离对象不导出几何。
 */
import type { ProjectData, Vec2, VersionEntry } from './types';

const esc = (s: string): string =>
  s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;'
  );

function pathD(pts: Vec2[], yUp: boolean): string {
  if (!pts.length) return '';
  const tr = (p: Vec2): string => `${p.x.toFixed(3)},${(yUp ? -p.y : p.y).toFixed(3)}`;
  return 'M ' + pts.map(tr).join(' L ') + ' Z';
}

export function exportSvg(entry: VersionEntry, options?: { includeCut?: boolean }): string {
  const data: ProjectData = entry.data;
  const includeCut = options?.includeCut ?? true;

  // 统一包围盒（基于已提交派生几何）
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const piece of data.pieces) {
    const d = entry.derived.find((x) => x.pieceId === piece.id);
    const loops = [d?.seamLoop ?? [], ...(d?.cutPaths ?? [])];
    for (const loop of loops)
      for (const p of loop) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
  }
  const margin = 30;
  const w = maxX - minX + margin * 2 + 120;
  const h = maxY - minY + margin * 2 + 70;
  const ox = -minX + margin;
  const oy = maxY + margin; // y-up → svg y-down

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${(w / 10).toFixed(1)}cm" height="${(h / 10).toFixed(1)}cm" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" data-unit="mm" data-committed-version="${entry.version}">`
  );
  parts.push(
    `<metadata>${JSON.stringify({
      kind: 'pattern-studio-export',
      committedVersion: entry.version,
      committedAt: new Date(entry.committedAt).toISOString(),
      label: entry.label,
      formatVersion: data.formatVersion,
      validation: {
        ok: entry.report.ok,
        maxClosureGapMm: entry.report.maxClosureGap,
        maxLegDeltaMm: entry.report.maxLegDelta,
        tolerances: entry.report.tolerances,
        failures: entry.report.reasons
      },
      unit: 'mm (internal; inches are display-only)'
    })}</metadata>`
  );
  parts.push('<g stroke-linejoin="round">');

  for (const piece of data.pieces) {
    const d = entry.derived.find((x) => x.pieceId === piece.id);
    parts.push(`<g data-piece="${esc(piece.id)}" data-name="${esc(piece.name)}">`);

    if (includeCut) {
      for (const cut of d?.cutPaths ?? []) {
        parts.push(
          `<path d="${pathD(cut, true).replace(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g, (_m, x, y) => `${(Number(x) + ox).toFixed(3)},${(Number(y) + oy).toFixed(3)}`)}" fill="none" stroke="#b45309" stroke-width="0.35" stroke-dasharray="1.5 1"/>`
        );
      }
    }

    // 缝合轮廓（用冻结的派生环，与校验同源）
    if (d) {
      parts.push(
        `<path d="${pathD(d.seamLoop, true).replace(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g, (_m, x, y) => `${(Number(x) + ox).toFixed(3)},${(Number(y) + oy).toFixed(3)}`)}" fill="none" stroke="#1f2937" stroke-width="0.5"/>`
      );
    }

    // 记号
    for (const rm of d?.resolvedMarks ?? []) {
      const cx = rm.point.x + ox;
      const cy = -rm.point.y + oy;
      if (rm.kind === 'drill') {
        parts.push(
          `<path d="M ${cx - 1.2} ${cy - 1.2} L ${cx + 1.2} ${cy + 1.2} M ${cx + 1.2} ${cy - 1.2} L ${cx - 1.2} ${cy + 1.2}" stroke="#0369a1" stroke-width="0.4"/>`
        );
      } else {
        const ang = rm.direction ?? 0;
        const tx = cx + Math.cos(ang) * 2.2;
        const ty = cy - Math.sin(ang) * 2.2;
        parts.push(
          `<line x1="${cx.toFixed(2)}" y1="${cy.toFixed(2)}" x2="${tx.toFixed(2)}" y2="${ty.toFixed(2)}" stroke="${rm.pointsInward === false ? '#dc2626' : '#0e7490'}" stroke-width="0.5"/>`
        );
      }
    }
    parts.push(`<text x="${ox.toFixed(1)}" y="${(oy - (maxY - minY) - 6).toFixed(1)}" font-size="4" fill="#374151">${esc(piece.name)}</text>`);
    parts.push('</g>');
  }

  // —— 比例尺：真实 50mm（几何坐标即 mm）——
  const sy = h - 22;
  const sx = margin;
  parts.push(`<g data-role="scale-bar">`);
  for (let i = 0; i < 5; i++) {
    parts.push(
      `<rect x="${sx + i * 10}" y="${sy}" width="10" height="3" fill="${i % 2 ? '#ffffff' : '#111827'}" stroke="#111827" stroke-width="0.2"/>`
    );
  }
  parts.push(
    `<line x1="${sx}" y1="${sy + 3}" x2="${sx + 50}" y2="${sy + 3}" stroke="#111827" stroke-width="0.3"/>`
  );
  parts.push(
    `<text x="${sx + 25}" y="${sy + 9}" font-size="3.2" text-anchor="middle" fill="#111827">50 mm 比例尺 · 1:1（1 单位 = 1 mm）</text>`
  );
  parts.push(`</g>`);
  parts.push(
    `<text x="${sx}" y="${h - 6}" font-size="2.8" fill="${entry.report.ok ? '#15803d' : '#b91c1c'}">v${entry.version} · ${esc(entry.label)} · 闭合缺口 ${entry.report.maxClosureGap.toFixed(4)}mm · 省腿差 ${entry.report.maxLegDelta.toFixed(3)}mm · ${entry.report.ok ? '校验通过' : `失败 ${entry.report.reasons.length} 项`}</text>`
  );
  parts.push('</g></svg>');
  return parts.join('\n');
}

export function downloadSvg(entry: VersionEntry, filename?: void | string): void {
  const svg = exportSvg(entry);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? `pattern-v${entry.version}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}
