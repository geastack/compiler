import type { DeclarationId, FunctionId, RegionId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { HostNamespaceTable } from '../targets/cpp/host/host-members.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { resultOf } from '../semantics/model/operands.js'

/**
 * Where each binding cell physically lives.
 *
 * A binding is introduced by exactly one operation, and that operation's caller
 * is the execution context the cell belongs to. Nothing else in the compiler
 * knows this: the IR carries a `DeclarationId` on every read and write, and a
 * body seeing one has no way to tell a local of its own from a module-level
 * cell it merely refers to. Without this projection the emitter treats every
 * cell as a local, which turns a perfectly ordinary module-scope `const` read
 * from inside a function into either a capture it must refuse or -- worse -- a
 * reference to a variable no enclosing block declares.
 *
 * A binding introduced with `BindingOperation.external` set is `external`
 * storage instead of `local`/`region`: `declare const x` names a cell the
 * *host* defines, not this program, so there is no callable frame or run-once
 * region that owns it. That is not a defect to route around -- it is a
 * different, legitimate ownership, gated by its own preflight obligation
 * (`buildExternalBindingObligation`, preflight/run.ts) rather than by the
 * carrier-selection one every other binding raises. A declaration with no
 * introducing operation at all -- an import this program's semantic graph
 * does not yet model, for instance -- has no entry in the map rather than an
 * explicit `external` placement; a consumer sees the same absence either way
 * and refuses by name (`bindingReference`, targets/cpp/emit-context.ts).
 */

export type BindingStorage =
  /** A cell owned by one callable frame. */
  | { readonly kind: 'local'; readonly owner: FunctionId }
  /** A cell owned by a region that runs once: a module body, an initializer, a static block. */
  | { readonly kind: 'region'; readonly owner: RegionId }
  /**
   * Named by this program, defined by a host. `linkageName` is the ABI
   * contract the two sides agree on, carried verbatim from
   * `BindingOperation.external` (semantics/model/operations.ts) -- the one
   * place that string is read from the declaration's own spelling.
   */
  | { readonly kind: 'external'; readonly linkageName: string }
  /**
   * Named by this program, and defined by NOBODY -- an ambient global an
   * installed host declared it does not provide
   * (`PluginCapabilities.absentGlobals`).
   *
   * A cell, not an `extern`, and the difference is the whole point. The program
   * still reads the name, so there has to be something to read; but no object
   * file defines it, so `extern` would compile and never link. The unit defines
   * it itself, holding the one value it can have -- `undefined`, which is also
   * the carrier the type census gave it, so the storage and the value agree by
   * construction rather than by coincidence.
   *
   * `linkageName` is kept for diagnostics only. Nothing links against it.
   */
  | { readonly kind: 'absent'; readonly linkageName: string }
  /**
   * A host's class object: named by this program, and no cell anywhere.
   *
   * `NSColor` is not a variable a host defines. It is a class, and the only
   * things a program reaches through it -- constructing one, and its own class
   * members -- are spelled by the host by naming the class outright
   * (`[[::NSStackView alloc] init]`, `[::NSColor clearColor]`). Declaring an
   * `extern` for it invents a C++ global nothing defines, and in Objective-C++
   * it does worse than fail to link: the ObjC class of the same name is already
   * a type at global scope, so `extern gea::apple::AppKit::NSColor NSColor;` is
   * a redefinition as a different kind of symbol and the file does not compile.
   *
   * So the read of one produces no C++ at all, exactly as a host METHOD access
   * does (`emit-host-properties.ts` returns the empty rendering and the call
   * site spells the whole thing). Anything that genuinely needs a value here
   * is refused by name rather than handed a cell that does not exist.
   */
  | { readonly kind: 'host-class'; readonly linkageName: string }
  /**
   * A host's SINGLETON: one object the host owns, reached by its own name
   * rather than loaded from a cell.
   *
   * `document` is the case. The engine's `gea::embedded::ui::Document` has a
   * private default constructor and one instance behind `Document::instance()`,
   * and the member table the host ships spells every call through that -- no
   * template names a receiver. So there is nothing for a read of the global to
   * load: `extern gea::embedded::ui::Document document;` names a cell the
   * engine never defines and would not link, and the local it was copied into
   * (`gea::embedded::ui::Document v1;`) calls a constructor that is private.
   *
   * Physically identical to `host-class` -- the read renders nothing and the
   * member site spells the whole thing -- and named apart from it because the
   * two are recognized differently: a class object is one this program can
   * `new`, and a singleton is one the host states members for and no program
   * ever constructs.
   */
  | { readonly kind: 'host-singleton'; readonly linkageName: string }
  /**
   * A host's constant: named by this program, and the host states the text.
   *
   * `NSBoxCustom` is an Objective-C enumerator, not a C++ global, so there is
   * no cell for it and an `extern` naming one is ill-formed where the
   * enumerator is already in scope. The host answers with the value instead,
   * and every read renders that text.
   */
  | { readonly kind: 'host-constant'; readonly linkageName: string; readonly emit: string }
  /**
   * A name the host defines as a FUNCTION.
   *
   * `installRootViewController` is not a cell -- there is nothing to read and
   * nothing to declare `extern`, because the host exports a function of that
   * name and a C++ `extern <callable-carrier> installRootViewController;` would
   * be a global variable that no object file defines. The read renders
   * nothing; the call it feeds renders the host's own spelling.
   */
  | { readonly kind: 'host-function'; readonly linkageName: string; readonly emit: string }
  /**
   * A name the host defines as a NAMESPACE: a path, not a value.
   *
   * `deviceInfo`, `Display` and `navigator` are global objects to the
   * checker and paths to the host: `deviceInfo.deviceId(...)` is
   * `gea::host::device_info::deviceId(...)`, and no object of that name exists at run
   * time. Reading one produces no C++ -- `host-class`'s own convention, for
   * the same reason -- and what is done THROUGH it renders the host's
   * spelling. Without this the cell is an ordinary external and the unit
   * declares `extern std::shared_ptr<gea_record_type_801> deviceInfo;`,
   * which compiles and never links.
   */
  | { readonly kind: 'host-namespace'; readonly linkageName: string }

export interface BindingPlacement {
  readonly storage: BindingStorage
  /** The carrier the plan selected for the value this cell holds, or `null` when the introduction published none. */
  readonly representation: Representation | null
}

export interface BindingPlacementInput {
  readonly graph: SemanticGraph
  readonly plan: SealedRepresentationPlan
  /**
   * The ABI name a host defines a cell under, for declarations this program
   * reads but never introduces (`FrontendResult.externalBindings`).
   *
   * Only the frontend can produce this, because deciding it means asking the
   * checker which declaration a name resolves to and whether that declaration
   * is ambient. Omitted, every such cell simply has no placement -- which is
   * what it had before this existed.
   */
  readonly externals?: ReadonlyMap<DeclarationId, string>
  /** Which of those an installed host denied (`FrontendResult.absentBindings`) -- see `absent` storage. */
  readonly absentBindings?: ReadonlySet<DeclarationId>
  /**
   * The ambient names an installed host defines as constants, to the text each
   * one is (`PluginCapabilities.nativeConstants`).
   *
   * Consulted only for a declaration this program never introduces, and only by
   * the name the frontend resolved it to -- a program that declares its own
   * `NSBoxCustom` keeps its own cell, because the loop below runs second and
   * skips anything already placed.
   */
  readonly hostConstants?: ReadonlyMap<string, string>
  /** The ambient names this program's hosts define as free functions, to the C++ each is. */
  readonly hostFunctions?: ReadonlyMap<string, string>
  /**
   * The ECMAScript/WHATWG GLOBAL FUNCTIONS the backend implements itself, to
   * the C++ each is (`targets/cpp/host/core-globals.ts`).
   *
   * Held apart from `hostFunctions` above rather than merged into it, because
   * the two are admitted differently: a host's name is the host's whatever
   * declares it, while a language builtin's name is only the language's when
   * the STANDARD LIBRARY declared it -- see `standardLibraryExternals`.
   */
  readonly coreGlobalFunctions?: ReadonlyMap<string, string>

  /**
   * The language's own CLASS OBJECTS -- names whose value is a constructor
   * this backend spells the construction of, with no cell behind the name.
   * See `coreGlobalClasses` (targets/cpp/host/core-globals.ts). Same
   * `standardLibraryExternals` gate as its two siblings.
   */
  readonly coreGlobalClasses?: ReadonlySet<string>
  /**
   * The declarations the standard library declares
   * (`FrontendResult.standardLibraryBindings`).
   *
   * The gate on `coreGlobalFunctions`: without it, a program's own ambient
   * `declare function btoa(...)` would be silently redirected to this
   * backend's base64 codec by name alone.
   */
  readonly standardLibraryExternals?: ReadonlySet<DeclarationId>
  /**
   * The same, for the names one host declares in more than one of its own files
   * (`PluginCapabilities.hostFunctionsByDeclaration`), keyed by that file.
   */
  readonly hostFunctionsByDeclaration?: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** The file each external declaration lives in (`FrontendResult.externalBindingFiles`). */
  readonly externalFiles?: ReadonlyMap<DeclarationId, string>
  /**
   * The same disambiguation `hostFunctionsByDeclaration` gives constants: two
   * of a host's own files can declare one name as a different ambient
   * constant, and only the declaration this program actually resolved to says
   * which was meant.
   */
  readonly hostConstantsByDeclaration?: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** The ambient names this program's hosts own as namespace paths rather than as values. */
  readonly hostNamespaces?: HostNamespaceTable
  /** The same disambiguation, for a namespace root two of a host's own files both claim. */
  readonly hostNamespaceRootsByDeclaration?: ReadonlyMap<string, ReadonlySet<string>>
  /** Namespace roots authenticated by the frontend against a complete declaration set. */
  readonly hostNamespaceBindings?: ReadonlySet<DeclarationId>
  /** Names with exact declaration rows; these may not fall back to name-only admission. */
  readonly exactHostNamespaceNames?: ReadonlySet<string>
  /** The ambient names this program's hosts own as singleton objects reached by name -- see `host-singleton`. */
  readonly hostSingletons?: ReadonlySet<string>
  /** The same disambiguation, for a singleton name two of a host's own files both claim. */
  readonly hostSingletonsByDeclaration?: ReadonlyMap<string, ReadonlySet<string>>
  /** Singleton values the frontend authenticated from an exact host declaration. */
  readonly hostSingletonBindings?: ReadonlySet<DeclarationId>
}

/**
 * The storage a host claims for a name, or `null` when no host claims it.
 *
 * Asked at BOTH sites that can produce a host-owned cell, and that is the
 * point of it being a function. A program reaches an ambient name in one of
 * two ways -- by writing the declaration itself (`declare const deviceInfo:
 * {...}` in its own source, which introduces a cell) or by merely reading one
 * the environment declares -- and which of the two it used says nothing about
 * whose name it is. When the two sites answered separately, a program that
 * declared its own view of the host got `extern std::shared_ptr<...>
 * deviceInfo;` while `requestAnimationFrame`, reached the other way three
 * lines later, resolved to the host's function.
 *
 * The order is constant, then function, then namespace, then singleton. A
 * constant and a function each name something the program can hold or call; a
 * namespace and a singleton name neither, so they are asked last.
 * `__gea_audioContext` is what makes the order matter rather than merely be
 * tidy: the host states it as a constant AND states members under its name,
 * because the members really are members of that one object, and it is the
 * constant that must win.
 *
 * Each of the four is asked twice: once of the table keyed by the declaration
 * FILE this program's binding resolved to, and once of the flat table keyed
 * by name alone. The file-keyed answer always wins, on the same reasoning
 * `hostFunctionsByDeclaration` states for functions -- two of a host's own
 * files can declare one name and mean a different constant, namespace root or
 * singleton by it, and only the declaration this program actually resolved to
 * says which was meant. A host with no such collision states an empty
 * file-keyed table for that question and every name is answered by the flat
 * one exactly as before.
 */
const hostStorageOf = (
  input: BindingPlacementInput,
  declaration: DeclarationId,
  linkageName: string,
  representation: Representation | null
): BindingStorage | null => {
  // The declaration first, the name second -- for all four of a host's own
  // tables, not only its functions. Two of a host's own files can declare the
  // same name and mean a different constant, namespace root or singleton by
  // it, exactly as they can a different function, and only the declaration
  // this program actually resolved to says which was meant. Computed once and
  // reused below, since it is the same file for every one of these questions
  // about the same declaration.
  const file = input.externalFiles?.get(declaration)
  const declaredConstant = file === undefined ? undefined : input.hostConstantsByDeclaration?.get(file)?.get(linkageName)
  if (declaredConstant !== undefined) return { kind: 'host-constant', linkageName, emit: declaredConstant }
  const constant = input.hostConstants?.get(linkageName)
  if (constant !== undefined) return { kind: 'host-constant', linkageName, emit: constant }
  // The name-keyed table below is the answer for every host that has no such
  // pair, which is nearly all of them.
  const declared = file === undefined ? undefined : input.hostFunctionsByDeclaration?.get(file)?.get(linkageName)
  if (declared !== undefined) return { kind: 'host-function', linkageName, emit: declared }
  const hostFunction = input.hostFunctions?.get(linkageName)
  if (hostFunction !== undefined) return { kind: 'host-function', linkageName, emit: hostFunction }
  // A language builtin, last of the three function routes and gated on the
  // declaration being the standard library's own: an installed host that
  // claims one of these names has already won above, which is the right
  // precedence -- a target that implements `btoa` itself is describing its own
  // platform, and this table is the answer for every target that does not.
  if (input.standardLibraryExternals?.has(declaration)) {
    const core = input.coreGlobalFunctions?.get(linkageName)
    if (core !== undefined) return { kind: 'host-function', linkageName, emit: core }
  }
  // The language's own class objects, on the same gate: a constructor with no
  // cell, whose `new` the emitter spells whole. Checked after the function
  // table because the two never share a name and the order costs nothing, and
  // before the namespace/singleton routes because neither of those describes a
  // constructor.
  if (input.standardLibraryExternals?.has(declaration) && input.coreGlobalClasses?.has(linkageName)) {
    return { kind: 'host-class', linkageName }
  }
  if (input.hostNamespaceBindings?.has(declaration)) return { kind: 'host-namespace', linkageName }
  if (input.exactHostNamespaceNames?.has(linkageName)) return null
  if (file !== undefined && input.hostNamespaceRootsByDeclaration?.get(file)?.has(linkageName)) {
    return { kind: 'host-namespace', linkageName }
  }
  if (input.hostNamespaces?.roots.has(linkageName)) return { kind: 'host-namespace', linkageName }
  if (input.hostSingletonBindings?.has(declaration)) return { kind: 'host-singleton', linkageName }
  if (file !== undefined && input.hostSingletonsByDeclaration?.get(file)?.has(linkageName)) {
    return { kind: 'host-singleton', linkageName }
  }
  if (input.hostSingletons?.has(linkageName)) return { kind: 'host-singleton', linkageName }
  // A host handle that declares a construct convention is the host's class
  // object rather than a cell the host defines -- see `host-class` above.
  if (representation?.kind === 'native-handle' && representation.construct !== null) return { kind: 'host-class', linkageName }
  return null
}

/**
 * The namespace a value stands for, or `null` when it is an ordinary value.
 *
 * Two shapes, and only two.
 *
 * A READ of a cell already placed as a namespace is that namespace: the
 * framework re-exports the host's globals under second names
 * (`export const geolocation = Geolocation`), and an alias of a path is a
 * path.
 *
 * A CONDITIONAL whose arms are that namespace and nothing else is also that
 * namespace. This is the framework's own guard --
 * `typeof __gea_Accelerometer !== 'undefined' ? __gea_Accelerometer :
 * (undefined as unknown as typeof __gea_Accelerometer)` -- written because a
 * web build only injects the global when an app uses it. On a target whose
 * host TABLE claims the name, the question the guard asks is already answered:
 * the host defines it, so the absent arm is unreachable and the value is the
 * namespace. Every other arm must be an absent constant for that to hold, and
 * an arm that is anything else makes this `null` rather than a guess.
 */
const namespacePathOfValue = (
  valueId: string,
  producers: ReadonlyMap<string, SemanticOperation>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  seen: Set<string>
): string | null => {
  if (seen.has(valueId)) return null
  seen.add(valueId)
  const producer = producers.get(valueId)
  if (!producer) return null
  if (producer.family === 'binding' && producer.action === 'read' && producer.declaration) {
    const placed = placements.get(producer.declaration)
    return placed?.storage.kind === 'host-namespace' ? placed.storage.linkageName : null
  }
  if (producer.family !== 'computation' || producer.form !== 'conditional') return null
  let path: string | null = null
  for (const operand of producer.operands) {
    if (operand.role === 'condition') continue
    if (operand.source.kind === 'constant') {
      // The arm the host rules out. Only an absence qualifies: an arm holding
      // any other value would mean the program really can observe something
      // other than the namespace here.
      if (operand.source.literal === 'undefined' || operand.source.literal === 'null') continue
      return null
    }
    if (operand.source.kind !== 'result') return null
    const armPath = namespacePathOfValue(operand.source.result, producers, placements, seen)
    if (armPath === null) return null
    if (path !== null && path !== armPath) return null
    path = armPath
  }
  return path
}

/**
 * Cells whose value is a host namespace, placed as that namespace.
 *
 * Run to a fixpoint after every direct claim, because an alias can alias an
 * alias: the framework exports `Geolocation`, then `geolocation`, and a single
 * pass would place whichever it reached first and leave the other an `extern`
 * nothing defines.
 */
const placeNamespaceAliases = (input: BindingPlacementInput, placements: Map<DeclarationId, BindingPlacement>): void => {
  if (!input.hostNamespaces || input.hostNamespaces.roots.size === 0) return
  const producers = new Map<string, SemanticOperation>()
  for (const operation of input.graph.operations.values()) {
    for (const result of operation.results) producers.set(result.id, operation)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const operation of input.graph.operations.values()) {
      if (operation.family !== 'binding' || operation.action !== 'initialize' || !operation.declaration) continue
      const existing = placements.get(operation.declaration)
      if (existing?.storage.kind === 'host-namespace') continue
      const initializer = operation.operands.find((operand) => operand.role === 'initializer')
      if (initializer?.source.kind !== 'result') continue
      const path = namespacePathOfValue(initializer.source.result, producers, placements, new Set())
      if (path === null) continue
      placements.set(operation.declaration, {
        storage: { kind: 'host-namespace', linkageName: path },
        representation: existing?.representation ?? null
      })
      changed = true
    }
  }
}

/**
 * Every cell a program introduces, keyed by declaration.
 *
 * `initialize`, `declare`, and the `module-link`/`initialize` events of the
 * declaration-lifecycle family are all introductions, and they are collected
 * together on purpose: a consumer asking "where does this cell live" must get
 * one answer regardless of which family happened to introduce it.
 */
export const projectBindingPlacements = (input: BindingPlacementInput): ReadonlyMap<DeclarationId, BindingPlacement> => {
  const placements = new Map<DeclarationId, BindingPlacement>()

  // Every graph operation that names one watched declaration, family and
  // action included. The refusal a missing placement raises
  // (`native-boundary:external-binding`) can only say that nothing introduced
  // the cell; which producer was supposed to and what it emitted instead is
  // exactly this list, and there is no other way to see it on the module-graph
  // path. An instrument like `GEA_SHAKE_DEBUG`, not a result.
  const watched = process.env['GEA_PLACEMENT_WATCH']
  if (watched) {
    for (const operation of input.graph.operations.values()) {
      if (!('declaration' in operation) || String((operation as { declaration?: unknown }).declaration) !== watched) continue
      const action = 'action' in operation ? String((operation as { action?: unknown }).action) : ''
      const event = 'event' in operation ? String((operation as { event?: unknown }).event) : ''
      console.log(`[PLACEMENT] ${watched} <- ${operation.family}${action ? `/${action}` : ''}${event ? `/${event}` : ''} ${operation.id}`)
    }
  }

  const record = (declaration: DeclarationId, storage: BindingStorage, representation: Representation | null): void => {
    const existing = placements.get(declaration)
    // A cell introduced twice keeps its first placement rather than acquiring a
    // second: `var` re-declaration and a hoisted function name both do this, and
    // they introduce one cell, not two.
    if (existing) return
    placements.set(declaration, { storage, representation })
  }

  for (const operation of input.graph.operations.values()) {
    const introduces =
      (operation.family === 'binding' && (operation.action === 'initialize' || operation.action === 'declare')) ||
      (operation.family === 'declaration-lifecycle' && (operation.event === 'module-link' || operation.event === 'initialize'))
    if (!introduces) continue
    const published = resultOf(operation, 'value')
    const representation = published ? (input.plan.selected.get(published.id) ?? null) : null
    // `external` is checked ahead of `caller.kind`: an ambient declaration's
    // caller is still an ordinary region (the module body it sits in), and
    // that fact is irrelevant here -- the host, not that region, owns the
    // cell, so the caller must not be consulted for one once this is set.
    const storage: BindingStorage =
      operation.family === 'binding' && operation.external
        ? (hostStorageOf(input, operation.declaration, operation.external.linkageName, representation) ?? {
            kind: 'external',
            linkageName: operation.external.linkageName
          })
        : operation.caller.kind === 'function'
          ? { kind: 'local', owner: operation.caller.functionId }
          : { kind: 'region', owner: operation.caller.regionId }
    record(operation.declaration, storage, representation)
  }

  // Second, and only where the graph introduced nothing: a cell the program
  // reads but never creates. The order is what makes this safe -- a declaration
  // this program really does introduce keeps its own placement, so a local
  // shadowing an ambient name is never turned into an `extern`.
  //
  // The carrier comes from a *read* of the cell rather than from an
  // introduction, because there is no introduction: the reads are the only
  // published results that name this declaration's type, and every one of them
  // carries the same type, so any one of them answers. A cell with no read
  // reaches nothing and needs no `extern`.
  const reads = readsByDeclaration(input.graph)
  for (const [declaration, linkageName] of input.externals ?? []) {
    if (placements.has(declaration)) continue
    const representation = readCarrierOf(input, reads, declaration)
    if (!representation) continue
    // A host that DENIED the name is answered before any host that might claim
    // it, because a denial is the one claim that cannot be outvoted by the
    // generic external fallback below: falling through would emit an `extern`
    // for a symbol this compiler has just concluded is not there.
    const storage: BindingStorage = input.absentBindings?.has(declaration)
      ? { kind: 'absent', linkageName }
      : (hostStorageOf(input, declaration, linkageName, representation) ?? { kind: 'external', linkageName })
    placements.set(declaration, { storage, representation })
  }

  // A program cell that is written but whose introduction nothing reached:
  // every read folded to what the initializer named (a script-global
  // `var Request = RequestImpl` read only as the class), so the tree shake
  // dropped the initialize while a later write (`global.Request = ...`) still
  // stores into it. The cell is file-scope storage like any module cell; its
  // owner region is never consulted for one.
  let anyRegion: RegionId | undefined
  for (const operation of input.graph.operations.values()) {
    if (operation.caller.kind !== 'function') {
      anyRegion = operation.caller.regionId
      break
    }
  }
  for (const operation of input.graph.operations.values()) {
    if (operation.family !== 'binding' || operation.action !== 'write' || !operation.declaration) continue
    if (placements.has(operation.declaration) || input.externals?.has(operation.declaration)) continue
    const written = resultOf(operation, 'value')
    const representation =
      readCarrierOf(input, reads, operation.declaration) ?? (written ? (input.plan.selected.get(written.id) ?? null) : null)
    const owner = operation.caller.kind === 'function' ? anyRegion : operation.caller.regionId
    if (representation === null || owner === undefined) continue
    placements.set(operation.declaration, { storage: { kind: 'region', owner }, representation })
  }

  // Last, so every directly-claimed cell is already placed: an alias is
  // recognized by what it reads, and what it reads has to be known first.
  placeNamespaceAliases(input, placements)

  return placements
}

/**
 * Every read of a cell, by the declaration it reads, in `graph.operations` order.
 *
 * `readCarrierOf` below answers "what carrier does a read of this cell publish",
 * once per ambient declaration this program never introduces, and answering it
 * by walking the whole operation table made placement cost externals x
 * operations. Bucketing on the field the scan already tested answers all of them
 * in one pass, and dealing the buckets in table order keeps the same read
 * first -- which is the one the original scan returned.
 */
const readsByDeclaration = (graph: BindingPlacementInput['graph']): ReadonlyMap<DeclarationId, readonly SemanticOperation[]> => {
  const reads = new Map<DeclarationId, SemanticOperation[]>()
  for (const operation of graph.operations.values()) {
    const declaration =
      operation.family === 'binding' && operation.action === 'read'
        ? operation.declaration
        : operation.family === 'property'
          ? operation.resolvedBinding
          : undefined
    if (declaration === undefined) continue
    const bucket = reads.get(declaration)
    if (bucket) bucket.push(operation)
    else reads.set(declaration, [operation])
  }
  return reads
}

/** The carrier the plan selected for a value read out of one cell, or `null` when nothing reads it. */
const readCarrierOf = (
  input: BindingPlacementInput,
  reads: ReadonlyMap<DeclarationId, readonly SemanticOperation[]>,
  declaration: DeclarationId
): Representation | null => {
  for (const operation of reads.get(declaration) ?? []) {
    const published = resultOf(operation, 'value')
    const representation = published ? input.plan.selected.get(published.id) : undefined
    if (representation && representation.kind !== 'unresolved') return representation
  }
  return null
}
