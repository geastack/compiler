function make (flag) {
  return flag ? [] : {}
}
console.log(JSON.stringify(make(false)))
