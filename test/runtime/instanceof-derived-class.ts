// `x instanceof Derived` where `x` is declared at a BASE class is the one
// question `instanceof` exists to answer, and the emitter answered it at
// compile time from the handle's STATIC class -- which says nothing, because
// a `gea::Ref<Base>` may hold any descendant. It rendered the constant
// `false`, so three's `Object3D.traverse( part => { if ( part instanceof Mesh )
// ... } )` compiled, linked, ran, and skipped every branch: the three.js app's whole
// shadow rig did nothing.
//
// The test is now a read of the handle's own allocated type
// (`instanceOfClassFamilyRef`), and the reads past the guard are a checked
// downcast (`downcastClassRef`) -- a pairing `conversion/build.ts` had never
// proposed, since its class-ref loop asked only about widenings.
class Part {
  name: string
  constructor(name: string) {
    this.name = name
  }
}

class Visible extends Part {
  castShadow = false
  constructor(name: string) {
    super(name)
  }
}

class Skinned extends Visible {
  bones = 3
  constructor(name: string) {
    super(name)
  }
}

const describe = (part: Part): string => {
  if (part instanceof Visible) {
    part.castShadow = true
    return `${part.name}:visible:${String(part.castShadow)}`
  }
  return `${part.name}:plain`
}

// A member of the family reached through a handle typed at the family's own
// class stays a compile-time `true`, and one that cannot possibly be in the
// handle stays a compile-time `false`.
const alwaysVisible = (part: Visible): string => `${part.name}:${String(part instanceof Part)}`

for (const part of [new Part('bare'), new Visible('wing'), new Skinned('pilot')]) {
  console.log(`part=${describe(part)}`)
}
console.log(`always=${alwaysVisible(new Visible('body'))}`)

//! emitted-has: instanceOfClassFamilyRef
//! emitted-has: downcastClassRef
//! expect: part=bare:plain
//! expect: part=wing:visible:true
//! expect: part=pilot:visible:true
//! expect: always=body:true
