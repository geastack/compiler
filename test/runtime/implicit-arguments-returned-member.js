// Both publication forms must share the same typed implicit frame as their
// counted callers. An empty frame still produces undefined for its first read.
function explicitFactory() {
  function first() {
    return arguments[0]
  }
  return { first: first }
}

function shorthandFactory() {
  function first() {
    return arguments[0]
  }
  return { first }
}

const explicitRecord = explicitFactory()
const shorthandRecord = shorthandFactory()
console.log(explicitRecord.first(11), shorthandRecord.first(12))
console.log(explicitRecord.first() === undefined, shorthandRecord.first() === undefined)
//! expect: 11 12
//! expect: true true
//! emitted-lacks: gea::ArrayObject<gea::Value>
