import ts from 'typescript'
import { isAmbientDeclaration } from '../ambient.js'

/**
 * The host effect contract: what a BODILESS host declaration states about the
 * native implementation behind it.
 *
 * A `declare function` has no body for the host-mutation census to read, so
 * a call to one was an unknown callee, and handing it any value the census
 * could not prove non-global wildcarded every host binding and every
 * intrinsic prototype. The native WebGL upload functions only read the bytes
 * of the typed array they are given; nothing in the program could say so.
 *
 * `@gea-host-inert` on the declaration says so. It states, for the native
 * implementation, all of:
 *
 * - it does not retain any argument, or anything reachable from one, past
 *   the call;
 * - it does not write, define, delete or re-prototype a property of any
 *   JavaScript object -- the global object, an intrinsic, or an argument;
 * - it does not invoke program code (no callbacks, no accessors).
 *
 * Only the declaration can carry it, and only a declaration with no body:
 * a body is censused like any other code, and a contract beside one would be
 * a second, unverifiable authority. It is trusted the way every native
 * declaration's signature is trusted -- which is exactly why it is narrow,
 * explicit per declaration, and never inferred.
 */
export const hostInertTagName = 'gea-host-inert'

const isBodilessCallableDeclaration = (declaration: ts.Declaration): boolean =>
  ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body === undefined) ||
  ts.isMethodSignature(declaration) ||
  (ts.isSetAccessorDeclaration(declaration) && declaration.body === undefined)

/** This one declaration states the inert host contract. */
export const declarationStatesHostInert = (declaration: ts.Declaration): boolean =>
  isBodilessCallableDeclaration(declaration) &&
  isAmbientDeclaration(declaration) &&
  ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === hostInertTagName)

/**
 * Every declaration of the symbol states the contract. An overload or merged
 * declaration without it is a callee the contract does not cover, and a
 * single uncovered declaration refuses the whole symbol.
 */
export const symbolStatesHostInert = (symbol: ts.Symbol | undefined): boolean => {
  const declarations = symbol?.declarations ?? []
  return declarations.length > 0 && declarations.every(declarationStatesHostInert)
}

/**
 * The SECOND, narrower host effect contract: `@gea-host-no-property-writes`.
 *
 * `@gea-host-inert` states three things at once, and a native that breaks any
 * one of them can carry none of it. Measured on `hono-hello`: of the natives
 * whose calls hold the global host-mutation census open, every single one
 * breaks a clause the census was not asking about --
 * `__gea_node_timer_start_timeout` and `__gea_http_serve` retain a callback
 * and later run it, `__gea_node_net_read` returns a fresh Buffer -- while none
 * of them writes a property on anything.
 *
 * So this states ONLY the middle clause: the native does not write, define,
 * delete or re-prototype a property of any JavaScript object -- the global
 * object, an intrinsic, an argument, or anything reachable from one. It says
 * nothing about retention, and nothing about invoking program code: a native
 * MAY store an argument and MAY call back into the program, because the
 * writes that callback performs are censused where that callback is WRITTEN,
 * which is the whole argument the argument stamp rests on.
 *
 * Building and returning a NEW object is not a write under this contract: the
 * object did not exist for the program to observe, and installing its own
 * initial keys changes nothing the program already held. `__gea_node_net_read`
 * returning a Buffer and `__gea_node_process_env` returning a fresh record
 * both qualify.
 *
 * Consumed at exactly one place -- the census's unknown-callee ARGUMENT stamp,
 * whose only question is which keys a callee can put on the intrinsics its
 * arguments reach. Every other consumer of a host contract keeps asking for
 * the full `@gea-host-inert`, because retention and re-entry matter to them.
 */
export const hostNoPropertyWritesTagName = 'gea-host-no-property-writes'

/** This one declaration states the no-property-writes contract. */
export const declarationStatesNoPropertyWrites = (declaration: ts.Declaration): boolean =>
  isBodilessCallableDeclaration(declaration) &&
  isAmbientDeclaration(declaration) &&
  ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === hostNoPropertyWritesTagName)

/**
 * Every declaration states one of the two contracts. `@gea-host-inert` is
 * strictly stronger, so a symbol whose declarations mix the two still writes
 * no property; one declaration carrying neither refuses the whole symbol, for
 * the same reason it does above.
 */
export const symbolWritesNoHostProperty = (symbol: ts.Symbol | undefined): boolean => {
  const declarations = symbol?.declarations ?? []
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => declarationStatesHostInert(declaration) || declarationStatesNoPropertyWrites(declaration))
  )
}

/**
 * The standard-library callables ECMA-262 specifies to create, delete or
 * redefine a property on an object reachable from their arguments or `this`.
 *
 * A library callable that escapes as a VALUE -- `.filter( Boolean )`,
 * `const decoder = decodeURIComponent`, `emitter.on( 'x', console.error )` --
 * is not a reason to distrust an intrinsic. These are spec-defined functions
 * whose behaviour this compiler already relies on everywhere it says
 * "intrinsic", and outside this list none of them writes a program-visible
 * key: the most any of them does is RUN program code (a callback, an
 * accessor, a `toJSON`), which is censused where that code is written. Only
 * the ones below can install a key themselves, and the census's own
 * reflection-mutator list is this table's seed.
 *
 * Keyed by DECLARING INTERFACE and member so that `Console.error` can never
 * be confused with a mutator of the same spelling, with `''` for the global
 * function declarations that have no interface. This is a statement about the
 * standard library, which is one fixed, versioned text; it is NOT the host
 * contract. `@gea-host-inert` stays per declaration and never inferred,
 * because a host native's behaviour is stated by whoever wrote the native.
 */
const LIBRARY_MUTATOR_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['ObjectConstructor', new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf', 'freeze', 'seal', 'preventExtensions'])],
  ['Reflect', new Set(['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf', 'preventExtensions', 'apply', 'construct'])],
  ['Array', new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'])],
  ['Function', new Set(['call', 'apply', 'bind'])],
  ['CallableFunction', new Set(['call', 'apply', 'bind'])],
  ['NewableFunction', new Set(['call', 'apply', 'bind'])],
  ['', new Set(['eval', 'Function'])]
])
const TYPED_ARRAY_MUTATORS: ReadonlySet<string> = new Set(['set', 'sort', 'reverse', 'fill', 'copyWithin'])
const TYPED_ARRAY_INTERFACE = /^(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float16|Float32|Float64|BigInt64|BigUint64)Array$/

const declaringInterfaceName = (declaration: ts.Declaration): string => {
  const owner = declaration.parent
  if (owner && (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner))) return owner.name?.text ?? ''
  if (owner && ts.isModuleBlock(owner) && ts.isModuleDeclaration(owner.parent)) return owner.parent.name.getText()
  if (owner && ts.isModuleDeclaration(owner)) return owner.name.getText()
  return ''
}

/** Does this symbol name one of those? Asked of every declaration: one match is enough. */
export const symbolIsStandardLibraryMutator = (symbol: ts.Symbol | undefined): boolean =>
  (symbol?.declarations ?? []).some((declaration) => {
    const member = (declaration as ts.NamedDeclaration).name
    const name = member && (ts.isIdentifier(member) || ts.isStringLiteralLike(member)) ? member.text : symbol?.getName()
    if (name === undefined) return false
    const owner = declaringInterfaceName(declaration)
    if (TYPED_ARRAY_INTERFACE.test(owner)) return TYPED_ARRAY_MUTATORS.has(name)
    return LIBRARY_MUTATOR_MEMBERS.get(owner)?.has(name) === true
  })
