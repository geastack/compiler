// `error instanceof MongoError`-shaped code: a BOXED left operand (`dynamic`)
// tested against a program class (`constructor-family`). The naive fix -- OR
// together `payloadType() == tagFor<Ref<S>>` for every member -- is unsound in
// exactly the direction this fixture exercises: `Value::box`'s payload type is
// the STATIC C++ type at the box call site, and a `Ref<Derived>` upcast into a
// `Ref<Base>`-typed cell before boxing records `Base`, not `Derived`. This
// class hierarchy (`class-upcast-merge.ts`'s own animals) forces exactly that
// widening: `upcast`'s declared type is `Animal`, so the cell TypeScript
// assigns `new Dog()` into carries `class-ref(Animal)`, and `Value::box` sees
// a `gea::Ref<gea_class_Animal>` even though the live object is a Dog.
//
// The sound fix reads the block's OWN allocation identity instead
// (`Value::classIdentity()` / `detail::refPayloadIdentity`, gea_runtime.h):
// `gea::Ref<T>::release`'s operations-table pointer is written by whichever
// `makeRef<T>` actually allocated the object and sits at the same offset
// regardless of the static handle type, so it survives the upcast. `boxed
// instanceof Dog` must answer `true` (the live object IS a Dog), `boxed
// instanceof Animal` must answer `true` too (Dog descends from Animal -- the
// family's runtime extension, not just its stated member), and `boxed
// instanceof Cat` must answer `false` (a sibling, never an ancestor).
class Animal {
  legs(): number {
    return 4
  }
}

class Dog extends Animal {
  override legs(): number {
    return 4
  }
  bark(): number {
    return 7
  }
}

class Cat extends Animal {
  override legs(): number {
    return 4
  }
}

const upcast: Animal = new Dog()
const boxed: unknown = upcast

export const probe = (boxed instanceof Dog ? 1 : 0) + (boxed instanceof Animal ? 10 : 0) + (boxed instanceof Cat ? 100 : 0)

if (probe !== 11) throw new Error('boxed upcast instanceof against a constructor-family computed the wrong result')
