//! expect: Binary 7 Binary
//! expect: Long 7 Long
//! expect: plain undefined

// A binary-document serializer: every value class extends `WireValue`, whose
// symbol-keyed getters `[WIRE_VERSION_SYMBOL]` and `[wireType]` answer for
// every subclass. The serializer reads them off an `any` document value
// (`value[constants.WIRE_VERSION_SYMBOL] !== constants.WIRE_MAJOR_VERSION`),
// so the dynamic read has to find a getter the BASE declares under a
// registered-symbol key.

const WIRE_VERSION_SYMBOL = Symbol.for('@@wire.version')
const wireType = Symbol.for('@@wire.type')
const WIRE_MAJOR_VERSION = 7 as const

abstract class WireValue {
  abstract get _wiretype(): string
  get [wireType](): this['_wiretype'] {
    return this._wiretype
  }
  get [WIRE_VERSION_SYMBOL](): typeof WIRE_MAJOR_VERSION {
    return WIRE_MAJOR_VERSION
  }
}

class Binary extends WireValue {
  get _wiretype(): 'Binary' {
    return 'Binary'
  }
  bytes: number[]
  constructor(bytes: number[]) {
    super()
    this.bytes = bytes
  }
}

class Long extends WireValue {
  get _wiretype(): 'Long' {
    return 'Long'
  }
  high = 0
  low = 1
}

function describe(value: any): string {
  if (value._wiretype == null) return 'plain ' + String(value[WIRE_VERSION_SYMBOL])
  return value._wiretype + ' ' + String(value[Symbol.for('@@wire.version')]) + ' ' + String(value[wireType])
}

const doc: Record<string, unknown> = { id: new Binary([1, 2]), n: new Long(), p: { a: 1 } }
for (const key of Object.keys(doc)) console.log(describe(doc[key]))
