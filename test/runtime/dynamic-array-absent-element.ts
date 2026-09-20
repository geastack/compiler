function firstOfCopy(values: any[]): any {
  const copy = values.slice()
  return copy[0]
}

const sparse: any[] = []
sparse.length = 2
sparse[1] = 'present'
const empty: any[] = []
const filled: any[] = []
const dynamicNumber: any = 42
filled.push(dynamicNumber)
//! expect: empty true
//! expect: hole true
//! expect: outside true
//! expect: present present
//! expect: copied 42
console.log('empty', firstOfCopy(empty) === undefined)
console.log('hole', sparse[0] === undefined)
console.log('outside', sparse[4] === undefined)
console.log('present', sparse[1])
console.log('copied', firstOfCopy(filled))
