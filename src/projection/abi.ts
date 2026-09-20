import type { DiagnosticLocation } from '../diagnostics/model.js'
import { declarationOfFunction, type DeclarationId, type FunctionId, type SemanticResultId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { abiKey, representationKey } from '../representation/model.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import { callableMutationFactsOf, callableOriginsOf } from '../semantics/callable-origins.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { resultOf } from '../semantics/model/operands.js'

/**
 * Projecting each source function's physical calling convention.
 *
 * This stage decides nothing. The convention was already fixed when the plan
 * selected a carrier for the callable value a `function-object` allocation
 * publishes: a `function-value-dispatch`/`function` carrier *is* an ABI, and
 * re-deriving one here from the parameter list would be a second authority over
 * a question the fixed point already answered -- the classic way one function
 * ends up called through one convention and defined with another.
 *
 * What this stage does do is check the two ends against each other. The frame
 * the body reads (its `parameter`-sourced binding initializations) and the
 * frame the ABI declares are published independently; if they disagree in
 * count or in carrier, the disagreement is reported, never reconciled. A
 * reconciliation here would silently pick a winner and emit a body that reads
 * arguments the caller did not push.
 */

export interface AbiProjectionBlocker {
  readonly functionId: FunctionId
  readonly reason: string
  /**
   * Where the blocked declaration is, or `null` when this program has no node
   * for it (an identity `locationOfDeclaration` was never asked to index, or a
   * blocker minted ahead of a full compiler run -- see `AbiProjectionInput.
   * locationOfDeclaration`). ⛔ DISPLAY ONLY, never an admission input, same as
   * every other `DiagnosticLocation` in the compiler.
   */
  readonly location: DiagnosticLocation | null
}

export interface AbiProjection {
  readonly abis: ReadonlyMap<FunctionId, CallableAbi>
  /** Exact declaration provenance for callable values, proved by the semantic graph. */
  readonly callableOrigins: ReadonlyMap<SemanticResultId, FunctionId>
  /** Own-property writes keyed by that same exact Function identity. */
  readonly callableOwnPropertyWrites: ReadonlyMap<FunctionId, ReadonlySet<string>>
  /** Mutations of the inherited Function.prototype methods shared by every callable. */
  readonly functionPrototypePropertyWrites: ReadonlySet<string>
  /**
   * The convention `new` invokes, for the bodies that have one of their own.
   *
   * Only a `function-and-constructor` carrier is in here: a pre-`class`
   * JavaScript constructor function, whose ONE body is entered two ways. The
   * two are stated separately because they are separately physical --
   * `[[Call]]` is handed a receiver and returns what the body returns, while
   * `[[Construct]]` manufactures the receiver (ECMA-262 10.2.2) and evaluates
   * to it -- and the emitter needs both to render the two function pointers
   * `gea::CallableConstructorObject` holds. A class is NOT here: its
   * construction is a `ClassLayout` (`projection/classes.ts`), rendered from
   * its own declaration.
   */
  readonly constructs: ReadonlyMap<FunctionId, CallableAbi>
  readonly blocked: readonly AbiProjectionBlocker[]
}

export interface AbiProjectionInput {
  readonly graph: SemanticGraph
  readonly plan: SealedRepresentationPlan
  /**
   * Optional only for callers that predate this field (`preflight/run.ts`
   * builds its own `AbiProjectionInput` ahead of a full compiler run, where
   * no boxed-callable body could exist yet to need it). Every carrier that
   * needs it -- `abiOfCarrier`'s fallback for a `dynamic` function-object
   * allocation -- is unreachable without `--dynamic-fallback`, so its
   * absence there costs nothing real.
   */
  readonly deriver?: RepresentationDeriver
  /**
   * Where a DeclarationId is, for a blocker to carry as display evidence --
   * `CompilationResult.locationOfDeclaration`, the frontend's own position
   * index. Optional for the same reason `deriver` is: `preflight/run.ts`
   * builds its own `AbiProjectionInput` ahead of a full compiler run, before
   * there is a frontend result to ask. A blocker minted there carries a `null`
   * location rather than one this stage invented a second way to compute.
   */
  readonly locationOfDeclaration?: (declaration: DeclarationId) => DiagnosticLocation | null
}

/**
 * The carrier the plan selected for one parameter binding's published value.
 *
 * Read through the plan rather than re-derived, for the same reason the ABI is:
 * a parameter's carrier is a fixed-point output, and a second derivation of it
 * would be a second answer.
 */
const parameterCarrierKeys = (
  input: AbiProjectionInput,
  functionId: FunctionId,
  bodies: ReadonlyMap<FunctionId, readonly SemanticOperation[]>
): ReadonlyMap<number, string> => {
  const keys = new Map<number, string>()
  for (const operation of bodies.get(functionId) ?? []) {
    // A defaulted parameter's own `binding.initialize` operand no longer cites
    // `{kind: 'parameter'}` directly -- it cites the `default-value` merge's
    // result instead, because what it binds is the post-default value, not
    // the raw argument. The raw argument is what the new `parameter-value`
    // reference operation cites, so that operation is equally valid evidence
    // that this ABI position is bound, for the one case the original scan
    // alone can no longer see.
    const isDefaultedParameterSource = operation.family === 'reference' && operation.form === 'parameter-value'
    if (!isDefaultedParameterSource && (operation.family !== 'binding' || operation.action !== 'initialize')) continue
    const initializer = operation.operands.find((operand) => operand.source.kind === 'parameter')
    if (!initializer || initializer.source.kind !== 'parameter') continue
    const published = resultOf(operation, 'value')
    const carrier = published ? input.plan.selected.get(published.id) : undefined
    keys.set(initializer.source.ordinal, carrier ? representationKey(carrier) : 'unselected')
  }
  return keys
}

/**
 * The convention(s) a selected callable carrier states, or `null` for a carrier
 * that states none.
 *
 * `construct` is non-null only for the two-entry carrier: it is the second
 * convention into the SAME body, not a second body.
 */
interface BodyConventions {
  readonly call: CallableAbi
  readonly construct: CallableAbi | null
}

const abiOfCarrier = (
  input: AbiProjectionInput,
  functionId: FunctionId,
  allocations: ReadonlyMap<FunctionId, readonly SemanticOperation[]>
): BodyConventions | null => {
  for (const operation of allocations.get(functionId) ?? []) {
    const published = resultOf(operation, 'value')
    const carrier = published ? input.plan.selected.get(published.id) : undefined
    if (!carrier) continue
    if (carrier.kind === 'function' || carrier.kind === 'function-value-dispatch') return { call: carrier.abi, construct: null }
    if (carrier.kind === 'function-family' || carrier.kind === 'function-value-family') return { call: carrier.abi, construct: null }
    // A JS CONSTRUCTOR FUNCTION: one `function F( a, b ) {}` that is both
    // called and `new`ed, which is how three.js writes almost every internal
    // module -- `WebGLTextures`, `WebGLProgram`, `WebGLShadowMap`, ten of them
    // in one program, each blocked here with "no function-object allocation
    // published a callable carrier" while its allocation had published a
    // perfectly good one this function had no arm for.
    //
    // One body serves both conventions, and its FORMALS are the shared half:
    // the same parameter list is read whichever way it was entered. The result
    // is not shared -- `new F()` evaluates to the instance and `F()` to what
    // the body returns -- and the body's own is the call one, since a
    // construction takes the instance from `.construct` (`emit-callable.ts`),
    // never from the body's return value.
    //
    // Only when the two frames agree. Where they do not, the two entry points
    // would need two bodies, and this projection has one to state.
    if (carrier.kind === 'function-and-constructor' && argumentFrameKey(carrier.call) === argumentFrameKey(carrier.construct)) {
      return { call: carrier.call, construct: carrier.construct }
    }
    // A function boxed to `dynamic` under `--dynamic-fallback` (its own
    // `.prototype` read or written, `prototypeMutatedConstructorTypes` in
    // dynamic-fallback.ts) still has to bind a real parameter frame when its
    // body runs -- a fact about the DECLARATION, never about which carrier a
    // later census chose for the value. `nativeCallableConventions` answers
    // exactly that, keyed by the allocation's checker-authenticated FunctionId.
    // Its structural shape is deliberately not accepted: unrelated functions
    // with the same signature share that id and may not borrow this frame.
    if (
      carrier.kind === 'dynamic' &&
      operation.family === 'allocation' &&
      operation.allocated === 'function-object' &&
      operation.callable === functionId &&
      input.deriver
    ) {
      const native = input.deriver.nativeCallableConventions(functionId)
      if (native) return native
    }
  }
  return null
}

/**
 * A convention's ARGUMENT half, as a key -- the part two entry points into one
 * body have to share, with the result and the receiver deliberately left out.
 *
 * The receiver is left out because it is the one slot the two conventions into
 * a JS constructor function legitimately DISAGREE in, and neither answer is
 * wrong: `[[Construct]]` manufactures the receiver (ECMA-262 10.2.2, so
 * `representation/derive.ts` states none for it) while `[[Call]]` is handed
 * one. Keying on it made every such function's frames compare unequal and
 * blocked the body -- which is the whole of three.js's renderer -- for a
 * disagreement that is the language's own.
 */
const argumentFrameKey = (abi: CallableAbi): string =>
  [abi.parameters.map((parameter) => `${representationKey(parameter.value)}/${parameter.ownership}`).join(','), abi.restFrom ?? '-'].join(
    ';'
  )

/**
 * The calling convention a Representation states, when it states one -- the
 * same set of callable carrier kinds `abiOfCarrier` above reads off a
 * `function-object` allocation, asked instead of an arbitrary published
 * value. `function-and-constructor` contributes its `call` half alone: unlike
 * `abiOfCarrier`'s own use of that carrier (which is *becoming* the two-entry
 * function and so needs both frames to agree), a forwarding candidate is only
 * ever borrowed as a callee, and a call site only ever needs `[[Call]]`.
 */
const callConventionOf = (representation: Representation): CallableAbi | null => {
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-dispatch':
    case 'function-value-family':
      return representation.abi
    case 'native-handle':
      return representation.call
    case 'function-and-constructor':
      return representation.call
    default:
      return null
  }
}

/**
 * Whether a convention is the fiction a checker synthesizes for a JavaScript
 * function that declares no parameters but reads the `arguments` object --
 * three.js's `function texImage2D() { gl.texImage2D( ...arguments ) }`, one
 * of ~2,315 functions across a real application and the majority shape behind
 * this projection's blockers.
 *
 * There is no declared parameter for `structural-parts.ts`'s `parameterOf` to
 * read a `ts.ParameterDeclaration` from, so the checker's own inferred
 * signature is the only source that layer has, and what it publishes is one
 * parameter shaped like the whole `arguments` object: a plain dynamic array,
 * with no rest marker (a real `...args: T[]` parameter has a declaration, and
 * derives to whatever `T` is, not to this specific undeclared shape). Naming
 * the shape precisely -- one parameter, no `restFrom`, an `array-object` of
 * `dynamic(declared-any-never-narrowed)` -- is what keeps this from ever
 * matching a real single-parameter function whose declared type happens to be
 * `any[]`: that function has a `ts.ParameterDeclaration`, and its body binds
 * one physical parameter the standard check below already accepts.
 */
const isArgumentsObjectFiction = (abi: CallableAbi): boolean => {
  if (abi.restFrom !== null || abi.parameters.length !== 1) return false
  const value = abi.parameters[0]?.value
  return value?.kind === 'array-object' && value.element.kind === 'dynamic' && value.element.reason === 'declared-any-never-narrowed'
}

/**
 * The one other callable this shim forwards its whole `arguments` object to,
 * when there is exactly one.
 *
 * A forwarding shim's entire body is `callee( ...arguments )`, so the
 * `callee` sub-expression is READ (a `property` or `reference` operation
 * publishes it) but never itself an operand of anything else in the body --
 * the spread call that would consume it is exactly the call this compiler has
 * no primitive to build (`producers/spread-arguments.ts` refuses spreading an
 * `arguments` object into a callee with no rest formal), so it leaves no
 * `invocation` operation behind and the read sits unconsumed. That is the
 * signal: among this body's operations, the callable-valued one nothing else
 * cites is the callee the source forwarded to. A body with zero or with more
 * than one such candidate states nothing this projection can act on, and
 * returns `null` rather than guess between them -- `console.error`'s own
 * receiver read is exactly this shape's other common case (see the shim
 * bodies in `.scratch/threejs/abi-arity.mjs`'s output), and is excluded by
 * being consumed by its own call.
 *
 * `isArgumentsObjectFiction` is asked of every candidate too, not only of
 * this function's own ABI, so a chain of two shims never borrows the nearer
 * one's fiction instead of walking to the real callee underneath it.
 */
const forwardingCalleeAbi = (input: AbiProjectionInput, functionId: FunctionId, bodies: OperationIndex['bodies']): CallableAbi | null => {
  const operations = bodies.get(functionId) ?? []
  const consumed = new Set<string>()
  for (const operation of operations) {
    for (const operand of operation.operands) {
      if (operand.source.kind === 'result') consumed.add(operand.source.result)
    }
  }
  let found: CallableAbi | null = null
  for (const operation of operations) {
    const published = resultOf(operation, 'value')
    if (!published || consumed.has(published.id)) continue
    const carrier = input.plan.selected.get(published.id)
    const abi = carrier ? callConventionOf(carrier) : null
    if (!abi || isArgumentsObjectFiction(abi)) continue
    if (found) return null
    found = abi
  }
  return found
}

/**
 * The two questions above, asked of the operation table once instead of once
 * per function.
 *
 * Both helpers are filters over the whole table -- one keeps the operations a
 * function's body owns, the other the `function-object` allocations that name
 * it -- and each function asked both. That is functions x operations: on one
 * measured application, 2,315 functions against 114,686 operations, twice,
 * which is half a billion visits to answer 2,315 questions. Bucketing by the
 * key each filter already tested answers all of them in one pass.
 *
 * Each bucket is filled in `graph.operations` iteration order, which is what
 * keeps the answers identical: `parameterCarrierKeys` writes one ordinal at a
 * time and lets the last writer win, and `abiOfCarrier` returns on the first
 * carrier it finds -- both decided by table order, and both reading that same
 * order here.
 */
interface OperationIndex {
  /** Every operation whose caller is this function, in table order. */
  readonly bodies: ReadonlyMap<FunctionId, readonly SemanticOperation[]>
  /** Every `function-object` allocation naming this function as its callable, in table order. */
  readonly allocations: ReadonlyMap<FunctionId, readonly SemanticOperation[]>
}

/**
 * The `[[Construct]]` convention each call frame is asked for, over the whole
 * plan, computed once.
 *
 * A cast that asserts a construct signature onto a call-only function puts the
 * second convention on the CAST's carrier; nothing links it back to the
 * declaration except the call frame the two share. This is that link, read by
 * the demand test below. Deliberately keyed by the call frame and not by a
 * declaration: the plan has no declaration to offer here, and matching two
 * declarations that share one frame costs an unused thunk, never a wrong
 * construction -- the runtime looks the entry up by the value's own invoke
 * pointer.
 *
 * A carrier nested inside a container is not reached. That is the fail-closed
 * direction: the conversion then finds no entry and refuses by name.
 */
const demandedConstructAbis = (plan: SealedRepresentationPlan): ReadonlyMap<string, CallableAbi> => {
  const abis = new Map<string, CallableAbi>()
  // Two different construct conventions over one call frame name no single
  // second entry point for the body, so neither is published. That is the same
  // "one body states one convention" rule `abiOfCarrier` applies to the
  // allocation's own carrier, and the conversion then refuses by name.
  const ambiguous = new Set<string>()
  for (const carrier of plan.selected.values()) {
    const payload = carrier.kind === 'optional' ? carrier.payload : carrier
    if (payload.kind !== 'function-and-constructor') continue
    const key = abiKey(payload.call)
    const seen = abis.get(key)
    if (seen !== undefined && abiKey(seen) !== abiKey(payload.construct)) ambiguous.add(key)
    abis.set(key, payload.construct)
  }
  for (const key of ambiguous) abis.delete(key)
  return abis
}

const indexOperations = (graph: SemanticGraph): OperationIndex => {
  const bodies = new Map<FunctionId, SemanticOperation[]>()
  const allocations = new Map<FunctionId, SemanticOperation[]>()
  const add = (into: Map<FunctionId, SemanticOperation[]>, key: FunctionId, operation: SemanticOperation): void => {
    const bucket = into.get(key)
    if (bucket) bucket.push(operation)
    else into.set(key, [operation])
  }
  for (const operation of graph.operations.values()) {
    if (operation.caller.kind === 'function') add(bodies, operation.caller.functionId, operation)
    if (operation.family === 'allocation' && operation.allocated === 'function-object' && operation.callable) {
      add(allocations, operation.callable, operation)
    }
  }
  return { bodies, allocations }
}

export const projectAbis = (input: AbiProjectionInput): AbiProjection => {
  const abis = new Map<FunctionId, CallableAbi>()
  const constructs = new Map<FunctionId, CallableAbi>()
  const blocked: AbiProjectionBlocker[] = []
  const callableOrigins = callableOriginsOf(input.graph)
  const callableMutations = callableMutationFactsOf(input.graph, input.plan, callableOrigins)
  const { bodies, allocations } = indexOperations(input.graph)
  const demandedConstructs = demandedConstructAbis(input.plan)

  const functions = new Set<FunctionId>()
  for (const operation of input.graph.operations.values()) {
    if (operation.caller.kind === 'function') functions.add(operation.caller.functionId)
    if (operation.family === 'allocation' && operation.callable) functions.add(operation.callable)
  }

  // Resolved once per blocked function rather than inline at each push site:
  // every blocker below names the SAME `functionId`, and `declarationOfFunction`
  // plus the lookup is one answer, not three.
  const locationOf = (functionId: FunctionId): DiagnosticLocation | null =>
    input.locationOfDeclaration?.(declarationOfFunction(functionId)) ?? null

  for (const functionId of [...functions].sort()) {
    const conventions = abiOfCarrier(input, functionId, allocations)
    if (!conventions) {
      blocked.push({
        functionId,
        reason: 'no function-object allocation published a callable carrier for this function, so it has no stated calling convention',
        location: locationOf(functionId)
      })
      continue
    }
    const abi = conventions.call
    const carriers = parameterCarrierKeys(input, functionId, bodies)
    // A forwarding shim declares no `ts.ParameterDeclaration` at all, so
    // `carriers` is legitimately empty by source, not by defect -- there is no
    // named binding the standard check below could ever find. Its checker-
    // published ABI is not a second, disagreeing authority either: it is a
    // fiction the checker states for lack of anything better, over a value
    // this compiler's own plan already carries the real convention for, one
    // step away at the callee the shim forwards to. Adopting that convention
    // here is not the reconciliation this file's own module comment refuses --
    // there was never a real disagreement to reconcile, only one authority
    // (the checker, over an undeclared parameter) that had nothing to publish
    // and said so with a fiction.
    if (carriers.size === 0 && isArgumentsObjectFiction(abi)) {
      const forwarded = forwardingCalleeAbi(input, functionId, bodies)
      if (forwarded) {
        abis.set(functionId, forwarded)
        continue
      }
    }
    if (carriers.size !== abi.parameters.length) {
      blocked.push({
        functionId,
        reason: `the body binds ${carriers.size} physical parameter(s) but the ABI declares ${abi.parameters.length}`,
        location: locationOf(functionId)
      })
      continue
    }
    const mismatch = abi.parameters.findIndex((parameter, ordinal) => carriers.get(ordinal) !== representationKey(parameter.value))
    const declared = abi.parameters[mismatch]
    if (mismatch >= 0 && declared) {
      blocked.push({
        functionId,
        reason:
          `parameter ${mismatch} is bound as "${carriers.get(mismatch) ?? 'absent'}" but the ABI declares ` +
          `"${representationKey(declared.value)}"`,
        location: locationOf(functionId)
      })
      continue
    }
    abis.set(functionId, abi)
    if (conventions.construct) constructs.set(functionId, conventions.construct)
    else {
      // The allocation published only a `[[Call]]` carrier, and somewhere the
      // program still names this declaration's `[[Construct]]`: `Factory as
      // typeof Factory & (new (v: number) => T)` puts the construct half on
      // the CAST's carrier, never on the allocation's. ECMA-262 gives a
      // pre-`class` constructor function both internal methods when it is
      // created, so the second convention is not invented here -- it is taken
      // from the carrier that demanded it, matched to this declaration by its
      // call frame, and only where the two entry points share one argument
      // frame the single body can bind.
      //
      // Demand-driven, so a function that is only ever called still emits one
      // thunk. Two declarations sharing one call frame both get one, and that
      // costs an unused thunk rather than a wrong answer: the runtime looks
      // the entry up by the value's own invoke pointer
      // (`gea::withConstructEntry`), so a construction can never enter another
      // declaration's body.
      const demanded = demandedConstructs.get(abiKey(abi))
      if (demanded && argumentFrameKey(abi) === argumentFrameKey(demanded)) constructs.set(functionId, demanded)
    }
  }

  return {
    abis,
    constructs,
    callableOrigins,
    callableOwnPropertyWrites: callableMutations.ownProperties,
    functionPrototypePropertyWrites: callableMutations.functionPrototypeProperties,
    blocked: Object.freeze(blocked)
  }
}
