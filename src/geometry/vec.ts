import type { Vec } from '../model/types';

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const equal = (a: Vec, b: Vec, eps = 1e-9): boolean => dist(a, b) <= eps;

export const normalize = (a: Vec): Vec => {
  const l = len(a);
  return l < 1e-12 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
};

/** 相对存储方向 from->to 的左侧法向（normalSide=+1 指向它）。 */
export const leftNormal = (a: Vec): Vec => ({ x: -a.y, y: a.x });

export const angleOf = (a: Vec): number => Math.atan2(a.y, a.x);

/** 将向量 d 绕原点旋转 angle（弧度）。 */
export const rotateVec = (d: Vec, angle: number): Vec => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: d.x * c - d.y * s, y: d.x * s + d.y * c };
};

/** 点 p 绕中心 c 旋转 angle。 */
export const rotateAbout = (p: Vec, c: Vec, angle: number): Vec =>
  add(c, rotateVec(sub(p, c), angle));

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));
