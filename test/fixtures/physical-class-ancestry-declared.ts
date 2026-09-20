export class DeclaredBase {
  inherited = 7
}

export class DeclaredMiddle extends DeclaredBase {
  middle = 9
}

export class DeclaredDerived extends DeclaredMiddle {
  own = 11
}
