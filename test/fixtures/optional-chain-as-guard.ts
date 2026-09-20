interface Options {
  mirror?: boolean
}

const a = (): number => 1
const b = (): number => 2
const ready = (): boolean => true

// An optional chain whose own short-circuit result is the *guard* of a merge.
// The chain's value is itself a merge over the chain's presence guard, so it is
// only settled once that guard has closed -- which happens while the ternary's
// own guard is being opened, not after.
export const pick = (options?: Options): number => (options?.mirror ? a() : b())

export const gated = (options?: Options): boolean | undefined => options?.mirror && ready()

export const defaulted = (options?: Options): boolean => options?.mirror ?? false

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = pick({}) + (gated({}) === true ? 1 : 0) + (defaulted({}) ? 1 : 0)
