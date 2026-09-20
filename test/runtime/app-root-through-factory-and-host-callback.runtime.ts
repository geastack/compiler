// A three.js app's entry shape: a factory returns the app object, a module-level
// const holds it, and a host callback (requestAnimationFrame's frame function)
// drives it every frame. Every class method under the root is reached only
// through that const, so if its allocation origin is lost at the factory or at
// the host-held closure, every slot below it is open and the host-mutation
// census reads `*`.
declare function requestAnimationFrame(callback: (timestampMs: number) => void): number
declare const opaqueSink: { pushed?: unknown }

class Controls {
  x = 0
  poll(source: number): void {
    this.x = source
  }
}

class Game {
  distance = 0
  update(dt: number, controls: Controls): void {
    this.distance += dt * controls.x
  }
}

class App {
  private readonly game: Game
  constructor(width: number) {
    this.game = new Game()
    this.game.distance = width
  }
  update(dt: number, controls: Controls): void {
    this.game.update(dt, controls)
  }
  report(): number {
    return this.game.distance
  }
}

function createApp(width: number): App {
  return new App(width)
}

const app = createApp(JSON.parse('10'))
const controls = new Controls()
controls.poll(JSON.parse('2'))
// `frames` collides with the DOM lib's own ambient `Window.frames` global at
// this file's script scope (no import/export makes every top-level binding
// here a global, not a module local) and TS resolves the conflict onto the
// ambient declaration's type -- so the counter is named to not collide.
let frameCount = 0
requestAnimationFrame(function frame(timestampMs: number): void {
  app.update(timestampMs, controls)
  frameCount++
  if (frameCount < 3) requestAnimationFrame(frame)
})
app.update(5, controls)
console.log(app.report())
console.log(Object.keys(controls).length)
// The intended behavior is `20` then `1` -- traced by hand: `createApp(10)`
// builds `App` with `game.distance = 10`; the direct `app.update(5, controls)`
// adds `5 * controls.x` (`controls.x` is `2`, from `controls.poll(2)`) for
// `10 + 10 = 20`; `Object.keys(controls).length` is `1` (`x` is the only own
// key). Unverified here: `gea::host::requestAnimationFrame` is declared by the
// runtime (`gea_runtime.h`) but only ever DEFINED by a real platform bridge
// (the web/native-webgl-angle target such an app links against) -- this
// generic runner links no host at all, the same gap `compile-only`'s own doc
// comment names for a JSX program needing a real document. The
// census/certification proof this file exists to pin is exactly what
// `--compile-only` checks (`clang -fsyntax-only` over the emitted C++, with
// zero boxing and zero `origin-slot-open`/`member-slot-open` refusals) --
// `expect:` lines are meaningless on a program this runner cannot link, so
// none are stated (matching every other `compile-only` program in this suite).
//! compile-only
