//! expect: label,values,nested
//! expect: sample/7/5
//! emitted-lacks: bool gea_readOwnField(
//! emitted-lacks: bool gea_ownFieldDescriptor(

function inspectNativeFields(): void {
  const data = { label: 'sample', values: [1, 2, 3], nested: { n: 4 } }
  data.values[1]! += 5
  data.nested.n += 1
  console.log(Object.keys(data).join(','))
  console.log(`${data.label}/${data.values[1]}/${data.nested.n}`)
}

inspectNativeFields()
