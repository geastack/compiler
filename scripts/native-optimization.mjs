/**
 * The one authority for how a test's native build is optimized, and for how
 * the runtime reaches it.
 *
 * A level is chosen by what the program is there to prove, never written as a
 * literal at the call site:
 *
 *   correctness  the program prints the right answer or its assertions hold.
 *                -O0: the answer cannot depend on the optimizer, and -O0 is
 *                where clang spends least. On a sample of runtime programs
 *                -O1 compiled 2.4x slower than -O0 and -O2 2.7x slower.
 *   allocation   allocation-count and emitted-shape probes. Their counts were
 *                taken at -O1, and -O1 is where clang starts eliding the
 *                new/delete pairs those counts are about.
 *   optimized    probes of what the optimizer may assume (signed zero, NaN,
 *                strict aliasing over the runtime's own storage).
 *   aggressive   CPU proofs: the loop shapes a release build vectorizes.
 *   size         code-size probes.
 *
 * `GEA_NATIVE_RELEASE=1` is the release gate: every correctness build goes to
 * -O2, as one translation unit with the runtime inlined into it, which is how
 * a shipping program is built. Undefined behaviour and aliasing defects can
 * surface only there, so that mode exists to be run before a release, not on
 * every edit.
 */
export const nativeRelease = process.env.GEA_NATIVE_RELEASE === '1'

const levels = {
  correctness: nativeRelease ? '-O2' : '-O0',
  allocation: '-O1',
  optimized: '-O2',
  aggressive: '-O3',
  size: '-Os'
}

/** The optimization flags for a native build whose purpose is `purpose`. */
export const nativeOptimization = (purpose) => {
  const level = levels[purpose]
  if (level === undefined) throw new Error(`unknown native build purpose: ${purpose}`)
  return [level]
}

/**
 * How a correctness build reaches the runtime. `prebuilt` compiles the
 * runtime's code once per content key and links it into every program;
 * `single` compiles it into the program's own translation unit, which is what
 * benchmarks, devices and the release gate need -- the optimizer inlines the
 * runtime into the program only when it can see both. `GEA_NATIVE_RUNTIME`
 * overrides it.
 */
export const nativeRuntimeLayout = () => process.env.GEA_NATIVE_RUNTIME ?? (nativeRelease ? 'single' : 'prebuilt')

/**
 * Whether correctness builds share one precompiled runtime header. On unless
 * `GEA_NATIVE_PCH=0`, which with `GEA_NATIVE_RUNTIME=single` measures what the
 * shared artifacts save.
 */
export const nativePch = () => process.env.GEA_NATIVE_PCH !== '0'
