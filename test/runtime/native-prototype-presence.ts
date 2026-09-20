let getterReads = 0
class Parent {
  method(): number {
    return 1
  }
  get measured(): number {
    getterReads++
    return 2
  }
}
class Child extends Parent {
  own = 3
}
function hasMethod(value: Parent | null): boolean {
  return 'method' in value!
}
function hasGetter(value: Parent | undefined): boolean {
  return 'measured' in value!
}
function hasExtra(value: Parent): boolean {
  return 'extra' in value
}
function hasMissing(value: Parent): boolean {
  return 'missing' in value
}
function hasOptionalExtra(value: Parent | null): boolean {
  return 'extra' in value!
}
function hasNumeric(value: Parent): boolean {
  return 0 in value
}
function hasObjectPrototype(value: Parent): boolean {
  return 'toString' in value
}
function hasOptionalObjectPrototype(value: Parent | null): boolean {
  return 'toString' in value!
}
const child = new Child()
console.log(hasMethod(child), hasGetter(child), getterReads)
;(child as any).extra = 4
console.log(
  hasExtra(child),
  hasMissing(child),
  hasOptionalExtra(child),
  hasNumeric(child),
  hasObjectPrototype(child),
  hasOptionalObjectPrototype(child)
)
let caught = 0
try {
  hasMethod(null)
} catch {
  caught++
}
try {
  hasGetter(undefined)
} catch {
  caught++
}
try {
  hasOptionalExtra(null)
} catch {
  caught++
}
try {
  hasOptionalObjectPrototype(null)
} catch {
  caught++
}
console.log(caught)
