function definition(name: string): number {
  console.log(name)
  return 1
}
function dormantInstance(): number {
  console.log('DORMANT_INSTANCE_MUST_NOT_RUN')
  return 1
}
function computedName(): 'definitionMethod' {
  console.log('computed')
  return 'definitionMethod'
}
export class Dormant {
  static ready = definition('dormant-static');
  [computedName()]() {
    return 1
  }
  value = dormantInstance()
  constructor() {
    console.log('DORMANT_CONSTRUCTOR_MUST_NOT_RUN')
  }
}
export class Base {
  static ready = definition('base-static')
  value = definition('base-instance')
  constructor() {
    console.log('base-constructor')
  }
}
export class Constructed extends Base {
  static own = definition('derived-static')
  own = definition('derived-instance')
  constructor() {
    super()
    console.log('derived-constructor')
  }
}
