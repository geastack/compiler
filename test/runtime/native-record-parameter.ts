class RecordParameterItem {
  constructor(public value: number) {}
}

function makeRecordParameterAccessors(offset: number) {
  function read(item: RecordParameterItem): number {
    return item.value + offset
  }
  return { read }
}

function makeRecordParameterReader(accessors: ReturnType<typeof makeRecordParameterAccessors>) {
  function read(item: RecordParameterItem): number {
    return accessors.read(item)
  }
  return { read }
}

const firstAccessors = makeRecordParameterAccessors(5)
const secondAccessors = makeRecordParameterAccessors(20)
const firstReader = makeRecordParameterReader(firstAccessors)
const secondReader = makeRecordParameterReader(secondAccessors)
const item = new RecordParameterItem(7)
console.log(firstReader.read(item), secondReader.read(item))
item.value = 11
console.log(firstReader.read(item), secondReader.read(item))

class RecordParameterHolder {
  constructor(public accessors: ReturnType<typeof makeRecordParameterAccessors>) {}
  read(item: RecordParameterItem): number {
    return this.accessors.read(item)
  }
}

class RecordParameterDefaultHolder {
  accessors = makeRecordParameterAccessors(30)
  read(item: RecordParameterItem): number {
    return this.accessors.read(item)
  }
}

const firstHolder = new RecordParameterHolder(firstAccessors)
const secondHolder = new RecordParameterHolder(secondAccessors)
const defaultHolder = new RecordParameterDefaultHolder()
console.log(firstHolder.read(item), secondHolder.read(item), defaultHolder.read(item))
item.value = 17
console.log(firstHolder.read(item), secondHolder.read(item), defaultHolder.read(item))

function retainRecordParameterHolder(holder: RecordParameterHolder): RecordParameterHolder {
  return holder
}

function readRecordParameterHolder(holder: RecordParameterHolder, value: RecordParameterItem): number {
  return holder.read(value)
}

firstHolder.accessors = makeRecordParameterAccessors(100)
console.log(readRecordParameterHolder(retainRecordParameterHolder(firstHolder), item), secondHolder.read(item), defaultHolder.read(item))

function readOptionalRecordParameterHolder(holder: RecordParameterHolder | undefined, value: RecordParameterItem): number {
  if (holder === undefined) return -1
  return holder.accessors.read(value)
}

console.log(readOptionalRecordParameterHolder(firstHolder, item), readOptionalRecordParameterHolder(undefined, item))
