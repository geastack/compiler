declare const __gea_Panel: {
  width: number
  start(): void
}

export const Panel = typeof __gea_Panel !== 'undefined' ? __gea_Panel : (undefined as unknown as typeof __gea_Panel)

export function panelWidth(): number {
  return Panel.width
}

// Called at module scope, deliberately. `ir/shake.ts` keeps a function body
// only through a kept CALL, so a fixture that declares and never calls is
// certified and then shaken away -- it emits an empty translation unit, and
// the corpus's `compiles` column reports `yes` for C++ that contains none of
// what the fixture is about.
export const probe = panelWidth()
