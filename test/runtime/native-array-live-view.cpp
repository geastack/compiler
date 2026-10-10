#include "gea_runtime.h"
#include <cassert>
#include <iostream>

using gea::ArrayObject;
using gea::PropertyDescriptor;
using gea::PropertyKey;
using gea::Ref;
using gea::Value;

static Value number(double value) { return Value::box(Value::Tag::Number, value); }
static double readNumber(const Value& value) {
  if (value.tag() != Value::Tag::Number) gea::host::throwRuntimeError("TypeError", "number entry required");
  return value.as<double>();
}
static Value observeNumber(const double& value) { return number(value); }

struct Payload {
  double value = 0;
  Ref<void> back;
  friend void geaTraceRefs(const Payload& value, gea::detail::RefVisitor& visitor) {
    gea::detail::traceRefs(value.back, visitor);
  }
};
struct SnapshotView {};
namespace gea::detail {
template <> struct NativeViewTarget<SnapshotView> : std::true_type {};
}
static int payloadObservations = 0;
static Value observePayload(const Ref<Payload>& value) {
  ++payloadObservations;
  return Value::box(Value::Tag::Object, value);
}
static Ref<Payload> readPayload(const Value& value) {
  if (value.payloadType() != gea::detail::payloadTypeTagFor<Ref<Payload>>())
    gea::host::throwRuntimeError("TypeError", "payload entry required");
  return value.as<Ref<Payload>>();
}

static void nativeSourceAndIndependentReads() {
  auto source = gea::makeRef<ArrayObject<double>>();
  source->push(1.0);
  source->push(2.0);
  source->pushHole();
  source->push(4.0);
  auto view = gea::makeNativeArrayView<long long>(source,
      [](const double& value) { return static_cast<long long>(value); },
      [](const long long& value) { return static_cast<double>(value); },
      [](const Ref<ArrayObject<double>>& value) { return Value::box(Value::Tag::Object, value); },
      [](const double& value) { return number(value); });
  assert(source->hasOrdinaryDenseStorage() && !view->hasOrdinaryDenseStorage());
  assert(view->viewAnchor().get() == source.get());
  assert(view == source);
  assert(view->size() == 4 && !view->present(2));
  source->setElementAtIndex(0, 7.0);
  assert(view->readElementAtIndex(0) == 7);
  view->setElementAtIndex(1, 9ll);
  assert(source->readElement(1) == 9.0);
  gea::runtime::array::reverse(view);
  assert(source->readElement(0) == 4.0 && !source->present(1) && source->readElement(3) == 7.0);
  assert(gea::nativeDynamicSet(view, PropertyKey::string("label"), Value::box(Value::Tag::String, std::string("same"))));
  assert(gea::nativeDynamicGet(source, PropertyKey::string("label")).as<std::string>() == "same");
  assert(gea::nativeDynamicDelete(source, PropertyKey::string("label")));
  assert(!gea::nativeDynamicHas(view, PropertyKey::string("label")));
  auto second = gea::makeNativeArrayView<double>(view,
      [](const long long& value) { return static_cast<double>(value); },
      [](const double& value) { return static_cast<long long>(value); });
  assert(second->viewAnchor().get() == source.get());
  assert(second == source && second == view);
  second->setElementAtIndex(0, 8.0);
  assert(source->readElement(0) == 8.0);
  assert(Value::strictEquals(Value::box(Value::Tag::Object, view), Value::box(Value::Tag::Object, source)));

  auto strings = gea::makeRef<ArrayObject<std::string>>();
  strings->push(std::string("first"));
  auto stringView = gea::makeNativeArrayView<std::string>(strings,
      [](const std::string& value) { return value; }, [](const std::string& value) { return value; });
  const auto retained = stringView->readElement(0);
  strings->setElementAtIndex(0, std::string("later"));
  assert(retained == "first" && stringView->readElement(0) == "later");
}

static void nativeEntryAndDelayedObservation() {
  auto source = gea::makeRef<ArrayObject<Value>>();
  source->push(Value{});
  auto view = gea::makeNativeEntryArrayView<Ref<Payload>>(source, &readPayload, &observePayload);
  auto payload = gea::makeRef<Payload>();
  payload->value = 42;
  view->setElementAtIndex(0, payload);
  assert(payloadObservations == 0 && view->readElement(0) == payload);
  assert(!source->hasOrdinaryDenseStorage());
  PropertyDescriptor descriptor;
  assert(source->ownIndexDescriptor(0, descriptor) && descriptor.nativeValue);
  assert(view->ownIndexDescriptor(0, descriptor) && payloadObservations == 0);
  const auto held = descriptor.nativeValue.get<Ref<Payload>>();
  assert(held && *held == payload);
  const auto keys = gea::nativeOwnPropertyKeys(view);
  assert(keys.size() == 2 && keys[0].text() == "0" && keys[1].text() == "length" && payloadObservations == 0);
  assert(source->readElement(0).as<Ref<Payload>>() == payload && payloadObservations == 1);
  source->setElementAtIndex(0, number(3));
  bool rejected = false;
  try { (void)view->readElement(0); } catch (const Value& error) {
    rejected = gea::host::runtimeErrorString(error).find("payload entry required") != std::string::npos;
  }
  assert(rejected && "a later source write must use the selected checked reader");

  auto numbers = gea::makeRef<ArrayObject<Value>>();
  numbers->push(number(1));
  Value original = Value::box(Value::Tag::Object, numbers);
  auto checked = gea::detail::checkedNativeArrayView<double>(original, "number array required", &readNumber, &observeNumber);
  checked->setElementAtIndex(0, 6.0);
  Value observed;
  assert(original.dynamicArrayElement(0, observed, "array required") && observed.as<double>() == 6.0);
  original.setProperty(PropertyKey::string("0"), number(7));
  assert(checked->readElement(0) == 7.0);
  assert(!gea::detail::nativeArrayViewAccepts<double>(Value::object()));
}

static void descriptorsAndMutationOrder() {
  auto source = gea::makeRef<ArrayObject<Value>>();
  source->push(number(1)); source->push(number(2)); source->push(number(3));
  int getterReads = 0;
  int setterWrites = 0;
  double lastWritten = 0;
  PropertyDescriptor getter;
  getter.hasGet = true;
  getter.get = [&](const Value&) { ++getterReads; return number(11); };
  getter.hasSet = true;
  getter.set = [&](const Value&, const Value& value) { ++setterWrites; lastWritten = readNumber(value); };
  getter.hasEnumerable = getter.hasConfigurable = true;
  getter.enumerable = false; getter.configurable = true;
  assert(source->defineIndex(0, getter));
  auto view = gea::makeNativeEntryArrayView<double>(source, &readNumber, &observeNumber);
  PropertyDescriptor reflected;
  assert(view->ownIndexDescriptor(0, reflected) && reflected.isAccessor() && !reflected.enumerable);
  assert(getterReads == 0 && gea::arrayOwnEnumerableKeys(view) == std::vector<std::string>({"1", "2"}));
  assert(view->readElement(0) == 11 && getterReads == 1);
  const auto removed = gea::runtime::array::splice(view, 0.0, 1.0);
  assert(removed->hasOrdinaryDenseStorage() && removed->readElement(0) == 11 && getterReads == 2);
  assert(setterWrites == 1 && lastWritten == 2);
  assert(source->size() == 2 && source->readElement(1).as<double>() == 3);
  assert(source->removeElement(0));
  assert(!view->present(0) && view->size() == 2);

  auto fixed = gea::makeRef<ArrayObject<Value>>();
  fixed->push(number(1)); fixed->push(number(2)); fixed->push(number(3)); fixed->push(number(4));
  PropertyDescriptor locked;
  locked.hasWritable = locked.hasConfigurable = true;
  locked.writable = false; locked.configurable = false;
  assert(fixed->defineIndex(1, locked));
  auto fixedView = gea::makeNativeEntryArrayView<double>(fixed, &readNumber, &observeNumber);
  auto boxed = Value::box(Value::Tag::Object, fixed);
  boxed.setProperty(PropertyKey::string("1"), number(9));
  assert(fixedView->readElement(1) == 2 && !gea::nativeDynamicDelete(fixedView, PropertyKey::string("1")));
  PropertyDescriptor shrink;
  shrink.hasValue = true; shrink.value = number(0);
  assert(!gea::nativeDynamicDefineProperty(fixedView, PropertyKey::string("length"), shrink));
  assert(fixed->size() == 2 && !fixed->present(2) && fixedView->readElement(1) == 2);
  PropertyDescriptor readonlyLength;
  readonlyLength.hasWritable = true; readonlyLength.writable = false;
  assert(gea::nativeDynamicDefineProperty(fixedView, PropertyKey::string("length"), readonlyLength));
  assert(!fixedView->hasWritableLength() && !fixed->defineIndex(2, PropertyDescriptor::assignment(number(5))));
  boxed.setProperty(PropertyKey::string("length"), number(9));
  assert(fixed->size() == 2);
  gea::nativeFreeze(fixedView);
  assert(gea::nativeIsFrozen(fixed) && gea::nativeIsFrozen(fixedView));
}

static void elementPolicyAndTracing() {
  using OptionalString = gea::Optional<std::string>;
  using NullPolicy = gea::NativeFieldOptionalPolicy<true>;
  using UndefinedPolicy = gea::NativeFieldOptionalPolicy<false>;
  auto optional = gea::makeRef<ArrayObject<OptionalString>>();
  optional->push(OptionalString{});
  const auto erased = Value::box(Value::Tag::Object, optional);
  assert((!gea::detail::nativeArrayViewAccepts<OptionalString, NullPolicy>(erased)));
  auto nullView = gea::makeNativeArrayView<OptionalString, NullPolicy, NullPolicy>(optional,
      [](const OptionalString& value) { return value; }, [](const OptionalString& value) { return value; });
  assert((gea::detail::nativeArrayViewAccepts<OptionalString, NullPolicy>(erased)));
  assert((!gea::detail::nativeArrayViewAccepts<OptionalString, UndefinedPolicy>(erased)));
  PropertyDescriptor descriptor;
  assert(nullView->ownIndexDescriptor(0, descriptor));
  assert(descriptor.nativeValue.sameValue(Value::box(Value::Tag::Null, nullptr)));
  assert(!descriptor.nativeValue.sameValue(Value{}));

  gea::WeakRef<ArrayObject<Value>> weakSource;
  gea::WeakRef<Payload> weakPayload;
  {
    auto source = gea::makeRef<ArrayObject<Value>>();
    source->push(Value{});
    auto view = gea::makeNativeEntryArrayView<Ref<Payload>>(source, &readPayload, &observePayload);
    auto payload = gea::makeRef<Payload>();
    payload->back = Ref<void>(view);
    weakSource = gea::WeakRef<ArrayObject<Value>>(source);
    weakPayload = gea::WeakRef<Payload>(payload);
    view->setElementAtIndex(0, payload);
  }
  gea::collectCycles();
  assert(weakSource.expired() && weakPayload.expired());
}

static void liveMethodEffectsKeepEntryRange() {
  auto popped = gea::makeRef<ArrayObject<Value>>();
  popped->push(number(1)); popped->push(number(2)); popped->push(number(3));
  int popReads = 0;
  PropertyDescriptor popGetter;
  popGetter.hasGet = popGetter.hasConfigurable = true;
  popGetter.configurable = true;
  popGetter.get = [&](const Value&) { ++popReads; popped->push(number(4)); return number(99); };
  assert(popped->defineIndex(2, popGetter));
  auto popView = gea::makeNativeEntryArrayView<double>(popped, &readNumber, &observeNumber);
  const auto last = gea::runtime::array::pop(popView);
  assert(last.has_value() && *last == 99 && popReads == 1 && popped->size() == 2);

  auto shifted = gea::makeRef<ArrayObject<Value>>();
  shifted->push(number(1)); shifted->push(number(2)); shifted->push(number(3));
  int shiftReads = 0;
  double shiftedFirstWrite = 0;
  PropertyDescriptor shiftGetter;
  shiftGetter.hasGet = shiftGetter.hasSet = shiftGetter.hasConfigurable = true;
  shiftGetter.configurable = true;
  shiftGetter.get = [&](const Value&) { ++shiftReads; shifted->push(number(4)); return number(88); };
  shiftGetter.set = [&](const Value&, const Value& value) { shiftedFirstWrite = readNumber(value); };
  assert(shifted->defineIndex(0, shiftGetter));
  auto shiftView = gea::makeNativeEntryArrayView<double>(shifted, &readNumber, &observeNumber);
  const auto first = gea::runtime::array::shift(shiftView);
  assert(first.has_value() && *first == 88 && shiftReads == 1 && shiftedFirstWrite == 2 && shifted->size() == 2);
  assert(shifted->readElement(1).as<double>() == 3);

  auto sorted = gea::makeRef<ArrayObject<Value>>();
  sorted->push(number(3)); sorted->push(number(1)); sorted->push(number(2)); sorted->pushHole();
  auto sortView = gea::makeNativeEntryArrayView<double>(sorted, &readNumber, &observeNumber);
  bool comparatorExtended = false;
  gea::runtime::array::sortIndexedProperties(sortView, [&](double left, double right) {
    if (!comparatorExtended) { comparatorExtended = true; sorted->setElementAtIndex(5, number(99)); }
    return left < right;
  });
  assert(comparatorExtended && sorted->size() == 6 && sorted->present(5));
  assert(sortView->readElement(0) == 1 && sortView->readElement(2) == 3 && sorted->readElement(5).as<double>() == 99);

  auto undefined = gea::makeRef<ArrayObject<Value>>();
  undefined->push(number(3)); undefined->pushUndefined(); undefined->pushHole(); undefined->push(number(1));
  auto undefinedView = gea::makeNativeEntryArrayView<double>(undefined, &readNumber, &observeNumber);
  gea::runtime::array::sortIndexedProperties(undefinedView, [](double left, double right) { return left < right; });
  assert(undefinedView->readElement(0) == 1 && undefinedView->readElement(1) == 3);
  assert(undefinedView->present(2) && undefinedView->elementIsUndefined(2) && !undefinedView->present(3));
}

static Ref<SnapshotView> snapshotView(const Ref<gea::NativeDescriptorSnapshot>& snapshot) {
  return gea::record::makeDescriptorSnapshotViewWithOrigin<SnapshotView>(snapshot,
      +[](const Ref<void>& source, const PropertyKey& key, const gea::NativeFieldRead& read) {
        return gea::nativeDescriptorSnapshotRead(source.staticCast<gea::NativeDescriptorSnapshot>(), key, read, true);
      });
}

static void descriptorSnapshotsRemainIndependent() {
  auto source = gea::makeRef<ArrayObject<Value>>();
  source->push(Value{});
  auto view = gea::makeNativeEntryArrayView<Ref<Payload>>(source, &readPayload, &observePayload);
  auto oldPayload = gea::makeRef<Payload>(); oldPayload->value = 17;
  view->setElementAtIndex(0, oldPayload);
  const int observations = payloadObservations;
  const auto captured = gea::captureNativeArrayDescriptor(view, PropertyKey::string("0"));
  assert(captured && payloadObservations == observations);
  const auto snapshot = *captured;
  auto publicView = snapshotView(snapshot);
  assert(gea::record::nativeViewOrigin(Ref<void>(publicView)).get() == snapshot->identity());
  assert(publicView == snapshot && publicView != view);
  const auto keys = gea::nativeOwnPropertyKeys(publicView);
  assert(keys == std::vector<PropertyKey>({PropertyKey::string("value"), PropertyKey::string("writable"),
      PropertyKey::string("enumerable"), PropertyKey::string("configurable")}));
  assert(gea::nativeEnumerableStringKeys(publicView) == keys);
  assert(gea::nativeDynamicHas(publicView, PropertyKey::string("value")) &&
      !gea::nativeDynamicHas(publicView, PropertyKey::string("get")));
  const auto own = gea::nativeOwnPropertyDescriptor(publicView, PropertyKey::string("value"));
  assert(own.has_value() && own->writable && own->enumerable && own->configurable && own->nativeValue);
  assert(payloadObservations == observations);
  auto nested = gea::record::makeLiveViewWithOrigin<SnapshotView>(publicView,
      +[](const Ref<void>& source, const PropertyKey& key, const gea::NativeFieldRead& read) {
        return gea::record::readFieldView(source, key, read);
      }, nullptr, nullptr,
      +[](const Ref<void>& source, const PropertyKey& key) { return gea::record::hasOwnFieldView(source, key); },
      +[](const Ref<void>& source, const PropertyKey& key) { return gea::record::hasPropertyFieldView(source, key); });
  assert(gea::nativeOwnPropertyKeys(nested) == keys && nested == publicView);
  gea::Optional<PropertyDescriptor> reused = *own;
  assert(gea::record::ownNativeViewDescriptor(Ref<void>(nested), PropertyKey::string("missing"), reused) && !reused.has_value());
  std::optional<Ref<Payload>> retained;
  assert(gea::nativeDescriptorSnapshotRead(snapshot, PropertyKey::string("value"), gea::NativeFieldRead(retained)));
  assert(*retained == oldPayload);
  auto replacement = gea::makeRef<Payload>(); replacement->value = 29;
  view->setElementAtIndex(0, replacement);
  retained.reset();
  assert(gea::nativeDescriptorSnapshotRead(snapshot, PropertyKey::string("value"), gea::NativeFieldRead(retained)) &&
      *retained == oldPayload);
  std::optional<Value> observed;
  assert(!gea::nativeDescriptorSnapshotRead(snapshot, PropertyKey::string("value"), gea::NativeFieldRead(observed), false));
  assert(gea::nativeDescriptorSnapshotRead(snapshot, PropertyKey::string("value"), gea::NativeFieldRead(observed), true));
  assert(observed->as<Ref<Payload>>() == oldPayload && payloadObservations == observations + 1);
  auto target = gea::makeRef<ArrayObject<Value>>();
  const auto copied = gea::record::nativeDescriptorSnapshotDefinitionFromView(publicView);
  assert(copied && target->defineIndex(0, *copied));
  auto targetView = gea::makeNativeEntryArrayView<Ref<Payload>>(target, &readPayload, &observePayload);
  assert(targetView->readElement(0) == oldPayload && payloadObservations == observations + 1);
  bool rejectedWrite = false;
  try { gea::nativeDynamicSet(publicView, PropertyKey::string("value"), number(3)); }
  catch (const Value&) { rejectedWrite = true; }
  assert(rejectedWrite);
  auto escaped = Value::fromDynamicObject(snapshot->fieldTable());
  escaped.setProperty(PropertyKey::string("value"), number(3));
  bool rejectedStale = false;
  try { (void)gea::record::nativeDescriptorSnapshotDefinitionFromView(publicView); }
  catch (const Value&) { rejectedStale = true; }
  assert(rejectedStale && payloadObservations == observations + 1);

  auto native = gea::makeRef<ArrayObject<double>>(); native->push(7.0);
  auto nativeAlias = gea::makeNativeArrayView<double>(native,
      [](double value) { return value; }, [](double value) { return value; });
  const auto nativeSnapshot = gea::captureNativeArrayDescriptor(nativeAlias, PropertyKey::string("0"));
  assert(nativeSnapshot);
  std::optional<double> total;
  assert(gea::nativeDescriptorSnapshotRead(*nativeSnapshot, PropertyKey::string("value"), gea::NativeFieldRead(total)) && *total == 7);
  observed.reset();
  assert(!gea::nativeDescriptorSnapshotRead(*nativeSnapshot, PropertyKey::string("value"), gea::NativeFieldRead(observed), true));
  const auto length = gea::captureNativeArrayDescriptor(nativeAlias, PropertyKey::string("length"));
  total.reset();
  assert(length && gea::nativeDescriptorSnapshotRead(*length, PropertyKey::string("value"), gea::NativeFieldRead(total)) && *total == 1);
  assert(!gea::captureNativeArrayDescriptor(nativeAlias, PropertyKey::string("4")));

  using OptionalString = gea::Optional<std::string>;
  using NullPolicy = gea::NativeFieldOptionalPolicy<true>;
  using UndefinedPolicy = gea::NativeFieldOptionalPolicy<false>;
  auto optional = gea::makeRef<ArrayObject<OptionalString>>(); optional->push(OptionalString{});
  bool refusedUnstamped = false;
  try { (void)gea::captureNativeArrayDescriptor(optional, PropertyKey::string("0")); }
  catch (const Value&) { refusedUnstamped = true; }
  assert(refusedUnstamped);
  const auto policySnapshot = gea::captureNativeArrayDescriptor(optional, PropertyKey::string("0"), NullPolicy{});
  std::optional<OptionalString> optionalValue;
  assert(policySnapshot && gea::nativeDescriptorSnapshotRead(*policySnapshot, PropertyKey::string("value"),
      gea::NativeFieldRead(optionalValue, NullPolicy{})) && !optionalValue->has_value());
  optionalValue.reset();
  assert(!gea::nativeDescriptorSnapshotRead(*policySnapshot, PropertyKey::string("value"),
      gea::NativeFieldRead(optionalValue, UndefinedPolicy{})));
}

static void accessorSnapshotsAreGetterBlind() {
  auto source = gea::makeRef<ArrayObject<Value>>(); source->push(Value{});
  int originalReads = 0;
  PropertyDescriptor accessor;
  accessor.hasGet = accessor.hasSet = accessor.hasEnumerable = accessor.hasConfigurable = true;
  accessor.enumerable = accessor.configurable = true;
  accessor.get = [&](const Value&) { ++originalReads; return number(41); };
  assert(source->defineIndex(0, accessor));
  const auto captured = gea::captureNativeArrayDescriptor(source, PropertyKey::string("0"));
  assert(captured && originalReads == 0);
  const auto snapshot = *captured;
  auto publicView = snapshotView(snapshot);
  assert(gea::nativeOwnPropertyNames(publicView) == std::vector<std::string>({"get", "set", "enumerable", "configurable"}));
  assert(!gea::nativeDynamicHas(publicView, PropertyKey::string("value")));
  std::optional<gea::Undefined> absent;
  assert(gea::nativeDescriptorSnapshotRead(snapshot, PropertyKey::string("value"), gea::NativeFieldRead(absent)) && originalReads == 0);
  std::optional<Value> getter;
  assert(!gea::nativeDescriptorSnapshotRead(snapshot, PropertyKey::string("get"), gea::NativeFieldRead(getter), true));
  PropertyDescriptor changed = accessor;
  changed.get = [](const Value&) { return number(99); };
  assert(source->defineIndex(0, changed));
  auto target = gea::makeRef<ArrayObject<Value>>();
  const auto copied = gea::record::nativeDescriptorSnapshotDefinitionFromView(publicView);
  assert(copied && target->defineIndex(0, *copied) && originalReads == 0);
  assert(target->readElement(0).as<double>() == 41 && originalReads == 1);
  std::optional<gea::Undefined> absentSetter;
  assert(gea::nativeDescriptorSnapshotRead(snapshot, PropertyKey::string("set"), gea::NativeFieldRead(absentSetter)));
}

static int nativeGetterReads = 0;
static void nativeAccessorSnapshotsRetainFunctionAndTrace() {
  using Getter = gea::CallableObject<double()>;
  Getter getter{+[](void*) { ++nativeGetterReads; return 73.0; }, nullptr};
  PropertyDescriptor descriptor;
  descriptor.hasGet = descriptor.hasSet = descriptor.hasEnumerable = descriptor.hasConfigurable = true;
  descriptor.enumerable = descriptor.configurable = true;
  descriptor.nativeGet = gea::NativeDescriptorAccessor::make(getter,
      +[](const gea::NativeDescriptorData& held, const gea::NativeCallReceiver&, const gea::NativeFieldRead& read) {
        const auto* function = held.get<Getter>();
        return function && read.acceptsExact<double>() && read.assign((*function)());
      }, nullptr);
  auto source = gea::makeRef<ArrayObject<Value>>(); source->push(Value{});
  assert(source->defineIndex(0, descriptor));
  const auto captured = gea::captureNativeArrayDescriptor(source, PropertyKey::string("0"));
  assert(captured && nativeGetterReads == 0);
  std::optional<Getter> copiedFunction;
  assert(gea::nativeDescriptorSnapshotRead(*captured, PropertyKey::string("get"), gea::NativeFieldRead(copiedFunction)));
  assert(copiedFunction->functionObjectIdentity() == getter.functionObjectIdentity() && nativeGetterReads == 0);
  auto target = gea::makeRef<ArrayObject<Value>>();
  assert(target->defineIndex(0, (*captured)->definition()));
  auto targetView = gea::makeNativeEntryArrayView<double>(target, &readNumber, &observeNumber);
  assert(targetView->readElement(0) == 73 && nativeGetterReads == 1);

  gea::WeakRef<gea::NativeDescriptorSnapshot> weakSnapshot;
  gea::WeakRef<Payload> weakPayload;
  {
    auto owner = gea::makeRef<ArrayObject<Value>>(); owner->push(Value{});
    auto typed = gea::makeNativeEntryArrayView<Ref<Payload>>(owner, &readPayload, &observePayload);
    auto payload = gea::makeRef<Payload>();
    typed->setElementAtIndex(0, payload);
    const auto snapshot = *gea::captureNativeArrayDescriptor(typed, PropertyKey::string("0"));
    auto view = snapshotView(snapshot);
    payload->back = Ref<void>(view);
    weakSnapshot = gea::WeakRef<gea::NativeDescriptorSnapshot>(snapshot);
    weakPayload = gea::WeakRef<Payload>(payload);
  }
  gea::collectCycles();
  assert(weakSnapshot.expired() && weakPayload.expired());
}

int main() {
  nativeSourceAndIndependentReads();
  nativeEntryAndDelayedObservation();
  descriptorsAndMutationOrder();
  elementPolicyAndTracing();
  liveMethodEffectsKeepEntryRange();
  descriptorSnapshotsRemainIndependent();
  accessorSnapshotsAreGetterBlind();
  nativeAccessorSnapshotsRetainFunctionAndTrace();
  std::cout << "NATIVE_ARRAY_LIVE_VIEW_OK\n";
}
