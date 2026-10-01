import { describe, it, expect } from 'vitest';
import { validateProject } from './validation';
import { createSkirtProject } from '../model/sample';
import { DEFAULT_TOLERANCE } from '../model/types';
import type { ProjectData } from '../model/types';

const data = (): ProjectData => createSkirtProject().versions[0].data;

/** 用四个点+四条直线边构造最小闭合裁片。 */
function quadProject(
  pts: Array<[number, number]>,
  opts: { gap?: { edgeIdx: number; detach: 'from' | 'to'; dx: number; dy: number }; zeroEdge?: number } = {},
): { d: ProjectData; pieceId: string } {
  const d: ProjectData = { seq: 0, points: {}, edges: {}, notches: {}, slashes: {}, darts: {}, pieces: {} };
  const ids = ['a', 'b', 'c', 'e'];
  pts.forEach(([x, y], i) => { d.points[ids[i]] = { id: ids[i], pos: { x, y }, kind: 'corner' }; });
  const refs: { edgeId: string; reversed: boolean }[] = [];
  for (let i = 0; i < 4; i++) {
    const eid = `e${i}`;
    d.edges[eid] = { id: eid, from: ids[i], to: ids[(i + 1) % 4], role: 'seam', curve: 'line' };
    refs.push({ edgeId: eid, reversed: false });
  }
  if (opts.gap) {
    // 复制端点并偏移：边的端点与环点身份分离且坐标有间隙
    const g = opts.gap;
    const e = d.edges[`e${g.edgeIdx}`];
    const oldId = g.detach === 'from' ? e.from : e.to;
    const cloneId = `${oldId}x`;
    d.points[cloneId] = { id: cloneId, pos: { x: d.points[oldId].pos.x + g.dx, y: d.points[oldId].pos.y + g.dy }, kind: 'corner' };
    if (g.detach === 'from') e.from = cloneId;
    else e.to = cloneId;
  }
  if (opts.zeroEdge !== undefined) {
    const e = d.edges[`e${opts.zeroEdge}`];
    const other = e.to;
    d.points[e.from].pos = { ...d.points[other].pos };
  }
  const pieceId = 'pc';
  d.pieces[pieceId] = {
    id: pieceId,
    name: 'Q',
    loop: { pointIds: ids, edges: refs },
    dartIds: [],
    slashIds: [],
    seamAllowance: 10,
    grainline: { id: 'g', at: { x: 50, y: 50 }, angle: Math.PI / 2, length: 40 },
  };
  return { d, pieceId };
}

describe('纯数值校验（不能以画面看似闭合通过）', () => {
  it('样例工程通过全部校验', () => {
    expect(validateProject(data(), DEFAULT_TOLERANCE).ok).toBe(true);
  });

  it('几何间隙超过闭合容差即报 LOOP_NOT_CLOSED，带实测值', () => {
    const { d, pieceId } = quadProject([[0, 0], [100, 0], [100, 100], [0, 100]], {
      gap: { edgeIdx: 1, detach: 'from', dx: 0.5, dy: 0 },
    });
    const r = validateProject(d, DEFAULT_TOLERANCE, [pieceId]);
    expect(r.ok).toBe(false);
    const gap = r.issues.find((i) => i.code === 'LOOP_NOT_CLOSED');
    expect(gap).toBeTruthy();
    expect(gap!.measured).toBeGreaterThan(DEFAULT_TOLERANCE.closure);
  });

  it('自交轮廓报 SELF_INTERSECTION', () => {
    const { d, pieceId } = quadProject([[0, 0], [100, 100], [100, 0], [0, 100]]);
    const r = validateProject(d, DEFAULT_TOLERANCE, [pieceId]);
    expect(r.issues.some((i) => i.code === 'SELF_INTERSECTION')).toBe(true);
  });

  it('零长度退化边报 ZERO_LENGTH_EDGE', () => {
    const { d, pieceId } = quadProject([[0, 0], [100, 0], [100, 100], [0, 100]], { zeroEdge: 0 });
    const r = validateProject(d, DEFAULT_TOLERANCE, [pieceId]);
    expect(r.issues.some((i) => i.code === 'ZERO_LENGTH_EDGE')).toBe(true);
  });

  it('记号 t 越界与法向非法被拦截', () => {
    const d = data();
    const n = Object.values(d.notches)[0];
    n.t = 1.4;
    n.normalSide = 3 as 1;
    const r = validateProject(d, DEFAULT_TOLERANCE);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'NOTCH_T_OUT_OF_RANGE' || i.code === 'NOTCH_DIRECTION_INVALID')).toBe(true);
  });

  it('省腿长度差超容差报 DART_LEG_LENGTH_MISMATCH', () => {
    const d = data();
    const pieceId = Object.keys(d.pieces)[0];
    const dartId = Object.keys(d.darts)[0];
    const dart = d.darts[dartId];
    const legOut = d.edges[dart.legOut];
    const mouthId = legOut.to === dart.apex ? legOut.from : legOut.to;
    d.points[mouthId].pos.x -= 3;
    const r = validateProject(d, DEFAULT_TOLERANCE, [pieceId]);
    expect(r.issues.some((i) => i.code === 'DART_LEG_LENGTH_MISMATCH')).toBe(true);
    const iss = r.issues.find((i) => i.code === 'DART_LEG_LENGTH_MISMATCH')!;
    expect(iss.measured).toBeGreaterThan(DEFAULT_TOLERANCE.legLength);
  });
});
