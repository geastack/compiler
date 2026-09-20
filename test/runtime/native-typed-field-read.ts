class Geometry {
  value = 7
}

class ObjectBase {
  visible = true
}

class Mesh extends ObjectBase {
  geometry = new Geometry()
}

function geometryOf(object: ObjectBase & { geometry: Geometry }): Geometry {
  return object.geometry
}

function render(object: ObjectBase): number {
  return geometryOf(object as ObjectBase & { geometry: Geometry }).value
}

const mesh = new Mesh()
let total = 0
for (let i = 0; i < 10000; ++i) total += render(mesh)
console.log(total)
mesh.geometry = new Geometry()
mesh.geometry.value = 11
console.log(render(mesh))

let getterReads = 0
const getter = {
  get geometry() {
    ++getterReads
    return mesh.geometry
  }
}
function readGetter(key: string): Geometry {
  return (getter as any)[key] as Geometry
}
console.log(readGetter('geometry').value, getterReads)
