import type { UnitMode } from '../state/editor';

export const MM_PER_IN = 25.4;

export function formatLength(mm: number, unit: UnitMode, digits = 2): string {
  if (unit === 'in') return `${(mm / MM_PER_IN).toFixed(digits)} in`;
  return `${mm.toFixed(digits)} mm`;
}

export function formatNumber(mm: number, unit: UnitMode, digits = 2): string {
  return unit === 'in' ? (mm / MM_PER_IN).toFixed(digits) : mm.toFixed(digits);
}

export function parseToMm(text: string, unit: UnitMode): number {
  const v = Number(text);
  if (!Number.isFinite(v)) return NaN;
  return unit === 'in' ? v * MM_PER_IN : v;
}
