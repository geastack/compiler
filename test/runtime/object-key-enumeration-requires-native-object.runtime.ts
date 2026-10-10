class OwnKeyReceiver {
  own = 'value'
  self(): OwnKeyReceiver {
    return this
  }
}

const receiver = new OwnKeyReceiver()
const self = receiver.self
const detached = self()
const nullReceiver = self.call(null)
let evaluations = 0

function source(value: OwnKeyReceiver): OwnKeyReceiver {
  evaluations++
  return value
}

for (const value of [detached, nullReceiver]) {
  try {
    Object.keys(source(value))
    console.log('keys:missing')
  } catch (error) {
    console.log('keys:TypeError:' + (error instanceof TypeError))
  }
  try {
    Object.getOwnPropertyNames(source(value))
    console.log('names:missing')
  } catch (error) {
    console.log('names:TypeError:' + (error instanceof TypeError))
  }
}

console.log('evaluations:' + evaluations)
console.log('attached-keys:' + Object.keys(receiver).join(','))
console.log('attached-names:' + Object.getOwnPropertyNames(receiver).join(','))
console.log('spread:' + Object.keys({ ...detached, ...nullReceiver, mark: 'present' }).join(','))

//! expect: keys:TypeError:true
//! expect: names:TypeError:true
//! expect: keys:TypeError:true
//! expect: names:TypeError:true
//! expect: evaluations:4
//! expect: attached-keys:own
//! expect: attached-names:own
//! expect: spread:mark
export {}
