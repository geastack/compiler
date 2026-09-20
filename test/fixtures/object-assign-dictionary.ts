type StringTable = Record<string, string>

const target = {} as StringTable
const source = { first: 'one', second: 'two' }
const result: StringTable = Object.assign(target, source)

console.log(result === target, Object.keys(result).join(','), result.first, result.second)

const dynamicSource: any = JSON.parse('{"third":3,"fourth":"four"}')
const dynamicTarget: Record<string, any> = {}
Object.assign(dynamicTarget, dynamicSource)
console.log(Object.keys(dynamicTarget).join(','), dynamicTarget.third, dynamicTarget.fourth)
