/**
 * 单位仅影响显示：内部几何恒为毫米。
 */
import type { Unit } from './types';

export const MM_PER_IN = 25.4;

export function mmToDisplay(mm: number, unit: Unit): number {
  return unit === 'in' ? mm / MM_PER_IN : mm;
}

export function displayToMm(value: number, unit: Unit): number {
  return unit === 'in' ? value * MM_PER_IN : value;
}

export function formatMm(mm: number, unit: Unit, digits = 2): string {
  const v = mmToDisplay(mm, unit);
  return `${v.toFixed(digits)} ${unit}`;
}

export function formatAngle(rad: number): string {
  return `${((rad * 180) / Math.PI).toFixed(1)}°`;
}
