export type { Hidden, Foo } from './_construction-type-export-hidden'
export type * as hidden from './_construction-type-export-hidden'
export type * from './_construction-type-export-hidden'
export * from './_construction-type-export-values'
console.log('visible-module')
export class Visible {
  value = 1
  constructor() {
    console.log('visible-constructor')
  }
}
