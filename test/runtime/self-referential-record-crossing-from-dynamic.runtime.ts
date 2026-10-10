// A 3D scene-graph library's texture source holds an `image` whose own `image` field is the same
// record type. A value of it arriving from code the program cannot see is read
// through a view per access: the nested `image` is wrapped when it is read,
// not converted eagerly to the bottom of a chain that may be a cycle.
interface Picture {
  width: number
  image?: Picture
}

function depth(picture: Picture): number {
  let total = 0
  let at: Picture | undefined = picture
  while (at !== undefined && total < 10) {
    total += at.width
    at = at.image
  }
  return total
}

const local: Picture = { width: 1, image: { width: 2 } }
console.log(depth(local))

const raw: any = JSON.parse('{"width":3,"image":{"width":4,"image":{"width":5}}}')
const crossed: Picture = raw
console.log(depth(crossed))

const cyclic: any = { width: 1 }
cyclic.image = cyclic
console.log(depth(cyclic))

//! expect: 3
//! expect: 12
//! expect: 10
