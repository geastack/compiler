// Companion to `class-named-only-by-type.ts`. That fixture proves the exact
// reachability rule (`openClassNamedByType`) by never mentioning `Skeleton`
// as a value anywhere -- the non-null member reads are lowered but never
// actually executed. This file drives the SAME reads with a genuine
// `new Skeleton()` so the published layout is checked against real data, not
// only checked for existing.
//
// It does NOT isolate the fix the way the other file does: `new Skeleton()`
// names the class in expression position, and `markReference` on that
// identifier opens the class's statement through the ordinary value-reference
// edge on its own (`markSymbol` walks up to the top-level `ClassDeclaration`
// and calls `openStatement` directly) -- regardless of whether
// `openClassNamedByType` exists at all. So this fixture certifies and runs
// correctly with or without that fix; only `class-named-only-by-type.ts`
// regresses when it is removed.
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

const withInverses = new Skeleton()
console.log(use(withInverses))

const withTexture = new Skeleton()
withTexture.boneTexture = 42
console.log(use(withTexture))

console.log(use(null))
