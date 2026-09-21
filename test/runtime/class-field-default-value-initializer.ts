//! expect: ||false|0|0|x|true|7|true
//! emitted-lacks: gea_this->emptyString =
//! emitted-lacks: gea_this->alsoEmpty =
//! emitted-lacks: gea_this->falseFlag =
//! emitted-lacks: gea_this->zero =
//! emitted-lacks: gea_this->zeroFloat =
//! emitted-has: gea_this->text =
//! emitted-has: gea_this->trueFlag =
//! emitted-has: gea_this->seven =
//! emitted-has: gea_this->negativeZero =

// A class field initializer that writes the value the field ALREADY holds.
//
// `gea::makeRef<T>()` value-initializes -- these structs declare no
// constructor, so `T()` zero-initializes and then default-constructs every
// member, and a `std::string` field is already `""` and a `bool` field
// already `false` before a single statement of the initializer sequence runs.
// The emitter called each field's initializer thunk anyway and assigned its
// result, which for a string is an out-of-line libstdc++ `_M_replace` per
// field per construction. `node:http`'s `ServerResponse` declares five such
// fields and is constructed once per request.
//
// The store is dropped only where dropping it cannot be observed, so this
// pins BOTH sides: the five defaults must lose their store and still read
// back as the default, and the four non-defaults must keep theirs. The
// runtime `expect:` alone could not tell an elision from a store of the same
// value, which is why the emission directives are here too -- they are what
// actually fails if the decision stops being made.
//
// `negativeZero` is a non-default on purpose: a value-initialized `double` is
// `+0.0`, and `-0` differs from it under `Object.is` and `1 / x`, so its store
// must survive. Writing this field is what found the separate defect that the
// integer-storage census accepted a `-0` and gave the member a `long long`,
// throwing the sign away before any of this ran; that is fixed, and
// `negative-zero-storage.ts` is where the sign itself is now asserted. This
// file keeps the field to pin the ELISION decision only -- one non-default
// whose value-initialized carrier is numerically equal to it, which is
// precisely the shape a too-eager elision would drop. It is still READ below,
// because a field nothing reads has its store dropped for an entirely
// different reason and would pin nothing.

class Fields {
  emptyString = ''
  alsoEmpty: string = ''
  falseFlag = false
  zero = 0
  zeroFloat = 0.0
  text = 'x'
  trueFlag = true
  seven = 7
  negativeZero = -0
}

const f = new Fields()
console.log(
  f.emptyString +
    '|' +
    f.alsoEmpty +
    '|' +
    String(f.falseFlag) +
    '|' +
    String(f.zero) +
    '|' +
    String(f.zeroFloat) +
    '|' +
    f.text +
    '|' +
    String(f.trueFlag) +
    '|' +
    String(f.seven) +
    '|' +
    String(f.negativeZero === 0)
)
