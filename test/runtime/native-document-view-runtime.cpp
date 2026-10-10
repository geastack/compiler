#include "gea_runtime.h"
#include <cassert>
#include <iostream>

using gea::PropertyKey;
using gea::Value;
using Document = gea::Dictionary<Value>;

struct Owner {
  std::string title = "initial";
  bool present = true;
  gea::NativeIndexAttributes attributes;
  mutable int gets = 0;
  int sets = 0;
  bool gea_readOwnField(const PropertyKey& key, Value& out) const {
    if (key.isSymbol() || key.text() != "title" || !present) return false;
    out = Value::box(Value::Tag::String, title);
    return true;
  }
  bool gea_writeOwnField(const PropertyKey& key, const Value& value, bool) {
    if (key.isSymbol() || key.text() != "title") return false;
    if (!attributes.writable) return false;
    if (!gea::detail::DynamicCarrier<std::string>::accepts(value)) gea::host::throwRuntimeError("TypeError", "title is not a string");
    title = value.as<std::string>();
    present = true;
    return true;
  }
  bool gea_ownFieldDescriptor(const PropertyKey& key, gea::PropertyDescriptor& out) const {
    Value value;
    if (!gea_readOwnField(key, value)) return false;
    out = gea::PropertyDescriptor::assignment(value);
    out.writable = attributes.writable;
    out.enumerable = attributes.enumerable;
    out.configurable = attributes.configurable;
    return true;
  }
  void gea_ownFieldKeys(std::vector<PropertyKey>& keys) const { if (present) keys.push_back(PropertyKey::string("title")); }
  bool gea_matchesOwnField(const PropertyKey& key) const { return !key.isSymbol() && key.text() == "title"; }
  bool gea_defineOwnField(const PropertyKey& key, const gea::PropertyDescriptor& descriptor, bool extensible) {
    return gea_matchesOwnField(key) && gea::applyNativeFieldDescriptor(title, attributes, present, descriptor, extensible, Value::Tag::String);
  }
  bool gea_deleteOwnField(const PropertyKey& key) {
    if (!gea_matchesOwnField(key)) return true;
    if (!attributes.configurable) return false;
    present = false;
    return true;
  }
  bool gea_ownFieldPresent(const PropertyKey& key, bool& present) const {
    if (key.isSymbol() || key.text() != "title") return false;
    present = this->present;
    return true;
  }
  bool gea_ownFieldEnumerable(const PropertyKey& key, bool& enumerable) const {
    if (!gea_matchesOwnField(key)) return false;
    enumerable = attributes.enumerable;
    return true;
  }
  bool gea_hasPrototypeProperty(const PropertyKey& key) const { return !key.isSymbol() && key.text() == "computed"; }
  bool gea_readPrototypeProperty(const PropertyKey& key, Value& out) const {
    if (!gea_hasPrototypeProperty(key)) return false;
    ++gets;
    out = Value::box(Value::Tag::String, title);
    return true;
  }
  gea::detail::NativePrototypeOps::SetResult gea_setPrototypePropertyNative(
      const PropertyKey& key, const Value& value, const gea::NativeCallReceiver& receiver) {
    if (!gea_hasPrototypeProperty(key)) return gea::detail::NativePrototypeOps::SetResult::Absent;
    assert(receiver.is<Owner>() && receiver.as<Owner>().get() == this);
    if (!gea::detail::DynamicCarrier<std::string>::accepts(value)) gea::host::throwRuntimeError("TypeError", "computed is not a string");
    ++sets;
    title = value.as<std::string>();
    return gea::detail::NativePrototypeOps::SetResult::Accepted;
  }
};
struct View;
namespace gea::detail {
template <> struct NativeViewTarget<::View> : std::true_type {};
}
struct View {};
struct Other {};
struct NativeSlotOwner : Owner {
  bool gea_readOwnFieldNative(const PropertyKey& key, gea::NativeFieldRead& read) const {
    return gea_matchesOwnField(key) && present && read.assign(title);
  }
};
struct IndexedOwner : Owner {
  Document entries;
  bool gea_matchesOwnIndex(const PropertyKey& key) const { return !key.isSymbol() && !gea_matchesOwnField(key); }
  bool gea_readOwnIndex(const PropertyKey& key, Value& out) const {
    if (!gea_matchesOwnIndex(key) || !entries.hasOwn(key.text())) return false;
    out = entries.read(key.text());
    return true;
  }
  bool gea_writeOwnIndex(const PropertyKey& key, const Value& value, bool) { return gea_matchesOwnIndex(key) && entries.setProperty(key.text(), value); }
  bool gea_ownIndexDescriptor(const PropertyKey& key, gea::PropertyDescriptor& out) const {
    Value value;
    if (!gea_readOwnIndex(key, value)) return false;
    out = gea::PropertyDescriptor::assignment(value);
    return true;
  }
  bool gea_defineOwnIndex(const PropertyKey& key, const gea::PropertyDescriptor& descriptor, bool) {
    return gea_matchesOwnIndex(key) && !descriptor.isAccessor() && (!descriptor.hasValue || entries.setProperty(key.text(), descriptor.dataValue()));
  }
  bool gea_deleteOwnIndex(const PropertyKey& key) { return !gea_matchesOwnIndex(key) || entries.deleteProperty(key.text()); }
  void gea_freezeOwnIndex() {
    for (const auto& key : entries.propertyKeys()) {
      const auto attributes = entries.attributesOf(key);
      assert(entries.defineProperty(key, entries.read(key), {false, attributes.enumerable, false}));
    }
  }
};
static int viewSerializerCalls = 0;
void gea_json_write(std::string& out, const View&) {
  ++viewSerializerCalls;
  out += "\"inert view\"";
}
static Document* observedDocument = nullptr;
static int descriptorReads = 0;
struct Cycle {
  gea::Ref<Document> document;
  friend void geaTraceRefs(const Cycle& value, gea::detail::RefVisitor& visitor) { gea::detail::traceRefs(value.document, visitor); }
};
struct Nested {
  double size = 3;
  gea::Ref<Document> owner;
  friend void geaTraceRefs(const Nested& value, gea::detail::RefVisitor& visitor) { gea::detail::traceRefs(value.owner, visitor); }
};
static int nestedObservations = 0;
static Value observeNested(const gea::Ref<Nested>& value) {
  ++nestedObservations;
  return Value::box(Value::Tag::Object, value);
}

template <typename Run> void mustThrow(Run run) {
  bool threw = false;
  try { run(); } catch (...) { threw = true; }
  assert(threw);
}

gea::Ref<View> asView(const gea::Ref<Document>& source) {
  return gea::record::makeDocumentViewWithOrigin<View>(source,
    +[](const gea::Ref<void>& original, const PropertyKey& key, const gea::NativeFieldRead& read) {
      return gea::dictionary::readDocumentField(original.staticCast<Document>(), key, read);
    },
    +[](const gea::Ref<void>& original, const PropertyKey& key, const gea::NativeFieldWrite& write) {
      return gea::dictionary::writeDocumentField(original.staticCast<Document>(), key, write);
    },
    +[](const gea::Ref<void>& original, const PropertyKey& key, const gea::PropertyDescriptor& descriptor) {
      return gea::dictionary::defineDocumentField(original.staticCast<Document>(), key, descriptor);
    },
    +[](const gea::Ref<void>& original, const PropertyKey& key) {
      return gea::dictionary::hasOwnDocumentField(original.staticCast<Document>(), key);
    },
    +[](const gea::Ref<void>& original, const PropertyKey& key) {
      return gea::dictionary::hasDocumentField(original.staticCast<Document>(), key);
    });
}

std::string readText(const gea::Ref<View>& view, const PropertyKey& key) {
  std::optional<std::string> result;
  gea::NativeFieldRead read(result,
    +[](void* slot, const void* type, const void*, const void* entry) {
      if (type != gea::detail::payloadTypeTagFor<Value>()) return false;
      const auto& value = *static_cast<const Value*>(entry);
      if (!gea::detail::DynamicCarrier<std::string>::accepts(value)) gea::host::throwRuntimeError("TypeError", "view entry is not a string");
      static_cast<std::optional<std::string>*>(slot)->emplace(value.as<std::string>());
      return true;
    },
    +[](const void* type, const void* policy) {
      return type == gea::detail::payloadTypeTagFor<Value>() && policy == gea::detail::payloadTypeTagFor<gea::NativeFieldLeafPolicy>();
    });
  assert(gea::record::readDocumentEntryView(gea::Ref<void>(view), key, read));
  return *result;
}

int main() {
  const auto title = PropertyKey::string("title");
  const auto computed = PropertyKey::string("computed");
  const auto source = gea::makeRef<Owner>();
  const auto document = gea::dictionary::aliasOf(source);
  assert(document->nativeOwner() && document->nativeOwner()->held.get() == source.get());
  assert(document == source);
  assert(gea::dictionary::aliasOf(source) == document);
  assert(gea::dictionary::viewedObject<Owner>(document, "owner recovery") == source);
  mustThrow([&] { gea::dictionary::viewedObject<Other>(document, "wrong owner"); });
  assert(asView(gea::Ref<Document>::undefined()).isUndefined());
  assert(!asView(gea::Ref<Document>{}));
  const auto view = asView(document);
  assert(view == source && source->gets == 0);
  assert(gea::record::viewOriginClassRef<Owner>(view) == source);
  assert(document->has("computed") && !document->hasOwn("computed") && source->gets == 0);
  assert(readText(view, computed) == "initial" && source->gets == 1);
  source->title = "original";
  assert(readText(view, title) == "original");
  const auto written = Value::box(Value::Tag::String, std::string("through view"));
  assert(gea::record::writeFieldView(gea::Ref<void>(view), computed, gea::NativeFieldWrite(written)));
  assert(source->sets == 1 && source->title == "through view");
  const auto chainedDocument = gea::dictionary::aliasOf(view);
  assert(chainedDocument == document);
  assert(gea::dictionary::viewedObject<Owner>(chainedDocument, "chained owner") == source);
  const auto plain = gea::makeRef<Document>();
  plain->setProperty("title", written);
  const auto plainView = asView(plain);
  assert(plainView == plain);
  plain->setProperty("title", Value::box(Value::Tag::Number, 3.0));
  mustThrow([&] { readText(plainView, title); });
  assert(gea::record::writeFieldView(gea::Ref<void>(plainView), title, gea::NativeFieldWrite(written)));
  assert(plain->read("title").as<std::string>() == "through view");
  auto frozen = gea::PropertyDescriptor::assignment(written);
  frozen.writable = frozen.configurable = false;
  assert(gea::dictionary::defineDocumentField(plain, title, frozen));
  assert(!plain->setProperty("title", Value::box(Value::Tag::String, std::string("no"))));
  assert(!plain->deleteProperty("title"));
  observedDocument = plain.get();
  const auto lazy = PropertyKey::string("lazy");
  using Getter = gea::CallableObject<std::string(gea::Ref<Document>)>;
  const Getter getter{+[](void*, gea::Ref<Document> receiver) {
    assert(receiver.get() == observedDocument);
    ++descriptorReads;
    return receiver->read("title").as<std::string>();
  }, nullptr};
  gea::PropertyDescriptor accessor;
  accessor.hasGet = accessor.hasEnumerable = accessor.hasConfigurable = true;
  accessor.enumerable = accessor.configurable = true;
  accessor.nativeGet = gea::NativeDescriptorAccessor::make(getter, nullptr, nullptr, nullptr,
    +[](const gea::NativeDescriptorData& function, const gea::NativeCallReceiver& receiver) {
      assert(receiver.is<Document>() && receiver.as<Document>().get() == observedDocument);
      return Value::box(Value::Tag::String, function.get<Getter>()->call(receiver.as<Document>()));
    });
  plain->setProperty("before", written);
  assert(gea::dictionary::defineDocumentField(plain, lazy, accessor));
  plain->setProperty("after", written);
  assert(descriptorReads == 0 && plain->hasOwn("lazy"));
  assert(gea::dictionary::hasDocumentField(plain, lazy) && descriptorReads == 0);
  assert(readText(plainView, lazy) == "through view" && descriptorReads == 1);
  assert(!gea::record::writeFieldView(gea::Ref<void>(plainView), lazy, gea::NativeFieldWrite(written)));
  assert(descriptorReads == 1);
  assert((plain->enumerableKeys() == std::vector<std::string>{"title", "before", "lazy", "after"}));
  assert((gea::nativeDynamicKeys(plainView) == std::vector<std::string>{"title", "before", "lazy", "after"}));
  const auto viewDescriptor = gea::nativeOwnPropertyDescriptor(plainView, lazy);
  assert(viewDescriptor.has_value() && viewDescriptor->isAccessor() && descriptorReads == 1);
  assert(gea::nativeDynamicDelete(plainView, lazy) && !plain->hasOwn("lazy"));
  assert(!gea::nativeDynamicDelete(plainView, title));
  assert(gea::nativeDynamicSet(plainView, lazy, written));
  assert((gea::nativeDynamicKeys(plainView) == std::vector<std::string>{"title", "before", "after", "lazy"}));
  const auto chain = gea::record::makeLiveViewWithOrigin<View>(plainView,
    +[](const gea::Ref<void>&, const PropertyKey&, const gea::NativeFieldRead&) { return false; },
    +[](const gea::Ref<void>&, const PropertyKey&, const gea::NativeFieldWrite&) { return false; });
  assert(chain == plain && readText(chain, lazy) == "through view");
  assert(gea::nativeDynamicSet(chain, PropertyKey::string("grown"), Value::box(Value::Tag::Number, 0.5)));
  assert(plain->read("grown").as<double>() == 0.5);
  assert((gea::nativeDynamicKeys(chain) == std::vector<std::string>{"title", "before", "after", "lazy", "grown"}));
  std::string plainJson, chainJson;
  gea_json_write(plainJson, plain);
  gea_json_write(chainJson, chain);
  assert(plainJson == chainJson);
  assert(viewSerializerCalls == 0);
  using JsonMethod = gea::CallableObject<Value(Value, Value)>;
  const JsonMethod toJson{+[](void*, Value receiver, Value key) {
    assert(receiver.classObject().get() == observedDocument);
    assert(key.tag() == Value::Tag::String && key.as<std::string>().empty());
    return Value::box(Value::Tag::String, std::string("original toJSON"));
  }, nullptr};
  assert(plain->setProperty("toJSON", Value::boxMethod(toJson)));
  plainJson.clear(); chainJson.clear();
  gea_json_write(plainJson, plain); gea_json_write(chainJson, chain);
  assert(plainJson == "\"original toJSON\"" && plainJson == chainJson);
  assert(viewSerializerCalls == 0);
  assert(plain->deleteProperty("toJSON"));
  assert(gea::nativeDynamicDelete(chain, PropertyKey::string("grown")) && !plain->hasOwn("grown"));
  assert(plain->deleteProperty("lazy") && !plain->hasOwn("lazy"));
  plain->setProperty("lazy", written);
  assert((plain->enumerableKeys() == std::vector<std::string>{"title", "before", "after", "lazy"}));
  const auto array = gea::makeRef<gea::ArrayObject<double>>();
  array->push(0.5);
  array->pushHole();
  const auto arrayDocument = gea::dictionary::aliasOf(array);
  assert(gea::dictionary::viewsArray(arrayDocument) && arrayDocument == array);
  assert(gea::dictionary::viewedObject<gea::ArrayObject<double>>(arrayDocument, "array recovery") == array);
  assert(!arrayDocument->has("1"));
  assert(arrayDocument->setProperty("0", Value::box(Value::Tag::Number, 0.75)) && array->at(0) == 0.75);
  mustThrow([&] { gea::dictionary::viewedObject<gea::ArrayObject<std::string>>(arrayDocument, "wrong element carrier"); });
  const auto map = gea::makeRef<gea::Map<std::string, double>>();
  map->set("one", 1.0);
  const auto mapDocument = gea::dictionary::aliasOf(map);
  assert(gea::dictionary::viewsMap(mapDocument) && mapDocument == map);
  const auto broadMap = gea::dictionary::viewedDynamicMap(mapDocument, "map view");
  assert(broadMap == map);
  broadMap->set(Value::box(Value::Tag::String, std::string("two")), Value::box(Value::Tag::Number, 2.0));
  assert(*map->get("two") == 2.0);
  mustThrow([&] { broadMap->set(Value::box(Value::Tag::String, std::string("bad")), written); });
  const auto mapOwner = gea::dictionary::nativeOwnerOf(broadMap);
  assert((mapOwner.is<gea::Map<std::string, double>>()));
  assert((mapOwner.as<gea::Map<std::string, double>>("chained map owner") == map));
  const auto chainedMapDocument = gea::dictionary::aliasOf(broadMap);
  assert((gea::dictionary::viewedObject<gea::Map<std::string, double>>(chainedMapDocument, "chained map recovery") == map));
  const auto separatelyHeldMap = gea::makeRef<gea::Map<std::string, double>>();
  gea::Ref<gea::Map<Value, Value>> retainedBroadMap;
  gea::WeakRef<Document> retiredMapDocument;
  {
    const auto scopedDocument = gea::dictionary::aliasOf(separatelyHeldMap);
    retainedBroadMap = gea::dictionary::viewedDynamicMap(scopedDocument, "map retained without Document");
    retiredMapDocument = gea::WeakRef<Document>(scopedDocument);
  }
  assert(!retiredMapDocument.lock());
  const auto recreatedMapDocument = gea::dictionary::aliasOf(retainedBroadMap);
  assert((gea::dictionary::viewedObject<gea::Map<std::string, double>>(recreatedMapDocument, "recreated map recovery") == separatelyHeldMap));
  const auto dynamic = gea::makeRef<gea::DynamicObject>();
  dynamic->set(title, written, Value());
  const auto dynamicDocument = gea::detail::unboxDynamicDictionary<Value>(Value::fromDynamicObject(dynamic), "dynamic owner");
  assert(dynamicDocument->nativeOwner() && dynamicDocument->nativeOwner()->held.get() == dynamic.get());
  assert(dynamicDocument->setProperty("title", Value::box(Value::Tag::String, std::string("dynamic"))));
  assert(dynamic->get(title, Value()).as<std::string>() == "dynamic");
  {
    const auto optionalOwner = gea::makeRef<NativeSlotOwner>();
    const auto optionalDocument = gea::dictionary::aliasOf(optionalOwner);
    std::optional<gea::Optional<std::string>> answer;
    gea::NativeFieldRead optionalRead(answer,
      +[](void* slot, const void* type, const void*, const void* value) {
        auto& output = *static_cast<std::optional<gea::Optional<std::string>>*>(slot);
        if (type == gea::detail::payloadTypeTagFor<std::string>()) {
          output.emplace(*static_cast<const std::string*>(value));
          return true;
        }
        if (type == gea::detail::payloadTypeTagFor<Value>()) {
          const auto& entry = *static_cast<const Value*>(value);
          if (entry.tag() == Value::Tag::Undefined) output.emplace();
          else if (entry.tag() == Value::Tag::String) output.emplace(entry.as<std::string>());
          else gea::host::throwRuntimeError("TypeError", "an optional title has the wrong native entry");
          return true;
        }
        return false;
      },
      +[](const void* type, const void* policy) {
        return policy == gea::detail::payloadTypeTagFor<gea::NativeFieldLeafPolicy>() &&
            (type == gea::detail::payloadTypeTagFor<std::string>() || type == gea::detail::payloadTypeTagFor<Value>());
      });
    assert(gea::dictionary::readDocumentField(optionalDocument, title, optionalRead) && **answer == "initial");
    answer.reset();
    optionalOwner->present = false;
    assert(gea::dictionary::readDocumentField(optionalDocument, title, optionalRead) && answer && !answer->has_value());
    assert(optionalOwner->gets == 0);
  }
  {
    const auto original = gea::makeRef<Document>();
    original->setProperty("first", written);
    assert(original->defineProperty("meta", written, {true, false, true}));
    original->setProperty("last", written);
    const auto meta = PropertyKey::string("meta");
    const auto nested = gea::makeRef<Nested>();
    assert((gea::dictionary::writeDocumentNativeEntry<gea::Ref<Nested>, gea::NativeFieldLeafPolicy>(
        original, meta, gea::NativeFieldWrite(nested), observeNested)));
    assert(nestedObservations == 0 && !original->hasStoredKey("meta"));
    assert((original->propertyKeys() == std::vector<std::string>{"first", "meta", "last"}));
    const auto indexedView = asView(original);
    std::optional<Value> wildcard;
    gea::NativeFieldRead wildcardRead(wildcard);
    assert(gea::dictionary::readDocumentArrayEntry(indexedView, meta, wildcardRead));
    assert(wildcard->as<gea::Ref<Nested>>() == nested && nestedObservations == 1);
    nestedObservations = 0;
    assert((original->enumerableKeys() == std::vector<std::string>{"first", "last"}));
    std::optional<gea::Ref<Nested>> answer;
    gea::NativeFieldRead nativeRead(answer);
    assert(gea::dictionary::readDocumentField(original, meta, nativeRead) && *answer == nested);
    // A reader with a dynamic Value arm converts a native entry of another
    // layout through that arm (readDocumentField); one without it has no
    // conversion and must refuse before observing the entry.
    std::optional<gea::Ref<Other>> incompatible;
    gea::NativeFieldRead incompatibleRead(incompatible,
      +[](void*, const void*, const void*, const void*) { return false; },
      +[](const void* type, const void* policy) {
        return policy == gea::detail::payloadTypeTagFor<gea::NativeFieldLeafPolicy>() &&
            type == gea::detail::payloadTypeTagFor<gea::Ref<Other>>();
      });
    mustThrow([&] { gea::dictionary::readDocumentField(original, meta, incompatibleRead); });
    assert(nestedObservations == 0);
    gea::PropertyDescriptor descriptor;
    assert(gea::detail::nativeDocumentDescriptor(original, meta, descriptor));
    assert(descriptor.nativeValue && !descriptor.enumerable && descriptor.writable && descriptor.configurable);
    assert(nestedObservations == 0);
    auto dynamicOwner = Value::box(Value::Tag::Object, original);
    gea::PropertyDescriptor dynamicDescriptor;
    assert(dynamicOwner.ownDescriptor(meta, dynamicDescriptor));
    assert(dynamicDescriptor.nativeValue && !dynamicDescriptor.enumerable &&
        dynamicDescriptor.writable && dynamicDescriptor.configurable && nestedObservations == 0);
    auto replacement = Value::object();
    replacement.setProperty(PropertyKey::string("size"), Value::box(Value::Tag::Number, 4.0));
    assert(dynamicOwner.reflectSet(meta, replacement, dynamicOwner));
    assert(nestedObservations == 0);
    assert(original->read("meta").getProperty(PropertyKey::string("size")).as<double>() == 4.0);
    assert(gea::detail::nativeDocumentDescriptor(original, meta, descriptor));
    assert(!descriptor.nativeValue && !descriptor.enumerable && descriptor.writable && descriptor.configurable);
    assert((original->propertyKeys() == std::vector<std::string>{"first", "meta", "last"}));
    assert((gea::dictionary::writeDocumentNativeEntry<gea::Ref<Nested>, gea::NativeFieldLeafPolicy>(
        original, meta, gea::NativeFieldWrite(nested), observeNested)));
    assert(nestedObservations == 0);
    assert((original->propertyKeys() == std::vector<std::string>{"first", "meta", "last"}));
    gea::PropertyDescriptor readonly;
    readonly.hasWritable = true;
    readonly.writable = false;
    assert(gea::dictionary::defineDocumentField(original, meta, readonly));
    assert((!gea::dictionary::writeDocumentNativeEntry<gea::Ref<Nested>, gea::NativeFieldLeafPolicy>(
        original, meta, gea::NativeFieldWrite(gea::makeRef<Nested>()), observeNested)));
    assert(nestedObservations == 0);
    assert(original->read("meta").as<gea::Ref<Nested>>() == nested && nestedObservations == 1);
    assert(original->deleteProperty("meta"));
    assert(!original->hasOwn("meta") && !original->hasStoredKey("meta"));
    assert((gea::dictionary::writeDocumentNativeEntry<gea::Ref<Nested>, gea::NativeFieldLeafPolicy>(
        original, meta, gea::NativeFieldWrite(nested), observeNested)));
    assert((original->propertyKeys() == std::vector<std::string>{"first", "last", "meta"}));
    using Absent = gea::Optional<gea::Ref<Nested>>;
    const auto absent = PropertyKey::string("absent");
    const Absent empty;
    assert((gea::dictionary::writeDocumentNativeEntry<Absent, gea::NativeFieldOptionalPolicy<false, gea::NativeFieldLeafPolicy>>(
        original, absent, gea::NativeFieldWrite(empty, gea::NativeFieldOptionalPolicy<false, gea::NativeFieldLeafPolicy>{}),
        +[](const Absent& value) { return value.has_value() ? observeNested(*value) : Value{}; })));
    std::optional<Absent> optionalAnswer;
    gea::NativeFieldRead optionalRead(optionalAnswer, gea::NativeFieldOptionalPolicy<false, gea::NativeFieldLeafPolicy>{});
    assert(gea::dictionary::readDocumentField(original, absent, optionalRead) && optionalAnswer && !optionalAnswer->has_value());
  }
  {
    const auto indexed = gea::makeRef<IndexedOwner>();
    indexed->entries.setProperty("kind", Value::box(Value::Tag::String, std::string("native")));
    std::optional<Value> answer;
    gea::NativeFieldRead read(answer);
    assert(gea::dictionary::readDocumentArrayEntry(indexed, PropertyKey::string("kind"), read));
    assert(answer->as<std::string>() == "native");
    answer.reset();
    assert(gea::dictionary::readDocumentArrayEntry(indexed, PropertyKey::string("absent"), read));
    assert(answer->tag() == Value::Tag::Undefined);
    answer.reset();
    assert(gea::dictionary::readDocumentArrayEntry(indexed, PropertyKey::string("title"), read));
    assert(answer->as<std::string>() == "initial");
    answer.reset();
    assert(gea::dictionary::readDocumentArrayEntry(indexed, PropertyKey::string("computed"), read));
    assert(answer->as<std::string>() == "initial" && indexed->gets == 1);
    const auto uninstalled = gea::record::makeLiveViewWithOrigin<View>(indexed,
      +[](const gea::Ref<void>&, const PropertyKey&, const gea::NativeFieldRead&) { return false; },
      nullptr, nullptr, nullptr, nullptr);
    mustThrow([&] { gea::dictionary::readDocumentArrayEntry(uninstalled, PropertyKey::string("kind"), read); });
  }
  {
    const auto prototype = gea::makeRef<gea::DynamicObject>();
    const auto child = gea::makeRef<gea::DynamicObject>();
    assert(child->setPrototype(prototype));
    const auto nativeDocument = gea::dictionary::aliasOf(child);
    const auto meta = PropertyKey::string("meta");
    using Setter = gea::CallableObject<void(gea::Ref<gea::DynamicObject>, gea::Ref<Nested>)>;
    const Setter setter{+[](void*, gea::Ref<gea::DynamicObject> receiver, gea::Ref<Nested> value) {
      assert((receiver->setNativeDataWithNativeReceiver<gea::Ref<Nested>>(
          PropertyKey::string("seen"), value, observeNested, gea::NativeCallReceiver::object(receiver))));
    }, nullptr};
    gea::PropertyDescriptor descriptor;
    descriptor.hasSet = descriptor.hasEnumerable = descriptor.hasConfigurable = true;
    descriptor.enumerable = descriptor.configurable = true;
    descriptor.nativeSet = gea::NativeDescriptorAccessor::make(setter, nullptr,
      +[](const gea::NativeDescriptorData& function, const gea::NativeCallReceiver& receiver, const gea::NativeFieldWrite& written) {
        std::optional<gea::Ref<Nested>> value;
        if (!written.read(value)) return false;
        function.get<Setter>()->call(receiver.as<gea::DynamicObject>(), *value);
        return true;
      });
    assert(prototype->defineOwnProperty(meta, descriptor));
    const auto nested = gea::makeRef<Nested>();
    const int before = nestedObservations;
    assert((gea::dictionary::writeDocumentNativeEntry<gea::Ref<Nested>, gea::NativeFieldLeafPolicy>(
        nativeDocument, meta, gea::NativeFieldWrite(nested), observeNested)));
    assert(!child->ownProperty(meta) && !prototype->ownProperty(PropertyKey::string("seen")));
    assert(child->readNativeData<gea::Ref<Nested>>(PropertyKey::string("seen")) == nested);
    assert(nestedObservations == before);
  }
  gea::WeakRef<Nested> weakNested;
  gea::WeakRef<Document> weakNativeEntryDocument;
  {
    const auto document = gea::makeRef<Document>();
    const auto nested = gea::makeRef<Nested>();
    nested->owner = document;
    assert((gea::dictionary::writeDocumentNativeEntry<gea::Ref<Nested>, gea::NativeFieldLeafPolicy>(
        document, PropertyKey::string("meta"), gea::NativeFieldWrite(nested), observeNested)));
    weakNested = gea::WeakRef<Nested>(nested);
    weakNativeEntryDocument = gea::WeakRef<Document>(document);
  }
  gea::collectCycles();
  assert(!weakNested.lock() && !weakNativeEntryDocument.lock());
  gea::WeakRef<Cycle> weakOwner;
  gea::WeakRef<Document> weakDocument;
  {
    const auto owner = gea::makeRef<Cycle>();
    owner->document = gea::dictionary::aliasOf(owner);
    weakOwner = gea::WeakRef<Cycle>(owner);
    weakDocument = gea::WeakRef<Document>(owner->document);
  }
  gea::collectCycles();
  assert(!weakOwner.lock() && !weakDocument.lock());
  std::cout << "Native Document owner contracts passed\n";
}
