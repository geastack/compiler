//! expect: 7
//! emitted-lacks: gea::Value::box

class Holder {
  run: () => number
  constructor(run: () => number) {
    this.run = run
  }
  get worker(): () => number {
    return this.run
  }
  set worker(run: () => number) {
    this.run = run
  }
}

class DerivedHolder extends Holder {}

const holder = new DerivedHolder(() => 3)
holder.worker = () => 7
console.log(holder.worker())
