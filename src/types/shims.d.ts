declare module 'clipper2-wasm' {
  export interface Clipper2ZFactoryFunction {
    (moduleArg?: Record<string, unknown>): Promise<any>;
  }
  const Clipper2Z: Clipper2ZFactoryFunction;
  export default Clipper2Z;
}

declare module 'clipper2-wasm/dist/es/clipper2z.wasm?url' {
  const url: string;
  export default url;
}
