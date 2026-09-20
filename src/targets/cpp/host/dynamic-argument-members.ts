/**
 * The host members whose call-site renderer takes a `dynamic` argument through
 * unconditionally -- the C++ backend's half of
 * `TargetRuntimeManifest.dynamicArgumentHostParameters`
 * (preflight/obligations.ts), which states what listing one WAIVES and why
 * the key includes member, argument role and ordinal.
 *
 * Here rather than in `manifest.ts` because the fact is a property of the
 * renderers, not of the manifest: every entry below is an `objectMemberText`
 * arm (`emit-host-object.ts`), and a member added there without a row here --
 * or a row here whose arm was deleted -- is a drift best noticed by the two
 * living side by side. `manifest.ts` cites this set; it does not own it.
 *
 * ## Why each of these needs the waiver and the others do not
 *
 * Each row passes that one argument's box straight into a host call-site
 * renderer. So there is no conversion for the emitted line to perform and
 * none for preflight to demand at that position. No row grants anything to a
 * sibling parameter of the same member.
 *
 * `Object.keys`, `getOwnPropertyNames`, `freeze` and `isFrozen` are
 * deliberately ABSENT even though they take the same dynamic receiver. Their
 * declared parameter is `object` / `T`, which already derives a carrier a
 * `dynamic` converts into, so the ordinary obligation is satisfied on its own
 * -- and waiving a check that passes hides a real one for no gain.
 *
 * What these positions have in common is a declared parameter nothing
 * converts into:
 * `{ [s: string]: T } | ArrayLike<T>` for `values`/`entries`, which derives a
 * `tagged-union(dictionary | native-record-ref)`; and `PropertyKey` -- a
 * `string | number | symbol` union -- for the key parameter of `hasOwn`,
 * `defineProperty` and `getOwnPropertyDescriptor`. `assign`'s variadic source
 * parameter is the same shape as `values`'.
 *
 * `Object.defineProperty:argument:2` is deliberately absent. The emitter
 * materializes descriptors only from an exact descriptor carrier; a dynamic
 * box does not state which descriptor fields and attributes are present.
 * `Object.defineProperties` is absent wholesale: its source transform accepts
 * only a closed descriptor-map literal and lowers it to singular operations,
 * while an open/dynamic map must remain fail-closed.
 */
export const cppDynamicArgumentHostParameters: ReadonlySet<string> = new Set<string>([
  'gea::ReflectNamespace.get:argument:0',
  'gea::ReflectNamespace.get:argument:1',
  'gea::ReflectNamespace.set:argument:0',
  'gea::ReflectNamespace.set:argument:1',
  'gea::ReflectNamespace.set:argument:2',
  'gea::ReflectNamespace.has:argument:0',
  'gea::ReflectNamespace.has:argument:1',
  'gea::ReflectNamespace.deleteProperty:argument:0',
  'gea::ReflectNamespace.deleteProperty:argument:1',
  'ObjectConstructor.values:argument:0',
  'ObjectConstructor.entries:argument:0',
  'ObjectConstructor.hasOwn:argument:0',
  'ObjectConstructor.hasOwn:argument:1',
  'ObjectConstructor.defineProperty:argument:0',
  'ObjectConstructor.defineProperty:argument:1',
  'ObjectConstructor.getOwnPropertyDescriptor:argument:0',
  'ObjectConstructor.getOwnPropertyDescriptor:argument:1',
  'ObjectConstructor.assign:argument:*'
])
