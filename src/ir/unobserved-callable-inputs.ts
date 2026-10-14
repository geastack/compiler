import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { CallableAbi } from '../representation/model.js'
import type { IrBody, IrOperand, IrOperation } from './model.js'
import { operandsOfIrOperation } from './queries.js'

/**
 * Which target-convention argument positions a converted callable can never
 * observe, so its adapter's conversion of them publishes nothing.
 *
 * A callable adapter converts every target input the source convention does
 * not state in the target's own carrier (`reflection-demand.ts`'s
 * `callableAdapterInputsOf`), and a converted input is promoted to full
 * reflection because the source body might read it dynamically. That is only
 * true of a body that reads it at all. three's `WebGLBackground` installs
 * `boxMesh.onBeforeRender = function (renderer, scene, camera) { ... camera ... }`
 * into Object3D's `onBeforeRender(renderer: WebGLRenderer, ...)` slot; the
 * body never names `renderer`, yet promoting it published the renderer, its
 * render lists and every RenderItem to full reflection, and the frame's hot
 * render-item reads went through field-view receipts.
 *
 * The proof is per source body and closed: the converted value must be the
 * exact `allocate-callable` result of its own body, every physical body of
 * that function must take the source convention's fixed frame (no `arguments`
 * object, no rest packing, not a split generator), and each `parameter` value
 * at the position may only be stored into a binding no operation anywhere in
 * the program reads, renews or otherwise names. A position past the source's
 * declared parameters is dropped by the adapter outright, which only an
 * `arguments` object could observe, and that is excluded by the same frame
 * check. Anything else -- a phi, a binding-read source, a body of another
 * shape -- answers `null` and keeps the conservative promotion.
 */
export interface UnobservedCallableInputs {
  /**
   * The predicate over TARGET parameter positions for the callable `source`
   * names inside the body that executes `operation`, or `null` when the
   * source's body is not proven.
   */
  readonly ignoredParametersOf: (
    operation: IrOperation,
    source: IrOperand,
    sourceAbi: CallableAbi,
    targetAbi: CallableAbi
  ) => ((index: number) => boolean) | null
}

export const createUnobservedCallableInputs = (
  bodies: readonly IrBody[],
  bodyOf: (operation: IrOperation) => IrBody | undefined
): UnobservedCallableInputs => {
  const bodiesByFunction = new Map<string, IrBody[]>()
  for (const body of bodies) {
    const key = String(body.sourceOwner)
    const list = bodiesByFunction.get(key)
    if (list) list.push(body)
    else bodiesByFunction.set(key, [body])
  }
  let named: Set<DeclarationId> | null = null
  // Every declaration some operation other than a plain `binding-write` names
  // -- a read, a renewal, a constructor allocation, a module binding. A cell
  // outside this set is written and never observed.
  const namedDeclarations = (): Set<DeclarationId> => {
    if (named !== null) return named
    named = new Set<DeclarationId>()
    for (const body of bodies)
      for (const block of body.blocks.values())
        for (const operation of [...block.operations, block.terminator]) {
          if (operation.kind === 'binding-write') continue
          const declaration = (operation as { readonly declaration?: unknown }).declaration
          if (typeof declaration === 'string') named.add(declaration as DeclarationId)
        }
    return named
  }
  const definers = new Map<IrBody, Map<IrValueId, IrOperation>>()
  const definerOf = (body: IrBody, value: IrValueId): IrOperation | undefined => {
    let table = definers.get(body)
    if (table === undefined) {
      table = new Map()
      for (const block of body.blocks.values())
        for (const operation of block.operations) {
          const result = (operation as { readonly result?: { readonly id: IrValueId } | null }).result
          if (result) table.set(result.id, operation)
        }
      definers.set(body, table)
    }
    return table.get(value)
  }
  const verdicts = new Map<string, ReadonlySet<number> | null>()
  // The parameter ordinals no body of `functionId` observes, or `null` when a
  // body's frame does not match `sourceAbi` exactly.
  const unobservedOrdinalsOf = (functionId: FunctionId, sourceAbi: CallableAbi): ReadonlySet<number> | null => {
    const cacheKey = `${String(functionId)}#${sourceAbi.parameters.length}`
    if (verdicts.has(cacheKey)) return verdicts.get(cacheKey) ?? null
    const compute = (): ReadonlySet<number> | null => {
      const callees = bodiesByFunction.get(String(functionId))
      if (callees === undefined || callees.length === 0) return null
      const unobserved = new Set<number>(sourceAbi.parameters.map((_, index) => index))
      for (const body of callees) {
        const abi = body.abi
        if (
          abi === null ||
          body.generator === true ||
          (body.generatorPrologueBoundary ?? null) !== null ||
          abi.argumentsFrame !== undefined ||
          abi.restFrom !== null ||
          abi.parameters.length !== sourceAbi.parameters.length
        )
          return null
        const users = new Map<IrValueId, IrOperation[]>()
        const parameters: Extract<IrOperation, { kind: 'parameter' }>[] = []
        for (const block of body.blocks.values())
          for (const operation of [...block.operations, block.terminator]) {
            if (operation.kind === 'parameter') parameters.push(operation)
            for (const operand of operandsOfIrOperation(operation)) {
              const list = users.get(operand.value)
              if (list) list.push(operation)
              else users.set(operand.value, [operation])
            }
          }
        for (const parameter of parameters) {
          const silent = (users.get(parameter.result.id) ?? []).every(
            (user) => user.kind === 'binding-write' && !namedDeclarations().has(user.declaration)
          )
          if (!silent) unobserved.delete(parameter.ordinal)
        }
      }
      return unobserved
    }
    const verdict = compute()
    verdicts.set(cacheKey, verdict)
    return verdict
  }
  return {
    ignoredParametersOf: (operation, source, sourceAbi, targetAbi) => {
      if (sourceAbi.argumentsFrame !== undefined || sourceAbi.restFrom !== null) return null
      if (targetAbi.argumentsFrame !== undefined || targetAbi.restFrom !== null) return null
      const body = bodyOf(operation)
      if (body === undefined) return null
      const definer = definerOf(body, source.value)
      if (definer?.kind !== 'allocate-callable') return null
      const unobserved = unobservedOrdinalsOf(definer.functionId, sourceAbi)
      if (unobserved === null) return null
      return (index) => index >= sourceAbi.parameters.length || unobserved.has(index)
    }
  }
}
