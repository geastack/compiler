const object: any = {}
Object.defineProperty(object, 'locked', { value: 1, configurable: false })

let threw = false
try {
  delete object.locked
} catch (error) {
  threw = error instanceof TypeError
}

if (!threw || object.locked !== 1) throw new Error('strict delete must throw and preserve a non-configurable ordinary property')
