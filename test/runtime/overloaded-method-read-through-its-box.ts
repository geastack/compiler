//! dynamic-fallback
//! expect: compiled:{"a":1} compiled:"s"! true
// ajv's `compile` declares overloads that join no convention, so
// `this.ajv.compile` is read as the boxed method and called with its receiver.
class Ajv {
  readonly prefix = 'compiled:'
  compile(schema: Record<string, unknown>, meta?: boolean): string
  compile(schema: string, meta: boolean): string
  compile(schema: Record<string, unknown> | string, meta?: boolean): string {
    return this.prefix + JSON.stringify(schema) + (meta ? '!' : '')
  }
}
class Compiler {
  readonly ajv = new Ajv()
  build(schema: Record<string, unknown>): string {
    return this.ajv.compile(schema)
  }
}
const ajv = new Ajv()
const detached = ajv.compile
console.log(new Compiler().build({ a: 1 }), detached.call(ajv, 's', true), ajv.compile === detached)
