// expect: 12
// emitted-lacks: bool gea_readOwnField(
// emitted-lacks: bool gea_ownFieldDescriptor(
function createTable(offset: number) {
  function makePayload(input: number) {
    return { label: 'payload', total: input + offset }
  }
  return { makePayload }
}
const table = createTable(5)
console.log(table.makePayload(7).total)
