let visited = ''

function label(value: number): number {
  visited += String(value)
  return value
}

function choose(value: number): number {
  switch (value) {
    case label(1):
    case label(2):
    case label(3):
      return 10
    case label(4):
    case label(5):
      return 20
    default:
      return 30
  }
}

console.log(choose(1), visited)
visited = ''
console.log(choose(2), visited)
visited = ''
console.log(choose(3), visited)
visited = ''
console.log(choose(4), visited)
visited = ''
console.log(choose(5), visited)
visited = ''
console.log(choose(6), visited)

const labels = {
  get second(): number {
    visited += 'getter'
    return 2
  }
}

function getterLabel(value: number): number {
  switch (value) {
    case 1:
    case labels.second:
      return 40
    default:
      return 50
  }
}

visited = ''
console.log(getterLabel(1), visited)
console.log(getterLabel(2), visited)
