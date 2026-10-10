/** A text rewrite may remove the original intrinsic reads. These are
 * mandatory assumptions to discharge on the final source mutation ledger,
 * never permissions inferred from the replacement spelling. */
export type SourceTransformProtocol =
  | { readonly intrinsic: 'Object'; readonly member: string; readonly prototypeKeys?: never }
  | { readonly intrinsic: 'Object' | 'Function'; readonly prototypeKeys: readonly string[]; readonly member?: never }
  | { readonly intrinsic: 'Object' | 'Function'; readonly callablePrototypeMember: string; readonly ownKeys: readonly string[] }

export interface SourceTransformOutput {
  readonly protocolVersion: 1
  readonly text: string
  readonly protocols: readonly SourceTransformProtocol[]
}

export type SourceTransform = (input: {
  readonly fileName: string
  readonly text: string
  readonly declarationFileName?: string
}) => string | SourceTransformOutput | null
