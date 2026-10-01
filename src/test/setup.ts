import '@testing-library/jest-dom/vitest';

/**
 * jsdom 不实现 Canvas 2D。
 * - 提供最小 2D context 桩，使 paper 在【模块导入期】的自动初始化不抛错；
 * - PatternCanvas 自己的 setup 仍会用独立判定决定是否真正渲染（测试环境下降级）。
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  const cache = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  const makeStub = () => new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'measureText') return () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0 });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (prop === 'createImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (prop === 'getContextAttributes') return () => ({});
      return () => {};
    },
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;

  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    const canvas = this as unknown as HTMLCanvasElement;
    let ctx = cache.get(canvas);
    if (!ctx) { ctx = makeStub(); cache.set(canvas, ctx); }
    return ctx;
  }) as typeof HTMLCanvasElement.prototype.getContext;
}
