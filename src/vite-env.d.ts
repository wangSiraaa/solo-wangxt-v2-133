/// <reference types="vite/client" />

declare module 'clipper2-wasm/dist/es/clipper2z.js' {
  import type { Clipper2ZFactoryFunction } from 'clipper2-wasm/dist/clipper2z';
  const factory: Clipper2ZFactoryFunction;
  export default factory;
}
