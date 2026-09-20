class ReflectionRoot {
  rootValue = 1
}

class ReflectionLeft extends ReflectionRoot {
  leftValue = 2
}

class ReflectionLeaf extends ReflectionLeft {
  leafValue = 3
}

class ReflectionRight extends ReflectionRoot {
  rightValue = 4
}

function inspectLeft(value: ReflectionLeft, key: string): void {
  const dynamic = value as any
  console.log(dynamic[key])
  dynamic[key] = 9
  console.log(dynamic[key])
  console.log(Object.keys(value).includes(key))
}

const left = new ReflectionLeaf()
const right = new ReflectionRight()
inspectLeft(left, 'rootValue')
inspectLeft(left, 'leftValue')
inspectLeft(left, 'leafValue')
console.log(`${right.rootValue}:${right.rightValue}`)

//! expect: 1
//! expect: 9
//! expect: 2
//! expect: 3
//! expect: 1:4
