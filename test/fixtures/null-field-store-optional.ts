// three.js's `WebGLLights.js` shape: a module-level object literal record whose
// field is initialized with a bare `null` (no annotation), later written from
// an OPTIONAL class-ref read (`UniformsLib.LTC_FLOAT_1?: Texture`), and read
// back elsewhere.

class Texture {
  id = 1
}

const lib: { table?: Texture } = {}

const state = { slot: null, count: 0 }

const fill = (): void => {
  state.slot = lib.table
}

export const main = (): void => {
  fill()
  console.log(state.slot === null ? 'null' : 'value')
}

main()
