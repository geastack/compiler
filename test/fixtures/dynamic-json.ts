const parsed = JSON.parse('{"name":"gea","count":3,"active":true,"items":[1,null,"x"]}')
console.log(JSON.stringify(parsed))
if (typeof parsed !== 'object' || parsed === null) throw new Error('expected object')
const parsedRecord = parsed as Record<string, any>
console.log(parsedRecord.name, parsedRecord.count, parsedRecord.active)

const table: Record<string, any> = {}
table['name'] = 'mongo'
table['count'] = 4
table['missing'] = undefined
console.log(JSON.stringify(table))
