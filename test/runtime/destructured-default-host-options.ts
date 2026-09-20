// A stand-in for three.js's `WebGLRenderer` options bag: `constructor(parameters
// = {}) { const { canvas = createCanvasElement(), context = null, ... } =
// parameters }`, where the destructured field has a default but every real
// call site's literal states the field outright.
//
// `source-value-session.ts`'s 'binding-element' query used to refuse a
// defaulted destructuring element UNCONDITIONALLY (`fail('defaulted-binding-
// element', ...)`), regardless of whether the default could ever run. That
// made the allocation origin of `context` here unenumerable no matter what
// the caller wrote, which is exactly the shape that left three's `_gl` --
// and every native WebGL call reached through it -- a wildcard. This proves
// the shape still runs correctly once the proof can see through a literal
// that always supplies the key, and that the default itself still runs on
// the arm that actually omits it.

class Ctx {
  private readonly label: string
  constructor(label: string) {
    this.label = label
  }
  describe(): string {
    return 'ctx:' + this.label
  }
}

let fallbackCalls = 0
const fallbackCtx = (): Ctx => {
  fallbackCalls += 1
  return new Ctx('fallback')
}

interface RendererOptions {
  context?: Ctx
  depth?: boolean
}

const describeRenderer = (options: RendererOptions): string => {
  const { context = fallbackCtx(), depth = true } = options
  return context.describe() + '/' + depth
}

//! expect: supplied=ctx:primary/true
console.log('supplied=' + describeRenderer({ context: new Ctx('primary') }))
//! expect: supplied-calls=0
console.log('supplied-calls=' + fallbackCalls)

//! expect: omitted=ctx:fallback/false
console.log('omitted=' + describeRenderer({ depth: false }))
//! expect: omitted-calls=1
console.log('omitted-calls=' + fallbackCalls)
