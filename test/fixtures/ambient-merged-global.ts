// An ambient global declared twice -- `interface Math` for the type and
// `declare var Math: Math` for the value -- is ONE symbol with TWO
// declarations, and the two answer different questions. The structural walk
// anchors nominal shapes on the first; a name in value position reads the
// second. Resolving both through one function returns the interface whenever
// it sorts first (it does, for `Math`, `Error`, `Date` and `JSON` in
// lib.es5.d.ts), which mints a binding read against a declaration nothing
// introduces: preflight certifies, and emission then refuses the read by name.
export const cube = (edge: number): number => Math.pow(edge, 3)

export const hypotenuse = (a: number, b: number): number => Math.sqrt(a * a + b * b)

// Called at module scope so the bodies are emitted rather than shaken away --
// see `ambient-global-guard.ts` for why every fixture ends this way.
export const probe = cube(3) + hypotenuse(3, 4)
