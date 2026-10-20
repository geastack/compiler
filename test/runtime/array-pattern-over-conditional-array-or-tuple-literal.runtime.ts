// `const [near, back] = lods ? split(ids) : [ids, []]`: the literal arm is a
// tuple record beside the call's array, so the conditional holds a tagged
// union of both. The pattern read only the array arm and refused the tuple
// arm at run time as if GetIterator had rejected it, aborting a valid
// program. The tuple arm is read too, and `near` is `ids` itself.
const splitByDistance = (distances: number[], ids: number[], limit: number) => {
  const near: number[] = []
  const far: number[] = []
  for (const id of ids) (distances[id]! > limit ? far : near).push(id)
  return [near, far]
}

const distances = [10, 50, 90]
const ids = [0, 1, 2]
for (const lods of [true, false]) {
  const [near, back] = lods ? splitByDistance(distances, ids, 36) : [ids, []]
  const [mid, far] = splitByDistance(distances, back!, 80)
  console.log(`lods=${lods} near=${near!.join('|')} mid=${mid!.join('|')} far=${far!.join('|')}`)
  near!.push(7)
}
console.log(`ids=${ids.join(',')}`)
//! expect: lods=true near=0 mid=1 far=2
//! expect: lods=false near=0|1|2 mid= far=
//! expect: ids=0,1,2,7
