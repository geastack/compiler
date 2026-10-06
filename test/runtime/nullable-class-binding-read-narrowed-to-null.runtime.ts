// A `let` declared `C | null` and initialized to null is read where the
// checker's flow type has narrowed it to `null`, as an argument whose
// parameter is `C | null`. The binding's storage is the nullable class
// reference; the read must hand that storage over, not ask for a conversion
// from the class reference to the `null` type.
class Mesh {
  name = 'mesh'
}
class Instanced extends Mesh {
  count = 3
}
class Skinned extends Mesh {
  bones = 2
}
function push(instanced: Instanced | null, skinned: Skinned | null): string {
  return `${instanced === null ? 'none' : instanced.count} ${skinned === null ? 'none' : skinned.bones}`
}
function project(object: Mesh, early: boolean): string {
  let instanced: Instanced | null = null
  let skinned: Skinned | null = null
  if (early) {
    return push(instanced, skinned)
  }
  if (object instanceof Instanced) {
    instanced = object
  } else if (object instanceof Skinned) {
    skinned = object
  }
  return push(instanced, skinned)
}
console.log(project(new Mesh(), true), project(new Instanced(), false), project(new Skinned(), false), project(new Mesh(), false))
//! expect: none none 3 none none 2 none none
export {}
