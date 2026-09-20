// A class with no `extends`, no static members, and never referenced as a
// VALUE anywhere the program keeps -- no `new Skeleton`, no `instanceof
// Skeleton`, no bare mention of the identifier `Skeleton` in expression
// position -- is an inert definition, and an inert definition is prunable
// (`reachability.ts`'s `isPrunableDeclaration`). The ONLY thing that keeps
// `Skeleton`'s own statement open here is the member READ `s.boneTexture` on
// a receiver the checker types as `Skeleton` (from `use`'s parameter
// annotation `Skeleton | null`), which goes through `openClassOfReceiver` --
// never through `markReference` on a value use. Naming the class in a type
// position alone opens nothing: following every annotation was measured to
// pull three.js's whole `Curve` hierarchy into a program that never runs it.
//
// `use` is reachable (it is called below), so its whole body must lower --
// including the `s.boneTexture` / `s.calculateInverses()` reads in the
// non-null arm, even though this file only ever calls it with `null`. That
// arm's member access needs `Skeleton`'s LAYOUT to lower at all, and the
// class-lifecycle census only produces a layout for a class whose own
// statement the reachability walk opened. Before the fix, nothing opened it
// -- the class is named nowhere as a value, so ordinary reference marking
// never reaches it -- and lowering `s.boneTexture` refused at emission with
// "no class evaluation published". After the fix, the type annotation alone
// keeps the statement open, the census publishes the layout, and the member
// reads lower cleanly.
//
// A companion fixture, `class-named-only-by-type-instance.ts`, drives the
// non-null arm with a genuine `new Skeleton()` for a second, independent
// check that the published layout is actually CORRECT (right field, right
// method) -- but constructing an instance necessarily mentions `Skeleton` in
// expression position, which keeps the class open through the ordinary
// value-reference edge regardless of this fix, so that fixture does not by
// itself distinguish "fixed" from "not fixed". This file is the one that
// does: delete `openClassNamedByType` and this file alone starts refusing.
class Skeleton {
  boneTexture: number | null = null
  calculateInverses(): number {
    return 3
  }
}

function use(s: Skeleton | null): number {
  if (s === null) return -1
  return s.boneTexture === null ? s.calculateInverses() : s.boneTexture
}

console.log(use(null))
