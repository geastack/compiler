let last = null
function add () { const item = { prev: last }; last = item; return item }
console.log(add().prev)
