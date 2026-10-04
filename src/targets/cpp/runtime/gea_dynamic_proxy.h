// SPDX-License-Identifier: Apache-2.0
#pragma once

// Adapted from compiler-v1's value_12_proxy_object_internal_ops.h: retain the
// target, handler, receiver, and invariant checks across every boxed boundary.
namespace gea {

struct DynamicProxy {
  Value target;
  Value handler;
  bool revoked = false;
  friend void geaTraceRefs(const DynamicProxy& value, detail::RefVisitor& visitor) {
    detail::traceRefs(value.target, visitor);
    detail::traceRefs(value.handler, visitor);
  }
};

inline bool isObjectValue(const Value& value) {
  return value.tag() == Value::Tag::Object || value.tag() == Value::Tag::Function;
}

inline Value Value::proxy(Value target, Value handler) {
  if (!isObjectValue(target) || !isObjectValue(handler))
    host::throwRuntimeError("TypeError", "Proxy target and handler must be objects");
  Value value;
  value.tag_ = target.tag();
  value.proxy_ = true;
  value.held_ = gea::makeRef<DynamicProxy>(DynamicProxy{std::move(target), std::move(handler), false});
  return value;
}

namespace detail {
struct ProxyBoxCell {
  Value boxed;
  bool present = false;
};
inline std::shared_ptr<ProxyBoxCell> makeProxyBoxCell() { return std::make_shared<ProxyBoxCell>(); }
}  // namespace detail

/**
 * A native `ProxyObject` entering a `dynamic` slot: the same target and
 * handler, boxed, behind the dynamic proxy's own internal methods, so a trap
 * the native carrier does not dispatch (`apply`, an `any` receiver) still
 * runs. The box is minted once per proxy and every later boxing hands back
 * the same object, which is what keeps the proxy's identity across the
 * boundary. The two box texts are lambdas so a proxy already boxed boxes
 * nothing again.
 */
template <typename Target, typename Handler, typename BoxTarget, typename BoxHandler>
inline Value boxProxyObject(const ProxyObject<Target, Handler>& proxy, BoxTarget&& boxTarget, BoxHandler&& boxHandler) {
  const std::shared_ptr<detail::ProxyBoxCell>& cell = proxy.boxCell();
  if (cell && cell->present) return cell->boxed;
  Value boxed = Value::proxy(boxTarget(), boxHandler());
  if (cell) {
    cell->boxed = boxed;
    cell->present = true;
  }
  return boxed;
}

inline const DynamicProxy& Value::proxyState() const {
  if (!proxy_) host::throwRuntimeError("TypeError", "Expected a Proxy");
  const auto& state = *gea::refStaticCast<DynamicProxy>(held_);
  if (state.revoked) host::throwRuntimeError("TypeError", "Operation on a revoked Proxy");
  return state;
}

inline void Value::revokeProxy() {
  if (!proxy_) host::throwRuntimeError("TypeError", "Expected a Proxy");
  auto& state = *gea::refStaticCast<DynamicProxy>(held_);
  state.revoked = true;
  state.target = Value();
  state.handler = Value();
}

inline bool Value::isArrayPayload() const {
  return proxy_ ? proxyState().target.isArrayPayload() : metadata_->array;
}

enum class ToPrimitiveHint { Default, Number, String };

inline const char* toPrimitiveHintText(ToPrimitiveHint hint) {
  switch (hint) {
    case ToPrimitiveHint::Default: return "default";
    case ToPrimitiveHint::Number: return "number";
    case ToPrimitiveHint::String: return "string";
  }
  return "default";
}

inline Value ordinaryToPrimitive(const Value& value, ToPrimitiveHint hint) {
  const char* first = hint == ToPrimitiveHint::String ? "toString" : "valueOf";
  const char* second = hint == ToPrimitiveHint::String ? "valueOf" : "toString";
  for (const char* name : {first, second}) {
    const PropertyKey key = PropertyKey::string(name);
    const bool isToString = name[0] == 't';
    // A native callable's inherited Function.prototype.toString is one real
    // operation but is not modeled as a boxed callable. Keep its source fact
    // at this boundary; an own replacement still wins through the ordinary
    // property path below.
    const Ref<DynamicObject>& functionProperties = value.functionProperties();
    if (!value.isProxy() && value.tag() == Value::Tag::Function && isToString &&
        (!functionProperties || functionProperties->ownProperty(key) == nullptr))
      return Value::box(Value::Tag::String, value.functionSourceText());
    const bool present = value.hasProperty(key);
    if (!present && isToString &&
        (value.isDynamicObject() || value.isProxy() || value.isDynamicDictionaryPayload() ||
         (value.isNativeFieldPayload() && !value.isArrayPayload()))) {
      const Value tag = value.getProperty(PropertyKey::symbol(wellKnownSymbol(detail::WellKnownSymbol::ToStringTag)));
      const std::string tagText = tag.tag() == Value::Tag::String ? tag.as<std::string>() : std::string("Object");
      return Value::box(Value::Tag::String, std::string("[object ") + tagText + "]");
    }
    if (!present) continue;
    const Value method = value.getProperty(key);
    if (method.tag() != Value::Tag::Function) continue;
    const Value result = method.callWithReceiver(value, {});
    if (!isObjectValue(result)) return result;
  }
  host::throwRuntimeError("TypeError", "Cannot convert object to primitive value");
}

/**
 * ToPrimitive of a boxed typed array, which is always its ToString.
 *
 * A typed array is a native carrier with no dynamic property surface: it has no
 * `@@toPrimitive`, its `valueOf` is Object's and returns the object, and
 * nothing a program can do installs either on it. So 7.1.1 lands on
 * `%TypedArray%.prototype.toString` for every hint, and that is knowable from
 * the payload type alone -- without it the generic path below asks the box for
 * `@@toPrimitive` and the box, having no field table, refuses by name. A view
 * whose host brand states its own ToString (Node's Buffer) answers with that.
 */
template <typename Element>
inline bool boxedTypedArrayToStringAs(const Value& value, std::string& out) {
  using Handle = gea::Ref<TypedArray<Element>>;
  if (value.payloadType() != detail::payloadTypeTagFor<Handle>()) return false;
  const Handle& view = value.as<Handle>();
  if constexpr (std::is_same_v<Element, std::uint8_t>) {
    if (view) {
      if (const detail::HostViewToString render = detail::hostViewToStringFor(view->hostBrand())) {
        out = render(*view);
        return true;
      }
    }
  }
  out = runtime::array::join(view);
  return true;
}

inline bool boxedTypedArrayToString(const Value& value, std::string& out) {
  if (value.tag() != Value::Tag::Object || value.isProxy()) return false;
  return boxedTypedArrayToStringAs<std::uint8_t>(value, out) || boxedTypedArrayToStringAs<std::int8_t>(value, out) ||
         boxedTypedArrayToStringAs<ClampedUint8>(value, out) || boxedTypedArrayToStringAs<std::int16_t>(value, out) ||
         boxedTypedArrayToStringAs<std::uint16_t>(value, out) || boxedTypedArrayToStringAs<std::int32_t>(value, out) ||
         boxedTypedArrayToStringAs<std::uint32_t>(value, out) || boxedTypedArrayToStringAs<float>(value, out) ||
         boxedTypedArrayToStringAs<double>(value, out);
}

inline Value dynamicToPrimitive(const Value& value, ToPrimitiveHint hint = ToPrimitiveHint::Default) {
  if (!isObjectValue(value)) return value;
  if (std::string text; boxedTypedArrayToString(value, text)) return Value::box(Value::Tag::String, std::move(text));
  const Value exotic = value.getProperty(PropertyKey::symbol(wellKnownSymbol(detail::WellKnownSymbol::ToPrimitive)));
  if (exotic.tag() != Value::Tag::Undefined && exotic.tag() != Value::Tag::Null) {
    if (exotic.tag() != Value::Tag::Function) host::throwRuntimeError("TypeError", "@@toPrimitive is not callable");
    const Value result = exotic.callWithReceiver(value, {Value::box(Value::Tag::String, std::string(toPrimitiveHintText(hint)))});
    if (isObjectValue(result)) host::throwRuntimeError("TypeError", "@@toPrimitive must return a primitive value");
    return result;
  }
  return ordinaryToPrimitive(value, hint);
}

inline std::string dynamicToString(const Value& input) {
  const Value primitive = dynamicToPrimitive(input, ToPrimitiveHint::String);
  if (primitive.tag() == Value::Tag::Symbol) host::throwRuntimeError("TypeError", "Cannot convert a Symbol value to a string");
  return host::detail::toString(primitive);
}

/**
 * ECMA-262 7.1.17 ToString of a string-keyed table (`{ [key: string]: T }`),
 * read off the table itself rather than through a box of it.
 *
 * A table holds only string keys, so it has no `@@toPrimitive` of its own and
 * ToPrimitive(hint string) is OrdinaryToPrimitive (7.1.1.1): `toString`, then
 * `valueOf`, each called when it is callable and answering when it returns a
 * primitive. A table has no prototype of its own -- it is an ordinary object
 * over `Object.prototype` -- so a missing `toString` is
 * `Object.prototype.toString`, whose tag walk (20.1.3.6) answers
 * "[object Object]", and a missing `valueOf` returns the object and is passed.
 *
 * The receiver a stored function is called with is the table as a `Value`:
 * the callee is itself an `any` function whose `this` is dynamic by ABI. A
 * VIEW of another object (`gea::dictionary::aliasOf`) answers with that
 * object's own ToString, `@@toPrimitive` and prototype chain included.
 *
 * A table whose values can hold no callable (`Record<string, number>`) finds
 * no method to call: an own `toString` or `valueOf` key shadows the inherited
 * method with a non-callable, and nothing then yields a primitive.
 */
template <typename V>
inline std::string dictionaryToString(const Ref<Dictionary<V>>& table) {
  if constexpr (std::is_same_v<V, Value>) {
    if (const auto* alias = table->alias()) return dynamicToString(alias->object);
    for (const char* name : {"toString", "valueOf"}) {
      if (!table->has(name)) {
        if (name[0] == 't') return "[object Object]";
        continue;
      }
      const Value method = table->read(name);
      if (method.tag() != Value::Tag::Function) continue;
      const Value result = method.callWithReceiver(Value::box(Value::Tag::Object, table), {});
      if (isObjectValue(result)) continue;
      if (result.tag() == Value::Tag::Symbol) host::throwRuntimeError("TypeError", "Cannot convert a Symbol value to a string");
      return host::detail::toString(result);
    }
  } else {
    if (!table->has("toString")) return "[object Object]";
  }
  host::throwRuntimeError("TypeError", "Cannot convert object to primitive value");
}

inline double dynamicToNumber(const Value& input) {
  const Value value = dynamicToPrimitive(input, ToPrimitiveHint::Number);
  switch (value.tag()) {
    case Value::Tag::Number: return value.as<double>();
    case Value::Tag::Boolean: return value.as<bool>() ? 1 : 0;
    case Value::Tag::Null: return 0;
    case Value::Tag::Undefined: return std::numeric_limits<double>::quiet_NaN();
    case Value::Tag::String: return host::detail::toNumber(value.as<std::string>());
    default: host::throwRuntimeError("TypeError", "Cannot convert this value to a number");
  }
}

inline Value dynamicAdd(const Value& left, const Value& right) {
  const Value a = dynamicToPrimitive(left);
  const Value b = dynamicToPrimitive(right);
  if (a.tag() == Value::Tag::Symbol || b.tag() == Value::Tag::Symbol)
    host::throwRuntimeError("TypeError", "Cannot convert a Symbol for addition");
  if (a.tag() == Value::Tag::String || b.tag() == Value::Tag::String)
    return Value::box(Value::Tag::String, host::detail::toString(a) + host::detail::toString(b));
  if (a.tag() == Value::Tag::BigInt && b.tag() == Value::Tag::BigInt)
    return Value::box(Value::Tag::BigInt, a.as<BigInt>() + b.as<BigInt>());
  return Value::box(Value::Tag::Number, dynamicToNumber(a) + dynamicToNumber(b));
}

namespace detail {
/** ECMA-262 7.1.20 ToLength over an already-converted Number: NaN and negatives are 0, the rest clamp to 2^53 - 1. */
inline std::size_t arrayLikeLength(double length) {
  if (!(length > 0)) return 0;
  return static_cast<std::size_t>(std::min(std::floor(length), 9007199254740991.0));
}

template <typename Target, typename Element>
inline bool typedArraySetFromBoxedAs(TypedArray<Target>& target, const Value& source, double offset) {
  using Handle = gea::Ref<TypedArray<Element>>;
  if (source.payloadType() != payloadTypeTagFor<Handle>()) return false;
  const Handle& view = source.as<Handle>();
  if (!view) return false;
  target.setFrom(*view, offset);
  return true;
}
}  // namespace detail

/**
 * `%TypedArray%.prototype.set(source, offset)` (ECMA-262 23.2.3.26) from a
 * source whose carrier is `dynamic`. The specification chooses the algorithm
 * from the value itself, so this does too: a boxed typed array of any element
 * type is copied through its own element type by the same `setFrom` a
 * statically typed source takes (SetTypedArrayFromTypedArray, overlap and
 * all), and every other value is SetTypedArrayFromArrayLike (23.2.3.26.2):
 * ToObject, LengthOfArrayLike, the range check, then one [[Get]] and one
 * ToNumber per index, in index order, each written as it is read. three's
 * `previousBoneMatrices.set( skeleton.boneMatrices )` reaches here with the
 * skeleton read off an untyped callback argument.
 *
 * The offset follows `setFrom`'s rule (a named abort for a value that is not
 * an index, and for a source that would run past the end) so the two paths
 * cannot disagree on a RangeError.
 */
template <typename T>
inline void typedArraySetFromValue(TypedArray<T>& target, const Value& source, double offset) {
  if (detail::typedArraySetFromBoxedAs<T, std::uint8_t>(target, source, offset) || detail::typedArraySetFromBoxedAs<T, std::int8_t>(target, source, offset) ||
      detail::typedArraySetFromBoxedAs<T, ClampedUint8>(target, source, offset) || detail::typedArraySetFromBoxedAs<T, std::int16_t>(target, source, offset) ||
      detail::typedArraySetFromBoxedAs<T, std::uint16_t>(target, source, offset) ||
      detail::typedArraySetFromBoxedAs<T, std::int32_t>(target, source, offset) ||
      detail::typedArraySetFromBoxedAs<T, std::uint32_t>(target, source, offset) || detail::typedArraySetFromBoxedAs<T, float>(target, source, offset) ||
      detail::typedArraySetFromBoxedAs<T, double>(target, source, offset))
    return;
  const std::size_t start = detail::typedArrayLengthIndex(offset);
  // Step 4's ToObject: the only values it rejects are null and undefined.
  if (source.tag() == Value::Tag::Null || source.tag() == Value::Tag::Undefined)
    host::throwRuntimeError("TypeError", "Cannot convert undefined or null to object");
  const std::size_t count = detail::arrayLikeLength(dynamicToNumber(source.getProperty(PropertyKey::string("length"))));
  if (start > target.size() || count > target.size() - start) {
    std::fprintf(stderr, "gea: TypedArray.prototype.set source of length %zu at offset %zu does not fit a view of length %zu (RangeError)\n", count, start,
                 target.size());
    gea::detail::abortAfterFlush();
  }
  // TypedArraySetElement (10.4.5.16) converts before it checks the index, and
  // drops the write when a conversion's side effect left the index invalid --
  // exactly `setElementAtIndex`.
  for (std::size_t index = 0; index < count; ++index) {
    const double number = dynamicToNumber(source.getProperty(PropertyKey::number(static_cast<double>(index))));
    target.setElementAtIndex(static_cast<long long>(start + index), number);
  }
}

/**
 * `Array.from(items)` (ECMA-262 23.1.2.1, no mapper) from a source whose
 * carrier is `dynamic`, into an Array of boxed values. GetMethod(@@iterator)
 * decides between the two algorithms: an iterable is drained through its own
 * iterator, anything else is read as an array-like (ToObject, then
 * LengthOfArrayLike and one [[Get]] per index -- a hole reads `undefined`).
 *
 * A boxed Array or string answers no `@@iterator` from its box, so it takes
 * the intrinsic iterator `runtime::iterator::getIterator` already supplies for
 * it (a string iterates by code point, which the array-like path would not).
 * A boxed typed array refuses a symbol read off its chain by design; its
 * intrinsic `@@iterator` (unless the box holds its own) is
 * `%TypedArray%.prototype.values`, which visits exactly the indices below its
 * length, so it reads as the array-like it also is. three's
 * `Array.from( image.data )` over a DataTexture's pixel array reaches here.
 */
inline gea::Ref<ArrayObject<Value>> arrayFromValue(const Value& items) {
  if (items.tag() == Value::Tag::Null || items.tag() == Value::Tag::Undefined)
    host::throwRuntimeError("TypeError", "Array.from requires an iterable or array-like object, not null or undefined");
  auto out = gea::makeRef<ArrayObject<Value>>();
  const PropertyKey iteratorKey = PropertyKey::symbol(wellKnownSymbol(detail::WellKnownSymbol::Iterator));
  detail::BoxedByteBlockBrand brand;
  PropertyDescriptor own;
  const bool typedArray = detail::boxedByteBlockBrand(items, brand) && brand.kind == detail::BoxedByteBlockBrand::Kind::TypedArray &&
                          !items.ownDescriptor(iteratorKey, own);
  if (!typedArray) {
    const Value method = items.getProperty(iteratorKey);
    if (method.tag() != Value::Tag::Undefined && method.tag() != Value::Tag::Null) {
      if (method.tag() != Value::Tag::Function) host::throwRuntimeError("TypeError", "Array.from source's Symbol.iterator is not a function");
      const Value iterator = method.callWithReceiver(items, {});
      if (!isObjectValue(iterator)) host::throwRuntimeError("TypeError", "Result of the Symbol.iterator method is not an object");
      runtime::iterator::appendGather(*out, iterator);
      return out;
    }
    if (items.isArrayPayload() || items.tag() == Value::Tag::String) {
      runtime::iterator::appendGather(*out, items.tag() == Value::Tag::String ? runtime::iterator::stringIterator(items) : runtime::iterator::arrayIterator(items));
      return out;
    }
  }
  const std::size_t length = detail::arrayLikeLength(dynamicToNumber(items.getProperty(PropertyKey::string("length"))));
  for (std::size_t index = 0; index < length; ++index) out->push(items.getProperty(PropertyKey::number(static_cast<double>(index))));
  return out;
}

inline Value dynamicArrayPrototypeGet(const PropertyKey& key) {
  if (key.isSymbol()) return Value();
  using Args = gea::Ref<ArrayObject<Value>>;
  using Method = CallableObject<Value(Value, Args)>;
  if (key.text() == "push") {
    static const Value method = Value::boxMethod<1>(Method(+[](void*, Value receiver, Args args) -> Value {
      double length = dynamicToNumber(receiver.getProperty(PropertyKey::string("length")));
      for (std::size_t i = 0; i < args->size(); ++i) receiver.setProperty(PropertyKey::string(std::to_string(static_cast<std::size_t>(length++))), args->at(i));
      receiver.setProperty(PropertyKey::string("length"), Value::box(Value::Tag::Number, length));
      return Value::box(Value::Tag::Number, length);
    }, nullptr));
    return method;
  }
  if (key.text() == "pop") {
    static const Value method = Value::boxMethod<1>(Method(+[](void*, Value receiver, Args) -> Value {
      double length = dynamicToNumber(receiver.getProperty(PropertyKey::string("length")));
      Value result;
      if (length > 0) {
        const auto index = PropertyKey::string(std::to_string(static_cast<std::size_t>(--length)));
        result = receiver.getProperty(index);
        if (!receiver.deleteProperty(index)) host::throwRuntimeError("TypeError", "Cannot delete array element");
      }
      receiver.setProperty(PropertyKey::string("length"), Value::box(Value::Tag::Number, length));
      return result;
    }, nullptr));
    return method;
  }
  if (key.text() == "toString" || key.text() == "join" || key.text() == "map" || key.text() == "filter" || key.text() == "forEach" || key.text() == "slice" ||
      key.text() == "indexOf" || key.text() == "lastIndexOf" || key.text() == "includes" || key.text() == "splice") {
    static const std::map<std::string, Value> methods = [] {
      std::map<std::string, Value> result;
      for (const char* name : {"join", "map", "filter", "forEach", "slice", "indexOf", "lastIndexOf", "includes", "splice"}) {
        auto callable = Method(+[](void* environment, Value receiver, Args args) -> Value {
          alignas(void*) unsigned char slot[sizeof(void*)];
          const std::string& method = *gea::unpackEnvironment<std::string>(environment, slot);
          const double rawLength = dynamicToNumber(receiver.getProperty(PropertyKey::string("length")));
          const std::size_t length = rawLength > 0 ? static_cast<std::size_t>(std::min(std::floor(rawLength), 9007199254740991.0)) : 0;
          const Value first = args->size() ? args->at(0) : Value();
          const auto indexKey = [](std::size_t index) { return PropertyKey::string(std::to_string(index)); };
          // ToIntegerOrInfinity (7.1.5): NaN is 0, and the infinities stay
          // infinite so a clamp below sends them to either end.
          const auto integerOf = [](const Value& value) {
            const double number = dynamicToNumber(value);
            return std::isnan(number) ? 0.0 : std::trunc(number);
          };
          // 23.1.3.17 / 23.1.3.20 / 23.1.3.16: the search methods. `indexOf`
          // and `lastIndexOf` skip holes and compare strictly; `includes`
          // reads holes as `undefined` and compares with SameValueZero.
          if (method == "indexOf" || method == "includes") {
            const Value fromIndex = args->size() > 1 ? args->at(1) : Value();
            const double n = fromIndex.tag() == Value::Tag::Undefined ? 0.0 : integerOf(fromIndex);
            const bool includes = method == "includes";
            if (n >= static_cast<double>(length)) return includes ? Value::box(Value::Tag::Boolean, false) : Value::box(Value::Tag::Number, -1.0);
            const std::size_t from = n >= 0 ? static_cast<std::size_t>(n) : static_cast<std::size_t>(std::max(static_cast<double>(length) + n, 0.0));
            for (std::size_t i = from; i < length; ++i) {
              const auto index = indexKey(i);
              if (includes) {
                if (sameValueZero<Value>(receiver.getProperty(index), first)) return Value::box(Value::Tag::Boolean, true);
              } else if (receiver.hasProperty(index) && Value::strictEquals(receiver.getProperty(index), first)) {
                return Value::box(Value::Tag::Number, static_cast<double>(i));
              }
            }
            return includes ? Value::box(Value::Tag::Boolean, false) : Value::box(Value::Tag::Number, -1.0);
          }
          if (method == "lastIndexOf") {
            if (length == 0) return Value::box(Value::Tag::Number, -1.0);
            const double n = args->size() > 1 ? integerOf(args->at(1)) : static_cast<double>(length) - 1;
            const double start = n >= 0 ? std::min(n, static_cast<double>(length) - 1) : static_cast<double>(length) + n;
            for (double k = start; k >= 0; --k) {
              const auto index = indexKey(static_cast<std::size_t>(k));
              if (receiver.hasProperty(index) && Value::strictEquals(receiver.getProperty(index), first)) return Value::box(Value::Tag::Number, k);
            }
            return Value::box(Value::Tag::Number, -1.0);
          }
          // 23.1.3.31, generically over the receiver's own get/set/delete, as
          // `push` and `pop` above are: the removed elements come back as a
          // new array, the tail moves, and `length` is set last.
          if (method == "splice") {
            const auto clampToLength = [&](double relative) {
              return static_cast<std::size_t>(relative < 0 ? std::max(static_cast<double>(length) + relative, 0.0) : std::min(relative, static_cast<double>(length)));
            };
            const std::size_t start = args->size() ? clampToLength(integerOf(first)) : 0;
            const std::size_t deleteCount = args->size() == 0 ? 0
              : args->size() == 1 ? length - start
              : static_cast<std::size_t>(std::clamp(integerOf(args->at(1)), 0.0, static_cast<double>(length - start)));
            const std::size_t itemCount = args->size() > 2 ? args->size() - 2 : 0;
            auto removed = gea::makeRef<ArrayObject<Value>>();
            for (std::size_t k = 0; k < deleteCount; ++k) {
              const auto from = indexKey(start + k);
              if (receiver.hasProperty(from)) removed->push(receiver.getProperty(from));
              else removed->pushHole();
            }
            const auto move = [&](std::size_t fromIndex, std::size_t toIndex) {
              const auto from = indexKey(fromIndex);
              const auto to = indexKey(toIndex);
              if (receiver.hasProperty(from)) receiver.setProperty(to, receiver.getProperty(from));
              else if (!receiver.deleteProperty(to)) host::throwRuntimeError("TypeError", "Cannot delete array element");
            };
            if (itemCount < deleteCount) {
              for (std::size_t k = start; k < length - deleteCount; ++k) move(k + deleteCount, k + itemCount);
              for (std::size_t k = length; k > length - deleteCount + itemCount; --k)
                if (!receiver.deleteProperty(indexKey(k - 1))) host::throwRuntimeError("TypeError", "Cannot delete array element");
            } else if (itemCount > deleteCount) {
              for (std::size_t k = length - deleteCount; k > start; --k) move(k + deleteCount - 1, k + itemCount - 1);
            }
            for (std::size_t i = 0; i < itemCount; ++i) receiver.setProperty(indexKey(start + i), args->at(i + 2));
            receiver.setProperty(PropertyKey::string("length"), Value::box(Value::Tag::Number, static_cast<double>(length - deleteCount + itemCount)));
            return Value::box(Value::Tag::Object, removed);
          }
          if (method == "join") {
            const std::string separator = first.tag() == Value::Tag::Undefined ? "," : host::detail::toString(first);
            std::string text;
            for (std::size_t i = 0; i < length; ++i) {
              if (i) text += separator;
              const Value item = receiver.getProperty(PropertyKey::string(std::to_string(i)));
              if (item.tag() != Value::Tag::Undefined && item.tag() != Value::Tag::Null) text += host::detail::toString(item);
            }
            return Value::box(Value::Tag::String, text);
          }
          auto output = gea::makeRef<ArrayObject<Value>>();
          if (method == "slice") {
            const auto bound = [&](const Value& value, std::size_t fallback) {
              if (value.tag() == Value::Tag::Undefined) return fallback;
              const double number = dynamicToNumber(value);
              if (std::isnan(number)) return std::size_t{0};
              const double integer = std::trunc(number);
              return static_cast<std::size_t>(std::clamp(integer < 0 ? static_cast<double>(length) + integer : integer, 0.0, static_cast<double>(length)));
            };
            const std::size_t from = bound(first, 0);
            const std::size_t to = bound(args->size() > 1 ? args->at(1) : Value(), length);
            for (std::size_t i = from; i < to; ++i) {
              const auto index = PropertyKey::string(std::to_string(i));
              if (receiver.hasProperty(index)) output->push(receiver.getProperty(index));
              else output->pushHole();
            }
            return Value::box(Value::Tag::Object, output);
          }
          if (first.tag() != Value::Tag::Function) host::throwRuntimeError("TypeError", "Array callback must be callable");
          const Value thisArg = args->size() > 1 ? args->at(1) : Value();
          for (std::size_t i = 0; i < length; ++i) {
            const auto index = PropertyKey::string(std::to_string(i));
            if (!receiver.hasProperty(index)) { if (method == "map") output->pushHole(); continue; }
            const Value item = receiver.getProperty(index);
            const Value returned = first.callWithReceiver(thisArg, {item, Value::box(Value::Tag::Number, static_cast<double>(i)), receiver});
            if (method == "map") output->push(returned);
            if (method == "filter" && host::detail::toBoolean(returned)) output->push(item);
          }
          return method == "forEach" ? Value() : Value::box(Value::Tag::Object, output);
        }, gea::packEnvironment<std::string>(std::string(name)));
        result.emplace(name, Value::boxMethod<1>(callable));
      }
      return result;
    }();
    return methods.at(key.text() == "toString" ? "join" : key.text());
  }
  return Value();
}

/**
 * `String.prototype`'s methods read off a string the program declared `any`
 * (`name.toLowerCase()` after `name = \`${name}\``). Each is the native
 * string function the typed path already calls, reached through the boxed
 * receiver; the receiver is converted with ToString, which for the string
 * primitive these are read off is the string itself. A method not listed
 * reads `undefined`, so calling it is the language's own TypeError rather
 * than an answer this table invented.
 */
inline Value dynamicStringPrototypeGet(const PropertyKey& key) {
  if (key.isSymbol()) return Value();
  using Args = gea::Ref<ArrayObject<Value>>;
  using Method = CallableObject<Value(Value, Args)>;
  static const std::map<std::string, Value> methods = [] {
    std::map<std::string, Value> result;
    for (const char* name : {"toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase", "trim", "trimStart", "trimEnd",
                             "toString", "valueOf", "includes", "startsWith", "endsWith", "indexOf", "slice", "charAt"}) {
      auto callable = Method(+[](void* environment, Value receiver, Args args) -> Value {
        alignas(void*) unsigned char slot[sizeof(void*)];
        const std::string& method = *gea::unpackEnvironment<std::string>(environment, slot);
        if (receiver.tag() == Value::Tag::Null || receiver.tag() == Value::Tag::Undefined)
          host::throwRuntimeError("TypeError", "String.prototype method called on null or undefined");
        const std::string text = dynamicToString(receiver);
        const Value first = args->size() ? args->at(0) : Value();
        const Value second = args->size() > 1 ? args->at(1) : Value();
        const auto string = [](std::string value) { return Value::box(Value::Tag::String, std::move(value)); };
        const auto position = [](const Value& value, double fallback) {
          if (value.tag() == Value::Tag::Undefined) return fallback;
          const double number = dynamicToNumber(value);
          return std::isnan(number) ? 0.0 : std::trunc(number);
        };
        if (method == "toLowerCase" || method == "toLocaleLowerCase") return string(runtime::string::toLowerCase(text));
        if (method == "toUpperCase" || method == "toLocaleUpperCase") return string(runtime::string::toUpperCase(text));
        if (method == "trim") return string(runtime::string::trim(text));
        if (method == "trimStart") return string(runtime::string::trimStart(text));
        if (method == "trimEnd") return string(runtime::string::trimEnd(text));
        if (method == "toString" || method == "valueOf") return string(text);
        if (method == "slice") return string(runtime::string::slice(text, position(first, 0.0), position(second, std::numeric_limits<double>::infinity())));
        if (method == "charAt") return string(runtime::string::charAt(text, position(first, 0.0)));
        const std::string needle = dynamicToString(first);
        if (method == "indexOf") return Value::box(Value::Tag::Number, runtime::string::indexOf(text, needle, position(second, 0.0)));
        if (method == "includes") return Value::box(Value::Tag::Boolean, runtime::string::includes(text, needle, position(second, 0.0)));
        if (method == "startsWith") return Value::box(Value::Tag::Boolean, runtime::string::startsWith(text, needle, position(second, 0.0)));
        return Value::box(Value::Tag::Boolean, runtime::string::endsWith(text, needle, position(second, std::numeric_limits<double>::infinity())));
      }, gea::packEnvironment<std::string>(std::string(name)));
      result.emplace(name, Value::boxMethod<1>(callable));
    }
    return result;
  }();
  const auto found = methods.find(key.text());
  return found == methods.end() ? Value() : found->second;
}

// The intrinsic is one ordinary native array with its own method properties.
// Identity sidecars already carry descriptors on arrays; a new representation
// or a boxed array would lose that existing native ownership for no reason.
inline Ref<ArrayObject<Value>> arrayPrototypeObject() {
  static const Ref<ArrayObject<Value>> prototype = [] {
    auto object = makeRef<ArrayObject<Value>>();
    for (const char* name : {"push", "pop", "join", "toString", "map", "filter", "forEach", "slice", "indexOf", "lastIndexOf", "includes", "splice"}) {
      const auto key = PropertyKey::string(name);
      auto descriptor = PropertyDescriptor::assignment(dynamicArrayPrototypeGet(key));
      descriptor.enumerable = false;
      nativeDynamicDefineProperty(object, key, descriptor);
    }
    return object;
  }();
  return prototype;
}

inline Value propertyKeyValue(const PropertyKey& key) {
  return key.isSymbol()
      ? Value::box(Value::Tag::Symbol, Symbol(static_cast<std::uint32_t>(key.symbolId())))
      : Value::box(Value::Tag::String, key.text());
}

inline Value proxyTrap(const DynamicProxy& state, const char* name) {
  Value trap = state.handler.getProperty(PropertyKey::string(name));
  if (trap.tag() == Value::Tag::Null) return Value();
  if (trap.tag() != Value::Tag::Undefined && trap.tag() != Value::Tag::Function)
    host::throwRuntimeError("TypeError", std::string("Proxy trap is not callable: ") + name);
  return trap;
}

inline PropertyDescriptor proxyDescriptorFrom(const Value& value) {
  if (!isObjectValue(value)) host::throwRuntimeError("TypeError", "A property descriptor must be an object");
  PropertyDescriptor result;
  const auto read = [&](const char* name, bool& present) {
    const auto key = PropertyKey::string(name);
    present = value.hasProperty(key);
    return present ? value.getProperty(key) : Value();
  };
  result.enumerable = host::detail::toBoolean(read("enumerable", result.hasEnumerable));
  result.configurable = host::detail::toBoolean(read("configurable", result.hasConfigurable));
  result.value = read("value", result.hasValue);
  result.writable = host::detail::toBoolean(read("writable", result.hasWritable));
  Value getter = read("get", result.hasGet);
  Value setter = read("set", result.hasSet);
  if (getter.tag() != Value::Tag::Undefined) {
    if (getter.tag() != Value::Tag::Function) host::throwRuntimeError("TypeError", "Descriptor getter must be callable");
    result.getIdentity = getter.identity();
    result.getterValue = getter;
    result.get = [getter](const Value& receiver) { return getter.callWithReceiver(receiver, {}); };
  }
  if (setter.tag() != Value::Tag::Undefined) {
    if (setter.tag() != Value::Tag::Function) host::throwRuntimeError("TypeError", "Descriptor setter must be callable");
    result.setIdentity = setter.identity();
    result.setterValue = setter;
    result.set = [setter](const Value& receiver, const Value& value) { setter.callWithReceiver(receiver, {value}); };
  }
  if (result.isAccessor() && result.isData()) host::throwRuntimeError("TypeError", "Descriptor mixes accessors and a data value");
  return result;
}

inline bool compatibleProxyDescriptor(bool extensible, const PropertyDescriptor& incoming, const PropertyDescriptor* current) {
  DynamicObject scratch;
  const auto key = PropertyKey::string("property");
  if (current) scratch.defineOwnProperty(key, *current);
  if (!extensible) scratch.preventExtensions();
  return scratch.defineOwnProperty(key, incoming);
}

inline bool dynamicProxyDescriptor(const Value& proxy, const PropertyKey& key, PropertyDescriptor& out) {
  const DynamicProxy state = proxy.proxyState();
  Value trap = proxyTrap(state, "getOwnPropertyDescriptor");
  if (trap.tag() == Value::Tag::Undefined) return state.target.ownDescriptor(key, out);
  const Value result = trap.callWithReceiver(state.handler, {state.target, propertyKeyValue(key)});
  PropertyDescriptor current;
  const bool exists = state.target.ownDescriptor(key, current);
  const bool extensible = state.target.isExtensible();
  if (result.tag() == Value::Tag::Undefined) {
    if (exists && (!current.configurable || !extensible)) host::throwRuntimeError("TypeError", "Proxy descriptor trap hid a protected property");
    return false;
  }
  DynamicObject complete;
  complete.defineOwnProperty(key, proxyDescriptorFrom(result));
  out = *complete.ownProperty(key);
  if (!compatibleProxyDescriptor(extensible, out, exists ? &current : nullptr) ||
      (!out.configurable && (!exists || current.configurable || (out.isData() && !out.writable && current.writable))))
    host::throwRuntimeError("TypeError", "Proxy descriptor trap violated a protected property");
  return true;
}

inline void Value::freezeIntegrity() const {
  if (tag_ == Tag::Function) {
    functionProperties()->freezeIntegrity();
    return;
  }
  if (proxy_) host::throwRuntimeError("TypeError", "Object.freeze over a Proxy is not implemented");
  if (dynamic_) {
    asDynamicObject()->freezeIntegrity();
    return;
  }
  if (tag_ != Tag::Object) return;
  if (metadata_->fields != nullptr) metadata_->fields->freezeIndex(payload());
  if (metadata_->elements != nullptr) metadata_->elements->freeze(payload());
  detail::expandoFor(expandoAnchor(), true)->freezeIntegrity();
}

inline bool Value::hasFrozenIntegrity() const {
  if (tag_ == Tag::Function) return functionProperties()->hasFrozenIntegrity();
  if (proxy_) host::throwRuntimeError("TypeError", "Object.isFrozen over a Proxy is not implemented");
  if (dynamic_) return asDynamicObject()->hasFrozenIntegrity();
  // Primitives have no own properties and cannot be extended, so the
  // integrity predicate is vacuously true (ECMA-262 TestIntegrityLevel).
  if (tag_ != Tag::Object) return true;
  const auto expando = detail::expandoFor(expandoAnchor(), false);
  if (!expando || !expando->hasFrozenIntegrity()) return false;
  return metadata_->elements == nullptr || metadata_->elements->frozen(payload());
}

inline bool Value::isExtensible() const {
  if (tag_ == Tag::Function) return functionProperties()->extensible();
  if (proxy_) {
    const DynamicProxy state = proxyState();
    Value trap = proxyTrap(state, "isExtensible");
    if (trap.tag() == Tag::Undefined) return state.target.isExtensible();
    const bool result = host::detail::toBoolean(trap.callWithReceiver(state.handler, {state.target}));
    if (result != state.target.isExtensible()) host::throwRuntimeError("TypeError", "Proxy isExtensible trap disagrees with its target");
    return result;
  }
  if (dynamic_) return asDynamicObject()->extensible();
  if (metadata_->fields != nullptr && !metadata_->fields->extensible(payload())) return false;
  if (metadata_->elements != nullptr && metadata_->elements->frozen(payload())) return false;
  const auto expando = detail::expandoFor(expandoAnchor(), false);
  return !expando || expando->extensible();
}

inline std::vector<PropertyKey> Value::ownPropertyKeys() const {
  if (proxy_) {
    const DynamicProxy state = proxyState();
    Value trap = proxyTrap(state, "ownKeys");
    if (trap.tag() == Tag::Undefined) return state.target.ownPropertyKeys();
    Value result = trap.callWithReceiver(state.handler, {state.target});
    if (!isObjectValue(result)) host::throwRuntimeError("TypeError", "Proxy ownKeys trap must return an object");
    const double rawLength = dynamicToNumber(result.getProperty(PropertyKey::string("length")));
    const std::size_t length = rawLength > 0 ? static_cast<std::size_t>(std::min(std::floor(rawLength), 9007199254740991.0)) : 0;
    std::vector<PropertyKey> keys;
    for (std::size_t i = 0; i < length; ++i) {
      const Value item = result.getProperty(PropertyKey::string(std::to_string(i)));
      if (item.tag() != Tag::String && item.tag() != Tag::Symbol) host::throwRuntimeError("TypeError", "Proxy ownKeys item must be string or symbol");
      const auto key = host::toPropertyKey(item);
      if (std::find(keys.begin(), keys.end(), key) != keys.end()) host::throwRuntimeError("TypeError", "Proxy ownKeys returned duplicate keys");
      keys.push_back(key);
    }
    const bool extensible = state.target.isExtensible();
    const auto targetKeys = state.target.ownPropertyKeys();
    for (const auto& key : targetKeys) {
      PropertyDescriptor descriptor;
      state.target.ownDescriptor(key, descriptor);
      if ((!extensible || !descriptor.configurable) && std::find(keys.begin(), keys.end(), key) == keys.end())
        host::throwRuntimeError("TypeError", "Proxy ownKeys hid a protected key");
    }
    if (!extensible && keys.size() != targetKeys.size()) host::throwRuntimeError("TypeError", "Proxy ownKeys added keys to a non-extensible target");
    return keys;
  }
  if (dynamic_) return asDynamicObject()->ownKeys();
  if (tag_ == Tag::Function) return functionProperties()->ownKeys();
  std::vector<PropertyKey> keys;
  if (tag_ == Tag::String) {
    const std::size_t length = runtime::string::utf16Length(as<std::string>());
    keys.reserve(length + 1);
    for (std::size_t index = 0; index < length; ++index) keys.push_back(PropertyKey::string(std::to_string(index)));
    keys.push_back(PropertyKey::string("length"));
    return keys;
  }
  // `Dictionary<Value>` has no `metadata_->fields`, so without this arm a boxed
  // table reported no keys at all: `Object.keys` of a record read back out of a
  // `Map<string, unknown>` came out empty while `ownDescriptor` still answered
  // for every entry.
  if (metadata_->payloadType == detail::payloadTypeTagFor<gea::Ref<gea::Dictionary<gea::Value>>>()) {
    if (const gea::Value* gea_viewed = gea::dictionary::viewedObjectOf(*this)) return gea_viewed->ownPropertyKeys();
    const gea::Ref<gea::Dictionary<gea::Value>>& dictionary = as<gea::Ref<gea::Dictionary<gea::Value>>>();
    if (dictionary) for (const auto& key : dictionary->enumerableKeys()) keys.push_back(PropertyKey::string(key));
    return detail::ordinaryOwnPropertyKeyOrder(std::move(keys));
  }
  if (metadata_->fields) metadata_->fields->ownKeys(payload(), keys);
  if (metadata_->elements) {
    for (std::size_t i = 0; i < metadata_->elements->length(payload()); ++i) {
      Value ignored;
      if (metadata_->elements->element(payload(), i, ignored)) keys.push_back(PropertyKey::string(std::to_string(i)));
    }
    keys.push_back(PropertyKey::string("length"));
  }
  const gea::Ref<void> anchor = expandoAnchor();
  const auto expando = detail::expandoFor(anchor, false);
  if (expando) for (const auto& key : expando->ownKeys()) keys.push_back(key);
  return detail::nativeOwnKeysInCreationOrder(anchor.get(), std::move(keys));
}

inline bool Value::defineProperty(const PropertyKey& key, const PropertyDescriptor& descriptor) const {
  if (proxy_) {
    const DynamicProxy state = proxyState();
    Value trap = proxyTrap(state, "defineProperty");
    if (trap.tag() == Tag::Undefined) return state.target.defineProperty(key, descriptor);
    Value object = Value::object();
    if (descriptor.hasValue) object.setProperty(PropertyKey::string("value"), descriptor.value);
    if (descriptor.hasWritable) object.setProperty(PropertyKey::string("writable"), Value::box(Tag::Boolean, descriptor.writable));
    if (descriptor.hasEnumerable) object.setProperty(PropertyKey::string("enumerable"), Value::box(Tag::Boolean, descriptor.enumerable));
    if (descriptor.hasConfigurable) object.setProperty(PropertyKey::string("configurable"), Value::box(Tag::Boolean, descriptor.configurable));
    if (descriptor.hasGet) {
      Value getter = descriptor.getterValue;
      if (getter.tag() == Tag::Undefined && descriptor.get) {
        using Get = PropertyDescriptor::Getter;
        getter = Value::boxMethod(CallableObject<Value(Value)>(+[](void* env, Value receiver) -> Value {
          alignas(void*) unsigned char slot[sizeof(void*)];
          return (*gea::unpackEnvironment<Get>(env, slot))(receiver);
        }, gea::packEnvironment<Get>(descriptor.get)));
      }
      object.setProperty(PropertyKey::string("get"), getter);
    }
    if (descriptor.hasSet) {
      Value setter = descriptor.setterValue;
      if (setter.tag() == Tag::Undefined && descriptor.set) {
        using Set = PropertyDescriptor::Setter;
        setter = Value::boxMethod(CallableObject<void(Value, Value)>(+[](void* env, Value receiver, Value value) {
          alignas(void*) unsigned char slot[sizeof(void*)];
          (*gea::unpackEnvironment<Set>(env, slot))(receiver, value);
        }, gea::packEnvironment<Set>(descriptor.set)));
      }
      object.setProperty(PropertyKey::string("set"), setter);
    }
    if (!host::detail::toBoolean(trap.callWithReceiver(state.handler, {state.target, propertyKeyValue(key), object}))) return false;
    PropertyDescriptor current;
    const bool exists = state.target.ownDescriptor(key, current);
    if (!compatibleProxyDescriptor(state.target.isExtensible(), descriptor, exists ? &current : nullptr) ||
        (descriptor.hasConfigurable && !descriptor.configurable && (!exists || current.configurable)) ||
        (exists && !current.configurable && current.isData() && current.writable && descriptor.hasWritable && !descriptor.writable))
      host::throwRuntimeError("TypeError", "Proxy defineProperty trap violated a protected property");
    return true;
  }
  if (dynamic_) return asDynamicObject()->defineOwnProperty(key, descriptor);
  // `Dictionary<Value>` has its own arm in `getProperty`/`setProperty`/
  // `hasProperty`/`deleteProperty` (see the comment above `nativeFieldOpsFor`'s
  // `TypedStringDictionaryTable` branch) because it is an index-signature
  // store with no fixed field table -- `metadata_->fields` is null for it, so
  // without this arm `defineProperty` fell all the way to the expando sidecar
  // below. That sidecar is keyed on the box's identity, not the dictionary's
  // own entries, so `Reflect.set`/`Object.defineProperty` (both of which route
  // through here) silently wrote a key nothing else ever reads: a direct
  // `dictionary->read(key)` afterwards still saw the old table, unmodified.
  if (metadata_->payloadType == detail::payloadTypeTagFor<gea::Ref<gea::Dictionary<gea::Value>>>()) {
    if (const gea::Value* gea_viewed = gea::dictionary::viewedObjectOf(*this)) return gea_viewed->defineProperty(key, descriptor);
    if (key.isSymbol() || descriptor.isAccessor()) return false;
    const gea::Ref<gea::Dictionary<gea::Value>>& dictionary = as<gea::Ref<gea::Dictionary<gea::Value>>>();
    if (!dictionary) return false;
    if (!descriptor.hasValue) return dictionary->has(key.text());
    (*dictionary)[key.text()] = descriptor.value;
    return true;
  }
  if (tag_ == Tag::Function) return functionProperties()->defineOwnProperty(key, descriptor);
  // The fixed half first, exactly as `nativeDynamicDefineProperty` orders it:
  // a payload that models its own attributes answers for its own keys before
  // an index sidecar or the descriptor comparison below is consulted. Only a
  // payload that states the whole own-field protocol installs this hook, so
  // for every other native the next two branches are unchanged.
  if (metadata_->fields != nullptr && metadata_->fields->matchesField != nullptr &&
      metadata_->fields->matchesField(payload(), key)) {
    return metadata_->fields->defineField(payload(), key, descriptor, isExtensible());
  }
  if (metadata_->fields != nullptr && metadata_->fields->matchesIndex(payload(), key)) {
    return metadata_->fields->defineIndex(payload(), key, descriptor, isExtensible());
  }
  PropertyDescriptor current;
  if (ownDescriptor(key, current)) {
    if (!compatibleProxyDescriptor(isExtensible(), descriptor, &current)) return false;
    // Native fields retain their native storage. Attribute changes require a
    // native integrity/descriptor sidecar; never pretend to install one.
    if (descriptor.isAccessor() || (descriptor.hasWritable && descriptor.writable != current.writable) ||
        (descriptor.hasEnumerable && descriptor.enumerable != current.enumerable) ||
        (descriptor.hasConfigurable && descriptor.configurable != current.configurable)) return false;
    if (descriptor.hasValue) { Value self = *this; self.setProperty(key, descriptor.value); }
    return true;
  }
  if (metadata_->elements) {
    std::size_t index = 0;
    if (detail::arrayIndexOfKey(key, index)) {
      if (!descriptor.hasValue || !descriptor.hasWritable || !descriptor.writable || !descriptor.hasEnumerable ||
          !descriptor.enumerable || !descriptor.hasConfigurable || !descriptor.configurable) return false;
      return metadata_->elements->setElement(payload(), index, descriptor.value);
    }
  }
  const gea::Ref<void> anchor = expandoAnchor();
  if (!detail::expandoFor(anchor, true)->defineOwnProperty(key, descriptor)) return false;
  if (metadata_->fields)
    detail::noteNativeOwnKeyCreated(anchor, key, [&](std::vector<PropertyKey>& keys) { metadata_->fields->ownKeys(payload(), keys); });
  return true;
}

inline const NativeClassMethodState* Value::classPrototypeState() const {
  if (proxy_ || dynamic_ || metadata_ == nullptr || metadata_->prototypeState == nullptr || payload() == nullptr) return nullptr;
  return metadata_->prototypeState(payload());
}

inline bool Value::nativeClassChainStart(const NativeClassMethodState*& start) const {
  if (proxy_ || dynamic_ || metadata_ == nullptr || metadata_->methodState == nullptr || payload() == nullptr) return false;
  start = metadata_->methodState(payload());
  return true;
}

inline bool Value::ownDescriptor(const PropertyKey& key, PropertyDescriptor& out) const {
  if (proxy_) return dynamicProxyDescriptor(*this, key, out);
  if (tag_ == Tag::Function) {
    const auto* descriptor = functionProperties()->ownProperty(key);
    if (!descriptor) return false;
    out = *descriptor; return true;
  }
  if (dynamic_) {
    const auto* descriptor = asDynamicObject()->ownProperty(key);
    if (!descriptor) return false;
    out = *descriptor;
    return true;
  }
  // See the matching arm in `defineProperty`: `Dictionary<Value>` answers for
  // its own keys directly rather than through `metadata_->fields`, and
  // `ownDescriptor` needs the same arm `getProperty`/`hasProperty` already
  // have or `Reflect.set`'s existence check (and `for`-`in`/`Object.keys`,
  // which filter through `ownDescriptor`) never see what the table holds.
  if (metadata_->payloadType == detail::payloadTypeTagFor<gea::Ref<gea::Dictionary<gea::Value>>>()) {
    if (const gea::Value* gea_viewed = gea::dictionary::viewedObjectOf(*this)) return gea_viewed->ownDescriptor(key, out);
    if (key.isSymbol()) return false;
    const gea::Ref<gea::Dictionary<gea::Value>>& dictionary = as<gea::Ref<gea::Dictionary<gea::Value>>>();
    if (!dictionary || !dictionary->has(key.text())) return false;
    out = PropertyDescriptor::assignment(dictionary->read(key.text()));
    return true;
  }
  if (tag_ == Tag::String && detail::stringOwnDescriptor(as<std::string>(), key, out)) return true;
  if (metadata_->fields) {
    if (metadata_->fields->ownDescriptor(payload(), key, out)) {
      const auto integrity = detail::expandoFor(expandoAnchor(), false);
      if (integrity && integrity->nativeFieldsFrozen()) out.writable = false;
      return true;
    }
    if (metadata_->fields->ownIndexDescriptor(payload(), key, out)) return true;
    if (metadata_->fields->matchesIndex(payload(), key)) return false;
  }
  if (metadata_->elements) {
    const auto integrity = detail::expandoFor(expandoAnchor(), false);
    const bool frozen = integrity && integrity->hasFrozenIntegrity();
    if (!key.isSymbol() && key.text() == "length") {
      out = PropertyDescriptor::assignment(Value::box(Tag::Number, static_cast<double>(metadata_->elements->length(payload()))));
      out.enumerable = out.configurable = false;
      out.writable = !frozen;
      return true;
    }
    std::size_t index = 0;
    Value found;
    if (detail::arrayIndexOfKey(key, index) && metadata_->elements->element(payload(), index, found)) {
      out = PropertyDescriptor::assignment(found);
      if (frozen) out.writable = out.configurable = false;
      return true;
    }
  }
  const auto expando = detail::expandoFor(expandoAnchor(), false);
  const auto* descriptor = expando ? expando->ownProperty(key) : nullptr;
  if (!descriptor) return false;
  out = *descriptor;
  return true;
}

inline Value dynamicProxyCall(const Value& proxy, const Value& receiver, const std::vector<Value>& arguments) {
  const DynamicProxy state = proxy.proxyState();
  Value trap = proxyTrap(state, "apply");
  if (trap.tag() == Value::Tag::Undefined) return state.target.callWithReceiver(receiver, arguments);
  auto array = gea::makeRef<ArrayObject<Value>>();
  for (const Value& argument : arguments) array->push(argument);
  return trap.callWithReceiver(state.handler, {state.target, receiver, Value::box(Value::Tag::Object, array)});
}

inline Value dynamicProxyGet(const Value& proxy, const PropertyKey& key, const Value& receiver) {
  // Copy the references: a trap may revoke this proxy while it is running.
  const DynamicProxy state = proxy.proxyState();
  Value trap = proxyTrap(state, "get");
  if (trap.tag() == Value::Tag::Undefined) return state.target.getProperty(key, receiver);
  Value result = trap.callWithReceiver(state.handler, {state.target, propertyKeyValue(key), receiver});
  PropertyDescriptor descriptor;
  if (state.target.ownDescriptor(key, descriptor) && !descriptor.configurable) {
    if (descriptor.isAccessor() ? !descriptor.get && result.tag() != Value::Tag::Undefined
                                : !descriptor.writable && !Value::sameValue(result, descriptor.value))
      host::throwRuntimeError("TypeError", "Proxy get trap violated a non-configurable property");
  }
  return result;
}

inline bool dynamicProxySet(const Value& proxy, const PropertyKey& key, const Value& value, const Value& receiver) {
  DynamicProxy state = proxy.proxyState();
  Value trap = proxyTrap(state, "set");
  if (trap.tag() == Value::Tag::Undefined) return state.target.reflectSet(key, value, receiver);
  if (!host::detail::toBoolean(trap.callWithReceiver(state.handler, {state.target, propertyKeyValue(key), value, receiver}))) return false;
  PropertyDescriptor descriptor;
  if (state.target.ownDescriptor(key, descriptor) && !descriptor.configurable) {
    if (descriptor.isAccessor() ? !descriptor.set : !descriptor.writable && !Value::sameValue(value, descriptor.value))
      host::throwRuntimeError("TypeError", "Proxy set trap violated a non-configurable property");
  }
  return true;
}

inline bool dynamicProxyHas(const Value& proxy, const PropertyKey& key) {
  const DynamicProxy state = proxy.proxyState();
  Value trap = proxyTrap(state, "has");
  if (trap.tag() == Value::Tag::Undefined) return state.target.hasProperty(key);
  const bool result = host::detail::toBoolean(trap.callWithReceiver(state.handler, {state.target, propertyKeyValue(key)}));
  PropertyDescriptor descriptor;
  const auto object = state.target.asDynamicObject();
  if (!result && state.target.ownDescriptor(key, descriptor) && (!descriptor.configurable || (object && !object->extensible())))
    host::throwRuntimeError("TypeError", "Proxy has trap hid a protected property");
  return result;
}

inline bool dynamicProxyDelete(const Value& proxy, const PropertyKey& key) {
  DynamicProxy state = proxy.proxyState();
  Value trap = proxyTrap(state, "deleteProperty");
  if (trap.tag() == Value::Tag::Undefined) return state.target.deleteProperty(key);
  const bool result = host::detail::toBoolean(trap.callWithReceiver(state.handler, {state.target, propertyKeyValue(key)}));
  PropertyDescriptor descriptor;
  const auto object = state.target.asDynamicObject();
  if (result && state.target.ownDescriptor(key, descriptor) && (!descriptor.configurable || (object && !object->extensible())))
    host::throwRuntimeError("TypeError", "Proxy deleteProperty trap hid a protected property");
  return result;
}

inline bool Value::reflectSet(const PropertyKey& key, const Value& value, const Value& receiver) {
  if (!isObjectValue(*this)) host::throwRuntimeError("TypeError", "Reflect.set target must be an object");
  if (proxy_) return dynamicProxySet(*this, key, value, receiver);
  PropertyDescriptor descriptor;
  const bool exists = ownDescriptor(key, descriptor);
  if (!exists && dynamic_ && asDynamicObject()->prototype()) {
    Value parent;
    parent.tag_ = Tag::Object;
    parent.dynamic_ = true;
    parent.held_ = asDynamicObject()->prototype();
    return parent.reflectSet(key, value, receiver);
  }
  if (!exists && metadata_->prototype != nullptr) {
    const auto result = metadata_->prototype->set(payload(), key, value, receiver);
    if (result != detail::NativePrototypeOps::SetResult::Absent) {
      return result == detail::NativePrototypeOps::SetResult::Accepted;
    }
  }
  if (!exists && metadata_->methodState != nullptr) {
    const auto result = detail::nativePrototypeChainSet(metadata_->methodState(payload()), key, value, [&]() -> const Value& { return receiver; });
    if (result != detail::NativePrototypeOps::SetResult::Absent) return result == detail::NativePrototypeOps::SetResult::Accepted;
  }
  if (exists) {
    if (descriptor.isAccessor()) {
      if (!descriptor.set) return false;
      descriptor.set(receiver, value);
      return true;
    }
    if (!descriptor.writable) return false;
  }
  if (!isObjectValue(receiver)) return false;
  PropertyDescriptor existing;
  if (receiver.ownDescriptor(key, existing)) {
    if (existing.isAccessor() || !existing.writable) return false;
    PropertyDescriptor update;
    update.hasValue = true;
    update.value = value;
    return receiver.defineProperty(key, update);
  }
  return receiver.defineProperty(key, PropertyDescriptor::assignment(value));
}

template <typename T>
inline Value reflectBox(const T& value) { return detail::DynamicCarrier<std::decay_t<T>>::out(value); }

template <typename T, typename K, typename R>
inline Value reflectGet(const T& target, const K& key, const R& receiver) {
  const Value object = reflectBox(target);
  if (!isObjectValue(object)) host::throwRuntimeError("TypeError", "Reflect.get target must be an object");
  return object.getProperty(host::toPropertyKey(reflectBox(key)), reflectBox(receiver));
}
template <typename T, typename K>
inline Value reflectGet(const T& target, const K& key) { return reflectGet(target, key, target); }

template <typename T, typename K, typename V, typename R>
inline bool reflectSet(const T& target, const K& key, const V& value, const R& receiver) {
  Value object = reflectBox(target);
  return object.reflectSet(host::toPropertyKey(reflectBox(key)), reflectBox(value), reflectBox(receiver));
}
template <typename T, typename K, typename V>
inline bool reflectSet(const T& target, const K& key, const V& value) { return reflectSet(target, key, value, target); }

/**
 * `Reflect.get(T, k, R)` over a native object (three's TSL proxy traps).
 * The box is a view of the same object, so this is OrdinaryGet over its own
 * storage, declared members and prototype tables, with an inherited
 * accessor entered with `R`.
 */
template <typename T>
inline Value reflectGetNative(const gea::Ref<T>& target, const PropertyKey& key, const Value& receiver) {
  if (!target) host::throwRuntimeError("TypeError", "Reflect.get target must be an object");
  return Value::box(Value::Tag::Object, target).getProperty(key, receiver);
}

/** `Reflect.set(T, k, v, R)` over a native object: OrdinarySet, creating or updating the key on `R` for a data property. */
template <typename T>
inline bool reflectSetNative(const gea::Ref<T>& target, const PropertyKey& key, const Value& value, const Value& receiver) {
  if (!target) host::throwRuntimeError("TypeError", "Reflect.set target must be an object");
  Value object = Value::box(Value::Tag::Object, target);
  return object.reflectSet(key, value, receiver);
}

/**
 * `Reflect.apply(F, thisArgument, argumentsList)`: 28.1.1 -- CreateListFromArrayLike
 * over the list, then [[Call]] with `thisArgument` as the receiver.
 */
template <typename F, typename T, typename A>
inline Value reflectApply(const F& target, const T& thisArgument, const A& argumentsList) {
  const Value function = reflectBox(target);
  if (function.tag() != Value::Tag::Function) host::throwRuntimeError("TypeError", "Reflect.apply target must be a function");
  const Value list = reflectBox(argumentsList);
  if (!isObjectValue(list)) host::throwRuntimeError("TypeError", "CreateListFromArrayLike called on non-object");
  const double length = dynamicToNumber(list.getProperty(PropertyKey::string("length")));
  std::vector<Value> arguments;
  for (double index = 0; index < length; ++index) arguments.push_back(list.getProperty(PropertyKey::number(index)));
  return function.callWithReceiver(reflectBox(thisArgument), arguments);
}

template <typename T, typename K>
inline bool reflectHas(const T& target, const K& key) {
  const Value object = reflectBox(target);
  if (!isObjectValue(object)) host::throwRuntimeError("TypeError", "Reflect.has target must be an object");
  return object.hasProperty(host::toPropertyKey(reflectBox(key)));
}
/**
 * `Reflect.getOwnPropertyDescriptor` -- the own descriptor as a fresh object,
 * or `undefined` when the property is absent.
 *
 * `Value::ownDescriptor` already routes a Proxy through its own
 * `getOwnPropertyDescriptor` trap and enforces the invariants
 * (`dynamicProxyDescriptor`), so this is only the crossing back: the internal
 * `PropertyDescriptor` rendered as the ordinary JavaScript object the language
 * hands the program, with the same field set `Value::defineProperty` writes
 * when it crosses the other way.
 */
template <typename T, typename K>
inline Value reflectOwnDescriptor(const T& target, const K& key) {
  const Value object = reflectBox(target);
  if (!isObjectValue(object)) host::throwRuntimeError("TypeError", "Reflect.getOwnPropertyDescriptor target must be an object");
  PropertyDescriptor descriptor;
  if (!object.ownDescriptor(host::toPropertyKey(reflectBox(key)), descriptor)) return Value();
  Value result = Value::object();
  if (descriptor.isAccessor()) {
    result.setProperty(PropertyKey::string("get"), descriptor.getterValue);
    result.setProperty(PropertyKey::string("set"), descriptor.setterValue);
  } else {
    result.setProperty(PropertyKey::string("value"), descriptor.value);
    result.setProperty(PropertyKey::string("writable"), Value::box(Value::Tag::Boolean, descriptor.writable));
  }
  result.setProperty(PropertyKey::string("enumerable"), Value::box(Value::Tag::Boolean, descriptor.enumerable));
  result.setProperty(PropertyKey::string("configurable"), Value::box(Value::Tag::Boolean, descriptor.configurable));
  return result;
}

template <typename T, typename K>
inline bool reflectDelete(const T& target, const K& key) {
  Value object = reflectBox(target);
  if (!isObjectValue(object)) host::throwRuntimeError("TypeError", "Reflect.deleteProperty target must be an object");
  return object.deleteProperty(host::toPropertyKey(reflectBox(key)));
}

inline std::string objectTagText(const char* tag) {
  // One sized construction instead of `"[object " + tag + "]"`, which builds a
  // temporary from the prefix and then appends twice (three strlen/copies).
  constexpr std::size_t prefix = 8;
  const std::size_t length = std::char_traits<char>::length(tag);
  std::string text(prefix + length + 1, ']');
  std::memcpy(text.data(), "[object ", prefix);
  std::memcpy(text.data() + prefix, tag, length);
  return text;
}

inline std::string objectTagWithOverride(const Value& tag, const char* builtinTag) {
  return tag.tag() == Value::Tag::String ? std::string("[object ") + tag.as<std::string>() + "]" : objectTagText(builtinTag);
}

template <typename T>
std::string objectTag(const Ref<T>& object, const char* builtinTag, const char* defaultTag = nullptr) {
  if (!object) return objectTagText("Null");
  Value tag;
  const auto key = PropertyKey::symbol(wellKnownSymbol(detail::WellKnownSymbol::ToStringTag));
  if (nativeDynamicRead(object, key, tag)) return objectTagWithOverride(tag, builtinTag);
  return objectTagText(defaultTag ? defaultTag : builtinTag);
}

template <typename Callable>
std::string callableObjectTag(const Callable& callable, const char* builtinTag, const char* defaultTag) {
  const auto& identity = callable.functionObjectIdentity();
  const auto key = PropertyKey::symbol(wellKnownSymbol(detail::WellKnownSymbol::ToStringTag));
  if (identity && identity->properties) {
    // The native callable only crosses a dynamic boundary if a program-supplied
    // accessor actually needs its `this`. Absent and data properties never box it.
    Value tag;
    if (identity->properties->readWithReceiver(key, [&] { return Value::box(Value::Tag::Function, callable); }, tag))
      return objectTagWithOverride(tag, builtinTag);
  }
  return objectTagText(defaultTag ? defaultTag : builtinTag);
}

template <typename Result, typename... Arguments>
std::string objectTag(const CallableObject<Result(Arguments...)>& callable, const char* builtinTag, const char* defaultTag = nullptr) {
  return callableObjectTag(callable, builtinTag, defaultTag);
}

template <typename Result, typename... Arguments, typename Constructed, typename... ConstructArguments>
std::string objectTag(const CallableConstructorObject<Result(Arguments...), Constructed(ConstructArguments...)>& callable,
                      const char* builtinTag, const char* defaultTag = nullptr) {
  return callableObjectTag(callable, builtinTag, defaultTag);
}

template <typename T>
requires (std::is_arithmetic_v<T> || std::is_same_v<T, std::string> || std::is_same_v<T, Symbol> ||
          std::is_same_v<T, BigInt> || std::is_same_v<T, Undefined> || std::is_same_v<T, std::nullptr_t>)
std::string objectTag(const T&, const char* builtinTag, const char* defaultTag = nullptr) {
  return objectTagText(defaultTag ? defaultTag : builtinTag);
}

inline std::string hostIntrinsicObjectTag(const char* protocol, const char* builtinTag, const char* defaultTag = nullptr) {
  const auto key = PropertyKey::symbol(wellKnownSymbol(detail::WellKnownSymbol::ToStringTag));
  // Non-const binding on purpose: `hostIntrinsicSidecar` hands back a reference into
  // its own function-local static map, never into the argument, but gcc's
  // -Wdangling-reference heuristic fires on a CONST reference bound to a call whose
  // argument is a temporary (the std::string built from `protocol`), and ESP-IDF
  // builds with -Werror. Every emitter-generated sidecar site already spells `auto&`.
  auto& properties = detail::hostIntrinsicSidecar(protocol);
  if (properties.hasOverride(key)) return objectTagWithOverride(properties.get(key), builtinTag);
  return objectTagText(properties.isRemoved(key) || !defaultTag ? builtinTag : defaultTag);
}

inline std::string objectTag(const char*, const char* builtinTag, const char* defaultTag = nullptr) {
  return objectTagText(defaultTag ? defaultTag : builtinTag);
}

inline std::string dynamicIntrinsicObjectTag(const Value& value, const char* builtinTag, const char* defaultTag) {
  PropertyDescriptor descriptor;
  if (!value.ownDescriptor(PropertyKey::symbol(wellKnownSymbol(detail::WellKnownSymbol::ToStringTag)), descriptor))
    return objectTagText(defaultTag);
  const Value tag = descriptor.isAccessor() ? (descriptor.get ? descriptor.get(value) : Value()) : descriptor.value;
  return objectTagWithOverride(tag, builtinTag);
}

inline std::string objectTag(const Value& value, const char* = "Object", const char* = nullptr) {
  // BSONPERF-objecttag-document: a plain open document (a `Dictionary<Value>` that views nothing) is no Array, Date, RegExp, Error, Map or
  // ArrayBuffer, and its symbol-keyed read is always `undefined` (`getProperty` stores no symbols in it), so its tag is "Object".
  // bson's isDate/isRegExp ask this of every nested document it serializes.
  if (value.tag() == Value::Tag::Object && !value.isProxy() && !value.isDynamicObject() &&
      value.payloadType() == detail::payloadTypeTagFor<gea::Ref<gea::Dictionary<Value>>>() && gea::dictionary::viewedObjectOf(value) == nullptr)
    return objectTagText("Object");
  const char* builtinTag = "Object";
  switch (value.tag()) {
    case Value::Tag::Undefined: return objectTagText("Undefined");
    case Value::Tag::Null: return objectTagText("Null");
    case Value::Tag::Boolean: return objectTagText("Boolean");
    case Value::Tag::Number: return objectTagText("Number");
    case Value::Tag::String: return objectTagText("String");
    case Value::Tag::Symbol: return objectTagText("Symbol");
    case Value::Tag::BigInt: return objectTagText("BigInt");
    case Value::Tag::Function: builtinTag = "Function"; break;
    case Value::Tag::Object: break;
  }
  // IsArray also validates a proxy before the single observable @@toStringTag
  // read. A proxy around Date does not inherit its target's [[DateValue]] slot.
  if (value.isArrayPayload()) builtinTag = "Array";
  else if (!value.isProxy()) {
    if (host::instanceOfDate(value)) builtinTag = "Date";
    else if (host::instanceOfRegExp(value)) builtinTag = "RegExp";
    else if (host::isRuntimeError(value)) builtinTag = "Error";
    else if (value.isMapPayload()) return dynamicIntrinsicObjectTag(value, "Object", "Map");
    else if (host::instanceOfArrayBuffer(value)) return dynamicIntrinsicObjectTag(value, "Object", "ArrayBuffer");
  }
  // BSONPERF-tag-literal: the @@toStringTag read of a native record or class instance is a remembered miss like any literal-keyed read.
  static const PropertyKey toStringTagKey = PropertyKey::symbol(wellKnownSymbol(detail::WellKnownSymbol::ToStringTag));
  static detail::LiteralReadCache toStringTagCache;
  return objectTagWithOverride(value.getLiteralProperty(toStringTagKey, toStringTagCache), builtinTag);
}

inline std::string objectTag(const FunctionValue& value, const char* builtinTag = "Function", const char* defaultTag = nullptr) {
  return objectTag(static_cast<const Value&>(value), builtinTag, defaultTag);
}

/**
 * A native iterator cursor -- a `function*`'s own generator above all --
 * crossing into a dynamic value: an ordinary iterator object over the SAME
 * cursor, with `next`, `return` and an `@@iterator` that answers itself
 * (ECMA-262 27.5.1, %GeneratorPrototype%). This is what a generator function
 * boxed as a `gea::Value` returns when the runtime calls it, and TSL's proxies
 * need exactly that: their `get` trap answers `@@iterator` with a
 * `function*`, and `gea::runtime::iterator::getIterator` calls it.
 *
 * Only the out direction exists. A dynamic iterator object entering a native
 * cursor would have to become a coroutine it is not, so that refuses by name.
 */
namespace detail {

template <typename Cursor>
struct IteratorObjectState {
  gea::Ref<Cursor> cursor;
  friend void geaTraceRefs(const IteratorObjectState& value, RefVisitor& visitor) { traceRefs(value.cursor, visitor); }
};

template <typename E, typename TReturn, typename TNext>
Value iteratorObjectOver(Iterator<E, TReturn, TNext> source) {
  using Cursor = Iterator<E, TReturn, TNext>;
  using State = IteratorObjectState<Cursor>;
  State state{gea::makeRef<Cursor>(std::move(source))};
  CallableObject<Value()> next(
      +[](void* environment) -> Value {
        alignas(void*) unsigned char slot[sizeof(void*)];
        Cursor& cursor = *unpackEnvironment<State>(environment, slot)->cursor;
        if (cursor.done()) return runtime::iterator::result(Value(), true);
        E value = cursor.arrayNext();
        if (cursor.done()) {
          // The completion a finished generator states; `undefined` for a
          // cursor that has none (every other source, and `TReturn = void`).
          if constexpr (!std::is_void_v<TReturn>) {
            if (cursor.isGeneratorFrame()) return runtime::iterator::result(DynamicCarrier<TReturn>::out(cursor.takeCompletionValue()), true);
          }
          return runtime::iterator::result(Value(), true);
        }
        return runtime::iterator::result(DynamicCarrier<E>::out(value), false);
      },
      packEnvironment(state));
  CallableObject<Value(Value)> close(
      +[](void* environment, Value completion) -> Value {
        alignas(void*) unsigned char slot[sizeof(void*)];
        Cursor& cursor = *unpackEnvironment<State>(environment, slot)->cursor;
        if (cursor.done() || !cursor.isGeneratorFrame()) {
          cursor.setDone(true);
          return runtime::iterator::result(completion, true);
        }
        typename Cursor::ReturnStorage value{};
        if constexpr (!std::is_void_v<TReturn>) value = DynamicCarrier<TReturn>::in(completion, 0);
        E yielded = cursor.resumeReturn(std::move(value));
        // A `finally` in the frame may yield again; the generator is then
        // suspended there, not finished.
        if (!cursor.done()) return runtime::iterator::result(DynamicCarrier<E>::out(yielded), false);
        if constexpr (!std::is_void_v<TReturn>) return runtime::iterator::result(DynamicCarrier<TReturn>::out(cursor.takeCompletionValue()), true);
        return runtime::iterator::result(completion, true);
      },
      packEnvironment(state));
  CallableObject<Value(Value)> self(+[](void*, Value receiver) -> Value { return receiver; }, nullptr);
  Value object = Value::object();
  object.setProperty(PropertyKey::string("next"), Value::box(Value::Tag::Function, next));
  object.setProperty(PropertyKey::string("return"), Value::box(Value::Tag::Function, close));
  object.setProperty(PropertyKey::symbol(wellKnownSymbol(WellKnownSymbol::Iterator)), Value::boxMethod(self));
  return object;
}

template <typename E, typename TReturn, typename TNext>
struct DynamicCarrier<Iterator<E, TReturn, TNext>> {
  static constexpr bool supported = DynamicCarrier<E>::supported && (std::is_void_v<TReturn> || DynamicCarrier<TReturn>::supported);
  static Value out(const Iterator<E, TReturn, TNext>& cursor) { return iteratorObjectOver(cursor); }
  static bool accepts(const Value&) { return false; }
  static Iterator<E, TReturn, TNext> in(const Value&, std::size_t) {
    refusePayloadMismatch("a dynamic iterator object entering a native iterator cursor");
  }
};

}  // namespace detail

}  // namespace gea
