// Unions with no shared literal discriminant: the arm-index tagged-union
// fallback. Neither union below has a required literal property that all arms
// share, so `discriminantOf` can never fire -- this is the construct that
// exhausts it, not `Shape` in spread.ts (which does have a `kind` literal).

// Two unrelated primitives: no record shape at all to look for a discriminant in.
export type Loose = string | number

export const widen = (flag: boolean): Loose => (flag ? 'text' : 1)

// Two record shapes with disjoint keys and no shared tag.
export interface Circle2 {
  radius: number
}

export interface Square2 {
  side: number
}

export type Loose2 = Circle2 | Square2

export const identity = (shape: Loose2): Loose2 => shape

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const widened = widen(true)
export const kept = identity({ radius: 2 })
