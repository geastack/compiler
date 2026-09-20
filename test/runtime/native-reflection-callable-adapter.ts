interface Item {
  code: number
}

function run() {
  const original = (item: Item): void => {
    console.log(item.code)
  }
  const callback: (item: Item) => any = original
  //! expect: 7
  callback({ code: 7 })
}
run()
