#include "gea_runtime.h"
#include <cassert>
#include <vector>

using gea::Value;
using gea::PropertyKey;

struct DynamicBase {};
struct DynamicDerived : DynamicBase {};
struct UnsupportedDynamicCarrier {};
namespace gea::detail {
template <>
struct ClassRefBase<DynamicDerived> {
  using type = DynamicBase;
};
}  // namespace gea::detail

Value number(double n) { return Value::box(Value::Tag::Number, n); }

struct NativeReflectRecord {
  double value = 1;
  bool present = true;
  bool gea_matchesOwnField(const PropertyKey& key) const { return !key.isSymbol() && key.text() == "value"; }
  bool gea_readOwnFieldNative(const PropertyKey& key, gea::NativeFieldRead& out) const {
    return gea_matchesOwnField(key) && present && out.assign(value);
  }
  bool gea_writeOwnFieldNative(const PropertyKey& key, const gea::NativeFieldWrite& input, bool extensible) {
    if (!gea_matchesOwnField(key) || (!present && !extensible) || !input.assign(value)) return false;
    present = true;
    return true;
  }
  bool gea_deleteOwnField(const PropertyKey& key) {
    if (!gea_matchesOwnField(key)) return false;
    present = false;
    return true;
  }
  bool gea_ownFieldPresent(const PropertyKey& key, bool& out) const {
    if (!gea_matchesOwnField(key)) return false;
    out = present;
    return true;
  }
};

struct OptionalFixedRecord {
  double existing = 1;
  gea::Optional<double> optional;

  bool gea_readOwnField(const PropertyKey& key, Value& out) const {
    if (key.isSymbol()) return false;
    if (key.text() == "existing") out = number(existing);
    else if (key.text() == "optional" && optional.has_value()) out = number(*optional);
    else return false;
    return true;
  }

  bool gea_writeOwnField(const PropertyKey& key, const Value& value, bool extensible) {
    if (key.isSymbol()) return false;
    if (key.text() == "existing") existing = value.as<double>();
    else if (key.text() == "optional") {
      if (!optional.has_value() && !extensible) return false;
      optional = value.as<double>();
    } else return false;
    return true;
  }

  bool gea_ownFieldDescriptor(const PropertyKey& key, gea::PropertyDescriptor& out) const {
    Value value;
    if (!gea_readOwnField(key, value)) return false;
    out = gea::PropertyDescriptor::assignment(value);
    out.configurable = false;
    return true;
  }

  void gea_ownFieldKeys(std::vector<PropertyKey>& out) const {
    out.push_back(PropertyKey::string("existing"));
    if (optional.has_value()) out.push_back(PropertyKey::string("optional"));
  }
};

int main(int argc, char** argv) {
  {
    const auto record = gea::makeRef<NativeReflectRecord>();
    const auto key = PropertyKey::string("value");
    assert(gea::nativeFieldGet<double>(record, key, [] { return -1.0; }) == 1);
    assert(gea::nativeFieldSet(record, key, 42.0));
    assert(gea::nativeFieldGet<double>(record, key, [] { return -1.0; }) == 42);
    assert(gea::nativeDynamicDelete(record, key));
    assert(!gea::nativeDynamicHas(record, key));
    assert(gea::nativeFieldGet<double>(record, key, [] { return -1.0; }) == -1);
    assert(gea::nativeFieldSet(record, key, 43.0));
    assert(gea::nativeDynamicHas(record, key));
    gea::nativeFreeze(record);
    assert(!gea::nativeFieldSet(record, key, 99.0));
    assert(record->value == 43);
    std::string wrong = "unchanged";
    const double source = 1;
    assert(!gea::NativeFieldWrite(source).assign(wrong));
    assert(wrong == "unchanged");
  }
  {
    const auto tagKey = PropertyKey::symbol(gea::wellKnownSymbol(gea::detail::WellKnownSymbol::ToStringTag));
    const auto nativeArray = gea::arrayOf<double>({1, 2});
    assert(gea::objectTag(nativeArray, "Array") == "[object Array]");
    auto descriptor = gea::PropertyDescriptor::assignment(Value::box(Value::Tag::String, std::string("Custom")));
    assert(gea::nativeDynamicDefineProperty(nativeArray, tagKey, descriptor));
    assert(gea::objectTag(nativeArray, "Array") == "[object Custom]");
    descriptor.value = Value();
    assert(gea::nativeDynamicDefineProperty(nativeArray, tagKey, descriptor));
    assert(gea::objectTag(nativeArray, "Object", "Map") == "[object Object]");
    int getterCalls = 0;
    gea::PropertyDescriptor accessor;
    accessor.hasGet = accessor.hasConfigurable = accessor.configurable = true;
    accessor.get = [&](const Value&) { ++getterCalls; return Value(); };
    assert(gea::nativeDynamicDefineProperty(nativeArray, tagKey, accessor));
    assert(gea::objectTag(nativeArray, "Array") == "[object Array]");
    assert(getterCalls == 1);
    assert(gea::nativeDynamicDelete(nativeArray, tagKey));
    const auto callable = gea::CallableObject<void()>(+[](void*) {}, nullptr);
    assert(gea::objectTag(callable, "Function") == "[object Function]");
    assert(gea::objectTag(Value::box(Value::Tag::Object, nativeArray)) == "[object Array]");
    assert(gea::objectTag(Value::box(Value::Tag::Function, callable)) == "[object Function]");
    assert(gea::objectTag(Value::box(Value::Tag::Object, gea::Map<double, double>{})) == "[object Map]");
    assert(gea::objectTag(Value()) == "[object Undefined]");
    assert(gea::hostIntrinsicObjectTag("Math", "Object", "Math") == "[object Math]");
    auto& mathProperties = gea::detail::hostIntrinsicSidecar("Math");
    mathProperties.define(tagKey, gea::PropertyDescriptor::assignment(number(4)));
    assert(gea::hostIntrinsicObjectTag("Math", "Object", "Math") == "[object Object]");
    mathProperties.remove(tagKey);
    assert(gea::hostIntrinsicObjectTag("Math", "Object", "Math") == "[object Object]");
    const auto prototype = gea::arrayPrototypeObject();
    assert(prototype == gea::arrayPrototypeObject());
    const auto join = gea::nativeOwnPropertyDescriptor(prototype, PropertyKey::string("join"));
    assert(join.has_value() && join->value.tag() == Value::Tag::Function);
    assert(join->writable && !join->enumerable && join->configurable);
  }
  // Type metadata is shared, but payloads and mutable properties are not.
  static_assert(sizeof(Value) <= 48);
  static_assert(gea::detail::DynamicCallableCarrier<gea::Optional<double>>::supported);
  static_assert(!gea::detail::DynamicRestArgument<
                gea::Ref<gea::ArrayObject<UnsupportedDynamicCarrier>>>::supported);
  using UnsupportedRestCallable =
    gea::CallableObject<void(gea::Ref<gea::ArrayObject<UnsupportedDynamicCarrier>>)>;
  static_assert(!gea::detail::DynamicRestCallSignature<UnsupportedRestCallable, 0>::supported);
  Value value = number(-0.0);
  assert(value.payloadType() == gea::detail::payloadTypeTagFor<double>());
  assert(std::signbit(value.as<double>()));
  Value copy = value;
  value = Value::box(Value::Tag::Boolean, true);
  assert(value.as<bool>() && std::signbit(copy.as<double>()));
  value = Value::box(Value::Tag::String, std::string("owned"));
  copy = std::move(value);
  assert(copy.as<std::string>() == "owned");

  auto array = gea::arrayOf<double>({3, 7});
  Value boxedArray = Value::box(Value::Tag::Object, array);
  assert(boxedArray.isArrayPayload() && !boxedArray.isMapPayload());
  assert(boxedArray.getProperty(PropertyKey::number(1)).as<double>() == 7);
  boxedArray.setProperty(PropertyKey::number(0), number(9));
  assert(array->at(0) == 9);
  Value map = Value::box(Value::Tag::Object, gea::Map<double, double>{});
  assert(map.isMapPayload() && !map.isArrayPayload());
  Value promise = Value::box(Value::Tag::Object, gea::Promise<double>(12.0));
  assert(promise.payloadType() == gea::detail::payloadTypeTagFor<gea::Promise<double>>());
  assert(promise.as<gea::Promise<double>>().value() == 12);

  // The erased fixed-field write must receive the object's real
  // extensibility. A present writable field can still update after
  // preventExtensions; an absent optional fixed field cannot become present.
  auto sealedRecord = gea::makeRef<OptionalFixedRecord>();
  Value boxedSealedRecord = Value::box(Value::Tag::Object, sealedRecord);
  gea::detail::expandoFor(gea::refCastToVoid(sealedRecord), true)->preventExtensions();
  assert(!boxedSealedRecord.isExtensible());
  boxedSealedRecord.setProperty(PropertyKey::string("existing"), number(2));
  assert(sealedRecord->existing == 2);
  boxedSealedRecord.setProperty(PropertyKey::string("optional"), number(3));
  assert(!sealedRecord->optional.has_value());
  assert(!boxedSealedRecord.hasProperty(PropertyKey::string("optional")));
  assert(!boxedSealedRecord.reflectSet(PropertyKey::string("optional"), number(3), boxedSealedRecord));
  assert(gea::nativeDynamicSet(sealedRecord, PropertyKey::string("existing"), number(7)));
  assert(sealedRecord->existing == 7);
  assert(!gea::nativeDynamicSet(sealedRecord, PropertyKey::string("optional"), number(8)));
  assert(!sealedRecord->optional.has_value());

  auto openRecord = gea::makeRef<OptionalFixedRecord>();
  Value boxedOpenRecord = Value::box(Value::Tag::Object, openRecord);
  boxedOpenRecord.setProperty(PropertyKey::string("optional"), number(4));
  assert(openRecord->optional.has_value() && *openRecord->optional == 4);
  boxedOpenRecord.freezeIntegrity();
  boxedOpenRecord.setProperty(PropertyKey::string("existing"), number(5));
  boxedOpenRecord.setProperty(PropertyKey::string("optional"), number(6));
  assert(openRecord->existing == 1);
  assert(*openRecord->optional == 4);

  // Dynamic callable arguments use the same authenticated family projection
  // as a direct dynamic-to-class assertion: a Derived allocation crossing
  // through Ref<Derived> can satisfy a Base parameter without payload punning.
  auto derived = gea::makeRef<DynamicDerived>();
  Value boxedDerived = Value::box(Value::Tag::Object, derived);
  const gea::Ref<DynamicBase> base = gea::detail::DynamicCarrier<gea::Ref<DynamicBase>>::in(boxedDerived, 0);
  assert(base.get() == static_cast<DynamicBase*>(derived.get()));
  using OverlappingClasses = gea::TaggedUnion<gea::Ref<DynamicBase>, gea::Ref<DynamicDerived>>;
  assert(!gea::detail::DynamicCallableCarrier<OverlappingClasses>::accepts(boxedDerived));
  if (argc > 1 && std::string(argv[1]) == "overlapping-class-union") {
    (void)gea::detail::DynamicCallableCarrier<OverlappingClasses>::in(boxedDerived, 0);
    return 90;
  }

  const Value absent;
  const auto undefinedOptional = gea::detail::DynamicCallableCarrier<gea::Optional<double>>::in(absent, 0);
  assert(!undefinedOptional.has_value());
  assert(gea::detail::DynamicCallableCarrier<gea::Optional<double>>::out(undefinedOptional).tag() ==
         Value::Tag::Undefined);
  const Value nullValue = Value::box(Value::Tag::Null, nullptr);
  assert(!gea::detail::DynamicCallableCarrier<gea::Optional<double>>::accepts(nullValue));
  const auto optionalDynamicNull = gea::detail::DynamicCallableCarrier<gea::Optional<Value>>::in(nullValue, 0);
  assert(optionalDynamicNull.has_value() && optionalDynamicNull->tag() == Value::Tag::Null);

  using NullableCallable = gea::CallableObject<void(gea::Optional<double>)>;
  NullableCallable nullable(+[](void*, gea::Optional<double>) {}, nullptr);
  Value boxedNullable = Value::box(Value::Tag::Function, nullable);
  if (argc > 1 && std::string(argv[1]) == "nullable-callable") {
    boxedNullable.callAsFunction({Value::box(Value::Tag::Null, nullptr)});
    return 91;
  }
  using FunctionOrNumber = gea::TaggedUnion<gea::FunctionValue, double>;
  assert(gea::detail::DynamicCallableCarrier<FunctionOrNumber>::accepts(boxedNullable));
  assert(gea::detail::DynamicCallableCarrier<FunctionOrNumber>::accepts(number(3)));
  const Value text = Value::box(Value::Tag::String, std::string("not callable"));
  assert(!gea::detail::DynamicCallableCarrier<FunctionOrNumber>::accepts(text));
  const FunctionOrNumber functionArm = gea::detail::DynamicCallableCarrier<FunctionOrNumber>::in(boxedNullable, 0);
  assert(functionArm.is<0>() && functionArm.get<0>().tag() == Value::Tag::Function);
  assert(gea::detail::DynamicCallableCarrier<FunctionOrNumber>::out(functionArm).tag() == Value::Tag::Function);
  if (argc > 1 && std::string(argv[1]) == "function-union-string") {
    (void)gea::detail::DynamicCallableCarrier<FunctionOrNumber>::in(text, 0);
    return 92;
  }

  // Identical native signatures can have distinct fixed/rest call ABIs.
  using Fn = gea::CallableObject<double(gea::Ref<gea::ArrayObject<double>>)>;
  Fn fn(+[](void*, gea::Ref<gea::ArrayObject<double>> xs) {
    double sum = 0;
    for (std::size_t i = 0; i < xs->size(); ++i) sum += xs->at(i);
    return sum;
  }, nullptr);
  Value fixed = Value::box(Value::Tag::Function, fn);
  Value rest = Value::boxCallable<0>(fn);
  assert(fixed.callAsFunction({boxedArray}).as<double>() == 16);
  assert(rest.callAsFunction({number(4), number(5)}).as<double>() == 9);
  assert(rest.callAsFunction({}).as<double>() == 0);
  fixed.setProperty(PropertyKey::string("label"), number(1));
  assert(rest.getProperty(PropertyKey::string("label")).as<double>() == 1);
  assert(fixed.callAsFunction({boxedArray}).as<double>() == 16);

  // A typed rest target receives one native Array, while the boxed source
  // receives its JavaScript positional arguments. The adapter must expand the
  // target rest exactly once instead of passing the Array as one argument.
  using Rest = gea::Ref<gea::ArrayObject<double>>;
  using SourceRest = gea::CallableObject<double(Rest)>;
  using TargetRest = gea::CallableObject<double(double, Rest)>;
  SourceRest sourceRest(+[](void*, Rest values) {
    double sum = 0;
    for (std::size_t index = 0; index < values->size(); ++index) sum += values->at(index);
    return sum;
  }, nullptr);
  Value boxedSourceRest = Value::boxCallable<0>(sourceRest);
  TargetRest adaptedRest = gea::detail::DynamicCarrier<TargetRest>::template inWithRest<1>(boxedSourceRest, 0);
  assert(adaptedRest(1, gea::arrayOf<double>({2, 3})) == 6);

  struct Receiver {
    std::string label;
  };
  using ReceiverRef = gea::Ref<Receiver>;
  using SourceMethodRest = gea::CallableObject<std::string(ReceiverRef, Rest)>;
  using TargetMethodRest = gea::CallableObject<std::string(ReceiverRef, double, Rest)>;
  SourceMethodRest sourceMethodRest(+[](void*, ReceiverRef receiver, Rest values) {
    double sum = 0;
    for (std::size_t index = 0; index < values->size(); ++index) sum += values->at(index);
    return receiver->label + "/" + std::to_string(static_cast<int>(sum));
  }, nullptr);
  Value boxedSourceMethodRest = Value::boxMethod<1>(sourceMethodRest);
  TargetMethodRest adaptedMethodRest =
    gea::detail::DynamicCarrier<TargetMethodRest>::template inWithReceiverAndRest<2>(boxedSourceMethodRest, 0);
  assert(adaptedMethodRest(gea::makeRef<Receiver>(Receiver{"ctx"}), 4, gea::arrayOf<double>({5})) == "ctx/9");
}
