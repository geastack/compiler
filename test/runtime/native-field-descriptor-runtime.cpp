#include "gea_runtime.h"
#include <cassert>
#include <limits>

using gea::NativeIndexAttributes;
using gea::PropertyDescriptor;
using gea::Value;

template <typename T>
bool define(T& field, NativeIndexAttributes& attributes, bool& present,
            const PropertyDescriptor& descriptor, Value::Tag tag, bool extensible = true) {
  return gea::applyNativeFieldDescriptor(field, attributes, present, descriptor, extensible, tag);
}

PropertyDescriptor valueDescriptor(double value) {
  PropertyDescriptor result;
  result.hasValue = true;
  result.value = Value::box(Value::Tag::Number, value);
  return result;
}

// Attribute updates must not copy a native field into or out of a descriptor.
struct CopyObserved {
  static inline int copies = 0;
  CopyObserved() = default;
  CopyObserved(const CopyObserved&) { ++copies; }
  CopyObserved& operator=(const CopyObserved&) { ++copies; return *this; }
};

struct NativeAccessorOwner {
  gea::Ref<gea::ArrayObject<double>> value;
  int reads = 0;
  int writes = 0;
  friend void geaTraceRefs(const NativeAccessorOwner& owner, gea::detail::RefVisitor& visitor) {
    gea::detail::traceRefs(owner.value, visitor);
  }
};

void verifyNativeDescriptorFieldPolicies() {
  using Number = gea::Optional<double>;
  using NullPolicy = gea::NativeFieldOptionalPolicy<true>;
  using UndefinedPolicy = gea::NativeFieldOptionalPolicy<false>;
  auto absentNull = PropertyDescriptor::nativeAssignment<Number, NullPolicy>(Number{});
  auto absentUndefined = PropertyDescriptor::nativeAssignment<Number, UndefinedPolicy>(Number{});
  auto presentNull = PropertyDescriptor::nativeAssignment<Number, NullPolicy>(Number(9));
  absentNull.hasWritable = absentNull.hasEnumerable = absentNull.hasConfigurable = false;
  absentUndefined.hasWritable = absentUndefined.hasEnumerable = absentUndefined.hasConfigurable = false;
  presentNull.hasWritable = presentNull.hasEnumerable = presentNull.hasConfigurable = false;
  bool present = true;
  NativeIndexAttributes frozen{false, true, false};
  Number field;
  assert((!gea::applyNativeFieldDescriptor<Number, UndefinedPolicy>(field, frozen, present, absentNull, true, Value::Tag::Number)));
  assert(present && !field.has_value() && !frozen.writable && frozen.enumerable && !frozen.configurable);
  assert((gea::applyNativeFieldDescriptor<Number, UndefinedPolicy>(field, frozen, present, absentUndefined, true, Value::Tag::Number)));
  assert((!gea::applyNativeFieldDescriptor<Number, NullPolicy>(field, frozen, present, absentUndefined, true, Value::Tag::Number)));
  field = 9;
  assert((gea::applyNativeFieldDescriptor<Number, UndefinedPolicy>(field, frozen, present, presentNull, true, Value::Tag::Number)));
  assert(field.has_value() && *field == 9);
  assert((!gea::applyNativeFieldDescriptor<Number, UndefinedPolicy>(field, frozen, present, absentNull, true, Value::Tag::Number)));
  assert(field.has_value() && *field == 9);
  int loaded = 0;
  const auto load = [&](const Value&) { ++loaded; return Number(99); };
  field = Number{};
  assert((!gea::applyNativeFieldDescriptorLoaded<Number, UndefinedPolicy>(field, frozen, present, absentNull, true, load)));
  assert((gea::applyNativeFieldDescriptorLoaded<Number, UndefinedPolicy>(field, frozen, present, absentUndefined, true, load)));
  field = 9;
  assert((gea::applyNativeFieldDescriptorLoaded<Number, UndefinedPolicy>(field, frozen, present, presentNull, true, load)));
  assert(loaded == 0 && field.has_value() && *field == 9);
  using Union = gea::TaggedUnion<Number, std::string>;
  using NullUnionPolicy = gea::NativeFieldUnionPolicy<NullPolicy, gea::NativeFieldLeafPolicy>;
  using UndefinedUnionPolicy = gea::NativeFieldUnionPolicy<UndefinedPolicy, gea::NativeFieldLeafPolicy>;
  Union unionField = Union::ofArm<0>(Number{});
  auto unionNull = PropertyDescriptor::nativeAssignment<Union, NullUnionPolicy>(Union::ofArm<0>(Number{}));
  unionNull.hasWritable = unionNull.hasEnumerable = unionNull.hasConfigurable = false;
  assert((!gea::applyNativeFieldDescriptor<Union, UndefinedUnionPolicy>(unionField, frozen, present, unionNull, true, Value::Tag::Object)));
  unionField = Union::ofArm<0>(Number(9));
  auto unionPresent = PropertyDescriptor::nativeAssignment<Union, NullUnionPolicy>(Union::ofArm<0>(Number(9)));
  unionPresent.hasWritable = unionPresent.hasEnumerable = unionPresent.hasConfigurable = false;
  assert((gea::applyNativeFieldDescriptor<Union, UndefinedUnionPolicy>(unionField, frozen, present, unionPresent, true, Value::Tag::Object)));
  // The old API did not publish an absence policy, so retain its exact C++
  // payload behavior for callers that still deliberately use Leaf.
  field = Number{};
  assert(define(field, frozen, present, absentNull, Value::Tag::Number));
}

void verifyNativeAccessorDescriptors() {
  using OptionalNumber = gea::Optional<double>;
  using NullPolicy = gea::NativeFieldOptionalPolicy<true>;
  using UndefinedPolicy = gea::NativeFieldOptionalPolicy<false>;
  const auto nativeNull = gea::NativeDescriptorData::make<OptionalNumber, NullPolicy>(OptionalNumber{});
  std::optional<OptionalNumber> optionalAnswer;
  assert(!nativeNull.read(gea::NativeFieldRead(optionalAnswer)));
  assert(!nativeNull.read(gea::NativeFieldRead(optionalAnswer, UndefinedPolicy{})));
  assert(nativeNull.read(gea::NativeFieldRead(optionalAnswer, NullPolicy{})));
  assert(optionalAnswer.has_value() && !optionalAnswer->has_value());
  const auto nativeUndefined = gea::NativeDescriptorData::make<OptionalNumber, UndefinedPolicy>(OptionalNumber{});
  const auto presentNull = gea::NativeDescriptorData::make<OptionalNumber, NullPolicy>(OptionalNumber(9));
  const auto presentUndefined = gea::NativeDescriptorData::make<OptionalNumber, UndefinedPolicy>(OptionalNumber(9));
  assert(!nativeNull.sameValue(nativeUndefined) && !nativeUndefined.sameValue(nativeNull));
  assert(presentNull.sameValue(presentUndefined) && presentUndefined.sameValue(presentNull));
  const Value dynamicNull = Value::box(Value::Tag::Null, nullptr);
  const Value dynamicUndefined{};
  assert(nativeNull.sameValue(dynamicNull) && !nativeNull.sameValue(dynamicUndefined));
  assert(nativeUndefined.sameValue(dynamicUndefined) && !nativeUndefined.sameValue(dynamicNull));
  assert(presentNull.sameValue(Value::box(Value::Tag::Number, 9.0)));
  assert(!presentUndefined.sameValue(Value::box(Value::Tag::Number, 10.0)));
  const auto negativeZero = gea::NativeDescriptorData::make<OptionalNumber, NullPolicy>(OptionalNumber(-0.0));
  const auto positiveZero = gea::NativeDescriptorData::make<OptionalNumber, UndefinedPolicy>(OptionalNumber(0.0));
  assert(!negativeZero.sameValue(positiveZero));
  using OptionalArm = gea::TaggedUnion<OptionalNumber, std::string>;
  using NullArmPolicy = gea::NativeFieldUnionPolicy<NullPolicy, gea::NativeFieldLeafPolicy>;
  using UndefinedArmPolicy = gea::NativeFieldUnionPolicy<UndefinedPolicy, gea::NativeFieldLeafPolicy>;
  const auto nestedNull = gea::NativeDescriptorData::make<OptionalArm, NullArmPolicy>(OptionalArm::ofArm<0>(OptionalNumber{}));
  const auto nestedUndefined = gea::NativeDescriptorData::make<OptionalArm, UndefinedArmPolicy>(OptionalArm::ofArm<0>(OptionalNumber{}));
  assert(!nestedNull.sameValue(nestedUndefined));
  assert(nestedNull.sameValue(dynamicNull) && nestedUndefined.sameValue(dynamicUndefined));
  const auto nestedPresentNull = gea::NativeDescriptorData::make<OptionalArm, NullArmPolicy>(OptionalArm::ofArm<0>(OptionalNumber(9)));
  const auto nestedPresentUndefined = gea::NativeDescriptorData::make<OptionalArm, UndefinedArmPolicy>(OptionalArm::ofArm<0>(OptionalNumber(9)));
  assert(nestedPresentNull.sameValue(nestedPresentUndefined));
  assert(nestedPresentUndefined.sameValue(Value::box(Value::Tag::Number, 9.0)));
  using Array = gea::Ref<gea::ArrayObject<double>>;
  using Owner = gea::Ref<NativeAccessorOwner>;
  using Get = gea::CallableObject<Array(Owner)>;
  using Set = gea::CallableObject<void(Owner, Array)>;
  Get getter(+[](void*, Owner owner) { ++owner->reads; return owner->value; }, nullptr);
  Set setter(+[](void*, Owner owner, Array value) { ++owner->writes; owner->value = value; }, nullptr);
  PropertyDescriptor accessor;
  gea::installNativeDescriptorGetter(accessor, gea::NativeDescriptorAccessor::make(getter,
    +[](const gea::NativeDescriptorData& function, const gea::NativeCallReceiver& receiver, const gea::NativeFieldRead& answer) {
      if (!answer.accepts<Array>()) return false;
      const auto* source = function.get<Get>();
      return source != nullptr && answer.assign(source->call(receiver.as<NativeAccessorOwner>()));
    }, nullptr));
  gea::installNativeDescriptorSetter(accessor, gea::NativeDescriptorAccessor::make(setter, nullptr,
    +[](const gea::NativeDescriptorData& function, const gea::NativeCallReceiver& receiver, const gea::NativeFieldWrite& written) {
      std::optional<Array> value;
      const auto* source = function.get<Set>();
      if (source == nullptr || !written.read(value)) return false;
      source->call(receiver.as<NativeAccessorOwner>(), *value);
      return true;
    }));
  auto table = gea::makeRef<gea::DynamicObject>();
  const auto key = gea::PropertyKey::string("items");
  assert(table->defineOwnProperty(key, accessor));
  auto owner = gea::makeRef<NativeAccessorOwner>();
  owner->value = gea::arrayOf<double>({1});
  auto other = gea::makeRef<NativeAccessorOwner>();
  other->value = gea::arrayOf<double>({2});
  std::optional<Array> answer;
  assert(table->readNativeAccessor(key, gea::NativeCallReceiver::object(owner), gea::NativeFieldRead(answer)) == true);
  assert(*answer == owner->value && owner->reads == 1 && other->reads == 0);
  (*answer)->push(3);
  assert(owner->value->size() == 2);
  answer.reset();
  assert(table->readNativeAccessor(key, gea::NativeCallReceiver::object(other), gea::NativeFieldRead(answer)) == true);
  assert(*answer == other->value && other->reads == 1);
  auto replacement = gea::arrayOf<double>({7});
  assert(table->writeNativeAccessor(key, gea::NativeCallReceiver::object(other), gea::NativeFieldWrite::exact(replacement)) == true);
  assert(other->value == replacement && other->writes == 1 && owner->writes == 0);
  assert(table->writeNativeAccessor(key, gea::NativeCallReceiver::object(owner), gea::NativeFieldWrite::exact(9.0)) == false);
  assert(owner->writes == 0 && owner->value->size() == 2);
  const auto* snapshot = table->ownProperty(key);
  assert(snapshot && snapshot->nativeGet.function.get<Get>() != nullptr);
  assert(snapshot->nativeGet.identity() == getter.functionObjectIdentity().get());
  assert(snapshot->nativeSet.identity() == setter.functionObjectIdentity().get());
  assert(table->defineOwnProperty(key, accessor));
  Get different(+[](void*, Owner owner) { return owner->value; }, nullptr);
  auto changed = accessor;
  gea::installNativeDescriptorGetter(changed, gea::NativeDescriptorAccessor::make(different, accessor.nativeGet.read, nullptr));
  assert(!table->defineOwnProperty(key, changed));
  PropertyDescriptor setterOnly;
  gea::installNativeDescriptorSetter(setterOnly, accessor.nativeSet);
  const auto missing = gea::PropertyKey::string("noGetter");
  assert(table->defineOwnProperty(missing, setterOnly));
  std::optional<gea::Undefined> absent;
  assert(table->readNativeAccessor(missing, gea::NativeCallReceiver::object(owner), gea::NativeFieldRead(absent)) == true);
  assert(absent.has_value());
  using DynamicGet = gea::CallableObject<Value(Owner)>;
  DynamicGet dynamicGetter(+[](void*, Owner receiver) {
    ++receiver->reads;
    return Value::box(Value::Tag::Number, static_cast<double>(receiver->reads));
  }, nullptr);
  auto dynamicHalf = gea::NativeDescriptorAccessor::make(dynamicGetter, nullptr, nullptr, nullptr,
    +[](const gea::NativeDescriptorData& function, const gea::NativeCallReceiver& receiver) -> Value {
      return function.get<DynamicGet>()->call(receiver.as<NativeAccessorOwner>());
    });
  const auto observed = dynamicHalf.observeRead(gea::NativeCallReceiver::object(owner));
  assert(observed.tag() == Value::Tag::Number && observed.as<double>() == 2);
  assert(owner->reads == 2 && other->reads == 1);
  assert(dynamicHalf.identity() == dynamicGetter.functionObjectIdentity().get());
}

int main() {
  verifyNativeDescriptorFieldPolicies();
  verifyNativeAccessorDescriptors();
  double field = 1;
  bool present = true;
  NativeIndexAttributes attributes;
  PropertyDescriptor freeze;
  freeze.hasWritable = freeze.hasConfigurable = true;
  freeze.writable = freeze.configurable = false;
  assert(define(field, attributes, present, freeze, Value::Tag::Number));
  assert(field == 1 && !attributes.writable && !attributes.configurable && attributes.enumerable);
  assert(define(field, attributes, present, PropertyDescriptor{}, Value::Tag::Number));
  assert(define(field, attributes, present, valueDescriptor(1), Value::Tag::Number));
  assert(!define(field, attributes, present, valueDescriptor(2), Value::Tag::Number));
  assert(field == 1);

  field = std::numeric_limits<double>::quiet_NaN();
  assert(define(field, attributes, present, valueDescriptor(field), Value::Tag::Number));
  field = 0.0;
  assert(!define(field, attributes, present, valueDescriptor(-0.0), Value::Tag::Number));
  assert(!std::signbit(field));
  field = -0.0;
  assert(define(field, attributes, present, valueDescriptor(-0.0), Value::Tag::Number));

  auto invalid = valueDescriptor(7);
  invalid.hasEnumerable = true;
  invalid.enumerable = false;
  assert(!define(field, attributes, present, invalid, Value::Tag::Number));
  assert(attributes.enumerable && std::signbit(field));
  attributes = NativeIndexAttributes{};
  invalid.value = Value::box(Value::Tag::String, std::string("wrong type"));
  assert(!define(field, attributes, present, invalid, Value::Tag::Number));
  assert(attributes.enumerable && attributes.writable && attributes.configurable && std::signbit(field));
  // The JS tag alone cannot authorize a read with a different physical payload.
  invalid.value = Value::box(Value::Tag::Number, 7);
  assert(!define(field, attributes, present, invalid, Value::Tag::Number));
  PropertyDescriptor accessor;
  accessor.hasGet = true;
  assert(!define(field, attributes, present, accessor, Value::Tag::Number));

  present = false;
  assert(!define(field, attributes, present, PropertyDescriptor{}, Value::Tag::Number));
  assert(!define(field, attributes, present, valueDescriptor(3), Value::Tag::Number, false));
  assert(!present && std::signbit(field));
  assert(define(field, attributes, present, valueDescriptor(3), Value::Tag::Number));
  assert(present && field == 3 && !attributes.writable && !attributes.enumerable && !attributes.configurable);

  auto array = gea::arrayOf<double>({1});
  auto other = gea::arrayOf<double>({1});
  PropertyDescriptor reference;
  reference.hasValue = true;
  reference.value = Value::box(Value::Tag::Object, array);
  assert(define(array, attributes, present, reference, Value::Tag::Object));
  reference.value = Value::box(Value::Tag::Object, other);
  assert(!define(array, attributes, present, reference, Value::Tag::Object));
  assert(array != other);
  gea::Ref<gea::ArrayObject<double>> nullArray;
  reference.value = Value::box(Value::Tag::Object, nullArray);
  assert(define(nullArray, attributes, present, reference, Value::Tag::Object));
  assert(define(nullArray, attributes, present, reference, Value::Tag::Object));

  std::string text = "kept";
  reference.value = Value::box(Value::Tag::String, std::string("kept"));
  assert(define(text, attributes, present, reference, Value::Tag::String));
  reference.value = Value::box(Value::Tag::String, std::string("changed"));
  assert(!define(text, attributes, present, reference, Value::Tag::String));
  assert(text == "kept");

  bool flag = true;
  reference.value = Value::box(Value::Tag::Boolean, true);
  assert(define(flag, attributes, present, reference, Value::Tag::Boolean));
  reference.value = Value::box(Value::Tag::Boolean, false);
  assert(!define(flag, attributes, present, reference, Value::Tag::Boolean));
  assert(flag);

  using Function = gea::CallableObject<double()>;
  Function function(+[](void*) { return 1.0; }, nullptr);
  Function differentFunction(+[](void*) { return 1.0; }, nullptr);
  reference.value = Value::box(Value::Tag::Function, function);
  assert(define(function, attributes, present, reference, Value::Tag::Function));
  reference.value = Value::box(Value::Tag::Function, differentFunction);
  assert(!define(function, attributes, present, reference, Value::Tag::Function));

  using OptionalNumber = gea::Optional<double>;
  OptionalNumber optionalNumber(1.0);
  attributes = NativeIndexAttributes{};
  present = true;
  assert(gea::detail::applyNativeDynamicFieldDescriptor(optionalNumber, attributes, present, freeze, true, true, false, "test", "optional"));
  assert(optionalNumber.has_value() && *optionalNumber == 1.0);
  assert(gea::detail::applyNativeDynamicFieldDescriptor(optionalNumber, attributes, present, PropertyDescriptor{}, true, true, false, "test", "optional"));
  assert(gea::detail::applyNativeDynamicFieldDescriptor(optionalNumber, attributes, present, valueDescriptor(1.0), true, true, false, "test", "optional"));
  assert(!gea::detail::applyNativeDynamicFieldDescriptor(optionalNumber, attributes, present, valueDescriptor(2.0), true, true, false, "test", "optional"));
  assert(optionalNumber.has_value() && *optionalNumber == 1.0);
  optionalNumber = std::numeric_limits<double>::quiet_NaN();
  PropertyDescriptor optionalNaN = valueDescriptor(*optionalNumber);
  assert(gea::detail::applyNativeDynamicFieldDescriptor(optionalNumber, attributes, present, optionalNaN, true, true, false, "test", "optional"));
  optionalNumber = -0.0;
  assert(!gea::detail::applyNativeDynamicFieldDescriptor(optionalNumber, attributes, present, valueDescriptor(0.0), true, true, false, "test", "optional"));
  assert(std::signbit(*optionalNumber));
  assert(gea::detail::applyNativeDynamicFieldDescriptor(optionalNumber, attributes, present, valueDescriptor(-0.0), true, true, false, "test", "optional"));
  optionalNumber = 9.0;
  attributes = NativeIndexAttributes{};
  present = false;
  assert(gea::detail::applyNativeDynamicFieldDescriptor(optionalNumber, attributes, present, PropertyDescriptor{}, true, true, false, "test", "optional"));
  assert(present && !optionalNumber.has_value());

  OptionalNumber nullableNumber;
  attributes = NativeIndexAttributes{};
  present = true;
  assert(gea::detail::applyNativeDynamicFieldDescriptor(nullableNumber, attributes, present, freeze, true, false, true, "test", "nullable"));
  PropertyDescriptor nullableNull;
  nullableNull.hasValue = true;
  nullableNull.value = Value::box(Value::Tag::Null, nullptr);
  assert(gea::detail::applyNativeDynamicFieldDescriptor(nullableNumber, attributes, present, nullableNull, true, false, true, "test", "nullable"));
  PropertyDescriptor nullableUndefined;
  nullableUndefined.hasValue = true;
  nullableUndefined.value = Value();
  assert(!gea::detail::applyNativeDynamicFieldDescriptor(nullableNumber, attributes, present, nullableUndefined, true, false, true, "test", "nullable"));

  using NumberOrText = gea::TaggedUnion<double, std::string>;
  NumberOrText numberOrText = NumberOrText::ofArm<0>(1.0);
  attributes = NativeIndexAttributes{};
  present = true;
  assert(gea::detail::applyNativeDynamicFieldDescriptor(numberOrText, attributes, present, freeze, true, true, false, "test", "union"));
  assert(gea::detail::applyNativeDynamicFieldDescriptor(numberOrText, attributes, present, valueDescriptor(1.0), true, true, false, "test", "union"));
  PropertyDescriptor wrongArm;
  wrongArm.hasValue = true;
  wrongArm.value = Value::box(Value::Tag::String, std::string("text"));
  assert(!gea::detail::applyNativeDynamicFieldDescriptor(numberOrText, attributes, present, wrongArm, true, true, false, "test", "union"));
  assert(numberOrText.template is<0>() && numberOrText.template get<0>() == 1.0);
  PropertyDescriptor malformedNumber = valueDescriptor(1.0);
  malformedNumber.value = Value::box(Value::Tag::Number, static_cast<std::int64_t>(1));
  assert(!gea::detail::applyNativeDynamicFieldDescriptor(numberOrText, attributes, present, malformedNumber, true, true, false, "test", "union"));
  assert(numberOrText.template is<0>() && numberOrText.template get<0>() == 1.0);

  using NestedOptionalUnion = gea::Optional<NumberOrText>;
  NestedOptionalUnion nestedUnion(NumberOrText::ofArm<0>(1.0));
  attributes = NativeIndexAttributes{};
  present = true;
  assert(gea::detail::applyNativeDynamicFieldDescriptor(nestedUnion, attributes, present, freeze, true, true, false, "test", "nested"));
  assert(gea::detail::applyNativeDynamicFieldDescriptor(nestedUnion, attributes, present, valueDescriptor(1.0), true, true, false, "test", "nested"));
  assert(nestedUnion.has_value() && nestedUnion->template is<0>() && nestedUnion->template get<0>() == 1.0);

  using OptionalUnionArm = gea::TaggedUnion<gea::Optional<double>, std::string>;
  OptionalUnionArm optionalUnionArm = OptionalUnionArm::ofArm<0>(gea::Optional<double>());
  attributes = NativeIndexAttributes{};
  present = true;
  assert(gea::detail::applyNativeDynamicFieldDescriptor(optionalUnionArm, attributes, present, freeze, true, true, false, "test", "union-optional"));
  PropertyDescriptor explicitUndefined;
  explicitUndefined.hasValue = true;
  explicitUndefined.value = Value();
  assert(gea::detail::applyNativeDynamicFieldDescriptor(optionalUnionArm, attributes, present, explicitUndefined, true, true, false, "test", "union-optional"));
  assert(optionalUnionArm.template is<0>() && !optionalUnionArm.template get<0>().has_value());

  using UndefinedOrNumber = gea::TaggedUnion<gea::Undefined, double>;
  UndefinedOrNumber undefinedArm = UndefinedOrNumber::ofArm<0>(gea::Undefined{});
  attributes = NativeIndexAttributes{};
  present = true;
  assert(gea::detail::applyNativeDynamicFieldDescriptor(undefinedArm, attributes, present, freeze, true, true, false, "test", "union-undefined"));
  assert(gea::detail::applyNativeDynamicFieldDescriptor(undefinedArm, attributes, present, explicitUndefined, true, true, false, "test", "union-undefined"));
  assert(undefinedArm.template is<0>());

  using NestedUndefinedUnion = gea::TaggedUnion<gea::TaggedUnion<gea::Undefined, double>, std::string>;
  auto nestedUndefinedArm = gea::TaggedUnion<gea::Undefined, double>::ofArm<0>(gea::Undefined{});
  NestedUndefinedUnion nestedUndefined = NestedUndefinedUnion::ofArm<0>(nestedUndefinedArm);
  attributes = NativeIndexAttributes{};
  present = true;
  assert(gea::detail::applyNativeDynamicFieldDescriptor(nestedUndefined, attributes, present, freeze, true, true, false, "test", "nested-undefined"));
  assert(gea::detail::applyNativeDynamicFieldDescriptor(nestedUndefined, attributes, present, explicitUndefined, true, true, false, "test", "nested-undefined"));
  assert(nestedUndefined.template is<0>() && nestedUndefined.template get<0>().template is<0>());

  using NullOrNumber = gea::TaggedUnion<std::nullptr_t, double>;
  NullOrNumber nullArm = NullOrNumber::ofArm<0>(nullptr);
  PropertyDescriptor explicitNull;
  explicitNull.hasValue = true;
  explicitNull.value = Value::box(Value::Tag::Null, nullptr);
  attributes = NativeIndexAttributes{};
  present = true;
  assert(gea::detail::applyNativeDynamicFieldDescriptor(nullArm, attributes, present, freeze, true, false, true, "test", "union-null"));
  assert(gea::detail::applyNativeDynamicFieldDescriptor(nullArm, attributes, present, explicitNull, true, false, true, "test", "union-null"));
  assert(nullArm.template is<0>());

  using ValueOrText = gea::TaggedUnion<Value, std::string>;
  ValueOrText valueArm = ValueOrText::ofArm<0>(Value::box(Value::Tag::Number, 1.0));
  attributes = NativeIndexAttributes{};
  present = true;
  assert(gea::detail::applyNativeDynamicFieldDescriptor(valueArm, attributes, present, freeze, true, true, false, "test", "union-value"));
  assert(gea::detail::applyNativeDynamicFieldDescriptor(valueArm, attributes, present, valueDescriptor(1.0), true, true, false, "test", "union-value"));
  assert(valueArm.template is<0>() && Value::sameValue(valueArm.template get<0>(), Value::box(Value::Tag::Number, 1.0)));

  using OptionalFunction = gea::Optional<Function>;
  OptionalFunction callable(function);
  attributes = NativeIndexAttributes{};
  present = true;
  assert(gea::detail::applyNativeDynamicFieldDescriptor(callable, attributes, present, freeze, true, true, false, "test", "callable"));
  PropertyDescriptor sameCallable;
  sameCallable.hasValue = true;
  sameCallable.value = Value::box(Value::Tag::Function, function);
  assert(gea::detail::applyNativeDynamicFieldDescriptor(callable, attributes, present, sameCallable, true, true, false, "test", "callable"));
  sameCallable.value = Value::box(Value::Tag::Function, differentFunction);
  assert(!gea::detail::applyNativeDynamicFieldDescriptor(callable, attributes, present, sameCallable, true, true, false, "test", "callable"));

  CopyObserved observed;
  attributes = NativeIndexAttributes{};
  assert(define(observed, attributes, present, freeze, Value::Tag::Object));
  assert(CopyObserved::copies == 0);
  assert(define(observed, attributes, present, PropertyDescriptor{}, Value::Tag::Object));
  assert(CopyObserved::copies == 0);
  std::puts("NATIVE_FIELD_DESCRIPTOR_RUNTIME_OK");
}
