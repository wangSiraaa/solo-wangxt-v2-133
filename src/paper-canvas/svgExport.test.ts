import { describe, it, expect } from 'vitest';
import { createSkirtProject } from '../model/sample';
import { transferDart } from '../commands/transferDart';
import { exportSvg } from './svgExport';
import { DEFAULT_TOLERANCE } from '../model/types';
import type { Vec } from '../model/types';

describe('SVG 导出必须来自同一已提交版本并带比例尺/容差', () => {
  it('导出内容包含版本号、比例尺、容差、校验结论', () => {
    const project = createSkirtProject();
    const snap = project.versions[0];
    const svg = exportSvg({ version: snap, tolerance: DEFAULT_TOLERANCE, unit: 'mm' });
    expect(svg).toContain(`data-committed-version="${snap.version}"`);
    expect(svg).toContain('data-scale-bar="50mm"');
    expect(svg).toContain('50 mm');
    expect(svg).toContain(`closure_mm="${DEFAULT_TOLERANCE.closure}"`);
    expect(svg).toContain('validation ok="true"');
    // 精确三次曲线元素存在（样例右侧缝）
    expect(svg).toContain('C ');
    expect(svg).toContain('data-grainline');
    expect(svg).toContain('data-notch');
  });

  it('英寸只改变比例尺文字标注，几何坐标仍是毫米', () => {
    const project = createSkirtProject();
    const mm = exportSvg({ version: project.versions[0], tolerance: DEFAULT_TOLERANCE, unit: 'mm' });
    const inch = exportSvg({ version: project.versions[0], tolerance: DEFAULT_TOLERANCE, unit: 'in' });
    expect(inch).toContain('1.969 in');
    // 几何路径数据相同
    const geom = (s: string) => s.match(/<path d="M [^"]+"/g);
    expect(geom(inch)).toEqual(geom(mm));
  });

  it('导出的是指定的已提交版本（转移后导出版本号前进，且含裁剪层元数据）', () => {
    const project = createSkirtProject();
    const src = project.versions[0];
    const r = transferDart(src.data, {
      pieceId: Object.keys(src.data.pieces)[0],
      dartId: Object.keys(src.data.darts)[0],
      angle: Math.PI / 2,
      tolerance: DEFAULT_TOLERANCE,
    });
    const next = { ...src, version: 2, parentVersion: 1, data: r.data, report: r.report, label: '转移后', timestamp: Date.now() };
    // 传入一个缝份结果（来自同一版本数据派生）
    const allowanceOuter: Vec[][] = [[
      { x: -10, y: -10 }, { x: 210, y: -10 }, { x: 210, y: 310 }, { x: -10, y: 310 },
    ]];
    const svg = exportSvg({
      version: next,
      tolerance: DEFAULT_TOLERANCE,
      unit: 'mm',
      allowances: { [Object.keys(next.data.pieces)[0]]: { outer: allowanceOuter, holes: [], ms: 1 } },
    });
    expect(svg).toContain('data-committed-version="2"');
    expect(svg).toContain('data-cut-outer');
  });

  it('校验失败版本导出时 metadata 如实标注 ok=false 与退化原因', () => {
    const project = createSkirtProject();
    const snap = project.versions[0];
    const bad = {
      ...snap,
      report: { ...snap.report, ok: false, issues: [...snap.report.issues, {
        code: 'LOOP_NOT_CLOSED' as const,
        message: '测试性间隙',
        refs: ['e1'],
        tolerance: 0.01,
        measured: 0.5,
      }] },
    };
    const svg = exportSvg({ version: bad, tolerance: DEFAULT_TOLERANCE, unit: 'mm' });
    expect(svg).toContain('validation ok="false"');
    expect(svg).toContain('LOOP_NOT_CLOSED');
    // JSON 被 XML 转义，检查数值字段（引号被转成 &quot;）
    expect(svg).toContain('measured_mm&quot;:0.5');
    expect(svg).toContain('测试性间隙');
  });
});
