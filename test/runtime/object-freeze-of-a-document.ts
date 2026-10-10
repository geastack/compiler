// ECMA-262 20.1.2.6: `Object.freeze` of an open Document. A database
// client's run-command cursor freezes `{ ...command }` before sending it; the frozen
// copy must keep its keys and order, refuse writes in strict code, and leave
// the source untouched.

interface CommandDocument {
  [key: string]: any
}

function frozenCopy(command: CommandDocument): CommandDocument {
  return Object.freeze({ ...command })
}

const command: CommandDocument = { ping: 1, comment: 'hello' }
const frozen = frozenCopy(command)
//! expect: keys=ping,comment ping=1 comment=hello
console.log('keys=' + Object.keys(frozen).join(',') + ' ping=' + frozen['ping'] + ' comment=' + frozen['comment'])
//! expect: frozen=true extensible=false source frozen=false
console.log(
  'frozen=' + Object.isFrozen(frozen) + ' extensible=' + Object.isExtensible(frozen) + ' source frozen=' + Object.isFrozen(command)
)
let message = 'no throw'
try {
  frozen['ping'] = 2
} catch (error) {
  message = error instanceof TypeError ? 'TypeError' : 'other'
}
//! expect: write=TypeError ping=1
console.log('write=' + message + ' ping=' + frozen['ping'])
let added = 'no throw'
try {
  frozen['extra'] = true
} catch (error) {
  added = error instanceof TypeError ? 'TypeError' : 'other'
}
//! expect: add=TypeError has extra=false
console.log('add=' + added + ' has extra=' + ('extra' in frozen))
command['ping'] = 3
//! expect: source ping=3 frozen ping=1
console.log('source ping=' + command['ping'] + ' frozen ping=' + frozen['ping'])
