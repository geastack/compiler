import {
  irValueId,
  type IrValueId,
  type OperationId,
  type PhysicalBodyId,
  type SemanticResultId,
  type StructuralTypeId
} from '../identity/ids.js'
import { carriesNativeUndefined, type Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { OperandSource } from '../semantics/model/operands.js'
import { allOperationsOf, type IrBlock, type IrBlockId, type IrBody, type IrNonTerminatorOperation } from './model.js'
import type { SlotDrift } from './lower-operands.js'
import { resultOfIrOperation, successorsOfTerminator } from './queries.js'
import { verifyIrBody } from './verify.js'
import { closedNormalResultsOf, type ClosedNormalResultInput } from './closed-normal-results.js'

const nonNullPrimitive = (representation: Representation): boolean =>
  representation.kind === 'scalar' ||
  representation.kind === 'string' ||
  representation.kind === 'symbol' ||
  (representation.kind === 'tagged-union' &&
    representation.arms.length > 0 &&
    representation.arms.every((arm) => nonNullPrimitive(arm.value)))

const primitiveOrNullish = (representation: Representation): boolean =>
  nonNullPrimitive(representation) ||
  representation.kind === 'null' ||
  representation.kind === 'undefined' ||
  (representation.kind === 'optional' && primitiveOrNullish(representation.payload)) ||
  (representation.kind === 'tagged-union' && representation.arms.every((arm) => primitiveOrNullish(arm.value)))

const referenceKinds: ReadonlySet<Representation['kind']> = new Set<Representation['kind']>([
  'class-ref',
  'record',
  'record-with-index',
  'native-record-ref',
  'array-object',
  'typed-array',
  'keyed-collection',
  'dictionary',
  'iterator',
  'promise',
  'array-buffer',
  'shared-array-buffer',
  'data-view',
  'proxy-object',
  'function',
  'function-family',
  'function-value-family',
  'function-value-dispatch',
  'function-and-constructor',
  'constructor-family',
  'constructor-value-dispatch'
])

/**
 * Which JS types a value in `carrier` can be, or `null` when the carrier does
 * not say. Every object -- a function included -- is one `reference` tag,
 * joined with `null` because a refcounted reference can be the collapsed
 * `null` of `T | null`. Strict native receivers also retain `undefined`,
 * which a detached method can return through its declared object result.
 * Strict equality between two references is identity,
 * so only different primitive types, or a reference against a primitive, are
 * decided by the carrier alone.
 */
const jsTypeTagsOf = (carrier: Representation): ReadonlySet<string> | null => {
  if (carrier.kind === 'scalar') return new Set([carrier.domain === 'boolean' || carrier.domain === 'bigint' ? carrier.domain : 'number'])
  if (carrier.kind === 'string' || carrier.kind === 'symbol' || carrier.kind === 'null' || carrier.kind === 'undefined')
    return new Set([carrier.kind])
  if (referenceKinds.has(carrier.kind))
    return new Set(carriesNativeUndefined(carrier) ? ['reference', 'null', 'undefined'] : ['reference', 'null'])
  if (carrier.kind === 'optional') {
    const payload = jsTypeTagsOf(carrier.payload)
    return payload === null ? null : new Set([...payload, carrier.absence === 'null' ? 'null' : 'undefined'])
  }
  if (carrier.kind === 'tagged-union') {
    const tags = new Set<string>()
    for (const arm of carrier.arms) {
      const armTags = jsTypeTagsOf(arm.value)
      if (armTags === null) return null
      for (const tag of armTags) tags.add(tag)
    }
    return tags
  }
  return null
}

/**
 * `a === b` is false -- and `a !== b` true -- when no JS type both carriers
 * can hold is shared. A typical `isSameValue(a, b)` helper guards `1 / b`
 * behind `b === 0` with `b` a string or a function, which is code that never
 * runs and must not demand a ToNumber of the function.
 */
const disjointCarriers = (left: Representation, right: Representation): boolean => {
  const leftTags = jsTypeTagsOf(left)
  const rightTags = jsTypeTagsOf(right)
  if (leftTags === null || rightTags === null) return false
  for (const tag of leftTags) if (rightTags.has(tag)) return false
  return true
}

/** Normal-completion truth facts derived from the semantic operations' sealed results. */
export const provenResultTruthiness = (
  graph: Pick<SemanticGraph, 'operations'> & Partial<Pick<SemanticGraph, 'structuralTypes'>>
): ReadonlyMap<SemanticResultId, boolean> => {
  const facts = new Map<SemanticResultId, boolean>()
  // A value whose sealed type is `null` or `undefined` and nothing else is
  // falsy wherever it completes normally: a `this.flag` field only ever
  // written `null` guards code that never runs. `void` is
  // left out -- a `() => void` callee may return anything.
  const onlyNullish = (type: StructuralTypeId): boolean => {
    const shape = graph.structuralTypes?.get(type)?.shape
    if (shape === undefined) return false
    if (shape.kind === 'primitive') return shape.primitive === 'null' || shape.primitive === 'undefined'
    return shape.kind === 'union' && shape.members.length > 0 && shape.members.every(onlyNullish)
  }
  for (const operation of graph.operations.values())
    for (const result of operation.results) if (result.role === 'value' && onlyNullish(result.type)) facts.set(result.id, false)
  const read = (source: OperandSource | undefined): boolean | undefined => {
    if (source?.kind === 'result') return facts.get(source.result)
    if (source?.kind !== 'constant') return undefined
    switch (source.literal) {
      case 'undefined':
      case 'null':
        return false
      case 'boolean':
        return source.text === 'true'
      case 'string':
        return source.text.length !== 0
      case 'number':
        return Number(source.text) !== 0 && !Number.isNaN(Number(source.text))
      default:
        return undefined
    }
  }
  // The sealed-type half of `disjointCarriers`: a strict equality whose
  // operand TYPES share no JS type is decided, and -- unlike the IR carrier
  // rule, which a phi stops -- that fact composes through `&&`/`||` here, as
  // in the harness's `a === 0 && b === 0`.
  const tagsMemo = new Map<StructuralTypeId, ReadonlySet<string> | null>()
  const tagsOf = (type: StructuralTypeId, seen: Set<StructuralTypeId> = new Set()): ReadonlySet<string> | null => {
    const remembered = tagsMemo.get(type)
    if (remembered !== undefined) return remembered
    if (seen.has(type)) return null
    seen.add(type)
    const shape = graph.structuralTypes?.get(type)?.shape
    let tags: ReadonlySet<string> | null = null
    if (shape?.kind === 'primitive')
      tags =
        shape.primitive === 'never' ? new Set() : ['void', 'unknown', 'any'].includes(shape.primitive) ? null : new Set([shape.primitive])
    else if (shape?.kind === 'literal') tags = new Set([shape.primitive])
    else if (shape?.kind === 'unique-symbol') tags = new Set(['symbol'])
    // Only shapes no primitive can satisfy: TypeScript's object and class
    // types are structural, so `'abc'` inhabits `{ length: number }` and a
    // class whose one member is a public `length`.
    else if (shape?.kind === 'class-constructor' || shape?.kind === 'array' || shape?.kind === 'tuple' || shape?.kind === 'signature')
      tags = new Set(['reference'])
    else if (shape?.kind === 'union') {
      const union = new Set<string>()
      for (const member of shape.members) {
        const memberTags = tagsOf(member, seen)
        if (memberTags === null) {
          tagsMemo.set(type, null)
          return null
        }
        for (const tag of memberTags) union.add(tag)
      }
      tags = union
    }
    tagsMemo.set(type, tags)
    return tags
  }
  const disjointTypes = (left: StructuralTypeId, right: StructuralTypeId): boolean => {
    const leftTags = tagsOf(left)
    const rightTags = tagsOf(right)
    if (leftTags === null || rightTags === null) return false
    for (const tag of leftTags) if (rightTags.has(tag)) return false
    return true
  }
  // `typeof v` of a value whose sealed type is `undefined` and nothing else is
  // the string "undefined" wherever it completes normally. A host that states
  // a global absent (`PluginCapabilities.absentGlobals`) turns the reference
  // into exactly such a value, and portable libraries guard browser-only branches
  // with `typeof Global !== 'undefined'`; the guard must decide, or the dead
  // branch keeps every DOM-typed value it names alive into certification.
  const onlyUndefined = (type: StructuralTypeId): boolean => {
    const shape = graph.structuralTypes?.get(type)?.shape
    return shape?.kind === 'primitive' && shape.primitive === 'undefined'
  }
  const typeofNames = new Map<SemanticResultId, string>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'computation' || operation.form !== 'typeof') continue
    const operand = operation.operands[0]
    if (operand === undefined || !onlyUndefined(operand.type)) continue
    for (const result of operation.results) if (result.role === 'value') typeofNames.set(result.id, 'undefined')
  }
  const stringOf = (source: OperandSource | undefined): string | undefined => {
    if (source?.kind === 'result') return typeofNames.get(source.result)
    return source?.kind === 'constant' && source.literal === 'string' ? source.text : undefined
  }
  let changed = true
  while (changed) {
    changed = false
    for (const operation of graph.operations.values()) {
      let truth: boolean | undefined
      if (operation.family === 'property' && operation.internalMethod === 'get' && operation.normalResult === 'undefined') truth = false
      // `lower-property.ts` lowers such a read to the constant `true`.
      else if (operation.family === 'property' && operation.internalMethod === 'get' && operation.methodPresenceTest) truth = true
      else if (
        operation.family === 'computation' &&
        operation.form === 'unary' &&
        operation.operator === '!' &&
        operation.operandObjectTruthy === true &&
        operation.operands.length === 1 &&
        operation.operands[0]?.role === 'operand' &&
        operation.operands[0].ordinal === 0
      )
        truth = false
      else if (operation.family === 'computation' && operation.form === 'logical') {
        const left = read(operation.operands.find((operand) => operand.role === 'left')?.source)
        const right = read(operation.operands.find((operand) => operand.role === 'right')?.source)
        if (operation.operator === '&&') truth = left === false || right === false ? false : left === true ? right : undefined
        if (operation.operator === '||') truth = left === true || right === true ? true : left === false ? right : undefined
      } else if (
        operation.family === 'computation' &&
        operation.form === 'equality' &&
        (operation.operator === '===' || operation.operator === '!==')
      ) {
        const left = operation.operands.find((operand) => operand.role === 'left')
        const right = operation.operands.find((operand) => operand.role === 'right')
        const leftName = stringOf(left?.source)
        const rightName = stringOf(right?.source)
        if (leftName !== undefined && rightName !== undefined) truth = (leftName === rightName) === (operation.operator === '===')
        else if (left !== undefined && right !== undefined && disjointTypes(left.type, right.type)) truth = operation.operator === '!=='
      }
      if (truth === undefined) continue
      for (const result of operation.results) {
        if (result.role !== 'value' || facts.has(result.id)) continue
        facts.set(result.id, truth)
        changed = true
      }
    }
  }
  return facts
}

/**
 * Remove impossible control-flow edges before liveness and certification.
 * Evaluation of the condition is preserved, including calls and throws. This
 * pass uses normal-result facts, never a cast's destination type as evidence
 * that the cast's block is unreachable.
 */
export const pruneProvenBranches = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  graph: Pick<SemanticGraph, 'operations'> & Partial<Pick<SemanticGraph, 'structuralTypes'>>,
  slotDrift: readonly SlotDrift[] = [],
  normalResults?: ClosedNormalResultInput
): { readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>; readonly slotDrift: readonly SlotDrift[] } => {
  const semantic = provenResultTruthiness(graph)
  const semanticResults = new Map(
    [...graph.operations.values()].flatMap((operation) => operation.results.map((result) => [result.id, operation] as const))
  )
  const closed = normalResults === undefined ? null : closedNormalResultsOf(bodies, graph, normalResults)
  const absentReads = new Set<SemanticResultId>()
  for (const operation of graph.operations.values()) {
    if (operation.family === 'property' && operation.internalMethod === 'get' && operation.normalResult === 'undefined')
      for (const result of operation.results) if (result.role === 'value') absentReads.add(result.id)
  }
  const output = new Map(bodies)
  const removedBlocks = new Set<IrBlockId>()
  const truncatedDrift = new Map<IrBlockId, ReadonlySet<OperationId>>()
  let changedAny = false
  for (const [id, body] of bodies) {
    // These regions have entry/cleanup edges beyond ordinary terminators.
    // Keep their whole CFG until those edges have an explicit pruning recipe.
    const protectedFlow = Boolean(
      body.tryRegions.length || body.iteratorCloseRegions?.length || body.generator || body.generatorPrologueBoundary
    )
    const facts = new Map<string, boolean>(closed?.truthiness)
    const operations = [...body.blocks.values()].flatMap((block) => block.operations)
    const definitions = new Map(
      operations.flatMap((operation) => {
        const result = resultOfIrOperation(operation)
        return result === null ? [] : [[result.id, operation] as const]
      })
    )
    for (const operation of operations) {
      if (operation.kind === 'compute' && operation.form === 'unary' && operation.operator === '!') {
        const source = semanticResults.get(operation.lineage)
        const expected = source?.operands[0]?.source
        const actual = operation.operands.length === 1 ? definitions.get(operation.operands[0]!.value) : undefined
        const sameSource =
          expected?.kind === 'result'
            ? actual?.lineage === expected.result && actual.kind !== 'convert'
            : expected?.kind === 'parameter'
              ? actual?.kind === 'parameter' && actual.ordinal === expected.ordinal
              : expected?.kind === 'receiver' && actual?.kind === 'receiver'
        if (
          source?.family === 'computation' &&
          source.form === 'unary' &&
          source.operator === '!' &&
          source.operandObjectTruthy === true &&
          body.sourceOwner === (source.caller.kind === 'function' ? source.caller.functionId : source.caller.regionId) &&
          sameSource &&
          operation.result.representation.kind === 'scalar' &&
          operation.result.representation.domain === 'boolean' &&
          semantic.get(operation.lineage) === false
        )
          facts.set(operation.result.id, false)
        continue
      }
      // A decided string equality (`typeof Absent === 'undefined'`) is the branch
      // condition itself, a `compute` carrying the equality's own lineage.
      if (operation.kind === 'compute' && operation.form === 'equality') {
        const truth = semantic.get(operation.lineage)
        if (
          truth !== undefined &&
          operation.operands.length === 2 &&
          operation.operands.every((operand) => operand.representation.kind === 'string')
        )
          facts.set(operation.result.id, truth)
        continue
      }
      if (operation.kind !== 'get' && operation.kind !== 'phi' && operation.kind !== 'constant') continue
      const truth = semantic.get(operation.lineage)
      if (truth !== undefined) facts.set(operation.result.id, truth)
    }
    for (const operation of operations) {
      if (operation.kind !== 'compute' || operation.form !== 'equality' || (operation.operator !== '===' && operation.operator !== '!=='))
        continue
      const [left, right] = operation.operands
      if (left !== undefined && right !== undefined && disjointCarriers(left.representation, right.representation))
        facts.set(operation.result.id, operation.operator === '!==')
    }
    for (const operation of operations) {
      if (operation.kind !== 'test' || operation.predicate !== 'to-boolean') continue
      const truth = facts.get(operation.value.value)
      if (truth !== undefined) facts.set(operation.result.id, truth)
    }
    const blocks = new Map(body.blocks)
    const expandedValues = new Map(body.values)
    let ordinal = 0
    let changed = false
    for (const [blockId, unbounded] of blocks) {
      // GetValue on a receiver that can only be `undefined` or `null` throws
      // (ECMA-262 GetV -> ToObject) before anything after it in the block runs.
      // `_effects[ i ].render( renderer, ... )` over an array that never
      // holds anything still lowered the call, and boxing its arguments for a
      // callee that is never reached demanded full reflection of the renderer.
      const throwing = protectedFlow
        ? -1
        : unbounded.operations.findIndex(
            (operation) =>
              operation.kind === 'get' &&
              (operation.receiver.representation.kind === 'undefined' || operation.receiver.representation.kind === 'null')
          )
      let original = unbounded
      if (throwing >= 0) {
        const get = unbounded.operations[throwing] as Extract<IrNonTerminatorOperation, { kind: 'get' }>
        while (expandedValues.has(irValueId(body.owner, ordinal))) ordinal++
        const checked = irValueId(body.owner, ordinal++)
        expandedValues.set(checked, get.receiver.representation)
        original = {
          ...unbounded,
          operations: [
            ...unbounded.operations.slice(0, throwing),
            {
              kind: 'compute',
              lineage: get.lineage,
              form: 'require-object-coercible',
              operator: 'RequireObjectCoercible',
              operands: [get.receiver],
              result: { id: checked, representation: get.receiver.representation }
            }
          ],
          terminator: { kind: 'throw', lineage: get.lineage, value: { value: checked, representation: get.receiver.representation } }
        }
        // A conversion the census could not supply for an operation that now
        // never runs is not a refusal; one also lowered before the throw is.
        const operationOf = (lineage: SemanticResultId | null): OperationId | undefined =>
          lineage === null ? undefined : semanticResults.get(lineage)?.id
        const kept = new Set(unbounded.operations.slice(0, throwing + 1).map((operation) => operationOf(operation.lineage)))
        const dropped = new Set<OperationId>()
        for (const operation of [...unbounded.operations.slice(throwing + 1), unbounded.terminator]) {
          const semanticId = operationOf(operation.lineage)
          if (semanticId !== undefined && !kept.has(semanticId)) dropped.add(semanticId)
        }
        if (dropped.size) truncatedDrift.set(blockId, dropped)
        changed = true
      }
      const operations = original.operations.flatMap((operation): IrNonTerminatorOperation[] => {
        if (
          operation.kind !== 'get' ||
          !absentReads.has(operation.lineage) ||
          operation.result.representation.kind !== 'undefined' ||
          !primitiveOrNullish(operation.receiver.representation)
        )
          return [operation]
        // The base/key evaluations are separate SSA operations and remain.
        // A nullable receiver retains GetV's RequireObjectCoercible step.
        // The existing IR primitive preserves its TypeError without boxing.
        changed = true
        const result: IrNonTerminatorOperation[] = []
        if (!nonNullPrimitive(operation.receiver.representation)) {
          while (expandedValues.has(irValueId(body.owner, ordinal))) ordinal++
          const checked = irValueId(body.owner, ordinal++)
          expandedValues.set(checked, operation.receiver.representation)
          result.push({
            kind: 'compute',
            lineage: operation.lineage,
            form: 'require-object-coercible',
            operator: 'RequireObjectCoercible',
            operands: [operation.receiver],
            result: { id: checked, representation: operation.receiver.representation }
          })
        }
        result.push({
          kind: 'constant' as const,
          lineage: operation.lineage,
          literal: 'undefined' as const,
          text: 'undefined',
          result: operation.result
        })
        return result
      })
      const block = { ...original, operations }
      blocks.set(blockId, block)
      if (protectedFlow || block.terminator.kind !== 'branch') continue
      const truth = facts.get(block.terminator.condition.value)
      if (truth === undefined) continue
      blocks.set(blockId, {
        ...block,
        terminator: {
          kind: 'jump',
          lineage: block.terminator.lineage,
          target: truth ? block.terminator.whenTrue : block.terminator.whenFalse
        }
      })
      changed = true
    }
    if (!changed) continue
    // Replacing a proven, non-throwing lookup does not change any region's
    // control flow. Keep that operation-level simplification even when this
    // pass cannot yet remove the region's exceptional or cleanup edges.
    if (protectedFlow) {
      output.set(id, { ...body, blocks, values: expandedValues })
      changedAny = true
      continue
    }
    const live = new Set([body.entry])
    const pending = [body.entry]
    while (pending.length) {
      const block = blocks.get(pending.pop()!)!
      for (const target of successorsOfTerminator(block.terminator))
        if (!live.has(target)) {
          live.add(target)
          pending.push(target)
        }
    }
    const retained = new Map<typeof body.entry, IrBlock>()
    const values = new Map<IrValueId, Representation>()
    for (const blockId of body.blockOrder) {
      if (!live.has(blockId)) {
        removedBlocks.add(blockId)
        continue
      }
      const block = blocks.get(blockId)!
      const next: IrBlock = {
        ...block,
        operations: block.operations.map((operation) =>
          operation.kind === 'phi'
            ? {
                ...operation,
                incoming: operation.incoming.filter(
                  (edge) => live.has(edge.block) && successorsOfTerminator(blocks.get(edge.block)!.terminator).includes(blockId)
                )
              }
            : operation
        )
      }
      retained.set(blockId, next)
      for (const operation of allOperationsOf(next)) {
        const result = resultOfIrOperation(operation)
        if (result) values.set(result.id, result.representation)
      }
    }
    const pruned = { ...body, blocks: retained, blockOrder: body.blockOrder.filter((block) => live.has(block)), values }
    const violations = verifyIrBody(pruned)
    if (violations.length) throw new Error(`Proven branch pruning produced invalid IR: ${JSON.stringify(violations)}`)
    output.set(id, pruned)
    changedAny = true
  }
  // Lowering records failed slot conversions before this CFG exists. Drop
  // only rows attached to blocks this pass has proved unreachable; unrelated
  // and surviving failures still reach the unchanged certification guard.
  return {
    bodies: changedAny ? output : bodies,
    slotDrift:
      removedBlocks.size || truncatedDrift.size
        ? slotDrift.filter((row) => !removedBlocks.has(row.block) && !truncatedDrift.get(row.block)?.has(row.operation))
        : slotDrift
  }
}
