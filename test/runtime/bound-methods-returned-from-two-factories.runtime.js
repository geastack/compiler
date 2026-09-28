// @ts-nocheck
//! dynamic-fallback
//! expect: v:x s:y v:x
// @fastify/ajv-compiler's `AjvCompiler`: two closures, each pooling a method
// bound to its own class, returned from one factory. A bound method stored in
// a Map and handed back through a return is called with no receiver.
class ValidatorCompiler {
  constructor (prefix) { this.prefix = prefix }
  build (schema) { return this.prefix + schema }
}
class SerializerCompiler {
  constructor (prefix) { this.prefix = prefix }
  build (schema) { return this.prefix + schema }
}
function factory (serializer) {
  const pool = new Map()
  if (serializer) {
    return function fromSerializerPool (key) {
      if (pool.has(key)) return pool.get(key)
      const compiler = new SerializerCompiler('s:')
      const ret = compiler.build.bind(compiler)
      pool.set(key, ret)
      return ret
    }
  }
  return function fromValidatorPool (key) {
    if (pool.has(key)) return pool.get(key)
    const compiler = new ValidatorCompiler('v:')
    const ret = compiler.build.bind(compiler)
    pool.set(key, ret)
    return ret
  }
}
const validators = factory(false)
const serializers = factory(true)
console.log(validators('a')('x'), serializers('a')('y'), validators('a')('x'))
