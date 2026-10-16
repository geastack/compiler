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

/** Original implementation selected by this frontend's module authority. This
 * is provenance, not permission to claim a library protocol by package name. */
export interface SourceTransformModule {
  readonly fileName: string
  readonly text: string
  readonly declarationFileName: string | undefined
  /** Resolve an import of this selected module through the same frontend. */
  readonly resolveSource?: SourceTransformResolver
  /** Canonical source binding only; the final checker must authenticate symbols. */
  readonly resolveExport?: (name: string) => SourceTransformExport | null
  readonly packageManifest: { readonly fileName: string; readonly text: string } | null
}

export interface SourceTransformExport {
  readonly module: SourceTransformModule
  readonly localName: string
  /** The terminal module may export a private local under a different name. */
  readonly exportedName: string
}

export type SourceTransformResolver = (specifier: string) => SourceTransformModule | null

export type SourceTransform = (input: {
  readonly fileName: string
  readonly text: string
  readonly declarationFileName?: string
}) => string | SourceTransformOutput | null
