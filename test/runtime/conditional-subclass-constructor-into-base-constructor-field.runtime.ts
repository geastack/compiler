// A database client's operations pick the response class they construct
// per operation (aggregate, find and list-collections all do):
//
//   override SERVER_COMMAND_RESPONSE_TYPE = CursorResponse
//   ...
//   this.SERVER_COMMAND_RESPONSE_TYPE = this.explain ? ExplainedCursorResponse : CursorResponse
//
// Both arms are constructors of the `typeof CursorResponse` family (one is a
// subclass), so the conditional is itself a `typeof CursorResponse` value and
// `new this.SERVER_COMMAND_RESPONSE_TYPE(bytes)` constructs whichever was
// chosen.
class BaseResponse {
  constructor(readonly bytes: Uint8Array) {}
  describe(): string {
    return 'base:' + this.bytes.length
  }
}

class ListResponse extends BaseResponse {
  describe(): string {
    return 'list:' + this.bytes.length
  }
}

class ExplainedListResponse extends ListResponse {
  isExplain = true
  describe(): string {
    return 'explained:' + this.bytes.length
  }
}

abstract class Operation {
  abstract RESPONSE_TYPE: typeof BaseResponse
  run(bytes: Uint8Array): string {
    return new this.RESPONSE_TYPE(bytes).describe()
  }
}

class ListOperation extends Operation {
  override RESPONSE_TYPE = ListResponse
  constructor(readonly explain: boolean) {
    super()
    this.RESPONSE_TYPE = this.explain ? ExplainedListResponse : ListResponse
  }
}

class PlainOperation extends Operation {
  override RESPONSE_TYPE = BaseResponse
}

//! expect: list:3 explained:2 base:1
console.log(
  new ListOperation(false).run(new Uint8Array(3)) +
    ' ' +
    new ListOperation(true).run(new Uint8Array(2)) +
    ' ' +
    new PlainOperation().run(new Uint8Array(1))
)
