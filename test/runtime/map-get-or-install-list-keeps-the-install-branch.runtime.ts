//! expect: hooks=2,1
//! expect: calls=a1,a2,b1
//! expect: compiled=m1,m2
// `let list = hooks.get(key); if (!list) { ...install...; hooks.set(key, installed) }
// list.push(hook)`: the install branch runs on the first use of each key.
// `Map.prototype.get` completes `undefined` for a key no `set` stored, so the
// `!list` guard is not decided by the stored arrays alone. The branch was
// dropped, so the first push read an absent list and aborted.

class Scene {
  name: string
  onBeforeRender: (() => void) | undefined
  constructor(name: string) {
    this.name = name
  }
}
type Hook = () => string
const hooks = new Map<Scene, Hook[]>()
const calls: string[] = []
function addHook(scene: Scene, hook: Hook): void {
  let list = hooks.get(scene)
  if (!list) {
    const installed: Hook[] = []
    list = installed
    hooks.set(scene, installed)
    scene.onBeforeRender = () => {
      for (const h of installed) calls.push(h())
    }
  }
  list.push(hook)
}
const a = new Scene('a')
const b = new Scene('b')
addHook(a, () => 'a1')
addHook(a, () => 'a2')
addHook(b, () => 'b1')
a.onBeforeRender?.()
b.onBeforeRender?.()
console.log('hooks=' + hooks.get(a)?.length + ',' + hooks.get(b)?.length)
console.log('calls=' + calls.join(','))

// The same shape over a WeakMap, as a material's compile hooks.
class Material {
  onBeforeCompile: (() => void) | undefined
}
type CompileHook = () => string
const compileHooks = new WeakMap<Material, CompileHook[]>()
const compiled: string[] = []
function addCompileHook(material: Material, hook: CompileHook): void {
  let list = compileHooks.get(material)
  if (!list) {
    const installed: CompileHook[] = []
    list = installed
    compileHooks.set(material, installed)
    material.onBeforeCompile = () => {
      for (const h of installed) compiled.push(h())
    }
  }
  list.push(hook)
}
const m = new Material()
addCompileHook(m, () => 'm1')
addCompileHook(m, () => 'm2')
m.onBeforeCompile?.()
console.log('compiled=' + compiled.join(','))
