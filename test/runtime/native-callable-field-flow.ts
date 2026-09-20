class Runner {
  value: number
  run: (owner: Runner) => number

  constructor() {
    this.value = 40
    this.run = (owner: Runner) => owner.value + 1
  }
}

const runner = new Runner()
console.log(runner.run(runner))
runner.run = (owner: Runner) => owner.value + 2
console.log(runner.run(runner))
//! expect: 41
//! expect: 42
