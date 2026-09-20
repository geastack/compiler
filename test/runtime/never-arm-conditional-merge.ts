// tsc esDecorators.ts:1281: a conditional chain whose last arm is
// `Debug.fail()` (declared `never`) selects a `Statement[]` cell with `??=`
// in every other arm. A `never` arm has no value to merge -- control never
// continues past it -- but the census merged it as `void`:
// `merge-narrowing:void->array-object(...)` (17 rows in tsc).
type Statement = { text: string }
type ClassInfo = { staticStatements?: Statement[]; instanceStatements?: Statement[]; name: string }
function fail(message?: string): never {
  throw new Error(message ?? 'fail')
}
function statementsFor(info: ClassInfo, kind: number): Statement[] {
  return kind === 0 ? (info.staticStatements ??= []) : kind === 1 ? (info.instanceStatements ??= []) : fail('bad kind')
}
function labelFor(kind: number): string {
  return kind === 0 ? 'static' : kind === 1 ? 'instance' : fail()
}
const info: ClassInfo = { name: 'C' }
statementsFor(info, 0).push({ text: 'a' })
statementsFor(info, 1).push({ text: 'b' })
statementsFor(info, 0).push({ text: 'c' })
let caught = ''
try {
  statementsFor(info, 2)
} catch (error) {
  caught = (error as Error).message
}
console.log(info.staticStatements!.length, info.instanceStatements!.length, labelFor(1), caught)
//! expect: 2 1 instance bad kind
