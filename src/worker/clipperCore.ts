import { INTEGER_SCALE } from '../model/types';
import type { Vec } from '../model/types';
import type { IntPoly, JoinKind } from './protocol';

type ClipperModule = Awaited<ReturnType<typeof import('clipper2-wasm/dist/es/clipper2z.js').default>>;

/** 输入多边形翻转 y 后的有向面积（整数单位²），用于区分外轮廓/内孔方向。 */
function signedAreaUnits(polygons: Vec[][]): number {
  let total = 0;
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      total += a.x * (-b.y) - b.x * (-a.y);
    }
  }
  return total / 2;
}

/**
 * Clipper2 计算核心（可在 worker 与 Node 集成测试中共用）。
 * 纸样源坐标 y 向下；Clipper 约定 y 向上，因此统一翻转 y，
 * 使 Clipper 的外轮廓（正有向面积）/内孔（负）判定与纸样一致。
 */
export function offsetPolygons(
  C: ClipperModule,
  polygonsMm: Vec[][],
  deltaMm: number,
  join: JoinKind = 'miter',
  miterLimit = 2.0,
  arcToleranceMm = 0.02,
): { outer: Vec[][]; holes: Vec[][]; ms: number } {
  const perf = globalThis.performance;
  const now = () => (perf ? perf.now() : Date.now());
  const start = now();
  const paths = new C.Paths64();
  for (const poly of polygonsMm) {
    const p = new C.Path64();
    for (const q of poly) {
      p.push_back(new C.Point64(BigInt(Math.round(q.x * INTEGER_SCALE)), BigInt(-Math.round(q.y * INTEGER_SCALE)), 0n));
    }
    paths.push_back(p);
  }
  const joinMap = { square: C.JoinType.Square, round: C.JoinType.Round, miter: C.JoinType.Miter } as const;
  // 记录输入（翻转后）的有向面积符号；Inflate 保持方向，外轮廓与输入同向，内孔反向。
  const subjArea = signedAreaUnits(polygonsMm);
  const subjSign = subjArea >= 0 ? 1 : -1;
  const sol = C.InflatePaths64(
    paths,
    Math.round(deltaMm * INTEGER_SCALE),
    joinMap[join],
    C.EndType.Polygon,
    miterLimit,
    Math.max(arcToleranceMm * INTEGER_SCALE, 1),
  );
  paths.delete();
  const outer: Vec[][] = [];
  const holes: Vec[][] = [];
  for (let i = 0; i < sol.size(); i++) {
    const path = sol.get(i);
    const area = C.AreaPath64(path);
    const poly: Vec[] = [];
    for (let j = 0; j < path.size(); j++) {
      const q = path.get(j);
      poly.push({ x: Number(q.x) / INTEGER_SCALE, y: -Number(q.y) / INTEGER_SCALE });
    }
    ((area >= 0 ? 1 : -1) === subjSign ? outer : holes).push(poly);
    path.delete();
  }
  sol.delete();
  return { outer, holes, ms: now() - start };
}

/** 布尔运算（union/difference/intersection/xor），y 翻转同上。 */
export function booleanPolygons(
  C: ClipperModule,
  op: 'union' | 'difference' | 'intersection' | 'xor',
  subjectsMm: Vec[][],
  clipsMm: Vec[][],
): Vec[][] {
  const load = (polys: Vec[][]) => {
    const paths = new C.Paths64();
    for (const poly of polys) {
      const p = new C.Path64();
      for (const q of poly) {
        p.push_back(new C.Point64(BigInt(Math.round(q.x * INTEGER_SCALE)), BigInt(-Math.round(q.y * INTEGER_SCALE)), 0n));
      }
      paths.push_back(p);
    }
    return paths;
  };
  const subjects = load(subjectsMm);
  const clips = load(clipsMm);
  const clipper = C.CreateClipper64(true);
  clipper.AddSubject(subjects);
  clipper.AddClip(clips);
  const sol = new C.Paths64();
  clipper.ExecutePath(C.ClipType[op[0].toUpperCase() + op.slice(1) as keyof typeof C.ClipType], C.FillRule.NonZero, sol);
  clipper.delete();
  subjects.delete();
  clips.delete();
  const out: Vec[][] = [];
  for (let i = 0; i < sol.size(); i++) {
    const path = sol.get(i);
    const poly: IntPoly[number][] = [];
    for (let j = 0; j < path.size(); j++) {
      const q = path.get(j);
      poly.push({ x: Number(q.x) / INTEGER_SCALE, y: -Number(q.y) / INTEGER_SCALE });
    }
    out.push(poly);
  }
  sol.delete();
  return out;
}
