import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const executable = resolve(root, 'measurements/native-method-contracts')
const source = `#include "gea_runtime.h"
#include <cassert>
#include <iostream>
struct Receiver final { std::string name; bool namePresent = true; explicit Receiver(std::string name_) : name(std::move(name_)) {} };
struct View final { static constexpr bool gea_traceLeaf = true; double field = 0; };
struct ThrowingView final { ThrowingView() { throw std::runtime_error("view construction"); } };
namespace gea::detail {
template <> struct NativeViewTarget<View> : std::true_type {};
template <> struct NativeViewTarget<ThrowingView> : std::true_type {};
}
struct CycleOrigin final {
  gea::Ref<View> view;
  friend void geaTraceRefs(const CycleOrigin& value, gea::detail::RefVisitor& visitor) { gea::detail::traceRefs(value.view, visitor); }
};
struct OtherReceiver final { std::string name = "other-family"; };
using NativeReceiverSum = gea::TaggedUnion<gea::Ref<Receiver>, gea::Ref<OtherReceiver>>;
std::string sumRead(void*, NativeReceiverSum receiver) {
  if (receiver.is<0>()) return receiver.get<0>()->name;
  return receiver.get<1>()->name;
}
int effects = 0;
std::string readReceiver(void*, gea::Ref<Receiver> receiver, std::string suffix) {
  ++effects;
  return receiver->name + ":" + suffix;
}
gea::Ref<Receiver> self(void*, gea::Ref<Receiver> receiver) { return receiver; }
gea::Value dynamicRead(void*, gea::Value receiver, std::string suffix) {
  const std::string name = receiver.tag() == gea::Value::Tag::Undefined ? "undefined" :
    gea::detail::unboxClassRef<Receiver>(receiver, "a dynamic method receiver")->name;
  return gea::Value::box(gea::Value::Tag::String, name + ":" + suffix);
}
gea::Value dynamicSelf(void*, gea::Value receiver) { return receiver; }
int liveReads = 0;
int liveWrites = 0;
bool liveReadRoute(const gea::Ref<void>& immediate, const gea::PropertyKey& key, const gea::NativeFieldRead& read) {
  if (gea::record::hasLiveFieldView(immediate)) return gea::record::readFieldView(immediate, key, read);
  if (key.isSymbol() || key.text() != "name" || !read.accepts<std::string>()) return false;
  ++liveReads;
  return read.assign(immediate.staticCast<Receiver>()->name);
}
bool liveWriteRoute(const gea::Ref<void>& immediate, const gea::PropertyKey& key, const gea::NativeFieldWrite& write) {
  if (gea::record::hasLiveFieldView(immediate)) return gea::record::writeFieldView(immediate, key, write);
  if (key.isSymbol() || key.text() != "name") return false;
  std::optional<std::string> value;
  if (!write.read(value)) return false;
  ++liveWrites;
  immediate.staticCast<Receiver>()->name = std::move(*value);
  return true;
}
bool liveHasOwnRoute(const gea::Ref<void>& immediate, const gea::PropertyKey& key) {
  if (gea::record::hasLiveFieldView(immediate)) return gea::record::hasOwnFieldView(immediate, key);
  return !key.isSymbol() && key.text() == "name" && immediate.staticCast<Receiver>()->namePresent;
}
bool liveHasPropertyRoute(const gea::Ref<void>& immediate, const gea::PropertyKey& key) {
  if (gea::record::hasLiveFieldView(immediate)) return gea::record::hasPropertyFieldView(immediate, key);
  return liveHasOwnRoute(immediate, key) || gea::ordinaryObjectPrototypeHas(key);
}
std::string liveName(const gea::Ref<View>& view) {
  return gea::record::readLiveField<std::string>(view, gea::PropertyKey::string("name"),
      [](void* result, const void* type, const void* policy, const void* source) -> bool {
        if (type != gea::detail::payloadTypeTagFor<std::string>() ||
            policy != gea::detail::payloadTypeTagFor<gea::NativeFieldLeafPolicy>()) return false;
        static_cast<std::optional<std::string>*>(result)->emplace(*static_cast<const std::string*>(source));
        return true;
      },
      +[](const void* type, const void* policy) -> bool {
        return type == gea::detail::payloadTypeTagFor<std::string>() &&
            policy == gea::detail::payloadTypeTagFor<gea::NativeFieldLeafPolicy>();
      },
      []() -> std::string { throw std::runtime_error("plain allocation has no name"); });
}
void setLiveName(const gea::Ref<View>& view, std::string value) {
  const bool changed = gea::record::writeLiveField(view, gea::PropertyKey::string("name"), value,
      [&](const void* type, const void* policy, void* result) -> bool {
        if (type != gea::detail::payloadTypeTagFor<std::string>() ||
            policy != gea::detail::payloadTypeTagFor<gea::NativeFieldLeafPolicy>()) return false;
        static_cast<std::optional<std::string>*>(result)->emplace(value);
        return true;
      },
      []() -> bool { return false; });
  assert(changed);
}
gea::Ref<Receiver> retainedFunctionSelf(void* environment) { return *static_cast<gea::Ref<Receiver>*>(environment); }
gea::Value dynamicRestRead(void*, gea::Value receiver, gea::Ref<gea::ArrayObject<std::string>> values) {
  const std::string name = receiver.tag() == gea::Value::Tag::Undefined ? "undefined" :
    gea::detail::unboxClassRef<Receiver>(receiver, "a dynamic rest method receiver")->name;
  return gea::Value::box(gea::Value::Tag::String, name + ":" + std::to_string(values->size()));
}
using LazyOwner = gea::CallableObject<gea::Value(gea::Ref<Receiver>, gea::Ref<gea::ArrayObject<std::string>>)>;
inline char physicalReceiverSourceTag;
int ownerMaterializations = 0;
using ConstructorReceiver = gea::ConstructorObject<gea::Ref<Receiver>()>;
int constructorMaterializations = 0;
gea::Value materializeConstructor(const ConstructorReceiver& source) {
  ++constructorMaterializations;
  return gea::Value::box(gea::Value::Tag::Function, source);
}
gea::Value observeNativeConstructor(void*, ConstructorReceiver source) {
  assert(source.environment != nullptr && source.environmentOwner);
  return gea::Value::box(gea::Value::Tag::Number, 7.0);
}
gea::Value materializeOwner(const LazyOwner& source) {
  ++ownerMaterializations;
  return gea::Value::boxMethod<1>(source);
}
gea::Value nativeOwnerRest(void*, gea::Ref<Receiver> receiver, gea::Ref<gea::ArrayObject<std::string>> values) {
  return gea::Value::box(gea::Value::Tag::String, receiver->name + ":" + std::to_string(values->size()));
}
gea::Value ignoreOwner(void*) { return gea::Value::box(gea::Value::Tag::Number, 7.0); }
gea::Value dynamicRestSelf(void*, gea::Value receiver, gea::Ref<gea::ArrayObject<gea::Value>> values) {
  assert(values->size() == 2);
  assert(values->elementAt(0).as<std::string>() == "x" && values->elementAt(1).as<std::string>() == "y");
  return receiver;
}
gea::Value observeTypedOwner(void*, LazyOwner source) { return gea::Value::box(gea::Value::Tag::Number, source.length()); }
template <class Call> void requiresCallable(Call call) {
  bool threw = false;
  try { call(); }
  catch (const gea::Value& error) {
    threw = true;
    assert(gea::host::instanceOfRuntimeError(error, "TypeError"));
  }
  assert(threw);
}
int argumentEvaluations = 0;
std::string evaluatedArgument() { ++argumentEvaluations; return "argument"; }
int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "missing-receiver-factory") {
    using Physical = gea::CallableObject<gea::Value(double)>;
    const auto source = gea::Value::box(gea::Value::Tag::Function, gea::CallableObject<gea::Value()>{&ignoreOwner, nullptr});
    gea::detail::DynamicCarrier<Physical>::inWithReceiver(source, 0).call(7.0);
    return 1;
  }
  {
    using Policy = gea::NativeFieldLeafPolicy;
    auto owner = gea::makeRef<Receiver>("native storage owner");
    const auto key = gea::PropertyKey::string("extension");
    int absent = 0;
    auto get = [&]() {
      return gea::nativeObjectDataGet<std::string, Policy>(owner, key,
          [](const std::string& stored) { return stored; },
          [&]() { ++absent; return std::string("absent"); });
    };
    assert(get() == "absent" && absent == 1);
    assert(gea::nativeObjectDataSet<Policy>(owner, key, std::string("first")));
    assert(get() == "first" && absent == 1);
    assert(gea::nativeObjectDataSet<Policy>(owner, key, std::string("second")));
    assert(get() == "second");
    const auto table = gea::detail::expandoFor(gea::refCastToVoid(owner), false);
    const auto* descriptor = table->ownProperty(key);
    assert(descriptor && descriptor->hasValue && descriptor->writable && descriptor->enumerable && descriptor->configurable);
    assert(descriptor->nativeValue && descriptor->value.tag() == gea::Value::Tag::Undefined);
    std::optional<double> wrong;
    assert(!gea::nativeObjectDataReadNative(owner, key, gea::NativeFieldRead(wrong, Policy{})));
    gea::PropertyDescriptor readonly;
    readonly.hasWritable = true;
    readonly.writable = false;
    assert(table->defineOwnProperty(key, readonly));
    assert(!gea::nativeObjectDataSet<Policy>(owner, key, std::string("lost")) && get() == "second");
    table->preventExtensions();
    assert(!gea::nativeObjectDataSet<Policy>(owner, gea::PropertyKey::string("new"), 0.5));
    for (const auto nullish : {gea::Ref<Receiver>(), gea::Ref<Receiver>::undefined()}) {
      requiresCallable([&] {
        gea::nativeObjectDataGet<std::string, Policy>(nullish, key,
            [](const std::string& value) { return value; }, [] { return std::string("wrong"); });
      });
      requiresCallable([&] { gea::nativeObjectDataSet<Policy>(nullish, key, std::string("wrong")); });
    }
  }
  {
    using Policy = gea::NativeFieldLeafPolicy;
    auto owner = gea::makeRef<Receiver>("typed payload owner");
    auto payload = gea::makeRef<Receiver>("retained native payload");
    const gea::WeakRef<Receiver> weak(payload);
    const auto key = gea::PropertyKey::string("payload");
    assert(gea::nativeObjectDataSet<Policy>(owner, key, payload));
    const auto identity = payload.get();
    payload = {};
    assert(!weak.expired());
    auto stored = gea::nativeObjectDataGet<gea::Ref<Receiver>, Policy>(owner, key,
        [](const gea::Ref<Receiver>& value) { return value; }, []() -> gea::Ref<Receiver> { assert(false); return {}; });
    assert(stored.get() == identity && stored->name == "retained native payload");
    stored = {};
    owner = {};
    assert(weak.expired());
  }
  {
    const gea::CallableObject<std::string(std::string)> absent;
    requiresCallable([&] { absent.call(evaluatedArgument()); });
    assert(argumentEvaluations == 1);
    requiresCallable([&] { absent.callWithReceiver(gea::NativeCallReceiver::undefined(), "x"); });
    requiresCallable([&] { absent.callStable("x"); });
    requiresCallable([&] { absent.callKnown<&readReceiver>("x"); });
    requiresCallable([&] { absent.callStableKnown<&readReceiver>("x"); });
    requiresCallable([&] { absent("x"); });
    const gea::CallableConstructorObject<std::string(std::string), gea::Ref<Receiver>()> absentConstructor;
    requiresCallable([&] { absentConstructor.call("x"); });
    requiresCallable([&] { absentConstructor.callWithReceiver(gea::NativeCallReceiver::undefined(), "x"); });
    assert(effects == 0);
  }
  using Read = gea::CallableObject<std::string(std::string)>;
  const gea::CallableObject<std::string(gea::Ref<Receiver>, std::string)> source{&readReceiver, nullptr};
  const Read unbound = Read::unboundMethod(source);
  const auto first = gea::makeRef<Receiver>("first");
  const auto second = gea::makeRef<Receiver>("second");
  assert(unbound.callWithReceiver(gea::NativeCallReceiver::object(first), "x") == "first:x");
  try { unbound.call("detached"); assert(false); } catch (...) {}
  assert(effects == 2);
  const auto bound = gea::bindCallableWithReceiver<std::string(std::string), 0>(unbound, gea::NativeCallReceiver::object(second));
  assert(bound.call("y") == "second:y");
  const auto rebound = gea::bindCallableWithReceiver<std::string(std::string), 0>(bound, gea::NativeCallReceiver::object(first));
  assert(rebound.call("z") == "second:z");
  const auto prefixed = gea::bindCallableWithReceiver<std::string(), 1>(unbound, gea::NativeCallReceiver::object(second), std::string("prefix"));
  assert(prefixed.call() == "second:prefix");
  assert(unbound.functionObjectIdentity() == source.functionObjectIdentity());
  assert(Read::unboundMethod(source).functionObjectIdentity() == unbound.functionObjectIdentity());
  const auto view = gea::record::makeViewWithOrigin<View>(first);
  const auto secondView = gea::record::makeViewWithOrigin<View>(view);
  assert(unbound.callWithReceiver(gea::NativeCallReceiver::object(view), "view") == "first:view");
  assert(unbound.callWithReceiver(gea::NativeCallReceiver::object(secondView), "chain") == "first:chain");
  assert(gea::record::viewOriginClassRef<Receiver>(view) == first);
  assert(gea::record::viewOriginClassIs<Receiver>(secondView));
  assert(!gea::record::viewOriginClassIs<Receiver>(gea::makeRef<View>()));
  assert(gea::detail::refPayloadIdentity(view) == &gea::detail::RefOperationsFor<View>::table);
  assert(gea::NativeCallReceiver::object(view).is<View>());
  assert(gea::host::hasNativeClassLayoutRef<View>(view));
  assert(gea::NativeCallReceiver::object(view).dynamicValue().classObject() == first.staticCast<void>());
  assert(gea::NativeCallReceiver::object(secondView).dynamicValue().classObject() == first.staticCast<void>());
  {
    auto original = gea::makeRef<Receiver>("failed construction");
    const gea::WeakRef<Receiver> weakOriginal(original);
    try { gea::record::makeViewWithOrigin<ThrowingView>(original); assert(false); } catch (const std::runtime_error&) {}
    original = {};
    assert(weakOriginal.expired());
  }
  {
    auto original = gea::makeRef<Receiver>("retained origin");
    const gea::WeakRef<Receiver> weakOriginal(original);
    auto heldView = gea::record::makeViewWithOrigin<View>(original);
    const gea::WeakRef<View> weakView(heldView);
    original = {};
    assert(!weakOriginal.expired());
    assert(gea::record::viewOriginClassRef<Receiver>(heldView)->name == "retained origin");
    heldView = {};
    assert(weakOriginal.expired() && weakView.expired());
  }
  {
    auto original = gea::makeRef<CycleOrigin>();
    const gea::WeakRef<CycleOrigin> weakOriginal(original);
    auto cyclicView = gea::record::makeViewWithOrigin<View>(original);
    const gea::WeakRef<View> weakView(cyclicView);
    original->view = cyclicView;
    original = {};
    cyclicView = {};
    gea::collectCycles();
    assert(weakOriginal.expired() && weakView.expired());
  }
  {
    auto original = gea::makeRef<Receiver>("before");
    const gea::WeakRef<Receiver> weakOriginal(original);
    auto live = gea::record::makeLiveViewWithOrigin<View>(original, &liveReadRoute, &liveWriteRoute, nullptr, &liveHasOwnRoute, &liveHasPropertyRoute);
    const gea::WeakRef<View> weakLive(live);
    auto chain = gea::record::makeLiveViewWithOrigin<View>(live, &liveReadRoute, &liveWriteRoute, nullptr, &liveHasOwnRoute, &liveHasPropertyRoute);
    assert(liveReads == 0 && liveWrites == 0);
    assert(gea::nativeDynamicHas(chain, gea::PropertyKey::string("name")));
    assert(!gea::nativeDynamicHas(chain, gea::PropertyKey::string("field")));
    assert(!gea::nativeDynamicHas(chain, gea::PropertyKey::string("toString")));
    assert(gea::nativeDynamicHasProperty(chain, gea::PropertyKey::string("toString")));
    original->namePresent = false;
    assert(!gea::nativeDynamicHasProperty(chain, gea::PropertyKey::string("name")));
    original->namePresent = true;
    assert(liveReads == 0 && liveWrites == 0);
    assert(original == live && live == chain);
    assert(gea::Value::box(gea::Value::Tag::Object, chain).classObject() == original.staticCast<void>());
    original->name = "original write";
    assert(liveName(chain) == "original write");
    setLiveName(chain, "view write");
    assert(original->name == "view write" && liveName(live) == "view write");
    std::optional<double> incompatible;
    gea::NativeFieldRead noStringRoute(incompatible);
    assert(!gea::record::readFieldView(chain.staticCast<void>(), gea::PropertyKey::string("name"), noStringRoute));
    assert(liveReads == 2 && liveWrites == 1 && !incompatible);
    live = {};
    original = {};
    assert(!weakLive.expired() && !weakOriginal.expired());
    assert(liveName(chain) == "view write");
    chain = {};
    assert(weakLive.expired() && weakOriginal.expired());
  }
  {
    auto original = gea::makeRef<CycleOrigin>();
    const gea::WeakRef<CycleOrigin> weakOriginal(original);
    auto live = gea::record::makeLiveViewWithOrigin<View>(original, &liveReadRoute, &liveWriteRoute);
    const gea::WeakRef<View> weakLive(live);
    original->view = live;
    original = {};
    live = {};
    gea::collectCycles();
    assert(weakOriginal.expired() && weakLive.expired());
  }
  {
    int fallbacks = 0;
    for (const auto absent : {gea::Ref<View>(), gea::Ref<View>::undefined()}) {
      try {
        gea::record::readLiveField<std::string>(absent, gea::PropertyKey::string("name"),
            [](void*, const void*, const void*, const void*) -> bool { assert(false); return false; },
            +[](const void*, const void*) -> bool { assert(false); return false; },
            [&]() -> std::string { ++fallbacks; return "wrong fallback"; });
        assert(false);
      } catch (...) {}
      try {
        gea::record::writeLiveField(absent, gea::PropertyKey::string("name"), std::string("value"),
            [](const void*, const void*, void*) -> bool { assert(false); return false; },
            [&]() -> bool { ++fallbacks; return false; });
        assert(false);
      } catch (...) {}
    }
    assert(fallbacks == 0);
  }
  using SumRead = gea::CallableObject<std::string()>;
  const gea::CallableObject<std::string(NativeReceiverSum)> sumSource{&sumRead, nullptr};
  const auto nativeSum = SumRead::unboundMethodAs<NativeReceiverSum>(sumSource, [](const gea::NativeCallReceiver& receiver) -> NativeReceiverSum {
    if (receiver.kind == gea::NativeCallReceiver::Kind::Undefined) return NativeReceiverSum::ofArm<0>(gea::Ref<Receiver>::undefined());
    if (receiver.kind == gea::NativeCallReceiver::Kind::Null) return NativeReceiverSum::ofArm<0>(gea::Ref<Receiver>());
    if (receiver.is<Receiver>()) return NativeReceiverSum::ofArm<0>(receiver.as<Receiver>());
    if (receiver.is<OtherReceiver>()) return NativeReceiverSum::ofArm<1>(receiver.as<OtherReceiver>());
    gea::host::throwRuntimeError("TypeError", "foreign native receiver");
  });
  assert(nativeSum.callWithReceiver(gea::NativeCallReceiver::object(first)) == "first");
  assert(nativeSum.callWithReceiver(gea::NativeCallReceiver::object(gea::makeRef<OtherReceiver>())) == "other-family");
  assert(nativeSum.callWithReceiver(gea::NativeCallReceiver::object(view)) == "first");
  try { nativeSum.call(); assert(false); } catch (...) {}
  try { nativeSum.callWithReceiver(gea::NativeCallReceiver::object(gea::makeRef<View>())); assert(false); } catch (...) {}
  const gea::CallableObject<std::string(std::string, std::string)> extraArguments(unbound);
  assert(extraArguments.callWithReceiver(gea::NativeCallReceiver::object(second), "wide", "ignored") == "second:wide");
  const gea::CallableObject<void(std::string)> ignoredResult(unbound);
  ignoredResult.callWithReceiver(gea::NativeCallReceiver::object(first), "void");
  using Sum = gea::TaggedUnion<std::string, double>;
  const gea::CallableObject<Sum(std::string)> widenedResult(unbound);
  assert(widenedResult.callWithReceiver(gea::NativeCallReceiver::object(second), "sum").get<0>() == "second:sum");
  using Sized = gea::CallableObject<double(std::string)>;
  const auto sized = Sized::adaptSourceWithReceiver(unbound,
      [](void* environment, std::string value) -> double { return static_cast<Read*>(environment)->call(value).size(); },
      [](void* environment, const gea::NativeCallReceiver& receiver, std::string value) -> double {
        return static_cast<Read*>(environment)->callWithReceiver(receiver, value).size();
      });
  assert(sized.callWithReceiver(gea::NativeCallReceiver::object(second), "size") == 11);
  assert(sized.functionObjectIdentity() == unbound.functionObjectIdentity());
  const gea::CallableObject<gea::Value(gea::Value, std::string)> dynamicSource{&dynamicRead, nullptr};
  const auto dynamicBox = gea::Value::boxMethod(dynamicSource);
  const auto dynamicView = gea::detail::DynamicCarrier<Read>::in(dynamicBox, 0);
  assert(dynamicView.call("bare") == "undefined:bare");
  assert(dynamicView.callWithReceiver(gea::NativeCallReceiver::object(second), "call") == "second:call");
  assert(dynamicView.callWithReceiver(gea::NativeCallReceiver::object(view), "view") == "first:view");
  assert(dynamicView.callWithReceiver(gea::NativeCallReceiver::object(secondView), "chain") == "first:chain");
  assert(dynamicView.functionObjectIdentity() == dynamicBox.functionObjectIdentity());
  const gea::CallableObject<gea::Value(gea::Value)> dynamicSelfSource{&dynamicSelf, nullptr};
  const auto dynamicSelfView = gea::detail::DynamicCarrier<gea::CallableObject<gea::Value()>>::in(gea::Value::boxMethod(dynamicSelfSource), 0);
  {
    const auto environment = gea::allocateNativeClassMethodEnvironment<Receiver>();
    const ConstructorReceiver source{+[](void*) -> gea::Ref<Receiver> { return gea::makeRef<Receiver>("constructed"); }, environment};
    const auto receiver = gea::NativeCallReceiver::primitive(source, &materializeConstructor);
    const auto typed = gea::Value::boxMethod(gea::CallableObject<gea::Value(ConstructorReceiver)>{&observeNativeConstructor, nullptr});
    assert(typed.callWithReceiver(receiver, {}).as<double>() == 7.0 && constructorMaterializations == 0);
    const auto observed = dynamicSelfView.callWithReceiver(receiver);
    assert(constructorMaterializations == 1);
    assert(observed.functionObjectIdentity() == gea::constructorEnvironmentIdentity(source.environment));
    assert(observed.construct({}).as<gea::Ref<Receiver>>()->name == "constructed");
    assert(gea::detail::DynamicCarrier<ConstructorReceiver>::in(observed, 0).construct()->name == "constructed");
  }
  assert(dynamicSelfView.call().tag() == gea::Value::Tag::Undefined);
  assert(dynamicSelfView.callWithReceiver(gea::NativeCallReceiver::primitive(7.0)).as<double>() == 7.0);
  assert(dynamicSelfView.callWithReceiver(gea::NativeCallReceiver::primitive(std::string("text"))).as<std::string>() == "text");
  // A nil public frame can reach a body that explicitly asks for unknown
  // this. Container receivers must retain their actual payload and aliases.
  const auto logicalArray = gea::arrayOf<double>({1.0, 2.0});
  const auto arrayReceiver = gea::NativeCallReceiver::object(logicalArray);
  assert(arrayReceiver.is<gea::ArrayObject<double>>());
  assert(arrayReceiver.as<gea::ArrayObject<double>>() == logicalArray);
  auto arrayThis = dynamicSelfView.callWithReceiver(arrayReceiver);
  assert(arrayThis.isArrayPayload());
  assert(arrayThis.getProperty(gea::PropertyKey::string("length")).as<double>() == 2.0);
  assert(arrayThis.getProperty(gea::PropertyKey::string("0")).as<double>() == 1.0);
  arrayThis.setProperty(gea::PropertyKey::string("0"), gea::Value::box(gea::Value::Tag::Number, 9.0));
  assert(logicalArray->at(0) == 9.0);
  assert(gea::Value::strictEquals(arrayThis, gea::Value::box(gea::Value::Tag::Object, logicalArray)));
  const auto boundArrayThis = gea::bindCallableWithReceiver<gea::Value(), 0>(dynamicSelfView, arrayReceiver);
  assert(gea::Value::strictEquals(boundArrayThis.call(), arrayThis));
  const auto logicalDictionary = gea::makeRef<gea::Dictionary<std::string>>();
  logicalDictionary->setProperty("label", "before");
  const auto dictionaryReceiver = gea::NativeCallReceiver::object(logicalDictionary);
  auto dictionaryThis = dynamicSelfView.callWithReceiver(dictionaryReceiver);
  assert(dictionaryReceiver.as<gea::Dictionary<std::string>>() == logicalDictionary);
  assert(dictionaryThis.getProperty(gea::PropertyKey::string("label")).as<std::string>() == "before");
  dictionaryThis.setProperty(gea::PropertyKey::string("label"), gea::Value::box(gea::Value::Tag::String, std::string("after")));
  assert(logicalDictionary->read("label") == "after");
  assert(gea::Value::strictEquals(dictionaryThis, gea::Value::box(gea::Value::Tag::Object, logicalDictionary)));
  const auto numericDictionary = gea::makeRef<gea::NumericDictionary<double>>();
  numericDictionary->setProperty(2.0, 4.0);
  auto numericThis = dynamicSelfView.callWithReceiver(gea::NativeCallReceiver::object(numericDictionary));
  assert(numericThis.getProperty(gea::PropertyKey::string("2")).as<double>() == 4.0);
  numericThis.setProperty(gea::PropertyKey::string("2"), gea::Value::box(gea::Value::Tag::Number, 5.0));
  assert(numericDictionary->read(2.0) == 5.0);
  assert(gea::Value::strictEquals(numericThis, gea::Value::box(gea::Value::Tag::Object, numericDictionary)));
  const auto nativeError = gea::host::createRuntimeError("Error", gea::Optional<std::string>(std::string("before")));
  const auto errorReceiver = gea::NativeCallReceiver::object(nativeError);
  auto errorThis = dynamicSelfView.callWithReceiver(errorReceiver);
  assert(errorReceiver.is<gea::runtime::Error>() && errorReceiver.as<gea::runtime::Error>() == nativeError);
  assert(errorThis.holdsNativeError());
  assert(errorThis.getProperty(gea::PropertyKey::string("message")).as<std::string>() == "before");
  errorThis.setProperty(gea::PropertyKey::string("message"), gea::Value::box(gea::Value::Tag::String, std::string("after")));
  assert(nativeError->message == "after");
  assert(gea::Value::strictEquals(errorThis, gea::Value::box(gea::Value::Tag::Object, nativeError)));
  {
    auto retained = gea::arrayOf<double>({3.0});
    const gea::WeakRef<gea::ArrayObject<double>> weakRetained(retained);
    const auto boundThis = gea::bindCallableWithReceiver<gea::Value(), 0>(dynamicSelfView, gea::NativeCallReceiver::object(retained));
    retained = {};
    assert(!weakRetained.expired());
    assert(boundThis.call().getProperty(gea::PropertyKey::string("0")).as<double>() == 3.0);
  }
  {
    using HeldFunction = gea::CallableObject<gea::Ref<Receiver>()>;
    HeldFunction::registerSource<&retainedFunctionSelf>("nativeFn", 0, "function nativeFn() { return held; }");
    gea::WeakRef<Receiver> weakRetained;
    gea::CallableObject<gea::Value()> boundFunctionThis;
    {
      auto retained = gea::makeRef<Receiver>("function environment");
      weakRetained = gea::WeakRef<Receiver>(retained);
      const HeldFunction nativeFn{&retainedFunctionSelf, gea::packEnvironment(retained)};
      const auto logicalFunction = gea::NativeCallReceiver::primitive(nativeFn,
          +[](const HeldFunction& source) -> gea::Value { return gea::detail::DynamicCarrier<HeldFunction>::out(source); });
      auto functionThis = dynamicSelfView.callWithReceiver(logicalFunction);
      const auto original = gea::detail::DynamicCarrier<HeldFunction>::out(nativeFn);
      assert(functionThis.tag() == gea::Value::Tag::Function);
      assert(gea::Value::strictEquals(functionThis, original));
      assert(functionThis.functionSourceText() == "function nativeFn() { return held; }");
      assert(functionThis.getProperty(gea::PropertyKey::string("name")).as<std::string>() == "nativeFn");
      functionThis.setProperty(gea::PropertyKey::string("label"), gea::Value::box(gea::Value::Tag::String, std::string("shared")));
      assert(original.getProperty(gea::PropertyKey::string("label")).as<std::string>() == "shared");
      boundFunctionThis = gea::bindCallableWithReceiver<gea::Value(), 0>(dynamicSelfView, logicalFunction);
    }
    gea::collectCycles();
    assert(!weakRetained.expired());
    const auto retainedFunction = boundFunctionThis.call();
    assert(retainedFunction.getProperty(gea::PropertyKey::string("label")).as<std::string>() == "shared");
    assert(gea::detail::DynamicCarrier<HeldFunction>::in(retainedFunction, 0).call()->name == "function environment");
  }
  const gea::CallableObject<gea::Value(gea::Value, gea::Ref<gea::ArrayObject<std::string>>)> dynamicRestSource{&dynamicRestRead, nullptr};
  using RestRead = gea::CallableObject<std::string(gea::Ref<gea::ArrayObject<std::string>>)>;
  const auto dynamicRestView = gea::detail::DynamicCarrier<RestRead>::inWithRest<0>(gea::Value::boxMethod<1>(dynamicRestSource), 0);
  assert(dynamicRestView.callWithReceiver(gea::NativeCallReceiver::object(second), gea::arrayOf<std::string>({"x", "y"})) == "second:2");
  const auto boxedNative = gea::Value::box(gea::Value::Tag::Function, unbound);
  const auto boxedSecond = gea::Value::box(gea::Value::Tag::Object, second);
  const std::vector<gea::Value> boxedArguments{gea::Value::box(gea::Value::Tag::String, std::string("boxed"))};
  assert(boxedNative.callWithReceiver(boxedSecond, boxedArguments).as<std::string>() == "second:boxed");
  assert(boxedNative.callWithReceiver(gea::NativeCallReceiver::object(second), boxedArguments).as<std::string>() == "second:boxed");
  {
    const LazyOwner source{&nativeOwnerRest, nullptr};
    {
    // The compiler's callableIdentityDemand identifies this actual allocation
    // before a receiver Optional copies it. The pure census contract pins that
    // decision; the runtime factory preserves the published owner afterward.
    const auto source = gea::identifyCallable<&physicalReceiverSourceTag>(LazyOwner{&nativeOwnerRest, nullptr});
    using OptionalOwner = gea::Optional<LazyOwner>;
    using Physical = gea::CallableObject<gea::Value(OptionalOwner)>;
    const auto undefinedFactory = +[](const OptionalOwner& receiver) -> gea::NativeCallReceiver {
      return receiver.has_value() ? gea::NativeCallReceiver::primitive(*receiver, &materializeOwner)
                                  : gea::NativeCallReceiver::undefined();
    };
    const auto nullFactory = +[](const OptionalOwner& receiver) -> gea::NativeCallReceiver {
      return receiver.has_value() ? gea::NativeCallReceiver::primitive(*receiver, &materializeOwner)
                                  : gea::NativeCallReceiver::null();
    };
    const auto independentSource = gea::Value::box(gea::Value::Tag::Function, gea::CallableObject<gea::Value()>{&ignoreOwner, nullptr});
    const auto independentPhysical = gea::detail::DynamicCarrier<Physical>::inWithReceiver(independentSource, 0, undefinedFactory);
    ownerMaterializations = 0;
    assert(independentPhysical.call(OptionalOwner(source)).as<double>() == 7.0);
    assert(ownerMaterializations == 0);
    const auto anySource = gea::Value::boxMethod(gea::CallableObject<gea::Value(gea::Value)>{&dynamicSelf, nullptr});
    const auto observingPhysical = gea::detail::DynamicCarrier<Physical>::inWithReceiver(anySource, 0, undefinedFactory);
    const auto observedOwner = observingPhysical.call(OptionalOwner(source));
    assert(ownerMaterializations == 1 && observedOwner.receivesThis() && observedOwner.restFrom() == 1);
    assert(observedOwner.functionObjectIdentity() == source.functionObjectIdentity());
    assert(observingPhysical.call(OptionalOwner()).tag() == gea::Value::Tag::Undefined);
    const auto nullPhysical = gea::detail::DynamicCarrier<Physical>::inWithReceiver(anySource, 0, nullFactory);
    assert(nullPhysical.call(OptionalOwner()).tag() == gea::Value::Tag::Null);
    using PhysicalRest = gea::CallableObject<gea::Value(OptionalOwner, gea::Ref<gea::ArrayObject<std::string>>)>;
    const auto restSource = gea::Value::boxMethod<1>(
        gea::CallableObject<gea::Value(gea::Value, gea::Ref<gea::ArrayObject<gea::Value>>)>{&dynamicRestSelf, nullptr});
    const auto restPhysical = gea::detail::DynamicCarrier<PhysicalRest>::inWithReceiverAndRest<1>(restSource, 0, undefinedFactory);
    const auto restObserved = restPhysical.call(OptionalOwner(source), gea::arrayOf<std::string>({"x", "y"}));
    assert(ownerMaterializations == 2 && restObserved.receivesThis() && restObserved.restFrom() == 1);
    assert(restObserved.functionObjectIdentity() == source.functionObjectIdentity());
    const Physical exactSource{+[](void*, OptionalOwner receiver) -> gea::Value {
      return receiver.has_value() ? gea::Value::box(gea::Value::Tag::Number, 7.0) : gea::Value();
    }, nullptr};
    const auto exactPhysical = gea::detail::DynamicCarrier<Physical>::inWithReceiver(gea::Value::boxMethod(exactSource), 0);
    assert(exactPhysical.functionObjectIdentity() == exactSource.functionObjectIdentity());
    assert(exactPhysical.call(OptionalOwner(source)).as<double>() == 7.0 && ownerMaterializations == 2);
    }
    const auto owner = gea::NativeCallReceiver::primitive(source, &materializeOwner);
    // Retention precedes the first original property access. The factory must
    // identify the original capture-free Function before making its copy.
    const auto* retained = static_cast<const LazyOwner*>(owner.primitivePayload);
    assert(source.functionObject && retained->functionObjectIdentity() == source.functionObjectIdentity());
    const auto ordinaryOwner = gea::NativeCallReceiver::primitive(source);
    const auto* ordinaryRetained = static_cast<const LazyOwner*>(ordinaryOwner.primitivePayload);
    assert(ordinaryRetained->functionObjectIdentity() == source.functionObjectIdentity());
    requiresCallable([&] { ordinaryOwner.dynamicValue(); });
    const auto independent = gea::Value::box(gea::Value::Tag::Function, gea::CallableObject<gea::Value()>{&ignoreOwner, nullptr});
    gea::installCallableOwnFacts(source.functionObjectIdentity(), source.name(), source.length());
    assert(source.functionObjectIdentity()->properties->defineOwnProperty(
      gea::PropertyKey::string("bind"), gea::PropertyDescriptor::assignment(independent)));
    ownerMaterializations = 0;
    const auto ownBind = gea::callableDynamicGet(source, gea::PropertyKey::string("bind"), owner);
    assert(ownBind.callWithReceiver(owner, {}).as<double>() == 7.0);
    assert(ownerMaterializations == 0);

    const auto physical = gea::Value::boxMethod(gea::CallableObject<gea::Value(LazyOwner)>{&observeTypedOwner, nullptr});
    assert(physical.callWithReceiver(owner, {}).as<double>() == source.length());
    assert(ownerMaterializations == 0);
    const auto anyThis = gea::Value::boxMethod(gea::CallableObject<gea::Value(gea::Value)>{&dynamicSelf, nullptr});
    const auto observed = anyThis.callWithReceiver(owner, {});
    assert(ownerMaterializations == 1 && observed.receivesThis() && observed.restFrom() == 1);
    assert(observed.functionObjectIdentity() == source.functionObjectIdentity());
    assert(observed.callWithReceiver(gea::NativeCallReceiver::object(second), {
      gea::Value::box(gea::Value::Tag::String, std::string("x")),
      gea::Value::box(gea::Value::Tag::String, std::string("y"))}).as<std::string>() == "second:2");
    assert(ownerMaterializations == 1);

    gea::PropertyDescriptor accessor;
    gea::installDescriptorGetter(accessor, independent);
    assert(source.functionObjectIdentity()->properties->defineOwnProperty(gea::PropertyKey::string("probe"), accessor));
    assert(gea::callableDynamicGet(source, gea::PropertyKey::string("probe"), owner).as<double>() == 7.0);
    assert(ownerMaterializations == 1);
    requiresCallable([&] {
      const auto wrongFrame = gea::Value::boxMethod(gea::CallableObject<gea::Value(Read)>{
        +[](void*, Read) { return gea::Value(); }, nullptr});
      (void)wrongFrame.callWithReceiver(owner, {});
    });
    assert(ownerMaterializations == 1);
  }
  {
    gea::WeakRef<Receiver> weakOwnerEnvironment;
    gea::CallableObject<gea::Value()> retainedOwner;
    {
      auto environment = gea::makeRef<Receiver>("lazy Function owner");
      weakOwnerEnvironment = gea::WeakRef<Receiver>(environment);
      const LazyOwner source{&nativeOwnerRest, gea::packEnvironment(environment)};
      retainedOwner = gea::bindCallableWithReceiver<gea::Value(), 0>(
        dynamicSelfView, gea::NativeCallReceiver::primitive(source, &materializeOwner));
    }
    gea::collectCycles();
    assert(!weakOwnerEnvironment.expired());
    auto observed = retainedOwner.call();
    assert(observed.receivesThis() && observed.restFrom() == 1);
    assert(observed.callWithReceiver(gea::NativeCallReceiver::object(second), {
      gea::Value::box(gea::Value::Tag::String, std::string("bound"))}).as<std::string>() == "second:1");
    retainedOwner = {};
    observed = {};
    gea::collectCycles();
    assert(weakOwnerEnvironment.expired());
  }
  const auto exactDynamicView = gea::detail::DynamicCarrier<Read>::in(boxedNative, 0);
  assert(exactDynamicView.callWithReceiver(gea::NativeCallReceiver::object(second), "exact") == "second:exact");

  using Self = gea::CallableObject<gea::Ref<Receiver>()>;
  const gea::CallableObject<gea::Ref<Receiver>(gea::Ref<Receiver>)> selfSource{&self, nullptr};
  const Self unboundSelf = Self::unboundMethod(selfSource);
  const auto undefined = unboundSelf.call();
  const auto null = unboundSelf.callWithReceiver(gea::NativeCallReceiver::null());
  assert(undefined.isUndefined() && !undefined && undefined != nullptr);
  assert(!null.isUndefined() && !null && null == nullptr);
  assert(undefined != null && undefined == gea::Ref<Receiver>::undefined());
  assert(unboundSelf.callWithReceiver(gea::NativeCallReceiver::object(first)) == first);
  const auto boxedSelf = gea::Value::box(gea::Value::Tag::Function, unboundSelf);
  assert(boxedSelf.callAsFunction({}).tag() == gea::Value::Tag::Undefined);
  assert(boxedSelf.callWithReceiver(boxedSecond, {}).classObject() == gea::Ref<void>(second));
  const gea::CallableObject<gea::Ref<Receiver>(std::string)> droppedArguments(unboundSelf);
  assert(droppedArguments.callWithReceiver(gea::NativeCallReceiver::object(second), "ignored") == second);
  auto erased = gea::Ref<void>(undefined);
  assert(erased.isUndefined());
  auto recovered = erased.staticCast<Receiver>();
  assert(recovered.isUndefined());
  auto moved = std::move(erased).staticCast<Receiver>();
  assert(moved.isUndefined() && erased == nullptr);
  gea::Optional<gea::Ref<Receiver>> absent;
  gea::Optional<gea::Ref<Receiver>> presentUndefined(undefined);
  auto copiedUndefined = presentUndefined;
  auto movedUndefined = std::move(copiedUndefined);
  gea::Optional<gea::Ref<Receiver>> presentNull(null);
  assert(!absent.has_value());
  assert(presentUndefined.has_value() && presentUndefined->isUndefined());
  assert(movedUndefined.has_value() && movedUndefined->isUndefined());
  assert(presentNull.has_value() && *presentNull == nullptr);
  auto boxedUndefined = gea::Value::box(gea::Value::Tag::Object, undefined);
  auto boxedNull = gea::Value::box(gea::Value::Tag::Object, null);
  assert(boxedUndefined.tag() == gea::Value::Tag::Undefined);
  assert(boxedNull.tag() == gea::Value::Tag::Null);
  std::cout << "Native method contracts passed\\n";
}
`

execFileSync(
  process.env.CXX ?? 'clang++',
  [
    '-std=c++20',
    ...nativeOptimization('correctness'),
    '-g',
    '-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    '-x',
    'c++',
    '-',
    '-o',
    executable
  ],
  { input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
)
const output = execFileSync(executable, [], { encoding: 'utf8', env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
assert.equal(output, 'Native method contracts passed\n')
assert.throws(
  () =>
    execFileSync(executable, ['missing-receiver-factory'], {
      encoding: 'utf8',
      env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' },
      stdio: ['pipe', 'pipe', 'pipe']
    }),
  (error) => error.signal === 'SIGABRT' && /mismatched physical callable frame requires its published receiver factory/.test(error.stderr)
)
process.stdout.write(output)
