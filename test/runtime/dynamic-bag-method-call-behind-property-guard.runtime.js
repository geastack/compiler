// A 3D scene-graph library's `ShadedMaterial.toJSON` reads each uniform of an `Object` bag and,
// behind `value && value.isTexture`, calls `value.toJSON( meta )`. The values
// the program stores are a number, a string and a class instance, so the read
// of `toJSON` is a read off a union with arms that have no such member, and the
// call that follows must still reach the texture's own method with the texture
// as its receiver.

class Texture {
  constructor() {
    this.isTexture = true
    this.uuid = 'tex-1'
  }
  /** @param {any} [meta] */
  toJSON(meta) {
    return { uuid: this.uuid, seen: typeof meta }
  }
}

/** @type {Record<string, any>} */
const bag = {}
bag.a = { value: new Texture() }
bag.b = { value: 3 }
bag.c = { value: 'text' }

let out = ''
for (const name in bag) {
  const value = bag[name].value
  if (value && value.isTexture) out += name + '=' + value.toJSON(false).uuid + ' '
  else out += name + '=' + value + ' '
}
//! expect: a=tex-1 b=3 c=text
console.log(out.trim())
