interface StaticMethodInput {
  staticPayload: number
}

class StaticMethodBase {
  static read(input: StaticMethodInput): number {
    return input.staticPayload
  }
}

class StaticMethodChild extends StaticMethodBase {}

let staticReceiverReads = 0
function noteStaticReceiver(): void {
  staticReceiverReads++
}

console.log(StaticMethodBase.read({ staticPayload: 17 }), StaticMethodChild.read({ staticPayload: 42 }))
console.log((noteStaticReceiver(), StaticMethodChild).read({ staticPayload: 9 }), staticReceiverReads)

class StaticReceiverState {
  static value = 23
  static direct(): number {
    return this.value
  }
  static lexical(): number {
    const read = () => this.value
    return read()
  }
  static defaulted(value = this.value): number {
    return value
  }
}

console.log(StaticReceiverState.direct(), StaticReceiverState.lexical(), StaticReceiverState.defaulted())
