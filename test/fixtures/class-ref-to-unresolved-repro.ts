// Repro for binding-read-conversion:class-ref->unresolved(no primitive for an
// intersection whose member type|N (class-instance) is not a record shape)
// (mongodb execute_operation.ts:198 `operation instanceof AggregateOperation`
// inside `tryOperation<T extends AbstractOperation>`).
//
// `pet` is declared `Animal` (a plain class-ref cell). `Cat` is an unrelated
// class. TypeScript still narrows `pet instanceof Cat` to the intersection
// type `Animal & Cat` (neither class has an incompatible private member, so
// the checker cannot prove the intersection uninhabited). `representation/
// derive.ts`'s intersection handling explicitly refuses to build a record for
// an intersection with a nominal-class member (`isNominalClassMember` outranks
// the checker's own reduction, and `intersectionMemberShape` returns null for
// a class-instance member), so this read's representation is `unresolved`
// while the cell's own carrier is `class-ref(Animal)`.

class Animal {
  name = 'animal'
}

class Cat {
  meow(): string {
    return 'meow'
  }
}

export function speak(pet: Animal): string {
  if (pet instanceof Cat) {
    return pet.meow()
  }
  return pet.name
}
