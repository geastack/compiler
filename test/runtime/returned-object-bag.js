function buildLocations() {
  const locations = {}
  for (let index = 0; index < 2; index++) {
    const name = index === 0 ? 'position' : 'normal'
    locations[name] = { location: index + 3, size: 1 }
  }
  return locations
}

let cached
function getLocations() {
  if (cached === undefined) cached = buildLocations()
  return cached
}

const first = getLocations()
const second = getLocations()
//! expect: 3 4 true
console.log(first['position'].location, second['normal'].location, first === second)
first['position'].location = 9
//! expect: 9
console.log(second['position'].location)
