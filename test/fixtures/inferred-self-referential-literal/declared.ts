interface Item { prev: Item | null }
let last: Item | null = null
function add (): Item { const item: Item = { prev: last }; last = item; return item }
console.log(add().prev)
