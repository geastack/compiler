//! expect: wood gl 2|stone gl 2|loose gl|copied gl 2|TypeError
//! emitted-has: gea::host::frameArgumentClassRef<
// A method slot's frame is the join of every function stored into it: one
// hook declaring `renderer: Renderer` beside another taking `renderer: any`
// gives the slot `Renderer | any`, which TypeScript admits through method
// parameter bivariance. Reading the typed hook back out of the slot (to call
// it, or to store it on another object, three's
// `material.onBeforeCompile = other.onBeforeCompile`) adapts its frame to the
// slot's: the union argument is dispatched on its live arm -- the instance
// passes as itself (no conversion), an `any` holding one unboxes to it, and an
// `any` holding anything else is a catchable TypeError -- the frame's class
// check, never the unbox's abort. (JS throws a TypeError there too: the typed
// body reads `renderer.name.length` off a value with no `name`.)
class Renderer {
  name = 'gl'
}
class Shader {
  constructor(readonly source: string) {}
}
class Material {
  onBeforeCompile(shader: Shader, renderer: Renderer): void {}
}
const out: string[] = []
const typed = new Material()
typed.onBeforeCompile = (shader: Shader, renderer: Renderer) => {
  out.push(`${shader.source} ${renderer.name} ${renderer.name.length}`)
}
const loose = new Material()
loose.onBeforeCompile = (shader: Shader, renderer: any) => {
  out.push(`${shader.source} ${renderer.name}`)
}
const copied = new Material()
copied.onBeforeCompile = typed.onBeforeCompile
typed.onBeforeCompile(new Shader('wood'), new Renderer())
const anyRenderer: any = new Renderer()
typed.onBeforeCompile(new Shader('stone'), anyRenderer)
loose.onBeforeCompile(new Shader('loose'), new Renderer())
copied.onBeforeCompile(new Shader('copied'), new Renderer())
try {
  const stranger: any = { label: 'not a renderer' }
  copied.onBeforeCompile(new Shader('stranger'), stranger)
  out.push('accepted')
} catch (error) {
  out.push(error instanceof TypeError ? 'TypeError' : 'other')
}
console.log(out.join('|'))
