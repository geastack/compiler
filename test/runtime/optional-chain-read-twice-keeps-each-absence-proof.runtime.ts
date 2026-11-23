//! expect: 3 4
//! expect: 0 0
//! expect: continuous 0 0

// `options.point?.x ?? 0, options.point?.y ?? 0` reads `options.point` twice.
// Reusing the first read for the second is sound for the value, but the
// read of `y` carries a standard-prototype absence fact that is
// authenticated by tracing its receiver back to the source read it was
// proved for -- through the unwrap between them. Reused, it traced to the
// other read and the program was refused certification.

interface Point {
  x: number
  y: number
}

interface FocusOptions {
  mode?: 'continuous' | 'single'
  point?: Point
}

const focusText = (options: FocusOptions): string => [options.mode ?? 'continuous', options.point?.x ?? 0, options.point?.y ?? 0].join(' ')

const pair = (options: FocusOptions): string => `${options.point?.x ?? 0} ${options.point?.y ?? 0}`

console.log(pair({ point: { x: 3, y: 4 } }))
console.log(pair({}))
console.log(focusText({}))
