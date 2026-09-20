//! expect: 42
//! expect: function
//! expect: function
type Handler = { run: () => number }

class Runner {
  handlers: Handler
  configure: (handlers: Handler) => void

  constructor() {
    this.handlers = { run: () => 42 }
    this.configure = (handlers: Handler) => {
      this.handlers = handlers
    }
  }

  run(): number {
    return this.handlers.run()
  }

  configurePrototype(handlers: Handler): void {
    this.handlers = handlers
  }
}

const runner = new Runner()
console.log(runner.run())
console.log(typeof runner.configure)
console.log(typeof runner.configurePrototype)
