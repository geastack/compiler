class TaggedFieldPayload {
  number = 31
}

class TaggedFieldCell {
  value: TaggedFieldPayload | null | undefined = new TaggedFieldPayload()
}

function readTaggedField(cell: TaggedFieldCell): number {
  if (cell.value === undefined) return -1
  if (cell.value === null) return -2
  return cell.value.number
}

const taggedCell = new TaggedFieldCell()
console.log(readTaggedField(taggedCell))
taggedCell.value = null
console.log(readTaggedField(taggedCell))
taggedCell.value = undefined
console.log(readTaggedField(taggedCell))
taggedCell.value = new TaggedFieldPayload()
console.log(readTaggedField(taggedCell))
