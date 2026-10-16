// Node prints true. The existing synthetic static-block receiver allocates a
// fresh native owner; retain this separate observation until that path is fixed.
class IdentityObserved {
  static {
    console.log(this === IdentityObserved)
  }
}
