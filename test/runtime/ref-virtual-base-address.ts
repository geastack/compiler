class RefAddressRoot {
  marker = 'root'
}

class RefAddressMiddle extends RefAddressRoot {
  describe(): string {
    return 'middle'
  }
}

class RefAddressLeaf extends RefAddressMiddle {
  override describe(): string {
    return 'leaf'
  }
}

function rootMarker(value: RefAddressRoot): string {
  return value.marker
}

function virtualDescription(value: RefAddressMiddle): string {
  return value.describe()
}

const refAddressLeaf = new RefAddressLeaf()

//! expect: root
console.log(rootMarker(refAddressLeaf))
//! expect: leaf
console.log(virtualDescription(refAddressLeaf))
