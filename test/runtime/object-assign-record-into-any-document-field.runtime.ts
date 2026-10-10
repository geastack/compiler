// `Object.assign` FROM A TYPED RECORD INTO A VALUE THE PROGRAM DECLARES `any`.
//
// A database client's `applySession` does
// `command.readConcern = command.readConcern || {}` over a `Document`
// (`{ [key: string]: any }`) and then
// `Object.assign(command.readConcern, { afterClusterTime: session.operationTime })`.
// The target is genuinely dynamic -- nothing narrows the `any` -- and the
// source is a record whose keys are known here, so the copy is one [[Set]]
// per present source field on the dynamic object.

class Timestamp {
  readonly seconds: number
  constructor(seconds: number) {
    this.seconds = seconds
  }
}

interface CommandDocument {
  [key: string]: any
}

const applyClusterTime = (command: CommandDocument, operationTime: Timestamp, level?: string): CommandDocument => {
  command.readConcern = command.readConcern || {}
  const extra: { afterClusterTime: Timestamp; level?: string } = { afterClusterTime: operationTime }
  if (level !== undefined) extra.level = level
  Object.assign(command.readConcern, extra)
  return command
}

const fresh = applyClusterTime({ find: 'todos' }, new Timestamp(7))
//! expect: fresh=7 keys=afterClusterTime
console.log(`fresh=${fresh.readConcern.afterClusterTime.seconds} keys=${Object.keys(fresh.readConcern).join(',')}`)

const kept = applyClusterTime({ find: 'todos', readConcern: { level: 'local' } }, new Timestamp(9), 'majority')
//! expect: kept=9 level=majority keys=level,afterClusterTime
console.log(
  `kept=${kept.readConcern.afterClusterTime.seconds} level=${kept.readConcern.level} keys=${Object.keys(kept.readConcern).join(',')}`
)
