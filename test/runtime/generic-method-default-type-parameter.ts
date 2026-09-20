//! expect: {"hello":"world"}

// A call can infer an early type parameter while taking a later one from its
// declared default. Both parameters belong to one specialization: dropping it
// because the omitted value argument produced no inference evidence for U
// drops the method body itself from a monomorphized class.
class Context {
  json<T extends object, U extends number = number>(object: T, status?: U): string {
    if (status !== undefined) return String(status)
    return JSON.stringify(object)
  }
}

console.log(new Context().json({ hello: 'world' }))
