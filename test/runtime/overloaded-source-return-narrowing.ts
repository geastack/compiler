//! expect: value: 42
//! expect: none
//! emitted-lacks: gea::Value

// An overloaded source function has the implementation's physical parameter
// frame and the resolved overload's caller-visible return. The implementation
// union must not erase a result narrowed by overload resolution.
function select(mode: 'value'): number
function select(mode: 'none'): void
function select(mode: string): number | void {
  if (mode === 'value') return 41
}

const value = select('value')
console.log(`value: ${value + 1}`)
select('none')
console.log('none')
