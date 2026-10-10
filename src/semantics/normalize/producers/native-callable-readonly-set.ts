import type ts from 'typescript'
import type { NativeCallableReadonlySetSource } from '../../native-callable-readonly-set.js'
import type { OperandSource } from '../../model/operands.js'
import type { ProducerContext } from '../producer-context.js'
import { sourceForValue } from './shared.js'

/** Publication consumes only the sealed source temporal proof. */
export const nativeCallableReadonlySetSourceOf = (
  context: ProducerContext,
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  receiver: OperandSource,
  key: OperandSource
): NativeCallableReadonlySetSource | null => {
  const proof = context.readonlyCallableSetAt?.(node)
  if (!proof || proof.access !== node || receiver.kind !== 'result' || proof.keys.length === 0) return null
  const sources: NativeCallableReadonlySetSource['sources'][number][] = []
  for (const method of proof.sources) {
    const source = sourceForValue(context, method.access)
    if (source.kind !== 'result') return null
    sources.push({ read: source.result, declaration: context.identities.declarationIdOf(method.declaration), member: method.member })
  }
  const entries = proof.entries.map((call) => sourceForValue(context, call))
  if (sources.length === 0 || entries.some((entry) => entry.kind !== 'result')) return null
  return {
    receiver: receiver.result,
    key,
    keys: proof.keys,
    sources,
    entries: entries.flatMap((entry) => (entry.kind === 'result' ? [entry.result] : []))
  }
}
