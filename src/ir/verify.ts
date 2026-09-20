import type { IrValueId } from '../identity/ids.js'
import { dynamicReasons, representationKey, walkRepresentation } from '../representation/model.js'
import {
  atBlockExit,
  buildControlFlowGraph,
  buildDominatorTree,
  collectDefinitionSites,
  isVisible,
  type ControlFlowGraph,
  type DefinitionSite,
  type DominatorTree
} from './dominance.js'
import { allOperationsOf, terminatorKinds, type IrBlockId, type IrBody } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import { nativeEqualityOf } from './native-equality.js'

/**
 * Fail-closed guards over one IR body.
 *
 * Every guard here describes a state that would otherwise compile into a
 * silently wrong or undefined program: a dangling reference, a phi that
 * disagrees with its own predecessors, a carrier that never got selected. A
 * guard firing is always correct; the defect is in whatever produced the
 * body, never in the guard (mirrors `representation/verify.ts`).
 */

export interface IrViolation {
  readonly guard: string
  readonly value: IrValueId | null
  readonly block: IrBlockId | null
  readonly message: string
}

const violation = (guard: string, value: IrValueId | null, block: IrBlockId | null, message: string): IrViolation => ({
  guard,
  value,
  block,
  message
})

/**
 * `IrBlock.terminator` is a required field, so "missing" and "not last" are
 * unrepresentable through the ordinary builder path. Both checks stay here
 * anyway: nothing stops an unsafe cast from handing `verify` a body that was
 * never built through `createIrBodyBuilder`.
 */
const terminatorGuard = (body: IrBody): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  const known = new Set<string>(terminatorKinds)
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    if (!block.terminator || !known.has(block.terminator.kind)) {
      violations.push(violation('block-missing-terminator', null, blockId, `block ${blockId} has no valid terminator`))
    }
    block.operations.forEach((operation, index) => {
      // `operations` is typed to exclude terminator kinds, so this can only fire against a body that
      // reached here through an unsafe cast rather than `createIrBodyBuilder` -- exactly the case this
      // defensive check exists for.
      if (known.has(operation.kind)) {
        violations.push(
          violation(
            'terminator-not-last',
            null,
            blockId,
            `block ${blockId} holds a ${operation.kind} operation at position ${index}, ahead of the block's actual terminator`
          )
        )
      }
    })
  }
  return violations
}

/** Every block a terminator or a phi names must actually exist in this body. */
const jumpTargetGuard = (body: IrBody): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  const requireKnown = (target: IrBlockId, from: IrBlockId, describe: string): void => {
    if (!body.blocks.has(target))
      violations.push(violation('jump-to-unknown-block', null, from, `${describe} names unknown block ${target}`))
  }
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    const terminator = block.terminator
    switch (terminator.kind) {
      case 'branch':
        requireKnown(terminator.whenTrue, blockId, `branch in block ${blockId} (when-true)`)
        requireKnown(terminator.whenFalse, blockId, `branch in block ${blockId} (when-false)`)
        break
      case 'jump':
        requireKnown(terminator.target, blockId, `jump in block ${blockId}`)
        break
      case 'switch':
        terminator.cases.forEach((switchCase, index) =>
          requireKnown(switchCase.target, blockId, `switch in block ${blockId} (case ${index})`)
        )
        requireKnown(terminator.defaultTarget, blockId, `switch in block ${blockId} (default)`)
        break
      case 'return':
      case 'throw':
        break
    }
    for (const operation of block.operations) {
      if (operation.kind !== 'phi') continue
      for (const edge of operation.incoming) requireKnown(edge.block, blockId, `phi ${operation.result.id} in block ${blockId}`)
    }
  }
  return violations
}

/** No SSA value may be defined at more than one site in one body. */
const definitionUniquenessGuard = (body: IrBody): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  for (const [id, occurrences] of collectDefinitionSites(body)) {
    if (occurrences.length <= 1) continue
    violations.push(
      violation(
        'value-defined-twice',
        id,
        null,
        `value ${id} is defined ${occurrences.length} times, at ${occurrences.map((o) => `${o.block}#${o.position}`).join(', ')}`
      )
    )
  }
  return violations
}

/**
 * Every value-producing operation must cite the semantic result it lowers; an
 * empty lineage there is a producer defect, not an unresolved fact. A
 * terminator may carry none, and only because a body that ends implicitly has
 * no semantic operation for its end to point at.
 */
const lineageGuard = (body: IrBody): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    block.operations.forEach((operation, index) => {
      if (operation.lineage) return
      violations.push(
        violation(
          'operation-missing-lineage',
          resultOfIrOperation(operation)?.id ?? null,
          blockId,
          `operation ${operation.kind} at ${blockId}#${index} carries no semantic-result lineage`
        )
      )
    })
  }
  return violations
}

/**
 * `values` is a derived index over the authoritative per-operation results,
 * kept for O(1) lookup exactly like `SemanticGraph.results` is kept over
 * `operations`. This is the same cross-check `graph.ts` runs: the index must
 * agree with its source and must not contain an entry the source never
 * produced.
 */
const valuesIndexGuard = (body: IrBody): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  const declared = new Set<IrValueId>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of allOperationsOf(block)) {
      const result = resultOfIrOperation(operation)
      if (!result) continue
      declared.add(result.id)
      const indexed = body.values.get(result.id)
      if (indexed === undefined) {
        violations.push(
          violation('value-missing-from-index', result.id, blockId, `value ${result.id} is defined but absent from the body's value index`)
        )
      } else if (representationKey(indexed) !== representationKey(result.representation)) {
        violations.push(
          violation(
            'value-index-disagrees-with-definition',
            result.id,
            blockId,
            `value ${result.id} is indexed as ${representationKey(indexed)} but its defining operation selected ${representationKey(result.representation)}`
          )
        )
      }
    }
  }
  for (const id of body.values.keys()) {
    if (!declared.has(id))
      violations.push(
        violation('value-index-orphan', id, null, `value ${id} appears in the body's value index but no operation defines it`)
      )
  }
  return violations
}

/**
 * An operand's declared carrier must equal its definition's. A phi's incoming
 * values must additionally equal the phi's own result: a phi is one value
 * merged from several paths, so an incoming arm with a different carrier
 * would make the merge itself observationally meaningless.
 */
const representationConsistencyGuard = (body: IrBody): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of allOperationsOf(block)) {
      for (const operand of operandsOfIrOperation(operation)) {
        const defined = body.values.get(operand.value)
        if (defined === undefined) continue // reported by the definition-visibility guard instead
        if (representationKey(defined) === representationKey(operand.representation)) continue
        violations.push(
          violation(
            'operand-representation-disagrees-with-definition',
            operand.value,
            blockId,
            `operand referencing ${operand.value} in a ${operation.kind} operation expects ${representationKey(operand.representation)} but its definition selected ${representationKey(defined)}`
          )
        )
      }
      if (operation.kind !== 'phi') continue
      for (const edge of operation.incoming) {
        if (representationKey(edge.value.representation) === representationKey(operation.result.representation)) continue
        violations.push(
          violation(
            'phi-incoming-representation-disagrees-with-result',
            operation.result.id,
            blockId,
            `phi ${operation.result.id} selected ${representationKey(operation.result.representation)} but its incoming value from ${edge.block} carries ${representationKey(edge.value.representation)}`
          )
        )
      }
    }
  }
  return violations
}

/** A phi's incoming edges must name exactly the block's predecessors -- no fewer, no more, no duplicates. */
const phiPredecessorGuard = (body: IrBody, graph: ControlFlowGraph): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    const predecessors = new Set(graph.predecessors.get(blockId) ?? [])
    for (const operation of block.operations) {
      if (operation.kind !== 'phi') continue
      const incomingBlocks = operation.incoming.map((edge) => edge.block)
      const incomingSet = new Set(incomingBlocks)
      if (incomingSet.size !== incomingBlocks.length) {
        violations.push(
          violation(
            'phi-duplicate-predecessor',
            operation.result.id,
            blockId,
            `phi ${operation.result.id} in block ${blockId} names the same predecessor more than once`
          )
        )
      }
      const missing = [...predecessors].filter((p) => !incomingSet.has(p))
      const extra = [...incomingSet].filter((p) => !predecessors.has(p))
      if (missing.length === 0 && extra.length === 0) continue
      violations.push(
        violation(
          'phi-incoming-mismatches-predecessors',
          operation.result.id,
          blockId,
          `phi ${operation.result.id} in block ${blockId} has predecessors {${[...predecessors].join(', ')}} but incoming edges {${[...incomingSet].join(', ')}}` +
            `${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; unexpected ${extra.join(', ')}` : ''}`
        )
      )
    }
  }
  return violations
}

/**
 * A use is legal only when its definition dominates it: earlier in the same
 * block, or in a block that dominates the using block. A phi's incoming value
 * is checked against its predecessor's exit rather than the phi's own block,
 * because that is the point in the program where the value must exist.
 */
const usedBeforeDefinedGuard = (body: IrBody, graph: ControlFlowGraph): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  const sites = collectDefinitionSites(body)
  const firstSiteOf = (id: IrValueId): DefinitionSite | null => sites.get(id)?.[0] ?? null

  let dominance: DominatorTree
  try {
    dominance = buildDominatorTree(body, graph)
  } catch (error) {
    return [
      violation(
        'dominance-computation-failed',
        null,
        null,
        `dominance computation over body ${body.owner} failed: ${(error as Error).message}`
      )
    ]
  }

  const checkOperand = (id: IrValueId, useBlock: IrBlockId, usePosition: number, describe: string): void => {
    const site = firstSiteOf(id)
    if (!site) {
      violations.push(violation('value-used-before-defined', id, useBlock, `${describe} reads ${id}, which is never defined in this body`))
      return
    }
    if (!isVisible(site, useBlock, usePosition, dominance)) {
      violations.push(
        violation(
          'value-used-before-defined',
          id,
          useBlock,
          `${describe} reads ${id}, but its definition at ${site.block}#${site.position} does not dominate this use`
        )
      )
    }
  }

  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    if (!dominance.reachable.has(blockId)) continue // dead code makes no ordering claim on the entry path to verify

    block.operations.forEach((operation, index) => {
      if (operation.kind === 'phi') {
        for (const edge of operation.incoming)
          checkOperand(
            edge.value.value,
            edge.block,
            atBlockExit,
            `phi ${operation.result.id} in block ${blockId} from predecessor ${edge.block}`
          )
        return
      }
      for (const operand of operandsOfIrOperation(operation))
        checkOperand(operand.value, blockId, index, `operation ${operation.kind} at ${blockId}#${index}`)
    })

    const terminatorPosition = block.operations.length
    for (const operand of operandsOfIrOperation(block.terminator))
      checkOperand(operand.value, blockId, terminatorPosition, `terminator ${block.terminator.kind} of block ${blockId}`)
  }
  return violations
}

/** `unresolved` is lattice bottom and `dynamic` is legitimate only for the four declared reasons -- both must never reach a materialized IR value. */
const representationValidityGuard = (body: IrBody): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  const permitted = new Set<string>(dynamicReasons)
  for (const [id, representation] of body.values) {
    for (const found of walkRepresentation(representation)) {
      if (found.kind === 'unresolved') {
        violations.push(
          violation('unresolved-reaches-materialization', id, null, `value ${id} selected a carrier containing unresolved(${found.reason})`)
        )
      }
      if (found.kind === 'dynamic' && !permitted.has(found.reason)) {
        violations.push(
          violation(
            'boxed-without-declared-reason',
            id,
            null,
            `value ${id} selected dynamic carrier with undeclared reason "${found.reason}"`
          )
        )
      }
    }
  }
  return violations
}

/** A boxed Function may enter native bind only with the exact declaration identity semantics proved for it. */
const bindCallableIdentityGuard = (body: IrBody): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      if (operation.kind !== 'bind-callable' || operation.source.representation.kind !== 'dynamic') continue
      if (operation.source.representation.reason !== 'opt-in-fallback') {
        violations.push(
          violation(
            'dynamic-bind-source-reason',
            operation.source.value,
            blockId,
            'a dynamic bind source is not an authenticated opt-in Function object'
          )
        )
      }
      if (operation.sourceFunctionId === null) {
        violations.push(
          violation(
            'dynamic-bind-source-identity',
            operation.source.value,
            blockId,
            'a dynamic bind source carries no checker-authenticated FunctionId'
          )
        )
      }
    }
  }
  return violations
}

/** Iterator-close regions are executable IR boundaries, so their carrier and blocks are checked like ordinary operands and jumps. */
const iteratorCloseRegionGuard = (body: IrBody): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  const entries = new Set<IrBlockId>()
  for (const region of body.iteratorCloseRegions ?? []) {
    if (
      region.iterator.representation.kind !== 'dynamic' &&
      region.iterator.representation.kind !== 'record' &&
      region.iterator.representation.kind !== 'native-record-ref' &&
      region.iterator.representation.kind !== 'iterator'
    ) {
      violations.push(
        violation(
          'iterator-close-region-carrier',
          region.iterator.value,
          region.entry,
          'IteratorClose region does not carry a dynamic, concrete record, or generator iterator'
        )
      )
    }
    if (!body.blocks.has(region.entry) || !region.blocks.includes(region.entry)) {
      violations.push(
        violation(
          'iterator-close-region-entry',
          region.iterator.value,
          region.entry,
          'IteratorClose region entry is not one of its known blocks'
        )
      )
    }
    for (const target of region.dismissTargets)
      if (!body.blocks.has(target)) {
        violations.push(
          violation(
            'iterator-close-region-continuation',
            region.iterator.value,
            target,
            'IteratorClose region names an unknown normal-completion target'
          )
        )
      }
    for (const block of region.blocks)
      if (!body.blocks.has(block)) {
        violations.push(
          violation('iterator-close-region-block', region.iterator.value, block, 'IteratorClose region names an unknown body block')
        )
      }
    if (entries.has(region.entry))
      violations.push(
        violation('iterator-close-region-entry', region.iterator.value, region.entry, 'two IteratorClose regions share one entry')
      )
    entries.add(region.entry)
    const defined = body.values.get(region.iterator.value)
    if (!defined || representationKey(defined) !== representationKey(region.iterator.representation)) {
      violations.push(
        violation(
          'iterator-close-region-operand',
          region.iterator.value,
          region.entry,
          'IteratorClose region iterator is not a defined matching SSA value'
        )
      )
    }
  }
  return violations
}

const nativeEqualityGuard = (body: IrBody): readonly IrViolation[] => {
  const violations: IrViolation[] = []
  for (const operation of [...body.blocks.values()].flatMap((block) => allOperationsOf(block))) {
    if (operation.kind !== 'compute' || !operation.nativeEquality) continue
    const recipe = operation.nativeEquality
    const expected = nativeEqualityOf(operation.operator, operation.operands)
    if (
      expected === null ||
      (operation.form !== 'equality' && operation.form !== 'binary') ||
      expected.dynamicOperand !== recipe.dynamicOperand ||
      expected.primitive !== recipe.primitive ||
      expected.negate !== recipe.negate ||
      operation.result.representation.kind !== 'scalar' ||
      operation.result.representation.domain !== 'boolean'
    )
      violations.push(
        violation('native-equality-recipe', operation.result.id, null, 'strict equality recipe disagrees with its operands or result')
      )
  }
  return violations
}

/** Run every guard and return the complete violation set, never just the first. */
export const verifyIrBody = (body: IrBody): readonly IrViolation[] => {
  const graph = buildControlFlowGraph(body)
  return [
    ...terminatorGuard(body),
    ...jumpTargetGuard(body),
    ...definitionUniquenessGuard(body),
    ...lineageGuard(body),
    ...valuesIndexGuard(body),
    ...representationConsistencyGuard(body),
    ...phiPredecessorGuard(body, graph),
    ...usedBeforeDefinedGuard(body, graph),
    ...representationValidityGuard(body),
    ...bindCallableIdentityGuard(body),
    ...iteratorCloseRegionGuard(body),
    ...nativeEqualityGuard(body)
  ].sort((left, right) => {
    if (left.guard !== right.guard) return left.guard.localeCompare(right.guard)
    return String(left.value ?? left.block ?? '').localeCompare(String(right.value ?? right.block ?? ''))
  })
}
