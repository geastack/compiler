// The framework surface this compiler needs to model: an object literal whose
// properties are ES2015 method shorthand and accessor pairs, exactly how
// `@geastack/core`'s runtime spells its ambient controllers (`export const
// WiFi = { enabled() { ... }, get connected() { ... } }`). Two literals here
// separate the two capabilities on purpose: `radio` has methods only, and
// fully certifies once a method installs the same function-object allocation
// an arrow-function property value already does; `sensor` adds a getter and a
// setter, which need an accessor *descriptor* installed rather than a data
// property -- a primitive this compiler does not have -- so it stays honestly
// refused instead of being silently dropped or boxed.

let power = 0

const radio = {
  enable(step: number): number {
    power = power + step
    return power
  },
  disable(): number {
    power = 0
    return power
  }
}

const started: number = radio.enable(3)

let level = 0

const sensor = {
  get value(): number {
    return level
  },
  set value(next: number) {
    level = next
  }
}
