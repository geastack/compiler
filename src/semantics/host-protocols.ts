import ts from 'typescript'
import type { NamespacePathCensus } from './normalize/namespace-paths.js'
import { declaredBaseTypesOf, isAmbientSymbol } from './ambient.js'
import type { DeclarationId, StructuralTypeId } from '../identity/ids.js'
import type { TypedArrayElementDomain } from '../representation/model.js'
import type { KeyedCollectionFamily, RegExpDeclarationKind, StandardBufferKind } from '../representation/policies.js'
import type { CensusCandidate } from './normalize/census.js'
import { isValueReference } from './normalize/census.js'
import { valueSymbolAt } from './normalize/unresolvable-names.js'
import type { IdentityTable } from './normalize/identities.js'
import type { StructuralMapper } from './normalize/structural.js'
import type { StructuralTypeTable } from './model/structural-type-table.js'
import type { CommonJsWrapperDeclaration, HostNativeTypeDeclaration, HostOwnedDeclaration } from '../plugins/model.js'
import { commonJsBindingIdentifiers, createCommonJsWrapperIdentity, isCommonJsWrapperVarDeclaration } from './commonjs-wrapper.js'
import { hasExactHostDeclaration } from './host-declaration-provenance.js'

type CommonJsWrapperIdentity = ReturnType<typeof createCommonJsWrapperIdentity>

/**
 * The ambient host-protocol census: what this program's own declarations say
 * a host owns, split out of `frontend.ts` on its own (the architecture gate's
 * 800-line ceiling) rather than for any conceptual reason -- `runFrontend`
 * calls exactly three things here (`hostProtocolBindings`, `ambientHostBindings`,
 * `promiseDeclarationOf`) and owns the rest of the pipeline itself.
 */

/**
 * A declared type this program's own language surface binds to a host protocol.
 *
 * `protocol`/`version` name the runtime contract; nothing here names a
 * framework, a package, or a file. See `hostProtocolBindings` for what
 * authenticates one.
 */
export interface HostProtocolBinding {
  readonly protocol: string
  readonly version: number
  /**
   * The type the host's own runtime carries values of this protocol in, when
   * the plugin that installs the protocol stated one; `null` when it did not.
   *
   * This is the host's name for its own type, not a C++ spelling this compiler
   * invented -- which is why it can travel through the target-neutral carrier
   * and be spelled verbatim by the backend. A protocol with no stated carrier
   * keeps the opaque tagged handle, which is the honest physical answer for a
   * boundary nothing has described.
   *
   * It is also the join key everything downstream uses: the preflight claim,
   * and the host member table's lookup. Thirteen declared names carry one
   * `NodeHandle`, so keying on the carrier states the fact once.
   */
  readonly native: string | null
  /**
   * The protocol's own members, as the checker's lib declaration states them --
   * `null` for a protocol this walk did not classify (every construction site
   * but `bindAmbientValue`'s own, and that one only for a carrier with no
   * stated host type: see `hostIntrinsicMembersOf`'s own comment for why).
   *
   * This is the one static fact ECMA-262's own reflection questions over an
   * intrinsic (`Object.getOwnPropertyDescriptor(Math, k)`, `k in Math`,
   * `Object.getOwnPropertyNames(Math)`, `delete Math.k`) all reduce to: WHICH
   * names are own properties, and for each, whether reading it calls into a
   * signature or hands back a value. Nothing downstream may hand-list `Math`'s
   * members instead of reading them from here -- that would be a second,
   * syntax-free but still HAND-MAINTAINED table the checker's own lib
   * declaration could silently drift out from under.
   */
  readonly members?: readonly HostIntrinsicMember[] | null
  /**
   * True when the values of this protocol are built by the HOST rather than by
   * the program, so the declared body is not a layout at any size.
   *
   * `derive.ts` otherwise reads a bound declaration with a data-only body as a
   * struct the host returns by value (`GeolocationPosition`, `TouchSample`):
   * the program receives one and reads its fields, and spelling the host's own
   * struct makes clang check every member name. That rule is right for a type
   * a host *hands out* and wrong for one a host *is asked to construct*: a JSX
   * element is produced by an element expression, never by the program writing
   * its members, so its declared body -- `{}` in gea's `JSX.Element`, `{ readonly
   * nodeKind: number }` in a fixture's -- describes nothing physical at all.
   * Reading it as a layout turned every element in such a program into a struct
   * copy and refused emission by name.
   */
  readonly opaque: boolean
}
/**
 * The declared type the language gives a JSX element, bound to the JSX host
 * protocol.
 *
 * A JSX element is the one construction whose result type the *language*
 * defines by lookup rather than the program defining it by declaration: the
 * checker resolves `JSX.Element` through the JSX namespace in scope, and every
 * element expression in the program has that type. So asking the checker for
 * the type of an element -- which the element producer already does -- is what
 * identifies the declaration, and no name, path, or package is consulted to do
 * it.
 *
 * Binding it matters because the answer would otherwise be structurally
 * plausible and physically wrong. `interface Element extends GeaJsxElement {}`
 * where `GeaJsxElement` is `{}` derives a `native-record-ref` to an empty
 * struct: C++ that compiles, holds nothing, and renders nothing. An element is
 * an opaque host handle, and `native-handle` is the carrier that says so.
 *
 * The binding is only a *claim* -- `preflight/run.ts` still censuses the
 * protocol against `manifest.nativeProtocols`, so a target that has not
 * implemented it refuses the program instead of emitting against glue that
 * does not exist.
 *
 * An element the checker types `any` binds nothing: no JSX namespace was in
 * scope, and binding a protocol to `any`'s declaration -- if it even had one --
 * would claim a contract the program never established. The element producer
 * refuses that program by its own route, and this stays silent rather than
 * manufacturing a second, weaker answer to the same question.
 *
 * The carrier is asked of the host by the protocol's own name, exactly as every
 * other host protocol's is (`declaredHostShape` below): a host that states what
 * it holds a JSX element in gets its own type spelled, and one that states
 * nothing gets the tagged handle. Leaving it unconditionally unstated is what
 * made every element in a gea program a `gea::NativeHandle<...jsx_element_v1>`
 * -- a tag type with no tree behind it, so an app compiled, ran, and rendered
 * nothing, while the engine's real `NodeHandle` sat in the same table one
 * lookup away.
 */
export const hostProtocolBindings = (input: HostProtocolInput, census: HostCensus): void => {
  const native = input.nativeTypes.get('jsx-element') ?? null
  for (const candidate of input.census) {
    if (candidate.family !== 'element') continue
    const shape = input.table.get(input.types.typeAt(candidate.node))?.shape
    if (shape?.kind !== 'declared') continue
    census.protocols.set(shape.declaration, { protocol: 'jsx-element', version: 1, native, opaque: true })
  }
}

export interface HostProtocolInput {
  readonly checker: ts.TypeChecker
  readonly identities: IdentityTable
  readonly files: readonly ts.SourceFile[]
  readonly census: readonly CensusCandidate[]
  readonly types: StructuralMapper
  readonly table: StructuralTypeTable
  /** See `FrontendInput.nativeTypes`. Empty means no host states a carrier for anything. */
  readonly nativeTypes: ReadonlyMap<string, string>
  /** Exact declaration-owned native type rows, which take precedence over name-only rows. */
  readonly nativeTypesByDeclaration: ReadonlyMap<string, HostNativeTypeDeclaration>
  /** Exact declaration-owned singleton rows. */
  readonly hostSingletonDeclarations: ReadonlyMap<string, HostOwnedDeclaration>
  /** See `FrontendInput.hostNamespaceRoots`. A name in here is a path, never a value. */
  readonly hostNamespaceRoots: ReadonlySet<string>
  /** Exact declaration-owned namespace roots; configured names mask the name-only table. */
  readonly hostNamespaceRootDeclarations: readonly HostOwnedDeclaration[]
  /** See `FrontendInput.hostNamespacePaths`. A dotted path with one of these as a prefix is a path segment, never a value. */
  readonly hostNamespacePaths: ReadonlySet<string>
  /** See `FrontendInput.hostNamespaceRootTypes`. The type a host carries the one object behind a root in. */
  readonly hostNamespaceRootTypes: ReadonlyMap<string, string>
  readonly commonJsGlobals: ReadonlyMap<string, CommonJsWrapperDeclaration>
  /** The exact declaration files named by `commonJsGlobals`, as loaded by this Program. */
  readonly commonJsDeclarationFiles: readonly ts.SourceFile[]
  /** The program's own namespace paths (`normalize/namespace-paths.ts`), for the census's `isValueReference` rule. */
  readonly namespacePaths: NamespacePathCensus
  /** TypeScript's declarationless intrinsic global object, distinguished from a caller-owned binding with the same spelling. */
  readonly isIntrinsicGlobalThis: (node: ts.Node) => boolean
}

/** What one walk of the program's own files learns about the declarations a host owns. */
export interface HostCensus {
  readonly protocols: Map<DeclarationId, HostProtocolBinding>
  /** The ABI name a host defines a cell under, for every ambient value this program reads. */
  readonly externals: Map<DeclarationId, string>
  readonly externalFiles: Map<DeclarationId, string>
  /**
   * The structural type of every host NAMESPACE ROOT this program names, to
   * the C++ type the host carries that root's one object in.
   *
   * Keyed by structural type rather than by declaration -- the one key in this
   * census that is not a `DeclarationId`, and the difference is forced, not a
   * choice. A namespace root is a VALUE, so what needs an answer is the
   * carrier of the value's own type; and that type routinely has no
   * declaration to key by. `window`'s is `Window & typeof globalThis`, an
   * intersection whose `getSymbol()` is `undefined`, and a host is equally
   * free to declare a root with an anonymous object type
   * (`declare const __gea_Display: { ... }`). `representation/derive.ts` is
   * keyed by structural type throughout, so this is also the key it can
   * actually read; see `HostNamespaceRootPolicy`.
   *
   * Interning is free here: `bindAmbientValue` already asks
   * `types.typeOf(type)` for the shape it looks up, so this records an id that
   * exists either way rather than interning a type nothing else asked about --
   * which is what `bindNativeType`'s own comment warns is order-sensitive.
   */
  readonly namespaceRoots: Map<StructuralTypeId, string>
  /**
   * Which of those ambient declarations the STANDARD LIBRARY declares, rather
   * than a host, a framework, or the program's own declaration file.
   *
   * `SourceFile.hasNoDefaultLib` is the answer, and it is the checker's own
   * fact rather than a path guess: every `lib.*.d.ts` TypeScript ships opens
   * with `/// <reference no-default-lib="true"/>`, which is precisely the
   * directive that says "this file IS a standard library", and nothing else
   * sets it.
   *
   * Read by `projection/bindings.ts` for exactly one question: whether an
   * ambient name may resolve to one of the ECMAScript/WHATWG globals this
   * backend implements itself (`btoa`, `encodeURIComponent`, ...). Those are
   * language builtins, so the compiler owns their C++ spellings -- but the
   * table is keyed by NAME, and a name match alone would silently redirect a
   * program's own `declare function btoa` to this runtime's base64 codec.
   * Requiring the declaration to be the standard library's is what makes the
   * name safe to key on.
   */
  readonly standardLibrary: Set<DeclarationId>
  readonly commonJsBindings: Map<DeclarationId, 'require' | 'exports' | 'module'>
  /** Ambient declarations using a reserved wrapper spelling without the host identity. */
  readonly commonJsProvenanceFailures: Set<DeclarationId>
  /** Ambient values whose complete Symbol declaration set is owned by a host singleton row. */
  readonly hostSingletonBindings: Set<DeclarationId>
  /** Ambient namespace roots authenticated by their complete Symbol declaration set. */
  readonly hostNamespaceBindings: Set<DeclarationId>
}

/**
 * Whether this checker symbol is a host namespace root.
 *
 * An exact row masks the legacy name table even when it does not match. That
 * is the fail-closed case for declaration merging: adding a caller declaration
 * to `Buffer` must revoke the host claim rather than falling back to the same
 * spelling in `hostNamespaces.roots`.
 */
const isHostNamespaceRoot = (input: HostProtocolInput, symbol: ts.Symbol): boolean => {
  const configured = input.hostNamespaceRootDeclarations.filter((row) => row.declarationName === symbol.name)
  if (configured.length > 0) return configured.some((row) => hasExactHostDeclaration(symbol, row))
  return input.hostNamespaceRoots.has(symbol.name)
}

/**
 * A name-only native row remains supported for compiler-owned and existing
 * host surfaces. A declaration-owned row deliberately masks that fallback:
 * once a host says the spelling belongs to one declaration, a same-named or
 * merged declaration is not an alternate ABI.
 */
const nativeTypeOf = (input: HostProtocolInput, symbol: ts.Symbol): string | null => {
  const configured = input.nativeTypesByDeclaration.get(symbol.name)
  if (configured !== undefined) return hasExactHostDeclaration(symbol, configured) ? configured.native : null
  return input.nativeTypes.get(symbol.name) ?? null
}

/**
 * The host objects this program reads: `Math`, `Date`, `JSON`, `document`, and
 * whatever else its own declarations say a host supplies.
 *
 * Each of these is an ambient *value* whose type is a named interface -- the
 * exact shape of "a host owns this object; the program only reads it". The
 * carrier for one is a host handle, not a struct, and the difference is not
 * cosmetic. `Math`'s interface carries `[Symbol.toStringTag]`, `String`'s
 * result carries a numeric index signature, and `DateConstructor` carries four
 * construct signatures with four different frames -- all of which correctly
 * refuse to become a record layout, because none of them *is* one. Laying them
 * out structurally produced 108 unresolved carriers in one application, every
 * one of them describing a struct nothing was ever going to allocate.
 *
 * The protocol is named by the *type's* own declared name, so two globals of
 * one interface share one protocol. That is a spelling, and it is the same
 * admitted exception `BindingOperation.external`'s linkage name is: an ambient
 * declaration's name is its ABI contract with whatever defines it, and there is
 * no other handle on a thing this program never defines. Nothing is assumed
 * about which names exist -- a program whose declarations mention none of them
 * binds nothing, and `preflight/run.ts` still censuses every protocol against
 * `manifest.nativeProtocols`, so a target that has not implemented one refuses
 * rather than emitting against glue that is not there.
 *
 * A *class* declared ambiently does not bind here: its value is a constructor
 * object, not a `declared` type, and constructing one is a different question
 * from reading a member off a host singleton.
 */
/**
 * A declared type an installed host states a carrier for.
 *
 * `bindAmbientValue` below finds only what a host *value* hands out, and most
 * of a host's object model is never handed out by one. `GeaElement` is written
 * by the framework as a type-parameter constraint and default and never as a
 * value; `Node`, `Text` and `DOMTokenList` are parameter annotations in a
 * program that may never touch `document`. Nothing bound any of them, so
 * `derive.ts` expanded them structurally -- straight into `HTMLElement`'s own
 * `childNodes` cycle, which is the "no record layout ... carries unresolved"
 * failure `bindAmbientValue`'s own comment already predicted, three layers
 * downstream of the actual gap.
 *
 * The name is the join key. That is the same admitted exception an ambient
 * declaration's linkage name already is (`BindingOperation.external`): a host
 * type this program never defines has no other handle on it. What keeps it from
 * being a guess is that the table is the *plugin's*, supplied as input -- a
 * name it does not state binds nothing, and this file names none of them.
 */
const bindNativeType = (input: HostProtocolInput, census: HostCensus, reference: ts.Identifier): ts.Type | null => {
  const local = input.checker.getSymbolAtLocation(reference)
  if (!local) return null
  // The same alias step `bindAmbientValue` takes, for the same reason: an
  // imported name's own symbol is the import specifier, which lives in this
  // program's file and is not ambient at all. `GeaElement` is imported by the
  // framework's own `runtime/compiler.ts`, so without this it is an `Alias`
  // with no `Type` flag and binds nothing -- measured, not supposed.
  const symbol = (local.flags & ts.SymbolFlags.Alias) !== 0 ? input.checker.getAliasedSymbol(local) : local
  if ((symbol.flags & ts.SymbolFlags.Type) === 0 || !isAmbientSymbol(symbol)) return null
  const stated = nativeTypeOf(input, symbol)
  if (stated === null) return null
  // Routed through `identities.symbolDeclarationId` -- the same route
  // `promiseDeclarationOf` takes, and deliberately NOT through
  // `types.typeOf(...)`. Asking the structural mapper would *intern* every
  // named type this table mentions, and interning is order-sensitive: which
  // member of a type cycle gets the nominal anchor depends on which was interned
  // first, so a pass that interned thirty-nine extra types would move that
  // anchor. It did: an early version of this took the three.js app from 2
  // guard violations to 269, all of them
  // `unresolved(a self-referential type of this shape is not modelled)`
  // propagating out of three.js's `Object3D`/`Mesh` cycle. The declaration
  // identity is all a binding needs, and the identity table answers it without
  // interning anything.
  //
  // No shape check either, and none is needed: `derive.ts` consults
  // `binding.forDeclaration` only in its `declared`, `class-instance` and
  // `class-constructor` cases, so a binding for a declaration that never
  // derives as one of those is simply never read.
  const declaration = input.identities.symbolDeclarationId(symbol, reference)
  if (!declaration) return null
  const declared = input.checker.getDeclaredTypeOfSymbol(symbol)
  // ...and one check the NAME cannot make on its own.
  //
  // The join key is a bare name, which is the admitted exception this
  // function's own comment states -- but a name is not unique, and a plugin's
  // row means *its* declaration, never whichever same-named one a program
  // happens to import. The three.js app shims `troika-three-text` as
  // `declare module 'troika-three-text' { export class Text extends Object3D }`,
  // and the gea plugin states `Text -> gea::embedded::ui::NodeHandle` for the
  // DOM text node. Same name, unrelated types: every troika `Text` in the HUD
  // bound as a gea UI node handle, and the closure walk then followed that
  // handle's `userData`/`toJSON` into `lib.es5`'s own `Object` and `Function`
  // and demanded host boundaries for them -- 1329 of the three.js app's 3394 root
  // diagnostics, all from one collision, on top of a silent miscompile of
  // every text object in the program.
  //
  // What separates the two is not the name but the hierarchy. A host protocol
  // is OPAQUE: the host owns the type and everything it derives from, which is
  // why `@geastack/core`'s `Element extends Node` and AppKit's
  // `NSView extends NSResponder` bind exactly as before -- every base of each
  // is itself declared, never defined. troika's `Text` derives from three.js's
  // `Object3D`, an ordinary class this program COMPILES FROM SOURCE; a handle
  // with no layout cannot be the carrier of a type half of whose members this
  // compilation is emitting. So a declaration with a defined base is not the
  // host's, whatever it is called.
  for (const base of declaredBaseTypesOf(input.checker, declared)) {
    const baseSymbol = base.getSymbol()
    if (baseSymbol && !isAmbientSymbol(baseSymbol)) return null
  }
  if (!census.protocols.has(declaration))
    census.protocols.set(declaration, { protocol: symbol.name, version: 1, native: stated, opaque: false })
  return declared
}

/**
 * A host type reached only through a CONTEXTUAL type -- never spelled.
 *
 * `bindNativeType` above joins on a name the program writes. A JSX event
 * handler writes none: `onTouchMove={e => pan(e.clientX, e.clientY)}` gets `e`'s
 * type from the attribute's own declaration (`onTouchMove?: TouchEventHandler`)
 * in the framework's ambient file, so the identifier `TouchEvent` never appears
 * in any file this walk visits and the table's row for it never fired.
 *
 * The parameter's own name IS in the program, though, and it is the identifier
 * this walk is already standing on -- so the join is the same one, asked of the
 * checker instead of the source text. Restricted to a parameter with no written
 * annotation, because an annotation is itself an identifier `bindNativeType`
 * binds one line above; asking twice would just re-answer it.
 *
 * Narrow on purpose. Binding every name the table states, wherever a type
 * happens to carry it, is what `bindNativeType`'s own comment warns is
 * order-sensitive -- it interns types, and which member of a cycle gets the
 * nominal anchor depends on which was interned first.
 *
 * Without this, an event parameter derived structurally: a `TouchEvent` became
 * a generated record of doubles rather than the engine's own `PointerEvent`,
 * so the handler was an arity-1 callable the listener runtime had no way to
 * call, and every drag, pan and swipe in a JSX app did nothing at all.
 */
const bindNativeContextualType = (input: HostProtocolInput, census: HostCensus, reference: ts.Identifier): ts.Type | null => {
  const parameter = reference.parent
  if (!ts.isParameter(parameter) || parameter.name !== reference || parameter.type !== undefined) return null
  // STATED, not HOLDS -- deliberately not `censusedTypeAt`. This asks what
  // AMBIENT CONTEXTUAL type a framework's own `.d.ts` gave this unannotated
  // parameter (`onTouchMove?: TouchEventHandler` -> `e: TouchEvent`), so it
  // can bind a HOST-PROTOCOL identity -- a different question from "what
  // value does this parameter hold", which is what the parameter-binding
  // census answers from real call-site evidence. The two domains overlap
  // syntactically (both fire only on unannotated parameters), but a
  // parameter used BOTH as a JSX handler and called directly elsewhere with
  // unrelated arguments could have a census-bound value type that disagrees
  // with its ambient host type; substituting it here risks losing the host
  // binding (`type.getSymbol()`/`aliasSymbol` needs the AMBIENT type's
  // identity, not an unrelated value-derived one) for no boxing benefit --
  // this function feeds `census.protocols`, never a value carrier. Left as a
  // direct checker call.
  const type = input.checker.getTypeAtLocation(reference)
  const symbol = type.getSymbol() ?? type.aliasSymbol
  if (!symbol) return null
  const stated = nativeTypeOf(input, symbol)
  if (stated === null || !isAmbientSymbol(symbol)) return null
  const declaration = input.identities.symbolDeclarationId(symbol, reference)
  if (!declaration) return null
  if (!census.protocols.has(declaration))
    census.protocols.set(declaration, { protocol: symbol.name, version: 1, native: stated, opaque: false })
  return type
}

/**
 * Node wraps a CommonJS source in a function whose parameters already bind
 * require/exports/module. A module-scope `var` of one of those names therefore
 * redeclares that parameter; it does not allocate the local Symbol TypeScript
 * gives a standalone source file. Index that Symbol's declaration identity as
 * the same wrapper cell, including binding patterns and `for (var ... of/in)`.
 */
const indexCommonJsVarRedeclarations = (input: HostProtocolInput, census: HostCensus, identity: CommonJsWrapperIdentity): void => {
  const bindName = (name: ts.BindingName, declaration: ts.Declaration): void => {
    if (ts.isIdentifier(name)) {
      const configured = input.commonJsGlobals.get(name.text)
      if (!configured) return
      const id = input.identities.declarationIdOf(declaration)
      const global = identity.globalOfDeclaration(declaration)
      if (global === configured.global) census.commonJsBindings.set(id, global)
      else census.commonJsProvenanceFailures.add(id)
      return
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue
      bindName(element.name, element)
    }
  }

  const visitSource = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && isCommonJsWrapperVarDeclaration(node)) {
      if (ts.isIdentifier(node.name)) bindName(node.name, node)
      else {
        for (const identifier of commonJsBindingIdentifiers(node.name)) {
          const declaration = ts.isBindingElement(identifier.parent) ? identifier.parent : node
          bindName(identifier, declaration)
        }
      }
    }
    ts.forEachChild(node, visitSource)
  }
  for (const file of input.files) visitSource(file)
}

/** An exact host binding reached only as `globalThis.name` or `globalThis['name']`. */
const bindAmbientGlobalMember = (
  input: HostProtocolInput,
  census: HostCensus,
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  seedPaths: Map<ts.Type, string>
): ts.Type | null => {
  if (!input.isIntrinsicGlobalThis(node.expression)) return null
  const key = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)
      ? node.argumentExpression.text
      : null
  if (key === null) return null
  const symbol = ts.isPropertyAccessExpression(node)
    ? input.checker.getSymbolAtLocation(node.name)
    : input.checker.getPropertyOfType(input.checker.getTypeAtLocation(node.expression), key)
  if (!symbol || (symbol.flags & ts.SymbolFlags.Value) === 0 || !isAmbientSymbol(symbol)) return null
  const declaration = input.identities.valueDeclarationOfSymbol(symbol)
  if (!declaration) return null
  const singleton = input.hostSingletonDeclarations.get(symbol.name)
  const exactSingleton = singleton !== undefined && hasExactHostDeclaration(symbol, singleton)
  const namespace = isHostNamespaceRoot(input, symbol)
  if (!exactSingleton && !namespace) return null

  const id = input.identities.symbolValueDeclarationId(symbol, node)
  if (id === null) return null
  if (exactSingleton) census.hostSingletonBindings.add(id)
  if (namespace) census.hostNamespaceBindings.add(id)
  census.externals.set(id, symbol.name)
  census.externalFiles.set(id, declaration.getSourceFile().fileName)

  const type = input.checker.getTypeOfSymbolAtLocation(symbol, node)
  const typeId = input.types.typeOf(type)
  if (namespace) {
    const rootType = input.hostNamespaceRootTypes.get(symbol.name)
    if (rootType !== undefined) census.namespaceRoots.set(typeId, rootType)
    seedPaths.set(type, symbol.name)
  }
  return type
}

export const ambientHostBindings = (
  input: HostProtocolInput,
  census: HostCensus,
  typedArrayElements: Map<DeclarationId, TypedArrayElementDomain>
): void => {
  const seeds: ts.Type[] = []
  const commonJsIdentity = createCommonJsWrapperIdentity(
    input.checker,
    [...input.files, ...input.commonJsDeclarationFiles],
    input.commonJsGlobals
  )
  // A seed a bare namespace-root reference resolved to (`navigator`, `window`)
  // carries the root's own name as the path it was reached by -- see
  // `bindAmbientValue`'s own namespace-root branch. `bindHostObjectClosure`
  // reads this to keep extending the path into that seed's OWN members,
  // exactly as far as the host states members under it and no further.
  const seedPaths = new Map<ts.Type, string>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const global = bindAmbientGlobalMember(input, census, node, seedPaths)
      if (global) seeds.push(global)
    }
    // `isValueReference` is the census's own rule, reused rather than restated:
    // it is what excludes a JSX intrinsic tag (whose symbol is a *type* member
    // on `IntrinsicElements`, not a cell), a property key, and an import
    // specifier's own name. Writing a second rule here bound `div` and `span`
    // as host objects and gave their props interfaces host protocols.
    if (ts.isIdentifier(node)) {
      const value = isValueReference(node, input.namespacePaths) ? bindAmbientValue(input, census, node, seedPaths, commonJsIdentity) : null
      if (value) seeds.push(value)
      // Deliberately NOT an `else`. `isValueReference` is true for plenty of
      // identifiers whose `bindAmbientValue` then answers `null`, so an `else`
      // here never ran at all -- measured: with it, not one of the thirty-nine
      // names bound. The two walks ask different questions of the same
      // identifier and both answers are wanted.
      const stated = bindNativeType(input, census, node)
      // Seeded into the closure below like any other binding, so a host type
      // reached only through a bound type's members -- never spelled by the
      // program itself -- is found the same way `document`'s are.
      if (stated) seeds.push(stated)
      const contextual = bindNativeContextualType(input, census, node)
      if (contextual) seeds.push(contextual)
    }
    ts.forEachChild(node, visit)
  }
  for (const file of input.files) ts.forEachChild(file, visit)
  indexCommonJsVarRedeclarations(input, census, commonJsIdentity)
  bindHostObjectClosure(input, census, seeds, seedPaths)
  typedArrayElementBindings(input, seeds, typedArrayElements)
}

/**
 * The checker's own name for each standard-library TypedArray *constructor*
 * type, to the element width/encoding that constructor's instances store.
 *
 * These eight interfaces are core ECMAScript (`lib.es5.d.ts`,
 * `lib.es2015.iterable.d.ts`, `lib.es2017.typedarrays.d.ts`), not a host
 * protocol -- nothing here is framework-shaped or configurable, the same way
 * `primitiveCarrier` (representation/derive.ts) hardcodes `number`/`string`/
 * `boolean` rather than reading them from an installed table.
 *
 * `BigInt64Array`/`BigUint64Array` remain deliberately absent: their elements
 * are BigInts, which no `ScalarDomain`/`TypedArrayElementDomain` models and
 * this backend has no carrier for at all, so a program naming one gets no
 * typed-array carrier and refuses by name rather than being handed a 64-bit
 * integer view whose reads would have to lie about their type. That is the
 * same rule that kept `Uint8ClampedArray` out until its own write rule
 * (ECMA-262 7.1.11) had a verified implementation -- admitting a kind with no
 * verified truncation rule is worse than refusing it -- and it now has one.
 */
/**
 * The same nine kinds, keyed by the INSTANCE interface's own name.
 *
 * Two tables for two different questions, not one table duplicated.
 * `typedArrayConstructorDomains` below answers "which constructor type is
 * this ambient VALUE?", asked of a seed the program's own text produced;
 * this one answers "which declared TYPE is this?", asked of the standard
 * library directly with no use site at all -- the same independence
 * `standardBufferDeclarationsOf` and `keyedCollectionDeclarationsOf` are
 * written for, and for a reason the seed walk cannot cover:
 * `TextEncoder.prototype.encode` is declared to return `Uint8Array<ArrayBuffer>`,
 * so a program can HOLD a typed array while never naming one. Its declaration
 * then had no element width, so it derived the interface's structural body --
 * a `gea_record_type_N` whose `set`/`subarray`/`fill` are `CallableObject`
 * fields nothing defines -- instead of `gea::TypedArray<std::uint8_t>`.
 *
 * The nine rows are identical in both because they are the same nine kinds
 * for the same reason, `BigInt64Array`/`BigUint64Array` excluded from both by
 * the rule stated below.
 */
const typedArrayInstanceDomains = new Map<string, TypedArrayElementDomain>([
  ['Int8Array', 'int8'],
  ['Uint8Array', 'uint8'],
  ['Uint8ClampedArray', 'uint8-clamped'],
  ['Int16Array', 'int16'],
  ['Uint16Array', 'uint16'],
  ['Int32Array', 'int32'],
  ['Uint32Array', 'uint32'],
  ['Float32Array', 'float32'],
  ['Float64Array', 'float64']
])

/**
 * The same nine names, for a caller that only needs to ask "is this receiver
 * one of the standard TypedArray instance interfaces" and has no
 * `IdentityTable`/`DeclarationId` machinery available yet to consume
 * `typedArrayDeclarationsOf` below -- `flow/value-flow.ts` is built in
 * `frontend.ts` before `identities` exists (see that file's own doc comment
 * on `isStandardInterfaceType`). Exported so that caller can resolve each
 * name through the checker itself rather than re-typing this list as a
 * second, independently-maintained answer to "which nine names."
 */
export const typedArrayInstanceInterfaceNames: readonly string[] = [...typedArrayInstanceDomains.keys()]

/** The nine instance interfaces' declaration identities, resolved by name exactly as `standardBufferDeclarationsOf` resolves `ArrayBuffer`/`DataView` -- see `typedArrayInstanceDomains`. */
export const typedArrayDeclarationsOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[],
  program: ts.Program,
  hostDeclarations: readonly HostOwnedDeclaration[] = []
): Map<DeclarationId, TypedArrayElementDomain> => {
  const found = new Map<DeclarationId, TypedArrayElementDomain>()
  const anchor = files[0]
  if (!anchor) return found
  for (const [name, domain] of typedArrayInstanceDomains) {
    const symbol = checker.resolveName(name, anchor, ts.SymbolFlags.Interface, false)
    if (!symbol) continue
    const declaration = identities.symbolDeclarationId(symbol, anchor)
    if (declaration) found.set(declaration, domain)
  }
  extendedTypedArrayDeclarations(checker, identities, files, program, hostDeclarations, found)
  return found
}

/**
 * An interface that EXTENDS one of the nine carries the same elements.
 *
 * `interface Buffer extends Uint8Array<ArrayBuffer>` is node's own declaration
 * of its byte view, and TypeScript's answer for it is unambiguous: a `Buffer`
 * has every member a `Uint8Array` has and is assignable to one, which is why
 * bson and the mongodb driver pass a `Buffer` to every `Uint8Array` parameter
 * in the codebase. A physical carrier that is not the typed array cannot be
 * right for such a type, and the one it got instead is the failure this file
 * already records for `TextEncoder.encode`'s return type: the interface's
 * structural body, a record whose `set`/`subarray`/`fill` are
 * `CallableObject` fields nothing defines.
 *
 * Members the extending interface adds of its OWN (`readUInt32LE`,
 * `toString(encoding)`) are not in the carrier and refuse BY NAME at their own
 * access unless a host installs a row for them -- the same rule every typed
 * array already lives under, and the honest one: an added member is the host's
 * to implement, and inventing a record field for it is what produced the
 * undefined callables above.
 *
 * `files` are the program implementation files. A declaration file joins
 * them only when an installed host has authenticated that exact declaration
 * identity; caller `.d.ts` files, and unrelated declarations
 * in the same host file, remain out of this traversal. Run to a fixpoint so a
 * chain (`interface A extends Uint8Array`, `interface B extends A`) resolves
 * whatever order the files are in; the pass is bounded by the number of
 * interfaces, since every lap either adds one or stops.
 */
const extendedTypedArrayDeclarations = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[],
  program: ts.Program,
  hostDeclarations: readonly HostOwnedDeclaration[],
  found: Map<DeclarationId, TypedArrayElementDomain>
): void => {
  const interfaces: ts.InterfaceDeclaration[] = []
  const configuredByName = new Map<string, HostOwnedDeclaration[]>()
  for (const configured of hostDeclarations) {
    const rows = configuredByName.get(configured.declarationName) ?? []
    rows.push(configured)
    configuredByName.set(configured.declarationName, rows)
  }
  const collect = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) interfaces.push(node)
    ts.forEachChild(node, collect)
  }
  for (const file of files) ts.forEachChild(file, collect)
  const hostOwners = new Set<string>()
  for (const configured of hostDeclarations) {
    const file = program.getSourceFile(configured.declarationFileName)
    if (!file) continue
    const collectHost = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === configured.declarationName) {
        const symbol = checker.getSymbolAtLocation(node.name)
        if (symbol && hasExactHostDeclaration(symbol, configured)) {
          hostOwners.add(`${file.fileName}\u0000${configured.declarationName}`)
          interfaces.push(node)
        }
      }
      ts.forEachChild(node, collectHost)
    }
    ts.forEachChild(file, collectHost)
  }
  let added = true
  while (added) {
    added = false
    for (const declaration of interfaces) {
      // Resolved with NO use site, exactly as the nine above are resolved
      // against the anchor file: `useSitePath` answers a SPECIALIZATION path
      // for a generic interface named inside a copy, and `Uint8Array<T>` is
      // generic -- so asking at the heritage node minted an id for a copy
      // while the nine were registered at the root, and the two never
      // compared equal. Measured: the rule fired for nothing at all.
      const ownSymbol = checker.getSymbolAtLocation(declaration.name)
      const own = ownSymbol ? identities.symbolDeclarationId(ownSymbol) : null
      if (!own || found.has(own)) continue
      // An exact host row masks the ordinary source-file route too. This is
      // load-bearing for declaration-only `.ts` modules such as node-compat's
      // buffer-types.ts: they are part of `files`, but a caller augmentation
      // must still revoke the host's Buffer carrier claim.
      const configured = configuredByName.get(declaration.name.text)
      if (configured && (!ownSymbol || !configured.some((row) => hasExactHostDeclaration(ownSymbol, row)))) continue
      const sourceOwned = files.includes(declaration.getSourceFile())
      if (!sourceOwned && !hostOwners.has(`${declaration.getSourceFile().fileName}\u0000${declaration.name.text}`)) continue
      for (const clause of declaration.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
        for (const base of clause.types) {
          const symbol = checker.getSymbolAtLocation(base.expression)
          const baseDeclaration = symbol ? identities.symbolDeclarationId(symbol) : null
          const domain = baseDeclaration ? found.get(baseDeclaration) : undefined
          if (domain === undefined) continue
          found.set(own, domain)
          added = true
        }
      }
    }
  }
}

const typedArrayConstructorDomains = new Map<string, TypedArrayElementDomain>([
  ['Int8ArrayConstructor', 'int8'],
  ['Uint8ArrayConstructor', 'uint8'],
  // `Uint8ClampedArray` is admitted with its siblings now that its write rule
  // has a verified implementation and a carrier of its own to hold it:
  // ECMA-262 7.1.11 `ToUint8Clamp` -- clamp to [0, 255], round halves to EVEN
  // -- ported from v1's `gea_cpp_typed_array::coerce_element`
  // (`runtime/typed_array.h`), specialized on `gea::ClampedUint8` so the rule
  // is chosen at compile time. See `TypedArrayElementDomain`.
  ['Uint8ClampedArrayConstructor', 'uint8-clamped'],
  ['Int16ArrayConstructor', 'int16'],
  ['Uint16ArrayConstructor', 'uint16'],
  ['Int32ArrayConstructor', 'int32'],
  ['Uint32ArrayConstructor', 'uint32'],
  ['Float32ArrayConstructor', 'float32'],
  ['Float64ArrayConstructor', 'float64']
])

/**
 * Which declarations name a standard TypedArray *instance* interface, found
 * from the same ambient-value seeds `bindHostObjectClosure` already walks.
 *
 * Reusing `bindAmbientValue`'s seeds rather than `hostObjectTypeOf`'s member
 * closure is deliberate: `hostObjectTypeOf` unwraps a *single* type argument
 * off a container generic (correct for `Promise<Element>`, wrong here --
 * `Uint8ArrayConstructor.from(...)`'s modern return type is
 * `Uint8Array<ArrayBuffer>`, one type argument, and unwrapping it hands back
 * `ArrayBuffer` instead of the typed array itself). A constructor's own
 * construct signatures already state the instance type directly, with no
 * unwrapping needed -- `new (length: number) => Uint8Array<ArrayBuffer>` is
 * the answer as written, not a container to look inside.
 *
 * A seed with no matching name (every ordinary host global) costs one map
 * lookup and contributes nothing, so this runs over every seed unconditionally
 * rather than needing its own identifier walk. This runs whether or not the
 * program ever actually constructs one -- a program that only ever receives a
 * `Uint8Array` as a parameter still mentions the ambient `Uint8Array` name
 * once in that parameter's type position, and `bindAmbientValue` already
 * resolves that mention's merged type/value symbol to the constructor type
 * (`getTypeOfSymbolAtLocation` answers with the value meaning regardless of
 * which position the reference sat in), so the seed is present either way.
 */
// The five `.getReturnType()`/`getTypeOfSymbolAtLocation` calls in this
// function and in `bindHostObjectClosure`/`bindAmbientValue` below all walk
// TYPE-SYSTEM STRUCTURE -- a `ts.Signature`'s own return type, a `ts.Symbol`
// member's own declared type -- reached from ambient lib.d.ts seeds
// (`Uint8ArrayConstructor`, `document`, `navigator`, ...), never from a
// program `ts.Node`. There is no `censusedTypeAt(checker, census, node)`
// question to ask: the parameter/local/return/field binding censuses answer
// about program-AUTHORED positions a call site or a write could fill in
// (an unannotated parameter, a `let` with no initializer, a class field);
// they carry no information about a host's OWN ambient declarations, and an
// ambient member/signature has no such node to key on regardless. This
// whole file's subject is host-protocol IDENTITY -- STATED by the platform's
// own types -- not a value carrier this compiler could box. Left as direct
// checker calls throughout.
const typedArrayElementBindings = (
  input: HostProtocolInput,
  seeds: readonly ts.Type[],
  elements: Map<DeclarationId, TypedArrayElementDomain>
): void => {
  for (const type of seeds) {
    const domain = typedArrayConstructorDomains.get(type.getSymbol()?.name ?? '')
    if (!domain) continue
    for (const signature of input.checker.getSignaturesOfType(type, ts.SignatureKind.Construct)) {
      const instance = signature.getReturnType()
      const shape = input.table.get(input.types.typeOf(instance))?.shape
      if (shape?.kind === 'declared' && !elements.has(shape.declaration)) elements.set(shape.declaration, domain)
    }
  }
}

/**
 * The host owns what the host hands you.
 *
 * An ambient value binds a protocol for its own type -- `document` is a
 * `Document`. But the objects that value *returns* are host objects too:
 * `document.getElementById(id)` yields an `Element` the program did not
 * construct, whose members are the host's implementation and not a struct
 * layout this compiler is free to invent. Binding only the seed leaves
 * `Element` deriving as an ordinary record, and a call to `setAttribute` then
 * looks for a struct field that does not exist.
 *
 * The closure is transitive because the relationship is: an `Element`'s
 * `children` are `Element`s. It stops at types that are not ambient, which is
 * what keeps a program's own interface from being turned into a host object
 * merely by being mentioned in a host signature.
 */
const hostObjectTypeOf = (input: HostProtocolInput, type: ts.Type): ts.Type | null => {
  // A member that hands back `Element | null` hands back an Element; the
  // absence is the optional carrier's business, not the protocol's. Array and
  // readonly-array members (`querySelectorAll`) are the same fact once.
  const unwrapped = type.isUnion() ? type.types.filter((arm) => !isNullish(arm)) : [type]
  const single = unwrapped.length === 1 ? unwrapped[0] : undefined
  if (!single) return null
  const reference = input.checker.getTypeArguments(single as ts.TypeReference)
  const element = reference.length === 1 ? reference[0] : undefined
  const object = element ?? single
  // A generic host signature can hand back its caller's T. The structural
  // mapper may already substitute T with a program-owned document type;
  // registering that declaration under the ambient spelling "T" would turn
  // every instance of the document into an imaginary native host handle.
  // An open type parameter is not evidence of host ownership.
  return (object.flags & ts.TypeFlags.TypeParameter) !== 0 ? null : object
}

const isNullish = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0

/**
 * The declaration identity of the standard library's own `Promise<T>`
 * interface -- resolved independent of whether the program's own text ever
 * names `Promise`, because an `async` function's return type mentions it
 * without a single textual reference the ambient-value seed walk above could
 * pick up (`typedArrayElementBindings`/`bindHostObjectClosure` both start
 * from identifiers actually written in value position; `async function f()
 * {}` has none).
 *
 * `checker.resolveName` is the public TypeChecker API for exactly this:
 * "what does this name mean here", independent of any use site. Any source
 * file anchors the lookup -- `Promise` is a single ambient global, not
 * scoped per-file, so which file supplies the location does not change the
 * answer.
 *
 * Routed through `identities.symbolDeclarationId` rather than a bespoke
 * declaration walk: it already does alias-following and specialization-path
 * resolution the same way every other declaration identity in this file is
 * computed, so a program that re-exports or augments `Promise` is not a
 * second code path to get wrong.
 */
export const promiseDeclarationOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): DeclarationId | null => {
  const anchor = files[0]
  if (!anchor) return null
  const symbol = checker.resolveName('Promise', anchor, ts.SymbolFlags.Interface, false)
  if (!symbol) return null
  return identities.symbolDeclarationId(symbol, anchor)
}

/**
 * The declaration identity of the standard library's own `Date` INTERFACE --
 * `lib.es5.d.ts`'s `interface Date`, the type of a Date instance, never the
 * `DateConstructor` the global `Date` VALUE has.
 *
 * Resolved exactly the way `promiseDeclarationOf` above resolves `Promise`,
 * and for the same reason: a program can receive a Date purely through an
 * imported signature and never name the type itself, so `checker.resolveName`
 * -- which answers "what does this name mean here" with no use site at all --
 * is what makes the policy installable either way.
 *
 * Date is core ECMAScript with a compiler-owned native layout, the category
 * `Promise<T>`, the eight TypedArray views and the four keyed collections are
 * already in -- NOT a host protocol. Nothing installs it; `lib.es5.d.ts`
 * declares it, and `gea::runtime::Date` (runtime/gea_runtime.h) implements
 * it. Its C++ spelling therefore belongs to the backend's own tables
 * (`targets/cpp/prototype/emit-prototype-date.ts`), never to a plugin package.
 *
 * Consulted ahead of `HostBindingPolicy` in `derive.ts` for the reason
 * `PromiseDeclarationPolicy` states for itself: `Date`'s ambient interface
 * body, run through `declaredBodyOf`'s data-only member stripping, is an
 * EMPTY object shape (every member of `interface Date` is a method), so
 * falling through seals a layout of nothing and the emitter then spells
 * `d.getFullYear` as a struct field that does not exist.
 */
export const dateDeclarationOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): DeclarationId | null => {
  const anchor = files[0]
  if (!anchor) return null
  const symbol = checker.resolveName('Date', anchor, ts.SymbolFlags.Interface, false)
  if (!symbol) return null
  return identities.symbolDeclarationId(symbol, anchor)
}

/**
 * The declaration identity of the standard `String` WRAPPER-OBJECT interface
 * (`lib.es5.d.ts`'s `interface String`), resolved exactly the way
 * `dateDeclarationOf` immediately above resolves `Date`, and for the same
 * reasons: `new String(x)` can reach the type through an imported signature's
 * return type and never name it directly, so `checker.resolveName` -- which
 * answers "what does this name mean here" independent of any use site -- is
 * what makes the policy installable either way.
 *
 * `String` (the interface, not the `string` primitive or `StringConstructor`
 * the value `String` resolves to) is core ECMAScript with a compiler-owned
 * native layout, the same category `Date` is in -- see
 * `StringObjectDeclarationPolicy` (representation/policies.ts) for the full
 * reasoning on why this must be resolved and checked ahead of
 * `HostBindingPolicy`.
 */
export const stringObjectDeclarationOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): DeclarationId | null => {
  const anchor = files[0]
  if (!anchor) return null
  const symbol = checker.resolveName('String', anchor, ts.SymbolFlags.Interface, false)
  if (!symbol) return null
  return identities.symbolDeclarationId(symbol, anchor)
}

/** Resolve intrinsic Error interfaces by declaration identity, never at a property use site. */
export const errorDeclarationsOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): ReadonlySet<DeclarationId> => {
  const anchor = files[0]
  const declarations = new Set<DeclarationId>()
  if (!anchor) return declarations
  for (const name of ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError']) {
    const symbol = checker.resolveName(name, anchor, ts.SymbolFlags.Interface, false)
    if (!symbol || !symbol.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile)) continue
    const declaration = identities.symbolDeclarationId(symbol, anchor)
    if (declaration) declarations.add(declaration)
  }
  return declarations
}

/**
 * The declaration identity of the standard `Generator<T, TReturn, TNext>`
 * interface, resolved exactly the way `promiseDeclarationOf` above resolves
 * `Promise` and for the same reasons: independence from whether the program
 * ever writes the name, and one alias-following implementation shared with
 * every other declaration identity in this file.
 *
 * `ts.SymbolFlags.Interface`, because that is what `lib.es2015.generator.d.ts`
 * declares it as. A `lib` that does not install it (an `ES5`-only project)
 * answers `null`, and every `function*` in such a program is then refused
 * rather than mis-carried -- which is correct, since `function*` is not
 * expressible under that `lib` either.
 */
/**
 * The declaration identity of the bare `Function` interface (`lib.es5.d.ts`'s
 * `interface Function`), resolved exactly the way `stringObjectDeclarationOf`
 * above resolves `String` and for the same reason: a program almost never
 * writes the name, yet reaches the type constantly --
 * `typeof x === 'function'` narrows an `unknown` to it, and
 * `Object.prototype.constructor` is declared as it -- so `checker.resolveName`,
 * which answers "what does this name mean here" independent of any use site,
 * is what makes the policy installable at all.
 *
 * `ts.SymbolFlags.Interface`, because that is what declares it; the value
 * `Function` resolves to `FunctionConstructor`, which is a different symbol
 * and deliberately untouched -- an ambient constructor object really is a host
 * boundary. See `FunctionDeclarationPolicy` (representation/policies.ts).
 */
export const functionDeclarationOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): DeclarationId | null => {
  const anchor = files[0]
  if (!anchor) return null
  const symbol = checker.resolveName('Function', anchor, ts.SymbolFlags.Interface, false)
  if (!symbol) return null
  return identities.symbolDeclarationId(symbol, anchor)
}

/** Standard `SymbolConstructor` unique-symbol declarations, keyed by declaration identity. */
export const wellKnownSymbolDeclarationsOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): ReadonlyMap<DeclarationId, string> => {
  const anchor = files[0]
  if (!anchor) return new Map()
  const symbol = checker.resolveName('SymbolConstructor', anchor, ts.SymbolFlags.Interface, false)
  if (!symbol) return new Map()
  const declared = checker.getDeclaredTypeOfSymbol(symbol)
  const result = new Map<DeclarationId, string>()
  for (const member of declared.getProperties()) {
    const declaration = identities.declarationOfSymbol(member)
    if (!declaration) continue
    const type = checker.getTypeOfSymbolAtLocation(member, declaration)
    if ((type.flags & ts.TypeFlags.UniqueESSymbol) === 0) continue
    result.set(identities.declarationIdOf(declaration), member.getName())
  }
  return result
}

/**
 * The declaration identity of the standard `AsyncGenerator<T, TReturn, TNext>`
 * interface -- what an `async function*` returns -- resolved exactly the way
 * `generatorDeclarationOf` below resolves `Generator`.
 *
 * It carries the SAME `iterator(T)` cursor, and that is not an approximation:
 * `gea::Promise<V>` is a settled-value box with no job queue, so every `await`
 * this compiler emits is a synchronous read and an async body has run to
 * completion by the time it returns. Under that model an async generator's
 * `next()` hands back an already-settled result, which is exactly what the
 * synchronous cursor already is (see `producers/control.ts`'s yield comment
 * for the full argument, and for what a port with a real job queue would have
 * to revisit alongside it).
 */
export const asyncGeneratorDeclarationOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): DeclarationId | null => {
  const anchor = files[0]
  if (!anchor) return null
  const symbol = checker.resolveName('AsyncGenerator', anchor, ts.SymbolFlags.Interface, false)
  if (!symbol) return null
  return identities.symbolDeclarationId(symbol, anchor)
}

export const generatorDeclarationOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): DeclarationId | null => {
  const anchor = files[0]
  if (!anchor) return null
  const symbol = checker.resolveName('Generator', anchor, ts.SymbolFlags.Interface, false)
  if (!symbol) return null
  return identities.symbolDeclarationId(symbol, anchor)
}

/** The standard `MapIterator<T>` returned by `Map.prototype.entries()`. */
export const mapIteratorDeclarationOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): DeclarationId | null => {
  const anchor = files[0]
  if (!anchor) return null
  const symbol = checker.resolveName('MapIterator', anchor, ts.SymbolFlags.Interface, false)
  if (!symbol) return null
  return identities.symbolDeclarationId(symbol, anchor)
}

/**
 * The four standard keyed-collection interface names, to the family each one
 * is. Hardcoded for exactly the reason `typedArrayConstructorDomains` above
 * is: these are core ECMAScript (`lib.es2015.collection.d.ts`), not something
 * a host installs, so there is no table to read them from and nothing
 * framework-shaped about naming them -- the same way `primitiveCarrier`
 * (representation/derive.ts) names `number`/`string`/`boolean` outright.
 *
 * `ReadonlyMap`/`ReadonlySet` are deliberately absent. They are separate
 * declarations with their own identities, and admitting one here would claim
 * that a `ReadonlyMap<K, V>` parameter and the `Map<K, V>` handed to it are
 * one carrier -- which is true physically and *unproven* here, since nothing
 * in this compiler yet renders the read-only half's own member set. A program
 * that names one still refuses by name rather than silently sharing storage.
 */
const keyedCollectionFamilies: ReadonlyMap<string, KeyedCollectionFamily> = new Map([
  ['Map', 'map'],
  ['Set', 'set'],
  ['WeakMap', 'weak-map'],
  ['WeakSet', 'weak-set']
])

/**
 * The declaration identity of each standard keyed-collection interface this
 * compilation's `lib` installs.
 *
 * Resolved exactly the way `promiseDeclarationOf` above resolves `Promise`,
 * and for the same two reasons. First, independence from the program's own
 * text: `const seen: Set<string> = new Set()` names `Set` twice, but
 * `function f(m: Map<string, number>)` in a program that never writes `new
 * Map()` names only the TYPE, and the ambient-VALUE seed walk
 * (`bindAmbientValue`) would still find it -- while a program that receives
 * one purely through an imported signature names neither. `checker.resolveName`
 * answers "what does this name mean here" with no use site at all, so the
 * policy is installed identically either way.
 *
 * Second, and the reason this cannot be left to the host census: that census
 * ALREADY reaches `Map` and binds it as a host protocol, through
 * `MapConstructor.groupBy`'s `Map<K, T[]>` return type. That binding gives
 * every `Map<K, V>` an opaque `native-handle` with no key or value carrier --
 * measured, not supposed: `native-boundary:Map@1` was the missing obligation
 * on a two-line `new Map<string, number>()` probe. `derive.ts` consults this
 * policy first, so the concrete carrier wins over the opaque one; the
 * constructor's own handle (`MapConstructor@1`) is untouched and stays a host
 * boundary, which is correct -- `Map` the value really is a host-supplied
 * constructor object.
 */
/**
 * The two standard ArrayBuffer-family object types, by the interface name the
 * standard library declares each under.
 *
 * `SharedArrayBuffer` has its own carrier. It is not an `ArrayBuffer` alias:
 * its backing state is what makes Atomics' concurrent protocol truthful.
 */
const standardBufferKinds: ReadonlyMap<string, StandardBufferKind> = new Map<string, StandardBufferKind>([
  ['ArrayBuffer', 'array-buffer'],
  ['SharedArrayBuffer', 'shared-array-buffer'],
  ['DataView', 'data-view']
])

/**
 * The declaration identity of the standard `ArrayBuffer` and `DataView`
 * interfaces, resolved exactly the way `keyedCollectionDeclarationsOf` below
 * resolves `Map`/`Set` and for the same two reasons.
 *
 * Independence from the program's own text is the first: `three.js` writes
 * `function f(b: ArrayBuffer)` in files that never construct one, and a
 * program that only ever receives a `DataView` from a signature names neither
 * as a value. `checker.resolveName` answers "what does this name mean here"
 * with no use site at all.
 *
 * The second is the same collision the `Map` comment describes: the
 * ambient-value census ALREADY reaches `ArrayBuffer` -- through
 * `Uint8ArrayConstructor`'s own modern return type `Uint8Array<ArrayBuffer>`,
 * among others -- and binds it as an opaque host protocol, which is what the
 * corpus's three `native-boundary:ArrayBufferConstructor@1` rows were. Consulted
 * first in `derive.ts`, this policy gives the concrete byte-block carrier
 * instead; the CONSTRUCTOR's own handle stays a host boundary, which is
 * correct, because `ArrayBuffer` the value really is a constructor object.
 */
export const standardBufferDeclarationsOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): Map<DeclarationId, StandardBufferKind> => {
  const found = new Map<DeclarationId, StandardBufferKind>()
  const anchor = files[0]
  if (!anchor) return found
  for (const [name, kind] of standardBufferKinds) {
    const symbol = checker.resolveName(name, anchor, ts.SymbolFlags.Interface, false)
    if (!symbol) continue
    const declaration = identities.symbolDeclarationId(symbol, anchor)
    if (declaration) found.set(declaration, kind)
  }
  return found
}

/**
 * The standard library's own NATIVE-BACKED CLASSES, bound to the carrier the
 * backend implements them in.
 *
 * `TextEncoder` and `TextDecoder` are the pair this exists for. They are not a
 * host's protocol -- nothing installs them, no plugin declares them -- and they
 * are not `ArrayBuffer`'s shape either: each is a real object with methods, so
 * the honest carrier is the backend's own C++ class, spelled verbatim through
 * `native-handle`, exactly as an installed host's stated `nativeTypes` carrier
 * is. Which names are in the set, and what each is spelled as, is the
 * BACKEND's answer (`targets/cpp/host/core-globals.ts`); this function knows
 * only how to resolve a name to the two declarations that carry it.
 *
 * Only the INSTANCE type is bound here, and the reason the CONSTRUCTOR is not
 * is worth stating, because it is what shapes the rest of the route:
 *
 *   interface TextEncoder extends TextEncoderCommon { encode(...): Uint8Array }
 *   declare var TextEncoder: { prototype: TextEncoder; new(): TextEncoder }
 *
 * The instance type is a named interface, so it binds the way every other
 * declared type does. The constructor's type is an ANONYMOUS type literal --
 * unlike `Uint8Array`, whose constructor is the named `Uint8ArrayConstructor`
 * -- and an anonymous type reaches `representation/derive.ts` through its
 * structural body, never through the declaration-keyed binding this function
 * writes, so a row for it here would be a claim nothing reads. The class
 * OBJECT is answered one layer down instead, by name:
 * `projection/bindings.ts` gives it `host-class` storage (no cell, no extern)
 * and `targets/cpp/emit-buffers.ts`'s `emitTextCodecConstruct` spells the
 * construction whole. See `coreGlobalClasses`.
 *
 * Run AFTER `ambientHostBindings`, so it overwrites the weaker binding that
 * census may already have made from the same declaration -- the identical
 * precedence `standardBufferDeclarationsOf` states for `ArrayBuffer`.
 */
export const bindStandardClasses = (input: HostProtocolInput, census: HostCensus, names: ReadonlySet<string>): void => {
  const anchor = input.files[0]
  if (!anchor) return
  for (const name of names) {
    const instance = input.checker.resolveName(name, anchor, ts.SymbolFlags.Interface, false)
    const instanceDeclaration = instance ? input.identities.symbolDeclarationId(instance, anchor) : null
    if (instanceDeclaration) {
      census.protocols.set(instanceDeclaration, { protocol: name, version: 1, native: input.nativeTypes.get(name) ?? null, opaque: false })
    }
  }
}

export const keyedCollectionDeclarationsOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): Map<DeclarationId, KeyedCollectionFamily> => {
  const found = new Map<DeclarationId, KeyedCollectionFamily>()
  const anchor = files[0]
  if (!anchor) return found
  for (const [name, family] of keyedCollectionFamilies) {
    const symbol = checker.resolveName(name, anchor, ts.SymbolFlags.Interface, false)
    if (!symbol) continue
    const declaration = identities.symbolDeclarationId(symbol, anchor)
    if (declaration) found.set(declaration, family)
  }
  return found
}

/**
 * The three standard regular-expression interface names, to the role each one
 * plays. Hardcoded for exactly the reason `keyedCollectionFamilies` above is:
 * these are core ECMAScript (`lib.es5.d.ts`), not something a host installs,
 * so there is no table to read them from.
 *
 * `RegExpConstructor` is deliberately absent, and that absence is the point.
 * `RegExp` the VALUE is an ambient constructor object, and carrying it as a
 * host handle is the right answer -- `new RegExp(src, flags)` is a boundary
 * crossing into the runtime. Only the three INSTANCE shapes have a
 * compiler-owned layout. `RegExpStringIterator` is absent for a different
 * reason: nothing here mints a standalone iterator, so a program that names
 * one has to refuse by name rather than silently share a carrier.
 */
const regexpDeclarationKinds: ReadonlyMap<string, RegExpDeclarationKind> = new Map([
  ['RegExp', 'pattern'],
  ['RegExpExecArray', 'exec-result'],
  ['RegExpMatchArray', 'match-result']
])

/**
 * The declaration identity of each standard regular-expression interface this
 * compilation's `lib` installs.
 *
 * Resolved exactly the way `keyedCollectionDeclarationsOf` above resolves
 * `Map`, and for both of the same reasons. Independence from the program's own
 * text first: a regexp LITERAL (`/ab+c/g`) names `RegExp` nowhere, and neither
 * does `s.match(re)`'s `RegExpMatchArray | null` result -- the ambient-VALUE
 * seed walk starts from identifiers written in value position, and a literal
 * writes none. `checker.resolveName` answers "what does this name mean here"
 * with no use site at all.
 *
 * Second, and again the reason this cannot be left to the host census: that
 * census ALREADY reaches `RegExp` and binds it as a host protocol, through
 * `RegExpConstructor`'s `new (pattern: string): RegExp` result. That binding
 * gives every pattern an opaque `native-handle` with no layout -- so
 * `re.source` has nowhere to go, and `re.lastIndex = 0` has nothing to store
 * into. `derive.ts` consults this policy first, so the concrete record carrier
 * wins over the opaque handle; `RegExpConstructor@1` itself is untouched.
 */
export const regexpDeclarationsOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): Map<DeclarationId, RegExpDeclarationKind> => {
  const found = new Map<DeclarationId, RegExpDeclarationKind>()
  const anchor = files[0]
  if (!anchor) return found
  for (const [name, kind] of regexpDeclarationKinds) {
    const symbol = checker.resolveName(name, anchor, ts.SymbolFlags.Interface, false)
    if (!symbol) continue
    const declaration = identities.symbolDeclarationId(symbol, anchor)
    if (declaration) found.set(declaration, kind)
  }
  return found
}

const bindHostObjectClosure = (
  input: HostProtocolInput,
  census: HostCensus,
  seeds: readonly ts.Type[],
  seedPaths: ReadonlyMap<ts.Type, string> = new Map()
): void => {
  const pending = [...seeds]
  const visited = new Set<ts.Type>()
  // The path a type was reached by, for the types reached purely as a
  // namespace segment (`seedPaths`' own seeds, and whatever `admitHandedType`
  // below extends them into). Absent for every ordinary host object, which is
  // the common case and needs none of this: `document`'s own closure carries
  // no path at all, exactly as it did before this table existed.
  const pathOf = new Map<ts.Type, string>(seedPaths)
  while (pending.length > 0) {
    const type = pending.pop()
    if (!type || visited.has(type)) continue
    visited.add(type)
    const path = pathOf.get(type) ?? null
    // A host value that is itself CALLABLE hands back what it returns, and an
    // ambient free FUNCTION is exactly that and nothing else. It has no
    // receiver, so it is nobody's member and the walk below never reaches it --
    // which left `MKCoordinateRegionMakeWithDistance`'s `MKCoordinateRegion`
    // unbound and deriving as an ordinary record, while the identical struct
    // reached through `map.region` would have been bound. The two routes to one
    // host type have to agree, for the same reason the three shapes below do.
    //
    // A value that can be `new`-ed is not that. `ErrorConstructor` is callable
    // as well as constructible (`Error(m)` and `new Error(m)` are the same
    // object), so following its call signature binds `Error` itself as a host
    // protocol -- which is precisely what the `prototype` skip below refuses,
    // arriving by a second route. Measured: it cost 44 programs their
    // certificate at once, every one of them for `native-boundary:Error@1`.
    // What a program CONSTRUCTS is the program's, and reaching its type through
    // a construct signature is a separate question this walk does not ask.
    if (input.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length === 0) {
      for (const signature of input.checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
        admitHandedType(input, census, pending, signature.getReturnType(), null, null, pathOf)
      }
    }
    for (const member of input.checker.getPropertiesOfType(type)) {
      // The member is NOT ambient-tested. An interface's own members never
      // carry the `declare` modifier -- it sits on the interface -- so testing
      // them rejects every real host member. What has to be ambient is the type
      // handed back, checked below: the seed already established that this
      // container is a host's, and a host's member is part of that declaration
      // by construction.
      // `prototype` is not something the host hands the program. It is the
      // constructor's prototype slot, and its type is the *instance* type --
      // so following it binds every constructed object as a host protocol.
      // `new Error(m)` would stop being a record the program reads `.message`
      // off and become an opaque handle, which is the opposite of what the
      // declaration says. The instance type is reached through the construct
      // signature when it really is the host's, not through this slot.
      //
      // The slot itself, read as a VALUE (`Date.prototype`), is a different
      // thing again: a namespace-shaped intrinsic whose own members are the
      // instance methods (`verifyProperty(Date.prototype, "getTime", ...)`).
      // It is registered under its own protocol, keyed by the slot's
      // declaration -- which only a `X.prototype` read is ever typed by
      // (`prototypeObjectTypeAt`) -- so constructed instances stay what the
      // construct signature says they are.
      if (member.getName() === 'prototype') {
        const slot = member.valueDeclaration ?? member.declarations?.[0]
        if (!slot) continue
        const instanceType = input.checker.getTypeOfSymbolAtLocation(member, slot)
        const instanceName = instanceType.getSymbol()?.name
        if (instanceName === undefined) continue
        // `X.prototype.constructor` is the one own member the instance
        // interface does not spell (10.2.4 / every builtin prototype's own
        // `constructor` data property, writable and configurable); the
        // backend names its value from the protocol.
        const constructorMember: HostIntrinsicMember = { name: 'constructor', kind: 'method', arity: null }
        census.protocols.set(input.identities.declarationIdOf(slot), {
          protocol: `${instanceName}.prototype`,
          version: 1,
          native: null,
          opaque: false,
          members: [...hostIntrinsicMembersOf(input.checker, instanceType), constructorMember]
        })
        continue
      }
      const declaration = member.valueDeclaration ?? member.declarations?.[0]
      if (!declaration) continue
      const memberType = input.checker.getTypeOfSymbolAtLocation(member, declaration)
      // A method hands back its return type; a data member is itself the thing
      // handed back. Both are objects the host produced.
      //
      // A member that can be `new`-ed is the second kind, not the first, and
      // this is the same rule the seed walk above states: what a program
      // CONSTRUCTS is the program's. `lib.es5`'s own `Error: ErrorConstructor`
      // is a member of a host's anonymous shape, and `ErrorConstructor` is
      // callable as well as constructible -- so following its call signature
      // bound the `Error` INTERFACE as a host protocol, in nine corpus
      // programs, none of which mention `Error` at all. A boundary was then
      // required for `Error@1`, which nothing claims and nothing could: an
      // error in this compiler is a record the program reads `.message` off,
      // built by `gea::host::ErrorConstructor::create`, and an opaque handle is
      // the opposite of that. The constructor object itself is still admitted
      // below -- it really is a host value, and `ErrorConstructor@1` really is
      // claimed -- which is what the `[memberType]` fallback already does.
      const constructible = input.checker.getSignaturesOfType(memberType, ts.SignatureKind.Construct).length > 0
      const signatures = constructible ? [] : input.checker.getSignaturesOfType(memberType, ts.SignatureKind.Call)
      const handed = signatures.length > 0 ? signatures.map((signature) => signature.getReturnType()) : [memberType]
      // `admitHandedType` combines this with the member's own name -- the
      // path a member reached purely as a namespace segment continues by
      // (`navigator` at `"navigator"` hands `mediaDevices` the candidate path
      // `"navigator.mediaDevices"`) -- and separately checks the bare member
      // name against the namespace roots on its own, since `window`'s own
      // `navigator` member names a root (`"navigator"`) independent of
      // whatever path reached `Window` itself.
      for (const candidate of handed) admitHandedType(input, census, pending, candidate, path, member.getName(), pathOf)
    }
  }
}

/**
 * Whether a dotted path names a namespace segment rather than a value -- the
 * closure walk's own version of `targets/cpp/host-members.ts`'s
 * `isHostNamespacePath`, asked of the same two facts a plugin states
 * (`hostNamespaceRoots`, and every leaf key its `hostNamespaces.methods`/
 * `.properties` publish) rather than the emitter's own table shape, since the
 * frontend has no `HostNamespaceTable` to ask and needs none: a prefix test
 * over the leaf paths is the entire fact either layer needs.
 */
const isHostNamespacePathLike = (input: HostProtocolInput, path: string): boolean => {
  if (input.hostNamespaceRoots.has(path)) return true
  const prefix = `${path}.`
  for (const leaf of input.hostNamespacePaths) if (leaf.startsWith(prefix)) return true
  return false
}

/**
 * One type a host handed the program, bound as that host's protocol.
 *
 * Shared by both routes into `bindHostObjectClosure` -- what a member yields
 * and what a call yields -- because they are one question asked twice, and a
 * second copy of this admission is how the two came to disagree before.
 *
 * `path`/`name` are `bindHostObjectClosure`'s own bookkeeping for a candidate
 * reached as a struct/interface MEMBER: `path` is the path the CONTAINING type
 * was itself reached by (`null` for an ordinary host object, which is every
 * caller before this existed), and `name` is the member's own name. Both are
 * `null` for a candidate reached through a CALL signature's return, which
 * names no member and so extends no path.
 *
 * A candidate whose combined path (or bare member name alone -- `window`'s own
 * `navigator` member names the root `"navigator"` independent of whatever path
 * reached `Window`) is a stated namespace segment is never claimed as a
 * protocol: the host states no carrier for it and states instead that it is a
 * PATH, exactly as `bindAmbientValue` already treats a bare namespace-root
 * reference. It is still enqueued for further exploration, because a namespace
 * segment can still hand back a REAL host object one level further in --
 * `navigator.mediaDevices.getUserMedia(...)` hands back a `MediaStream`, which
 * has its own stated carrier and needs its own boundary claimed here as
 * usual.
 */
const admitHandedType = (
  input: HostProtocolInput,
  census: HostCensus,
  pending: ts.Type[],
  candidate: ts.Type,
  path: string | null,
  name: string | null,
  pathOf: Map<ts.Type, string>
): void => {
  const object = hostObjectTypeOf(input, candidate)
  const symbol = object?.getSymbol()
  if (!object || !symbol || !isAmbientSymbol(symbol)) return
  const shape = input.table.get(input.types.typeOf(object))?.shape
  // The same three shapes `bindAmbientValue` admits, and for the reason
  // it states there: a host declared with `interface` + `declare var` hands back
  // a `declared` shape, and one declared with `declare class` hands back
  // `class-instance` (or `class-constructor`, when the member is the class
  // itself). Admitting only `declared` here made the two walks disagree about
  // what a host type is -- a host object the program NAMES was bound and the
  // identical host object the program only RECEIVES was not.
  //
  // The gap was invisible until a host was declared entirely in class syntax.
  // `view.leadingAnchor` hands back `NSLayoutXAxisAnchor`, an ambient
  // `declare class` the program never writes in value position, so this walk
  // was its only route to a protocol -- and dropping it left an ambient class
  // whose members no evaluation publishes, which surfaced at emission as "a get
  // of constraintEqualToAnchor reaches class decl|f0|531, whose members no class
  // evaluation published": three layers from the binding that was never made.
  if (shape === undefined) return
  if (shape.kind !== 'declared' && shape.kind !== 'class-constructor' && shape.kind !== 'class-instance') return
  // A member whose own bare name is itself a stated root re-roots the path
  // there rather than nesting under whatever reached the containing type --
  // `window`'s `navigator` member is the root `"navigator"`, never
  // `"window.navigator"`, because nothing downstream states members under the
  // latter and a child reached through it must still extend the path the
  // host's own tables recognise.
  const combinedPath = name === null ? null : input.hostNamespaceRoots.has(name) ? name : path === null ? null : `${path}.${name}`
  const namespacePath = combinedPath !== null && isHostNamespacePathLike(input, combinedPath)
  if (namespacePath) {
    if (combinedPath !== null && !pathOf.has(object)) pathOf.set(object, combinedPath)
    pending.push(object)
    return
  }
  if (census.protocols.has(shape.declaration)) return
  // `GEA_PROTOCOL_TRACE=<name substring>` names the path the closure walk took
  // to reach a protocol, and the declaration file it bound. A protocol with a
  // null carrier demands `native-boundary:<name>@1`, which nothing can
  // satisfy, and the only actionable question about one is which host root
  // reached it -- a question no other output answers.
  if (process.env['GEA_PROTOCOL_TRACE'] && symbol.name.includes(String(process.env['GEA_PROTOCOL_TRACE']))) {
    const where = (symbol.declarations ?? [])[0]?.getSourceFile().fileName ?? '?'
    process.stderr.write(
      `[PROTOCOL] ${symbol.name} native=${input.nativeTypes.get(symbol.name) ?? '-'} via=${path ?? '(root)'}.${name ?? '?'} decl=${where}\n`
    )
  }
  census.protocols.set(shape.declaration, {
    opaque: false,
    protocol: symbol.name,
    version: 1,
    native: nativeTypeOf(input, symbol)
  })
  pending.push(object)
}

/** One own member of a reflectable host intrinsic, as `hostIntrinsicMembersOf` classifies it. */
export interface HostIntrinsicMember {
  readonly name: string
  /**
   * `'method'` when reading this member calls a signature (`Math.pow`);
   * `'value'` when the member itself IS the thing handed back (`Math.SQRT2`).
   * ECMA-262 gives the two different default attributes (21.3.1's constants
   * are non-writable/non-configurable data properties; a builtin's own
   * methods are writable/configurable, 10.2.4) -- this is the one bit that
   * decides which set of defaults a reflection question answers from, and it
   * comes from the SAME call-signature test `bindHostObjectClosure` above
   * already uses to tell a method from a data member.
   */
  readonly kind: 'value' | 'method'
  /**
   * The signature's own declared arity for a `'method'`, optional and rest
   * parameters excluded (`requiredArityOf`) -- ECMA-262's `length` for a
   * builtin function (10.2.4 `SetFunctionLength`) counts only the leading
   * required parameters. `null` for a `'value'`, which has no signature to
   * measure.
   */
  readonly arity: number | null
}

/**
 * A signature's own required parameter count: every parameter up to the
 * first optional or rest one. TypeScript requires optional and rest
 * parameters to be trailing, so a single forward scan that stops at the
 * first one it meets is exact, not an approximation of a general rule.
 */
const requiredArityOf = (signature: ts.Signature): number => {
  let count = 0
  for (const parameter of signature.getParameters()) {
    const declaration = parameter.valueDeclaration
    if (declaration && ts.isParameter(declaration) && (declaration.questionToken || declaration.dotDotDotToken)) break
    count++
  }
  return count
}

/**
 * The own members of a host intrinsic's declared type, read from the
 * checker's OWN lib declaration rather than hand-listed here -- see
 * `HostProtocolBinding.members`'s own comment for why that distinction
 * matters. `Math` is the type this exists for: `checker.getPropertiesOfType`
 * on its `lib.es5.d.ts` interface is the SAME list `Object.keys` on a real
 * `Math` would walk if this compiler modeled Math as a real object rather
 * than a zero-size tag, so a reflection question over the tag answers from
 * the identical source of truth.
 *
 * The method/value split reuses `bindHostObjectClosure`'s own test (a call
 * signature on the member's type) rather than inventing a second one: the
 * two questions -- "is this member a host object to keep walking into" and
 * "is this member a function" -- read the same signature list, and asking it
 * twice with two different answers is exactly the drift this compiler's own
 * "two authorities" defect pattern names.
 */
const hostIntrinsicMembersOf = (checker: ts.TypeChecker, type: ts.Type): readonly HostIntrinsicMember[] => {
  const members: HostIntrinsicMember[] = []
  for (const member of checker.getPropertiesOfType(type)) {
    if (member.getName() === 'prototype') continue
    // A well-known-symbol-keyed member (`Math[Symbol.toStringTag]`) escapes
    // with the checker's own internal `__@<name>@<id>` spelling rather than a
    // string -- `Object.getOwnPropertyNames`, `for...in` and this table's own
    // consumers all answer STRING-keyed reflection questions only (19.1.2.10,
    // 13.7.5.6), so a symbol-keyed member is never a candidate answer and
    // must not enter a table keyed by, and switched over, plain strings.
    if (member.getName().startsWith('__@')) continue
    const declaration = member.valueDeclaration ?? member.declarations?.[0]
    if (!declaration) continue
    const memberType = checker.getTypeOfSymbolAtLocation(member, declaration)
    const signature = checker.getSignaturesOfType(memberType, ts.SignatureKind.Call)[0]
    members.push(
      signature === undefined
        ? { name: member.getName(), kind: 'value', arity: null }
        : { name: member.getName(), kind: 'method', arity: requiredArityOf(signature) }
    )
  }
  return members
}

const bindAmbientValue = (
  input: HostProtocolInput,
  census: HostCensus,
  reference: ts.Identifier,
  seedPaths: Map<ts.Type, string>,
  commonJsIdentity: CommonJsWrapperIdentity
): ts.Type | null => {
  // The same name-to-symbol rule the reference producer applies
  // (`valueSymbolAt`): checked JavaScript's `module`/`exports` resolve past
  // the checker's export synthesis to the wrapper declaration the host owns,
  // or the census below never sees the wrapper cell and the read is emitted
  // against a declaration the program never introduces.
  const local = valueSymbolAt(input.checker, reference)
  if (!local) return null
  // An imported name's own symbol is the import specifier, which lives in this
  // program's file and is not ambient at all. The declaration the program is
  // really reading is the one the alias points at, and that is the identity
  // every other layer resolves to as well -- so following the alias is what
  // makes this walk's answer and the reference producer's the same answer.
  const symbol = (local.flags & ts.SymbolFlags.Alias) !== 0 ? input.checker.getAliasedSymbol(local) : local
  if ((symbol.flags & ts.SymbolFlags.Value) === 0 || !isAmbientSymbol(symbol)) return null
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (!declaration) return null

  // Every ambient value gets a linkage entry, whatever its type: the program
  // reads a cell it never introduces, so something has to say where that cell
  // lives, and "a host defines it under this name" is the only true answer.
  // Without it the cell has no placement at all, and emission refuses an
  // ordinary `import { mount }` for a reason the program cannot act on. Whether
  // the host really does define it is a link-time fact no static census can
  // see, and a linker already reports it.
  const externalId = input.identities.declarationIdOf(declaration)
  const commonJs = commonJsIdentity.classify(reference)
  if (commonJs.kind === 'wrapper') {
    census.commonJsBindings.set(externalId, commonJs.global)
    // A CommonJS wrapper parameter is supplied by a per-module record. It is
    // neither an external cell nor an ambient native protocol handle.
    return null
  }
  if (commonJs.kind === 'provenance-failure') {
    // Record every declaration in a merged Symbol. A caller cannot make a
    // host-owned `require` look authentic by arranging declaration order, and
    // the invocation producer can fail closed from whichever declaration the
    // checker selected as the value declaration.
    for (const candidate of symbol.declarations ?? []) census.commonJsProvenanceFailures.add(input.identities.declarationIdOf(candidate))
  }
  const configuredSingleton = input.hostSingletonDeclarations.get(symbol.name)
  if (configuredSingleton !== undefined && hasExactHostDeclaration(symbol, configuredSingleton)) {
    // Keep the authenticated declaration identity, not merely its file name:
    // declaration merging can otherwise arrange for the host file to become
    // `valueDeclaration` while a caller contributes a second declaration.
    census.hostSingletonBindings.add(externalId)
  }
  census.externals.set(externalId, symbol.name)
  const file = declaration.getSourceFile()
  census.externalFiles.set(externalId, file.fileName)
  // See `HostCensus.standardLibrary`. Recorded here, beside the linkage name,
  // because this is the one walk that has both the declaration identity and
  // the file it came from in hand.
  if (file.hasNoDefaultLib) census.standardLibrary.add(externalId)

  const type = input.checker.getTypeOfSymbolAtLocation(symbol, reference)
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return null
  const typeId = input.types.typeOf(type)
  // What carries a namespace ROOT, recorded before anything asks what SHAPE it
  // has -- and deliberately not folded into the shape-gated branch below.
  //
  // The two answer different questions. That branch decides what the closure
  // walk does with a root's own MEMBERS, and its gate is about the member
  // walk's needs. This one decides what the ROOT ITSELF is carried by, and the
  // shape is exactly the thing that must not gate it: `window`'s type is
  // `Window & typeof globalThis`, an `intersection`, so the branch below never
  // fires for the one global that most needs an answer, and the root fell
  // through to `deriveIntersection` flattening lib.dom's `Window` into a
  // 26-field struct naming protocol tags no host declares. The plugin's own
  // table is the whole of the authority: a root it states no type for records
  // nothing and derives exactly as it did before.
  const namespaceRoot = isHostNamespaceRoot(input, symbol)
  if (namespaceRoot) {
    census.hostNamespaceBindings.add(externalId)
    const rootType = input.hostNamespaceRootTypes.get(symbol.name)
    if (rootType !== undefined) census.namespaceRoots.set(typeId, rootType)
  }
  const shape = input.table.get(typeId)?.shape
  // An ambient `declare class`'s value reference (`UIColor` read, not
  // constructed) resolves to the class's own constructor type, whose shape
  // is `class-constructor` -- and a value typed by that class (a parameter,
  // a `new`-constructed local, or what a static factory hands back)
  // resolves to `class-instance`. Both anchor the SAME declaration id (one
  // class, two structural views of it, `structural.ts`'s
  // `declaredAnchorOf`), so admitting them here reaches the identical "a
  // host owns this identity" fact `declared` already states for `declare
  // var Map: MapConstructor` -- through the class syntax instead of the
  // interface-plus-var one. `derive.ts`'s `deriveClassConstructor` and its
  // `class-instance` case are what actually read this binding back.
  //
  // A seed with none of those three shapes still has to reach
  // `bindHostObjectClosure` below, unclaimed or not. `declare const
  // __gea_Display: { ctx: CanvasRenderingContext2D; width: number; ... }`
  // states an anonymous *shape* for `__gea_Display` itself -- there is no
  // name to bind the seed to, so it claims no protocol of its own -- but
  // `ctx` is exactly as host-owned as `document`'s own members are, and the
  // closure below is what finds a named protocol underneath an anonymous
  // seed's fields. Returning `null` here (as this used to) drops that
  // reachability entirely: `bindHostObjectClosure` never learns
  // `CanvasRenderingContext2D` is a host protocol, so it never walks into
  // `CanvasRenderingContext2D.canvas` either, and `HTMLCanvasElement` is
  // left as an ordinary, unbound `declared` shape. `derive.ts`'s `declared`
  // case then finds no policy for it and falls through to expanding the
  // full interface as a struct, which reaches `HTMLElement`'s own
  // `childNodes: NodeListOf<ChildNode>` cycle -- a shape
  // `structural-self-reference.ts` does not model (only union, intersection,
  // tuple, array and callable close a cycle without a declared name) -- so
  // the failure surfaces three layers downstream, at emission, as "no record
  // layout ... carries unresolved", naming the struct instead of the actual
  // gap: an ambient value's own type having no name is not evidence its
  // members are not a host's.
  if (shape?.kind === 'declared' || shape?.kind === 'class-constructor' || shape?.kind === 'class-instance') {
    const protocol = type.getSymbol()?.name
    // A namespace root claims nothing: a host states that name as a PATH, and
    // a path has no value to carry. Three apps lost their certificate to the
    // `Window@1` this used to demand.
    if (protocol && namespaceRoot) {
      // The seed is still returned below and still walked by
      // `bindHostObjectClosure` -- a namespace root's OWN members are exactly
      // as reachable as `document`'s are (`window.navigator`,
      // `navigator.mediaDevices`) -- but recorded under the root's own name so
      // that walk can tell a member that only continues the path from one
      // that hands back a real, separately-claimed host object.
      seedPaths.set(type, symbol.name)
    } else if (protocol) {
      if (process.env['GEA_PROTOCOL_TRACE'] && protocol.includes(String(process.env['GEA_PROTOCOL_TRACE']))) {
        const where = (type.getSymbol()?.declarations ?? [])[0]?.getSourceFile().fileName ?? '?'
        process.stderr.write(
          `[SEED] ${protocol} native=${input.nativeTypes.get(protocol) ?? '-'} ref=${symbol.name} at=${reference.getSourceFile().fileName} decl=${where}\n`
        )
      }
      const native = nativeTypeOf(input, type.getSymbol() ?? type.aliasSymbol ?? symbol)
      // Reflectable member list computed only for the opaque tag: a protocol
      // with a stated host carrier (`native !== null`) is a real value this
      // backend has some OTHER runtime representation for, and its own
      // properties -- if it needs to answer for any -- are that carrier's
      // question, not this compile-time tag's.
      const members = native === null ? hostIntrinsicMembersOf(input.checker, type) : null
      census.protocols.set(shape.declaration, { protocol, version: 1, native, opaque: false, members })
    }
  }
  return type
}
