import ts from 'typescript'
import { isValueReference } from './census.js'
import type { NamespacePathCensus } from './namespace-paths.js'
import { valueSymbolAt } from './unresolvable-names.js'

/**
 * The ambient globals an installed host declares it does NOT provide.
 *
 * An ambient declaration is a contract with a host: `declare var VideoFrame:
 * {...}` says something out there defines this. TypeScript has no way to say
 * the opposite, so a compiler with no other source of truth believes every one
 * of them -- and that belief is a measured silent miscompile. `typeof
 * VideoFrame !== 'undefined'` folds to `true` because the value's carrier is a
 * constructor, while the same unit emits `extern gea::ConstructorObject<...>
 * VideoFrame;` for a symbol no object file defines. The program is told a value
 * exists, takes the branch that reads `image.displayWidth` off something that
 * is not a `VideoFrame`, and the failure lands in the linker or at runtime
 * rather than here.
 *
 * three.js is written to run where these may not exist and says so in its own
 * source, guarding every one with `typeof X !== 'undefined'`. A native ANGLE
 * context is exactly such a place. `PluginCapabilities.absentGlobals` is where
 * a host states it; this turns that statement into the one thing the rest of
 * the compiler already knows how to reason about -- the type `undefined`.
 *
 * ## Why the type, and not a refusal or a carrier
 *
 * `undefined` is the language's OWN answer for a global that is not there, and
 * every stage downstream already handles it: `typeof` yields `'undefined'`, the
 * guard's other branch is dead, the binding is not external so no `extern` is
 * emitted, and a program that reads the value anyway is refused by the ordinary
 * rules for reading `undefined` rather than by a special case invented here.
 *
 * Refusing instead would reject a program that is correct precisely because it
 * checked, which is the opposite of what the guard is for.
 *
 * ## One authority
 *
 * Answering the DECLARATION and every REFERENCE from the same table is the
 * whole of it. A binding whose declaration said `undefined` while its
 * references said `VideoFrameConstructor` would be two carriers for one cell --
 * the defect shape this compiler has paid for repeatedly. Both routes go
 * through `typeAt` below.
 *
 * A host that states nothing gets `emptyAbsentGlobalCensus`, whose `typeAt` is
 * `() => null`, and nothing about such a program changes.
 */
export interface AbsentGlobalCensus {
  /**
   * `undefined` when this node reads a global a host declared absent, or `null`
   * when nothing here improves on the checker's answer.
   *
   * `null` is the normal case: the census answers only for names an installed
   * host actually listed.
   */
  readonly typeAt: (node: ts.Node) => ts.Type | null
  /**
   * `type`, unless it names an ambient TYPE a host declared absent -- in which
   * case `never`.
   *
   * `absentGlobals` is a fact about a VALUE (`typeAt` above): a host saying
   * `HTMLImageElement` is absent says the *constructor* is not there. It says
   * nothing yet about the TYPE `HTMLImageElement` -- the interface a program's
   * own ambient declarations (three.js's JSDoc `@param
   * {(HTMLImageElement|HTMLCanvasElement)} image`, straight off lib.dom) can
   * still name in a position this compiler never asked the value for. This is
   * that missing type-level counterpart, built the same way and for the same
   * reason: no ambient VALUE means no way for a program running on this host to
   * ever hold a value of that ambient TYPE either, so a position typed
   * (in part) that way can be told the arm is `never` -- the language's own
   * empty type, which every existing consumer of a structural union already
   * drops before building an arm (`representation/union.ts`'s `isNever`).
   *
   * Deliberately a `ts.Type -> ts.Type` function and not an attempt to hand
   * back a narrowed union: `ts.TypeChecker.getUnionType` is not on the public
   * surface (`producers/bindings.ts`'s `withoutUndefinedMember` hit the same
   * wall and solved it the same way -- filter the STRUCTURAL union instead of
   * reconstructing a `ts.Type`). Applying this to each member of a union
   * *before* it is interned needs no such reconstruction at all: every member
   * is already its own independent `ts.Type`, `getNeverType()` is public, and
   * a member that becomes `never` is dropped by the existing structural rule
   * with no new plumbing. See `structural.ts`'s union case for where this
   * wants to be called -- `type.types.map(typeOf)` becomes
   * `type.types.map((member) => typeOf(absent.substituteAbsentType(member)))`.
   *
   * Resolution is by SYMBOL, exactly as `typeAt` resolves by symbol rather
   * than by spelling: only a type whose OWN declaration is the standard
   * library's ambient one is answered, so a program's own same-named type is
   * untouched. Idempotent and total on every `ts.Type` -- it is safe to call
   * on anything, including a type that is not an object type at all, and it
   * always returns a real type rather than `null`, because unlike `typeAt`
   * there is no "no answer" case: the type is either named-absent or it is
   * simply itself.
   */
  readonly substituteAbsentType: (type: ts.Type) => ts.Type
  /** Declared or undeclared host-absent globals answered, for measurement. */
  readonly absentCount: number
  /**
   * The ambient declarations this census denied.
   *
   * Exposed because a cell's STORAGE CLASS is decided in two places -- the
   * binding producer, and the frontend's own ambient-value census that the
   * projection reads (`FrontendResult.externalBindings`) -- and both have to
   * reach the same answer. A declaration that stayed external in one of them
   * emits `extern gea::Undefined VideoFrame;`: a symbol nothing defines, for a
   * value this compiler has just concluded is not there.
   */
  readonly declarations: ReadonlySet<ts.Declaration>
}

/** A census that answers for nothing, for a compilation whose hosts state no absent name. */
export const emptyAbsentGlobalCensus: AbsentGlobalCensus = {
  typeAt: () => null,
  substituteAbsentType: (type) => type,
  absentCount: 0,
  declarations: new Set()
}

/**
 * Whether a declaration is ambient -- the same test `producers/bindings.ts`
 * uses to decide a binding is external, and deliberately the same one: this
 * census exists to contradict exactly the declarations that test admits, so
 * asking a different question would leave a gap between what is believed and
 * what can be denied.
 */
const isAmbient = (node: ts.Declaration): boolean => {
  if ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0) return true
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isModuleDeclaration(current) && (ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Ambient) !== 0) return true
  }
  return false
}

/**
 * The ambient VALUE declaration a name introduces, or `null`.
 *
 * A value, not a type: `interface ImageData` and `declare var ImageData` are two
 * declarations of one name, and only the second one is a thing the program can
 * hold. Answering `undefined` for the interface would say the TYPE does not
 * exist, which is a different and false claim -- a program may still receive an
 * `ImageData` from somewhere and only be unable to name the constructor.
 */
const ambientValueDeclarationOf = (symbol: ts.Symbol, platform: PlatformTest): ts.Declaration | null => {
  for (const declaration of symbol.declarations ?? []) {
    if (isValueDeclaration(declaration)) {
      if (isAmbient(declaration) && platform(declaration)) return declaration
    }
  }
  return null
}

/**
 * Whether a declaration introduces a VALUE a program could hold.
 *
 * `declare class XRWebGLBinding { ... }` is one declaration that is BOTH the
 * type and the constructor value, so it belongs here as much as `declare var`
 * does -- `@types/webxr` declares its whole surface that way, and leaving
 * classes out meant a host could not deny a single WebXR name. `interface`
 * alone still does not qualify, for the reason above: an interface names no
 * value.
 */
const isValueDeclaration = (node: ts.Node): node is ts.VariableDeclaration | ts.FunctionDeclaration | ts.ClassDeclaration =>
  ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)

/**
 * Whether a declaration is the STANDARD LIBRARY's own.
 *
 * `SourceFile.hasNoDefaultLib` is the checker's own fact rather than a path
 * guess: every `lib.*.d.ts` TypeScript ships opens with
 * `/// <reference no-default-lib="true"/>`, and nothing else sets it. The same
 * test `host-protocols.ts` computes `standardLibrary` from, for the same
 * reason it exists there -- a host's table is keyed by NAME, and a name match
 * alone would let one host's claim silently override a PROGRAM's own
 * `declare var VideoFrame`. A program that declares the name itself is
 * asserting something about its own environment, and denying that is a larger
 * claim than "the platform's standard library declares this and I do not
 * implement it".
 */
const isStandardLibrary = (node: ts.Declaration): boolean => node.getSourceFile().hasNoDefaultLib

/** Whether a declaration is the PLATFORM's rather than the program's -- see `platformDeclarationTest`. */
type PlatformTest = (node: ts.Declaration) => boolean

/**
 * The test for "this declaration is the platform's, not the program's".
 *
 * `hasNoDefaultLib` alone is too narrow. `@types/webxr` is a DefinitelyTyped
 * package describing a browser API; it stands in exactly the relation to the
 * program that `lib.dom.d.ts` does -- the program installed it, did not write
 * it, and holds no opinion about whether the platform implements it. Restricted
 * to `hasNoDefaultLib`, a host could deny `HTMLImageElement` and not
 * `XRWebGLLayer`, which is an accident of which file TypeScript happens to ship
 * rather than a distinction about authority. It cost the three.js app 81 unmet
 * obligations for `XRWebGLLayer@1`/`XRWebGLBinding@1` -- names three.js itself
 * guards with `typeof XRWebGLBinding !== 'undefined'`.
 *
 * What the original narrowness protected is still protected: a PROGRAM's own
 * `declare var VideoFrame` is an assertion about its own environment, and
 * denying that would be a larger claim than a host may make. That is why the
 * widening is `isDeclarationFile` AND `isSourceFileFromExternalLibrary` -- the
 * program's own sources, including its own `.d.ts` files, are untouched, and
 * `isSourceFileFromExternalLibrary` is the program's own answer rather than a
 * path guess.
 */
export const platformDeclarationTest =
  (program: ts.Program): PlatformTest =>
  (node) => {
    const file = node.getSourceFile()
    return isStandardLibrary(node) || (file.isDeclarationFile && program.isSourceFileFromExternalLibrary(file))
  }

/**
 * Whether a type's own declaring symbol names an ambient TYPE this census
 * denies.
 *
 * The same two tests `isAmbient`/`isStandardLibrary` already apply to a VALUE
 * declaration, applied here to whichever declaration kind actually introduces
 * a TYPE -- an `interface`, a `class`, or a `type` alias -- because none of
 * those match `ambientValueDeclarationOf`'s `VariableDeclaration`/
 * `FunctionDeclaration` filter, and a TYPE has no single declaration to begin
 * with: `interface HTMLImageElement extends HTMLElement` merges across
 * several files in `lib.dom.d.ts`, so every declaration the symbol carries is
 * checked rather than just the first. Both `type.getSymbol()` (an interface or
 * class reference) and `type.aliasSymbol` (a `type X = ...` reference kept
 * its alias identity) are consulted, because either can be the name a host
 * lists.
 */
const isAbsentAmbientType = (symbol: ts.Symbol | undefined, absent: ReadonlySet<string>, platform: PlatformTest): boolean => {
  if (!symbol || !absent.has(symbol.getName())) return false
  return (symbol.declarations ?? []).some((declaration) => isAmbient(declaration) && platform(declaration))
}

/**
 * The census for one program.
 *
 * Resolve the name's symbol before applying a host fact. A program's own
 * `const ImageData = ...`, or an import bound to that name, stays untouched.
 * Platform declarations and references with no declaration can both receive
 * the host's explicit absence fact. Missing declarations alone never establish
 * absence: the installed host must have listed the name independently.
 */
export const censusAbsentGlobals = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  absent: ReadonlySet<string>,
  platform: PlatformTest,
  namespacePaths: NamespacePathCensus
): AbsentGlobalCensus => {
  if (absent.size === 0) return emptyAbsentGlobalCensus

  const undefinedType = checker.getUndefinedType()
  const answered = new Set<ts.Node>()
  const declarations = new Set<ts.Declaration>()
  const undeclaredAbsentNames = new Set<string>()

  const admit = (name: ts.Identifier, node: ts.Node): void => {
    if (!absent.has(name.text)) return
    if (!isValueReference(name, namespacePaths)) return
    const symbol = valueSymbolAt(checker, name)
    if (!symbol) {
      // This is still the host's explicit absence statement, not a deduction
      // from a missing declaration. Older standard libraries may not declare
      // a newer API at all. A local binding would have a symbol and follows
      // the existing platform-declaration check below.
      answered.add(node)
      undeclaredAbsentNames.add(name.text)
      return
    }
    const declaration = ambientValueDeclarationOf(symbol, platform)
    if (!declaration) return
    declarations.add(declaration)
    answered.add(node)
    // The DECLARATION too, reached through the reference. The standard
    // library's own files are not among the files walked below, so a lib.dom
    // `declare var VideoFrame` is only ever seen from a program that mentions
    // it -- and a cell whose declaration kept the constructor carrier while
    // every reference answered `undefined` would be two carriers for one cell.
    answered.add(declaration)
    if ((ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) && declaration.name) {
      answered.add(declaration.name)
    }
  }

  for (const file of files) {
    const visit = (node: ts.Node): void => {
      // The declaration itself, so the cell and its readers agree.
      if (isValueDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        if (isAmbient(node) && platform(node) && absent.has(node.name.text)) {
          declarations.add(node)
          answered.add(node)
          answered.add(node.name)
        }
      } else if (ts.isIdentifier(node)) {
        admit(node, node)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  // Built once, not per call: `getNeverType()` is the same object every time,
  // and every `substituteAbsentType` call would otherwise ask the checker for
  // it again.
  const neverType = checker.getNeverType()
  const substituteAbsentType = (type: ts.Type): ts.Type =>
    isAbsentAmbientType(type.getSymbol() ?? type.aliasSymbol, absent, platform) ? neverType : type

  return {
    typeAt: (node: ts.Node): ts.Type | null => (answered.has(node) ? undefinedType : null),
    substituteAbsentType,
    absentCount: declarations.size + undeclaredAbsentNames.size,
    declarations
  }
}
