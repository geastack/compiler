// ECMA-262 25.5.2.2 step 2: JSON.stringify replaces an object that answers
// `toJSON` with that method's result before serializing anything. The
// a database client's monitor timer prints itself with `JSON.stringify(this)`
// from its own `toString`, and its `toJSON` returns a plain summary object.

class Timer {
  private timerId: number | undefined
  private lastCall: number
  private stopped: boolean
  constructor(lastCall: number) {
    this.timerId = undefined
    this.lastCall = lastCall
    this.stopped = false
  }
  start(id: number): void {
    this.timerId = id
  }
  stop(): void {
    this.stopped = true
    this.timerId = undefined
  }
  toString(): string {
    return JSON.stringify(this)
  }
  toJSON() {
    return {
      timerId: this.timerId != null ? 'set' : 'cleared',
      lastCallTime: this.lastCall,
      stopped: this.stopped
    }
  }
}

const timer = new Timer(42)
//! expect: {"timerId":"cleared","lastCallTime":42,"stopped":false}
console.log(timer.toString())
timer.start(7)
//! expect: {"timerId":"set","lastCallTime":42,"stopped":false}
console.log(JSON.stringify(timer))
timer.stop()
//! expect: {"timerId":"cleared","lastCallTime":42,"stopped":true}
console.log('' + timer)

class Label {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
  toJSON(): string {
    return 'label:' + this.text
  }
}
//! expect: "label:a\"b"
console.log(JSON.stringify(new Label('a"b')))
