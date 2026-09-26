//! expect: THREE.Renderer: slow path
//! expect: THREE.Material: bad value 3 true
//! expect: one warning

// three's logging shim (utils.js `warn`) ends in `console.warn( message,
// ...params )`, the twin of its `console.error` path. Node writes both to
// stderr; this runner reads stdout and stderr together.
const warn = (...params: unknown[]): void => {
  const message = 'THREE.' + String(params.shift())
  console.warn(message, ...params)
}

warn('Renderer: slow path')
warn('Material: bad value', 3, true)
console.warn('one warning')
