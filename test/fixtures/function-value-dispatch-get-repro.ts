// Repro for `property-access:function-value-dispatch:get:false`, the root
// with 31 unmet mandatory obligations in the mongodb CMAP-ping probe
// (geastack/node-compat, apps/hono-mongodb-todo/correctness/native/mongodb-cmap-ping.ts,
// through vendored mongodb/bson/mongodb-connection-string-url sources).
//
// `predicate.actual` is uniformly `"absent"` for all 31 rows, but grouping the
// real probe's rows by the exact property NAME read shows two independent,
// unrelated causes sharing the one predicate id:
//
//  (A) Function.prototype `.bind`/`.call` read off an ordinary first-class
//      function VALUE whose exact target is not statically pinned to one
//      declaration -- a parameter typed as a plain call signature, a bound
//      method value (`this.onSocketError.bind(this)`), or a builtin function
//      value (`Object.prototype.toString.call(x)`). `representation/derive.ts`'s
//      `deriveSignature` gives every such value the `function-value-dispatch`
//      carrier, and no runtime path anywhere renders `.bind`/`.call`/`.apply`
//      over it -- unlike `string`/`array-object`/`promise`/`keyed-collection`,
//      which each get a `Foo.prototype` method table deferred at the property
//      read and fused with the call
//      (`targets/cpp/manifest/capabilities.ts`'s `propertyRecipes` documents
//      the pattern per carrier; `function-value-dispatch` has no such table at
//      all). 15 `bind` + 9 `call` = 24 of the real probe's 31 rows.
//
//  (B) A NAMED property read off an ambient value whose declared type
//      combines a call signature with its own members -- mongodb's own
//      `declare const Bun: { (): void; version?: string }` Bun-detection shim
//      (`vendored-sources/mongodb/src/cmap/handshake/client_metadata.ts:328`),
//      and node-compat's `BufferConstructor` (`(value?) => Buffer` plus
//      `from`/`isBuffer`/`byteLength`/...). `semantics/normalize/structural.ts`
//      (~line 1047) takes the "this type has a call/construct signature"
//      branch and interns a bare `{kind:'signature', call, construct}` shape
//      BEFORE it would otherwise walk the type's own property members into a
//      record shape -- so `version`/`from`/`isBuffer`/`byteLength` are
//      discarded at shape-construction time, long before
//      `representation/derive.ts` ever runs. `function-value-dispatch` (the
//      exact call-side counterpart of `constructor-value-dispatch`) carries an
//      ABI only, never a member set -- there is no "callable value with named
//      members" representation kind at all, on either the call or the
//      construct side. 3 `isBuffer` + 2 `from` + 1 `byteLength` + 1 `version`
//      = 7 of the real probe's 31 rows.
//
// Both sub-causes are reproduced below, each kept alive through a module-scope
// call (`ir/shake.ts` only retains a function body through a kept call, so a
// fixture that merely declares and never calls is shaken to an empty
// translation unit and proves nothing).

function useBoundCallback(cb: () => void): () => void {
  return cb.bind(null)
}

function invokeWithReceiver(cb: (x: number) => number, x: number): number {
  return cb.call(null, x)
}

declare const Widget: { (): void; readonly version?: string }

function widgetVersion(): string {
  return typeof Widget.version === 'string' ? Widget.version : 'unknown'
}

export const probeBind = useBoundCallback(() => {})
export const probeCall = invokeWithReceiver((n) => n, 1)
export const probeNamedMember = widgetVersion()
