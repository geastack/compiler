// A keyed-collection method called with an argument whose static type is
// dynamic, on a receiver whose type arguments came from the collection census
// rather than from an annotation. `delete`'s parameter is the censused element
// -- never the ambient interface's own open `K`/`T`.
class Texture {
  readonly id: number = 0
}

const videoTextures = new WeakMap()
const htmlTextures = new Set()
const sources = new WeakMap()

export const dispose = (event: { target: unknown }): void => {
  const texture = event.target as Texture
  videoTextures.set(texture, 1)
  htmlTextures.add(texture)
  sources.set(texture, 2)
  const loose: any = texture
  videoTextures.delete(loose)
  htmlTextures.delete(loose)
  sources.has(loose)
}
