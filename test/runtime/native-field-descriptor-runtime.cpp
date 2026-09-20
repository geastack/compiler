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

int main() {
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
