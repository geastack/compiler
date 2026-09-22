import type { CallableAbi, Representation } from './model.js'

/**
 * Every carrier a representation embeds, visited once each, depth first.
 *
 * A carrier is not only its own kind: a `record` renders as a struct whose
 * every field is a carrier of its own, a `tagged-union` as an alternative of
 * each arm's, a callable as a signature spelling each parameter's. What the
 * emitted C++ names is the whole tree, so a fact that must hold of every
 * carrier the program spells -- that a `native-handle` names a protocol the
 * host registered -- has to be asked of the whole tree, not of its root. A
 * census that stopped at the root let lib.dom's `Window` reach clang as a
 * struct whose `Navigator`/`History`/`ScreenOrientation` fields named tag
 * types no host had declared: a certified program that did not compile.
 *
 * The walk mirrors what the backend renders (`targets/cpp/records.ts`'s
 * `visitRepresentation`): `native-record-ref` names a struct defined
 * elsewhere and carries no fields, `class-ref` names a class whose layout
 * is censused with the class, and a callable contributes its ABI carriers.
 * A representation tree is finite -- recursion is broken by
 * `native-record-ref` -- but each node is visited once regardless.
 */
export const forEachEmbeddedRepresentation = (root: Representation, visit: (carrier: Representation) => void): void => {
  const seen = new Set<Representation>([root])
  const abi = (value: CallableAbi | null): void => {
    if (value === null) return
    for (const parameter of value.parameters) walk(parameter.value)
    walk(value.result)
    if (value.receiver !== null) walk(value.receiver)
  }
  const walk = (value: Representation): void => {
    if (seen.has(value)) return
    seen.add(value)
    visit(value)
    children(value)
  }
  const children = (value: Representation): void => {
    switch (value.kind) {
      case 'record':
        for (const field of value.fields) walk(field.value)
        for (const accessor of value.accessors) walk(accessor.value)
        return
      case 'record-with-index':
        for (const field of value.fields) walk(field.value)
        for (const index of value.indexes) walk(index.value)
        return
      case 'proxy-object':
        walk(value.target)
        walk(value.handler)
        return
      case 'borrowed-ref':
        walk(value.referent)
        return
      case 'array-object':
      case 'dense-buffer':
      case 'native-sequence':
        walk(value.element)
        return
      case 'iterator':
        walk(value.element)
        walk(value.resume)
        walk(value.completion)
        return
      case 'promise':
        walk(value.value)
        return
      case 'keyed-collection':
        walk(value.key)
        if (value.value !== null) walk(value.value)
        return
      case 'dictionary':
        walk(value.value)
        return
      case 'optional':
        walk(value.payload)
        return
      case 'tagged-union':
        for (const arm of value.arms) walk(arm.value)
        return
      case 'function':
      case 'function-family':
      case 'constructor-family':
      case 'constructor-value-dispatch':
      case 'function-value-family':
      case 'function-value-dispatch':
        abi(value.abi)
        return
      case 'function-and-constructor':
        abi(value.call)
        abi(value.construct)
        return
      default:
        return
    }
  }
  children(root)
}
