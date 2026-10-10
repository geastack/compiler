//! expect: larger=large
//! expect: exact=small
interface Label {
  label: string
}

interface CountedLabel {
  label: string
  count: number
}

function chooseLabel(larger: boolean): Label {
  const value: CountedLabel | Label = larger ? { label: 'large', count: 7 } : { label: 'small' }
  return value
}

console.log('larger=' + chooseLabel(true).label)
console.log('exact=' + chooseLabel(false).label)
