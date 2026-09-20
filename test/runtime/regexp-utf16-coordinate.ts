export {}

const astral = '😀'
const sticky = /./y
sticky.lastIndex = 1
const low = sticky.exec(astral)

const described: any = /a/g
Object.defineProperty(described, 'lastIndex', {
  value: '4',
  writable: false,
  enumerable: false,
  configurable: false
})
let locked = false
try {
  described.lastIndex = 2
} catch {
  locked = true
}

console.log(
  `${low?.index}|${low?.[0].charCodeAt(0)}|${astral.replace(/(?:)/g, '-').length}|${astral
    .split(/(?:)/)
    .map((part) => part.charCodeAt(0))
    .join(',')}|${described.lastIndex}|${locked}`
)

//! expect: 1|56832|5|55357,56832|4|true
