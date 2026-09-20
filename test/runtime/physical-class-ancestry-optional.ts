class LiveBase {
  inherited = 7
}

// Derived is present only in the retained optional field type below. No
// `new PhysicalDerived()` reaches class projection, but the emitted carrier
// still needs the authenticated LiveBase ancestry for a sound layout.
class PhysicalDerived extends LiveBase {
  own = 11
}

type Holder = { child?: PhysicalDerived }

function read(holder: Holder, base: LiveBase): string {
  const child = holder.child
  return `${base.inherited}|${child?.inherited ?? -1}|${child?.own ?? -1}`
}

console.log(read({}, new LiveBase()))
