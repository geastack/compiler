// @ts-nocheck -- three is compiled from `node_modules`, where the checker
// reports nothing; this file stands in for it. The reads below of members the
// `Color` arm lacks are exactly what three's JS does unchecked.

// three's `WebGLBackground`: `scene.background` is declared `(Color | Texture)
// | null` (`@types/three`), and the renderer asks it `isCubeTexture` and
// `mapping` -- members only the texture family declares. On the `Color` arm
// both reads are simply `undefined`; nothing here can give a `Color` those
// properties, so neither class needs a dynamic field protocol for the reads to
// be answered.
class Texture {
  constructor() {
    this.isCubeTexture = false
    this.mapping = 300
  }
}

class CubeTexture extends Texture {
  constructor() {
    super()
    this.isCubeTexture = true
    this.flipY = false
  }
}

class Color {
  constructor() {
    this.isColor = true
    this.r = 0
  }
}

class Scene {
  constructor() {
    /** @type {Texture | Color | null} */
    this.background = null
  }
}

const scene = new Scene()

function usesCubeUV() {
  const background = scene.background
  if (background && (background.isCubeTexture || background.mapping === 306)) return 1
  return 0
}

scene.background = new Color()
const fromColor = usesCubeUV()
scene.background = new CubeTexture()
const fromCube = usesCubeUV()
scene.background = new Texture()
console.log(fromColor, fromCube, usesCubeUV())
