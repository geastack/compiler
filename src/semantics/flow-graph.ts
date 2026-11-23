import ts from '#typescript'

// TypeScript exports its flow-graph flags at runtime but not in its
// declarations; the graph itself (`flowNode`) is likewise internal.
export const FlowFlags = (
  ts as unknown as {
    readonly FlowFlags: Readonly<
      Record<'Unreachable' | 'Start' | 'Label' | 'Assignment' | 'TrueCondition' | 'Condition' | 'SwitchClause', number>
    >
  }
).FlowFlags

export type Flow = {
  readonly flags: number
  readonly antecedent?: Flow
  readonly antecedents?: readonly Flow[]
  readonly node?: ts.Node
}

export const flowOf = (node: ts.Node): Flow | undefined => (node as unknown as { readonly flowNode?: Flow }).flowNode
