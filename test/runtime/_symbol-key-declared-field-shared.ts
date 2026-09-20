// Helper for `symbol-key-declared-field.ts`: a module-level `unique symbol`
// EXPORTED and used as a computed class-field key from another module,
// mirroring `@hono/node-server` exporting `abortControllerKey` and friends
// for `listener.ts` to read off the request it built. The declared-field
// dispatch (`records.ts`'s `declaredSymbolId` branch, registered once by
// `emit-bindings.ts` when this cell runs) is keyed by the symbol's own
// declaration, not by which file's text names it -- so a write from this
// module and a read from the importer must reach the same native storage.
export const sharedKey = Symbol('shared')

export class Holder {
  [sharedKey]: number | undefined
}

export const readShared = (holder: Holder): number | undefined => holder[sharedKey]
export const writeShared = (holder: Holder, value: number): void => {
  holder[sharedKey] = value
}
