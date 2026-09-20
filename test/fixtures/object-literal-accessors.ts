// An object literal's `get`/`set` member has no storage: the struct lays out no
// field for it, and a read runs the body. Two facts have to hold together for
// that -- the shape must say the member is accessor-backed (so no field is laid
// out), and the accessor's own allocation must carry its *signature* rather
// than the property type its name denotes (so the body has a convention to be
// called through, and a receiver to be called with).
let backing = 5

export const Meter = {
  label: 'meter',
  get reading(): number {
    return backing
  },
  set reading(next: number) {
    backing = next
  },
  bump(): void {
    backing = backing + 1
  }
}

export function readMeter(): number {
  return Meter.reading
}

export function writeMeter(): number {
  Meter.reading = 12
  return Meter.reading
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = readMeter() + writeMeter()
