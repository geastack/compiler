class Owner {
  value: number
  read = (): number => this.value
  constructor(value: number) {
    this.value = value
  }
  releaseOwner(): number {
    sole = null
    churn()
    return this.value
  }
}

let sole: Owner | null = null

function churn(): number {
  let sum = 0
  for (let index = 0; index < 2000; index++) sum += new Owner(index).read()
  return sum
}

let escaped: () => number = () => 0
function prepareEscaped(): void {
  const owner = new Owner(41)
  escaped = owner.read
}
prepareEscaped()
//! expect: churn=1999000
console.log('churn=' + churn())
//! expect: escaped=41
console.log('escaped=' + escaped())
escaped = () => -1
churn()

let active: () => string = () => ''
function prepareActive(): void {
  const held = { value: 'alive' }
  active = () => {
    // Remove the last stored copy while this environment is executing.
    active = () => ''
    churn()
    return held.value
  }
}
prepareActive()
//! expect: active=alive
console.log('active=' + active())

sole = new Owner(77)
//! expect: receiver=77
console.log('receiver=' + sole.releaseOwner())

let pending: Owner | null = new Owner(99)
//! expect: pending=99
console.log('pending=' + pending.read())
pending = null
