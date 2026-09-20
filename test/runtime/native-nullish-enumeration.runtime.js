let evaluations = 0
let visits = 0

/** @returns {*} */
function absentEnumerationSource() {
  evaluations++
  return undefined
}

/** @returns {*} */
function nullEnumerationSource() {
  evaluations++
  return null
}

for (const key in absentEnumerationSource()) visits += key.length
for (const key in nullEnumerationSource()) visits += key.length
console.log(visits, evaluations)
//! expect: 0 2
