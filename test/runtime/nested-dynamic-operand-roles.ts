//! expect: 7
//! expect: 9
//! expect: 11

// A declared unknown payload is dynamic, but the containing class, its
// constructor and its method remain native. Their metadata operands do not
// convert to the class lifecycle event's result.
class PayloadHolder {
  payload: unknown

  constructor(payload: unknown) {
    this.payload = payload
  }

  read(): unknown {
    return this.payload
  }

  get value(): unknown {
    return this.payload
  }

  set value(next: unknown) {
    this.payload = next
  }
}

class DerivedPayloadHolder extends PayloadHolder {}

const holder = new DerivedPayloadHolder(7)
console.log(holder.read())
holder.value = 9
console.log(holder.value)

const fields: { payload: unknown; count: number } = { payload: 1, count: 11 }
const { count } = fields
console.log(count)
