class LogicalMapTarget {
  value: number

  constructor(value: number) {
    this.value = value
  }
}

class LogicalMapTargetOne extends LogicalMapTarget {
  one = 1
}

class LogicalMapTargetTwo extends LogicalMapTarget {
  two = 2
}

class LogicalMapSourceOne {
  one = 1
  map: LogicalMapTargetOne | null | undefined

  constructor(map: LogicalMapTargetOne | null | undefined) {
    this.map = map
  }
}

class LogicalMapSourceTwo {
  two = 2
  map: LogicalMapTargetTwo | null | undefined

  constructor(map: LogicalMapTargetTwo | null | undefined) {
    this.map = map
  }
}

class LogicalMapSourceThree {
  three = 3
  map: LogicalMapTargetOne | null | undefined

  constructor(map: LogicalMapTargetOne | null | undefined) {
    this.map = map
  }
}

type LogicalMapSource = LogicalMapSourceOne | LogicalMapSourceTwo | LogicalMapSourceThree

const logicalMapOf = (source: LogicalMapSource | null): LogicalMapTarget | null | undefined => source && source.map

const logicalMapTarget = new LogicalMapTargetTwo(42)

//! expect: logical-object-union-null=true
console.log(`logical-object-union-null=${logicalMapOf(null) === null}`)

//! expect: logical-object-union-undefined=true
console.log(`logical-object-union-undefined=${logicalMapOf(new LogicalMapSourceOne(undefined)) === undefined}`)

//! expect: logical-object-union-present=42
console.log(`logical-object-union-present=${logicalMapOf(new LogicalMapSourceTwo(logicalMapTarget))?.value}`)

//! expect: logical-object-union-third-null=true
console.log(`logical-object-union-third-null=${logicalMapOf(new LogicalMapSourceThree(null)) === null}`)
