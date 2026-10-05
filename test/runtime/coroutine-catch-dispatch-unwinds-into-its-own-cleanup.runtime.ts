//! expect: plain:a:1 | async:a:2 | fallback-plain:fallback:1:boom | fallback-async:fallback:2:boom
//! emitted-has: {\n[[maybe_unused]] gea::detail::CoroutineCatchFence gea_catch_fence;\ntry {
// A try statement in an async body, with class references declared OUTSIDE it
// and reassigned after the body's last await: three's `NodeManager` builds a
// node builder and, when that throws, a fallback one from a fresh
// `NodeMaterial`, awaiting either build. Under funclet EH the handler dispatch
// unwinds into the cleanup of those references; once SROA gives that cleanup
// PHIs, LLVM's coroutine split rewires it through a dispatch block the PHIs'
// values do not dominate, and clang 22.1.3 -O2 crashed on this program
// (correlated-propagation on the `_task` twin's resume). This runner builds at
// -O0, so the crash is not what it can see: it pins the fence block that gives
// the dispatch a cleanup of its own (`gea::detail::CoroutineCatchFence`), and
// that every path through it still answers right.
const log: string[] = []

class Material {
  readonly name: string
  constructor(name: string) {
    this.name = name
  }
}

class Builder {
  steps = 0
  readonly material: Material
  private readonly failing: boolean
  constructor(material: Material, failing: boolean) {
    this.material = material
    this.failing = failing
  }
  build(): void {
    if (this.failing) throw new Error('boom')
    this.steps += 1
  }
  async buildAsync(): Promise<void> {
    await null
    if (this.failing) throw new Error('boom')
    this.steps += 2
  }
}

async function forRender(useAsync: boolean, failing: boolean): Promise<string> {
  let material = new Material('a')
  let builder = new Builder(material, failing)
  let note = ''
  try {
    if (useAsync) await builder.buildAsync()
    else builder.build()
  } catch (error) {
    material = new Material('fallback')
    builder = new Builder(material, false)
    if (useAsync) await builder.buildAsync()
    else builder.build()
    note = `:${(error as Error).message}`
  }
  log.push(material.name)
  return `${builder.material.name}:${builder.steps}${note}`
}

async function main(): Promise<void> {
  const plain = await forRender(false, false)
  const async = await forRender(true, false)
  const fallbackPlain = await forRender(false, true)
  const fallbackAsync = await forRender(true, true)
  console.log(`plain:${plain} | async:${async} | fallback-plain:${fallbackPlain} | fallback-async:${fallbackAsync}`)
}

main()
