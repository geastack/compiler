//! expect: optional-undefined:undefined:true:false:true:absent
//! expect: optional-null:object:false:true:true:absent
//! expect: optional-value:object:false:false:false:original
//! expect: nullable-undefined:undefined:true:false:true:absent
//! expect: nullable-null:object:false:true:true:absent
//! expect: nullable-value:object:false:false:false:original
//! expect: tagged-undefined:undefined:true:false:true:absent
//! expect: tagged-null:object:false:true:true:absent
//! expect: tagged-value:object:false:false:false:original
//! expect: tagged-number:number:false:false:false:number
//! expect: outer-undefined:undefined:true:false:true:absent
//! expect: outer-null:object:false:true:true:absent
//! expect: same-undefined=true
//! expect: same-null-undefined=false
//! expect: same-tagged-undefined=true
//! expect: same-tagged-null=true
class ReturnedReceiver {
  label = 'original'
  self(): ReturnedReceiver {
    return this
  }
}

function optional(label: string, value: ReturnedReceiver | undefined): void {
  console.log(
    label +
      ':' +
      typeof value +
      ':' +
      (value === undefined) +
      ':' +
      (value === null) +
      ':' +
      (value == null) +
      ':' +
      (value?.label ?? 'absent')
  )
}

function nullable(label: string, value: ReturnedReceiver | null): void {
  console.log(
    label +
      ':' +
      typeof value +
      ':' +
      (value === undefined) +
      ':' +
      (value === null) +
      ':' +
      (value == null) +
      ':' +
      (value?.label ?? 'absent')
  )
}

function tagged(label: string, value: ReturnedReceiver | number | null | undefined): void {
  const text = typeof value === 'number' ? 'number' : (value?.label ?? 'absent')
  console.log(label + ':' + typeof value + ':' + (value === undefined) + ':' + (value === null) + ':' + (value == null) + ':' + text)
}

function sameOptional(left: ReturnedReceiver | undefined, right: ReturnedReceiver | undefined): boolean {
  return left === right
}

function sameTagged(left: ReturnedReceiver | number | null | undefined, right: ReturnedReceiver | number | null | undefined): boolean {
  return left === right
}

const receiver = new ReturnedReceiver()
const self = receiver.self
const detached = self()
const nullReceiver = self.call(null)
optional('optional-undefined', detached)
optional('optional-null', nullReceiver)
optional('optional-value', receiver)
nullable('nullable-undefined', detached)
nullable('nullable-null', nullReceiver)
nullable('nullable-value', receiver)
tagged('tagged-undefined', detached)
tagged('tagged-null', nullReceiver)
tagged('tagged-value', receiver)
tagged('tagged-number', 1)
optional('outer-undefined', undefined)
nullable('outer-null', null)
console.log('same-undefined=' + sameOptional(detached, undefined))
console.log('same-null-undefined=' + sameOptional(nullReceiver, undefined))
console.log('same-tagged-undefined=' + sameTagged(detached, undefined))
console.log('same-tagged-null=' + sameTagged(nullReceiver, null))

export {}
