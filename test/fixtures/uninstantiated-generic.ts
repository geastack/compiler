// A generic nothing instantiates. Its body has no meaning until something fills
// the hole, so the census walks it not at all -- exactly as a C++ template
// nobody instantiates emits nothing. Walking it once with the hole open would
// publish an allocation whose carrier *is* the hole, which representation then
// refuses; one uncalled generic in a shared module would deny a whole program
// its certificate.
export function unused<Held>(value: Held): Held {
  return value
}

// The same shape, instantiated, so the copy really is emitted.
function identity<Held>(value: Held): Held {
  return value
}

export function run(): number {
  return identity(7)
}

export function label(): string {
  return identity('seven')
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = run() + label().length
