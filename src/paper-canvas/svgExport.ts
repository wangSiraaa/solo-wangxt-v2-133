import type { Piece, ProjectData, Tolerance, Vec, ValidationReport, VersionSnapshot } from '../model/types';
import { rebuildPiece } from '../geometry/rebuild';
import { buildScreenPath } from './buildPath';
import type { OffsetResult } from '../worker/client';

export interface SvgOptions {
  version: VersionSnapshot;
  allowances?: Record<string, OffsetResult>;
  tolerance: Tolerance;
  unit: 'mm' | 'in';
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] as string));

function pathD(data: ProjectData, piece: Piece): string {
  const spec = buildScreenPath(data, piece);
  let d = `M ${spec.start.x.toFixed(3)} ${spec.start.y.toFixed(3)} `;
  for (const s of spec.segs) {
    if (s.kind === 'line') d += `L ${s.to.x.toFixed(3)} ${s.to.y.toFixed(3)} `;
    else d += `C ${s.c1.x.toFixed(3)} ${s.c1.y.toFixed(3)} ${s.c2.x.toFixed(3)} ${s.c2.y.toFixed(3)} ${s.to.x.toFixed(3)} ${s.to.y.toFixed(3)} `;
  }
  return d + 'Z';
}

function polyD(poly: Vec[]): string {
  return poly.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ') + ' Z';
}

/**
 * 从【同一个已提交版本】导出 SVG：缝线、裁剪轮廓、缝份、记号、丝缕、比例尺，
 * 并把数值容差与校验结论写入 <metadata>，杜绝"画面看似闭合即通过"。
 */
export function exportSvg(opts: SvgOptions): string {
  const { version, allowances, tolerance, unit } = opts;
  const data: ProjectData = version.data;
  const pieces = Object.values(data.pieces);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pieceBounds = pieces.map((p) => {
    const dp = rebuildPiece(data, p);
    minX = Math.min(minX, dp.bbox.min.x); minY = Math.min(minY, dp.bbox.min.y);
    maxX = Math.max(maxX, dp.bbox.max.x); maxY = Math.max(maxY, dp.bbox.max.y);
    return { piece: p, dp };
  });
  const pad = 40;
  minX -= pad; minY -= pad; maxX += pad; maxY += 40;
  const w = maxX - minX;
  const h = maxY - minY;

  const bodies: string[] = [];
  for (const { piece, dp } of pieceBounds) {
    bodies.push(`<path d="${pathD(data, piece)}" fill="rgba(17,24,39,0.04)" stroke="#111827" stroke-width="0.35" data-piece="${esc(piece.id)}"/>`);
    // 闭合省腿（内缝）
    for (const leg of dp.dartLegs) {
      bodies.push(`<path d="${polyD(leg.polyline)}" fill="none" stroke="#7c3aed" stroke-width="0.25" stroke-dasharray="2 2"/>`);
    }
    // 记号
    for (const n of dp.notches) {
      const tip = { x: n.pos.x + n.normal.x * 4, y: n.pos.y + n.normal.y * 4 };
      if (n.kind === 'drill') {
        bodies.push(`<circle cx="${n.pos.x.toFixed(3)}" cy="${n.pos.y.toFixed(3)}" r="1.1" fill="#0f766e" data-notch="${esc(n.id)}"/>`);
      } else {
        bodies.push(`<line x1="${n.pos.x.toFixed(3)}" y1="${n.pos.y.toFixed(3)}" x2="${tip.x.toFixed(3)}" y2="${tip.y.toFixed(3)}" stroke="#0f766e" stroke-width="0.45" data-notch="${esc(n.id)}"/>`);
      }
    }
    // 丝缕
    const g = piece.grainline;
    const hx = Math.cos(g.angle) * g.length / 2;
    const hy = Math.sin(g.angle) * g.length / 2;
    bodies.push(`<line x1="${(g.at.x - hx).toFixed(2)}" y1="${(g.at.y - hy).toFixed(2)}" x2="${(g.at.x + hx).toFixed(2)}" y2="${(g.at.y + hy).toFixed(2)}" stroke="#374151" stroke-width="0.3" data-grainline="${esc(piece.id)}"/>`);
    // 裁剪轮廓/缝份
    const off = allowances?.[piece.id];
    if (off) {
      for (const poly of off.outer) bodies.push(`<path d="${polyD(poly)}" fill="none" stroke="#b23b3b" stroke-width="0.3" stroke-dasharray="6 4" data-cut-outer="${esc(piece.id)}"/>`);
      for (const poly of off.holes) bodies.push(`<path d="${polyD(poly)}" fill="none" stroke="#b23b3b" stroke-width="0.3" stroke-dasharray="3 3" data-cut-hole="${esc(piece.id)}"/>`);
    }
  }

  // 比例尺（50mm，标注英寸换算仅显示用）
  const scaleY = maxY - 12;
  const scaleBar = `
    <g data-scale-bar="50mm">
      <line x1="${minX + 10}" y1="${scaleY}" x2="${minX + 60}" y2="${scaleY}" stroke="#000" stroke-width="0.6"/>
      <line x1="${minX + 10}" y1="${scaleY - 2}" x2="${minX + 10}" y2="${scaleY + 2}" stroke="#000" stroke-width="0.6"/>
      <line x1="${minX + 60}" y1="${scaleY - 2}" x2="${minX + 60}" y2="${scaleY + 2}" stroke="#000" stroke-width="0.6"/>
      <text x="${minX + 35}" y="${scaleY - 3}" text-anchor="middle" font-size="4">50 mm${unit === 'in' ? ` (${(50 / 25.4).toFixed(3)} in)` : ''}</text>
    </g>`;

  const report: ValidationReport = version.report;
  const issuesJson = JSON.stringify(report.issues.map((i) => ({
    code: i.code, message: i.message, refs: i.refs, tolerance_mm: i.tolerance, measured_mm: Number(i.measured.toFixed(4)),
  })));

  const metadata = `
  <metadata id="engineering">
    <version>${version.version}</version>
    <label>${esc(version.label)}</label>
    <timestamp>${new Date(version.timestamp).toISOString()}</timestamp>
    <units>mm</units>
    <tolerance closure_mm="${tolerance.closure}" selfIntersect_mm="${tolerance.selfIntersect}" zeroEdge_mm="${tolerance.zeroEdge}" legLength_mm="${tolerance.legLength}" reattach_mm="${tolerance.reattach}" hitMerge_mm="${tolerance.hitMerge}"/>
    <validation ok="${report.ok}" issueCount="${report.issues.length}">${esc(issuesJson)}</validation>
  </metadata>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(2)}mm" height="${h.toFixed(2)}mm" viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" data-format-version="3" data-committed-version="${version.version}">
${metadata}
  <g id="pieces">
${bodies.join('\n')}
  </g>
${scaleBar}
</svg>
`;
}

export function downloadSvg(filename: string, svg: string): void {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
