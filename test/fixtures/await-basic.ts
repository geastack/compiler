// A minimal, isolated exercise of `await` alone -- no iterator protocol, no
// `try`/`catch`, no host boundary -- so this backend's async/await lowering
// can be measured on its own, apart from every other unbuilt feature a real
// application also happens to use alongside it. See `runtime/gea_runtime.h`'s
// `Promise` doc comment for why this backend's `await` reads a settled value
// immediately rather than modeling a real suspension.

export const settleNumber = async (values: readonly number[]): Promise<number> => {
  const total = await Promise.resolve(values.length)
  return total
}

export const settleVoid = async (): Promise<void> => {
  await Promise.resolve()
}

// `await` on an operand that is not itself a `Promise` -- valid TypeScript,
// and `Awaited<T>` is `T` unchanged for a non-thenable `T` -- so this must
// lower as a plain pass-through, not a `.awaited()` call on a carrier that
// has no such method.
export const settlePlain = async (value: number): Promise<number> => {
  const doubled = await (value * 2)
  return doubled
}

export const runSettles = async (): Promise<number> => {
  const first = await settleNumber([1, 2, 3])
  await settleVoid()
  const second = await settlePlain(first)
  return second
}

// A concise arrow body that is itself the `await` expression, rather than a
// block containing one -- `census.ts` calls this out by name as a shape it
// handles specially.
export const runConcise = async (value: number): Promise<number> => await settlePlain(value)

// Called at module scope so the bodies are emitted rather than shaken away.
export const probeSettles = runSettles()
export const probeConcise = runConcise(2)
