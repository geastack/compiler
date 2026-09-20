// `a?.b` is two values, not one: the property, read only where the receiver was
// present, and what the whole expression evaluates to, which is that property on
// one branch and `undefined` on the other. The second is a merge over the
// presence test, and these cases exist to keep it honest -- consumed directly,
// consumed by `??`, and nested, where the inner chain's merge is itself the
// outer chain's receiver.
interface Point {
  x: number
  label: string
}

interface Options {
  point?: Point
  name?: string
}

interface Wrapper {
  options?: Options
}

export function pointX(options: Options): number {
  return options.point?.x ?? 0
}

export function pointLabel(options: Options): string | undefined {
  return options.point?.label
}

export function nameOrDefault(options: Options): string {
  return options.name ?? 'anonymous'
}

// The absent branch is reached without the present one ever running, so the
// merged carrier has to be the optional itself rather than the payload.
export function missing(): number {
  const empty: Options = {}
  return pointX(empty)
}

export function nestedName(wrapper: Wrapper): string {
  return wrapper.options?.name ?? 'none'
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = pointX({}) + missing() + nameOrDefault({}).length + nestedName({}).length + (pointLabel({}) ?? '').length
