// ECMA-262 20.1.2.5 / 20.1.2.22: `Object.values` and `Object.entries` of a handle
// typed at a base class enumerate the own properties of whatever class the
// instance really is, base fields first. The static arm used to list the
// handle's declared shape -- the base's fields only, or, where the handle's
// carrier named a wider shape than the struct, members the struct does not
// have, which certified and then failed to compile.
//! expect: keys name,visible,opacity,color,wireframe | values mat,true,1,Color,false | entries name=mat,visible=true,opacity=1,color=Color,wireframe=false
//! expect: keys name,visible,opacity,dashSize,label | values mat,true,1,3,undefined | entries name=mat,visible=true,opacity=1,dashSize=3,label=undefined
//! expect: keys name,visible,opacity | values mat,true,1 | entries name=mat,visible=true,opacity=1
//! expect: seen 13 mat,true,1,Color,false,mat,true,1,3,undefined,mat,true,1
//! expect: leaf name=mat,visible=true,opacity=1,dashSize=3,label=undefined
//! expect: leaf name=mat,visible=true,opacity=1,color=Color,wireframe=false

class Material {
  name = 'mat'
  visible = true
  opacity = 1
}
class Color {
  r = 1
}
class BasicMaterial extends Material {
  color: Color | null = new Color()
  wireframe = false
}
class DashedMaterial extends Material {
  dashSize = 3
  label: string | undefined = undefined
}
class Mesh {
  material: Material | Material[] | undefined
  constructor(material: Material | Material[] | undefined) {
    this.material = material
  }
}

const show = (v: unknown): string => (v instanceof Color ? 'Color' : String(v))
const meshes = [new Mesh(new BasicMaterial()), new Mesh([new DashedMaterial(), new Material()]), new Mesh(undefined)]
const seen: unknown[] = []
for (const o of meshes) {
  const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
  for (const m of mats) {
    for (const v of Object.values(m) as unknown[]) seen.push(v)
    const pairs: string[] = []
    for (const [k, v] of Object.entries(m)) pairs.push(k + '=' + show(v))
    console.log(
      'keys ' +
        Object.keys(m).join(',') +
        ' | values ' +
        (Object.values(m) as unknown[]).map(show).join(',') +
        ' | entries ' +
        pairs.join(',')
    )
  }
}
console.log('seen ' + seen.length + ' ' + seen.map(show).join(','))

// The same walk over a handle typed as the union of the subclasses.
const leaves: (BasicMaterial | DashedMaterial)[] = [new DashedMaterial(), new BasicMaterial()]
for (const m of leaves)
  console.log(
    'leaf ' +
      Object.entries(m)
        .map(([k, v]) => k + '=' + show(v))
        .join(',')
  )
