// SYMBOL-KEYED CLASS FIELDS DECLARED WITHOUT AN INITIALIZER, BESIDE
// SYMBOL-KEYED METHODS.
//
// The shape `@hono/node-server`'s lightweight request takes once its prototype
// surgery is written as the class the language has for it: nine fields on
// module-level `unique symbol` keys, most of them absent until something
// assigns them, and methods on symbol keys of their own.

const incomingKey = Symbol('incoming')
const boxKey = Symbol('box')
const bufferKey = Symbol('buffer')
const reasonKey = Symbol('reason')
const consumedKey = Symbol('consumed')
const getBox = Symbol('getBox')
const abortIt = Symbol('abortIt')

class Box {
  label: string
  constructor(label: string) {
    this.label = label
  }
}

// Declared BEFORE the class it names: `@hono/node-server`'s body readers sit
// two hundred lines above the request they take, and a class used as a type
// ahead of its own declaration is exactly what the adapter produces.
const clearBuffer = (holder: LightHolder): void => {
  holder[bufferKey] = undefined
  holder[consumedKey] = true
}

class LightHolder {
  [incomingKey]: string;
  [boxKey]: Box | undefined;
  [bufferKey]: string | undefined;
  [reasonKey]: unknown;
  [consumedKey]: boolean = false

  constructor(incoming: string) {
    this[incomingKey] = incoming
  }

  [getBox](): Box {
    return (this[boxKey] ||= new Box('box:' + this[incomingKey]))
  }

  [abortIt](reason: unknown): void {
    if (this[reasonKey] === undefined) {
      this[reasonKey] = reason
    }
  }

  describe(): string {
    return this[getBox]().label + ' buffer=' + String(this[bufferKey]) + ' consumed=' + String(this[consumedKey])
  }

  consume(): void {
    clearBuffer(this)
  }

  reasonText(): string {
    return String(this[reasonKey])
  }
}

const holder = new LightHolder('socket-3')
holder[bufferKey] = 'bytes'

//! expect: before=box:socket-3 buffer=bytes consumed=false
console.log('before=' + holder.describe())

holder.consume()
//! expect: after=box:socket-3 buffer=undefined consumed=true
console.log('after=' + holder.describe())

holder[abortIt]('closed')
//! expect: reason=closed
console.log('reason=' + holder.reasonText())
