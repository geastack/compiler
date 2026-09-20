class Base {
  value: number
  constructor(value: number) {
    this.value = value
  }
}

class Derived extends Base {
  constructor(value: number) {
    super(value)
  }
}

const instance: Base = new Derived(42)
console.log(instance.value)
