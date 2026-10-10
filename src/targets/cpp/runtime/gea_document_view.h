// SPDX-License-Identifier: Apache-2.0
#ifndef GEA_DOCUMENT_VIEW_H
#define GEA_DOCUMENT_VIEW_H

namespace gea::detail {

inline Ref<Dictionary<Value>> documentRef(const Dictionary<Value>* table) {
  return Ref<Dictionary<Value>>::adopt(const_cast<Dictionary<Value>*>(table), true);
}
inline Ref<DynamicObject> documentOverlay(const Dictionary<Value>* table, bool create = false) {
  if (!create && !table->hasNativePropertyOverlay()) return {};
  return expandoFor(refCastToVoid(documentRef(table)), create);
}
/** Runs mid-collection, when the table's weak word holds a graph index, so the
 * registry is probed directly rather than through its `expandoEntry` bit. */
inline void traceDocumentOverlay(const Dictionary<Value>* table, RefVisitor& visitor) {
  GEA_PARALLEL_SIDE_TABLE
  const auto& entries = nativeExpandos();
  const auto found = entries.find(table);
  if (found != entries.end() && !found->second.owner.expired()) traceRefs(found->second.table, visitor);
}
inline bool readDocumentOverlay(const Dictionary<Value>* table, std::string_view key, Value& out) {
  const auto overlay = documentOverlay(table);
  const auto property = PropertyKey::string(std::string(key));
  if (!overlay || (overlay->ownProperty(property) == nullptr && table->hasStoredKey(key)) || !overlay->hasProperty(property)) return false;
  out = overlay->getWithNativeReceiver(property, NativeCallReceiver::object(documentRef(table)));
  return true;
}
inline bool hasDocumentOverlay(const Dictionary<Value>* table, std::string_view key, bool own) {
  const auto overlay = documentOverlay(table);
  const auto property = PropertyKey::string(std::string(key));
  return overlay && (own ? overlay->ownProperty(property) != nullptr : overlay->hasProperty(property));
}
inline bool hasDocumentOverlayKeys(const Dictionary<Value>* table) {
  const auto overlay = documentOverlay(table);
  return overlay && !overlay->ownKeys().empty();
}
inline bool documentOverlayAttributes(const Dictionary<Value>* table, const std::string& key,
                                      bool& writable, bool& enumerable, bool& configurable) {
  const auto overlay = documentOverlay(table);
  const auto* descriptor = overlay ? overlay->ownProperty(PropertyKey::string(key)) : nullptr;
  if (descriptor == nullptr) return false;
  writable = !descriptor->isAccessor() && descriptor->writable;
  enumerable = descriptor->enumerable;
  configurable = descriptor->configurable;
  return true;
}
inline std::optional<bool> setDocumentOverlay(Dictionary<Value>* table, const std::string& key, const Value& value) {
  const auto overlay = documentOverlay(table);
  const auto property = PropertyKey::string(key);
  if (!overlay || (overlay->ownProperty(property) == nullptr && table->hasStoredKey(key)) || !overlay->hasProperty(property)) return std::nullopt;
  return overlay->setWithNativeReceiver(property, value, NativeCallReceiver::object(documentRef(table)));
}
inline std::optional<bool> deleteDocumentOverlay(Dictionary<Value>* table, const std::string& key) {
  const auto overlay = documentOverlay(table);
  const auto property = PropertyKey::string(key);
  if (!overlay || overlay->ownProperty(property) == nullptr) return std::nullopt;
  const bool removed = overlay->deleteOwnProperty(property);
  if (removed) forgetNativeOwnKey(table, property);
  return removed;
}
inline void appendDocumentOverlayKeys(const Dictionary<Value>* table, std::vector<std::string>& keys, bool enumerableOnly) {
  const auto overlay = documentOverlay(table);
  if (!overlay) return;
  std::vector<PropertyKey> all;
  all.reserve(keys.size());
  for (const auto& key : keys) all.push_back(PropertyKey::string(key));
  for (const auto& key : overlay->ownKeys()) {
    if (key.isSymbol()) continue;
    const auto* descriptor = overlay->ownProperty(key);
    if ((!enumerableOnly || descriptor->enumerable) && std::find(all.begin(), all.end(), key) == all.end()) all.push_back(key);
  }
  all = nativeOwnKeysInCreationOrder(table, std::move(all));
  keys.clear();
  for (const auto& key : all) keys.push_back(key.text());
}
inline void noteDocumentDataKeyCreated(const Dictionary<Value>* table, const std::string& key) {
  if (!table->hasNativePropertyOverlay()) return;
  if (auto* order = findNativeOwnKeyOrder(table)) order->create(PropertyKey::string(key));
}
inline void forgetDocumentDataKey(const Dictionary<Value>* table, const std::string& key) {
  if (!table->hasNativePropertyOverlay()) return;
  forgetNativeOwnKey(table, PropertyKey::string(key));
}

inline std::optional<bool> readDocumentNativeObject(
    const Ref<DynamicObject>& object, const PropertyKey& key,
    const NativeCallReceiver& receiver, const NativeFieldRead& read) {
  for (auto cursor = object; cursor; cursor = cursor->prototype()) {
    const auto* descriptor = cursor->ownProperty(key);
    if (descriptor == nullptr) continue;
    if (!descriptor->isAccessor())
      return descriptor->nativeValue ? std::optional<bool>(descriptor->nativeValue.read(read)) : std::nullopt;
    if (descriptor->nativeGet && descriptor->nativeGet.read != nullptr)
      return descriptor->nativeGet.readNative(receiver, read);
    return std::nullopt;
  }
  return std::nullopt;
}

/** nullopt leaves an actual Value entry to the selected checked reader.
 * A native holder/getter instead consumes the exact policy request once. */
template <typename T>
std::optional<bool> nativeDocumentReadNative(const Ref<T>& source, const PropertyKey& key, const NativeFieldRead& read) {
  if constexpr (std::is_same_v<T, DynamicObject>)
    return readDocumentNativeObject(source, key, NativeCallReceiver::object(source), read);
  if constexpr (std::is_same_v<T, Dictionary<Value>>) {
    if (const auto* owner = source->nativeOwner()) {
      if (owner->operations == nullptr || owner->operations->readNative == nullptr) return false;
      return owner->operations->readNative(owner->held, key, read);
    }
    if (source->alias()) {
      const auto& object = source->alias()->object;
      if (object.isDynamicObject())
        return readDocumentNativeObject(object.asDynamicObject(), key, NativeCallReceiver::object(object.asDynamicObject()), read);
      if (!object.isProxy() && object.classObject() && object.nativeDocumentOperations() && object.nativeDocumentOperations()->readNative)
        return object.nativeDocumentOperations()->readNative(object.classObject(), key, read);
      return std::nullopt;
    }
    const auto overlay = documentOverlay(source.get());
    if (overlay && (overlay->ownProperty(key) != nullptr || key.isSymbol() || !source->hasStoredKey(key.text())))
      return readDocumentNativeObject(overlay, key, NativeCallReceiver::object(source), read);
    return std::nullopt;
  }
  if (record::hasLiveFieldView(refCastToVoid(source))) return record::readFieldView(refCastToVoid(source), key, read);
  if (const auto* elements = nativeArrayOpsFor<Ref<T>>()) {
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) {
      PropertyDescriptor descriptor;
      if (elements->ownDescriptor == nullptr || !elements->ownDescriptor(&source, index, descriptor)) return std::nullopt;
      if (!descriptor.isAccessor())
        return descriptor.nativeValue ? std::optional<bool>(descriptor.nativeValue.read(read)) : std::nullopt;
      if (descriptor.nativeGet && descriptor.nativeGet.read != nullptr)
        return descriptor.nativeGet.readNative(NativeCallReceiver::object(source), read);
      return std::nullopt;
    }
  }
  auto mutableRead = read;
  if constexpr (requires { source->gea_matchesOwnField(key); source->gea_readOwnFieldNative(key, mutableRead); }) {
    if (source->gea_matchesOwnField(key)) {
      bool present = true;
      if constexpr (requires { source->gea_ownFieldPresent(key, present); })
        if (source->gea_ownFieldPresent(key, present) && !present) return std::nullopt;
      return source->gea_readOwnFieldNative(key, mutableRead);
    }
  }
  if constexpr (requires { source->gea_matchesOwnIndex(key); source->gea_readOwnIndexNative(key, mutableRead); }) {
    if (source->gea_matchesOwnIndex(key)) {
      bool present = true;
      if constexpr (requires { source->gea_ownIndexPresent(key, present); })
        if (source->gea_ownIndexPresent(key, present) && !present) return std::nullopt;
      return source->gea_readOwnIndexNative(key, mutableRead);
    }
  }
  const auto sidecar = expandoFor(nativePropertyAnchor(source), false);
  return sidecar ? readDocumentNativeObject(sidecar, key, NativeCallReceiver::object(source), read) : std::nullopt;
}

template <typename T>
bool nativeDocumentRead(const Ref<T>& source, const PropertyKey& key, Value& out, bool followMissingIndex = false) {
  if constexpr (std::is_same_v<T, DynamicObject>) {
    if (!source->hasProperty(key)) return false;
    out = source->getWithNativeReceiver(key, NativeCallReceiver::object(source));
    return true;
  }
  if constexpr (std::is_same_v<T, Dictionary<Value>>) {
    if (const auto* owner = source->nativeOwner()) return dictionary::nativeOwnerRead(owner, key, out);
    if (source->alias()) { out = source->alias()->object.getProperty(key); return true; }
    if (!key.isSymbol()) { out = source->read(key.text()); return source->has(key.text()); }
    const auto overlay = expandoFor(nativePropertyAnchor(source), false);
    if (!overlay || !overlay->hasProperty(key)) return false;
    out = overlay->getWithNativeReceiver(key, NativeCallReceiver::object(source));
    return true;
  }
  const auto* elements = nativeArrayOpsFor<Ref<T>>();
  if (elements != nullptr) {
    if (!key.isSymbol() && key.text() == "length") {
      out = Value::box(Value::Tag::Number, static_cast<double>(elements->length(&source)));
      return true;
    }
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) {
      elements->element(&source, index, out);
      return true;
    }
  }
  const auto* fields = nativeFieldOpsFor<Ref<T>>();
  if (fields != nullptr) {
    if (fields->read(&source, key, out) || fields->readIndex(&source, key, out)) return true;
    if (fields->matchesField(&source, key) || (!followMissingIndex && fields->matchesIndex(&source, key))) return false;
  }
  if constexpr (NativeOwnFieldPresenceTable<T>) {
    bool present = false;
    if (source->gea_ownFieldPresent(key, present) && present)
      host::throwRuntimeError("TypeError", "a native Document field has no published value protocol");
  }
  const auto sidecar = expandoFor(nativePropertyAnchor(source), false);
  if (sidecar && sidecar->hasProperty(key)) {
    out = sidecar->getWithNativeReceiver(key, NativeCallReceiver::object(source));
    return true;
  }
  if (elements != nullptr) {
    out = dynamicArrayPrototypeGet(key);
    return out.tag() != Value::Tag::Undefined;
  }
  if constexpr (requires { source->gea_readPrototypeProperty(key, out); })
    if (source->gea_readPrototypeProperty(key, out)) return true;
  if constexpr (requires { source->gea_hasPrototypeProperty(key); })
    if (source->gea_hasPrototypeProperty(key))
      host::throwRuntimeError("TypeError", "a native Document prototype property has no published read protocol");
  if constexpr (IsMapPayload<Ref<T>>::value) {
    if (!key.isSymbol() && key.text() == "size") {
      out = Value::box(Value::Tag::Number, source->size());
      return true;
    }
    if (key.isSymbol() && key.symbolId() == static_cast<std::size_t>(WellKnownSymbol::ToStringTag)) {
      out = Value::box(Value::Tag::String, std::string("Map"));
      return true;
    }
    if (mapPrototypeChainHas(key)) refuseOpaquePropertyAccess("a Map Document property read", key);
  }
  return false;
}

template <typename T>
bool nativeDocumentDescriptor(const Ref<T>& source, const PropertyKey& key, PropertyDescriptor& out) {
  if constexpr (std::is_same_v<T, DynamicObject>) {
    const auto* descriptor = source->ownProperty(key);
    if (descriptor == nullptr) return false;
    out = *descriptor;
    return true;
  }
  if constexpr (std::is_same_v<T, Dictionary<Value>>) {
    if (const auto* owner = source->nativeOwner()) return dictionary::nativeOwnerDescriptor(owner, key, out);
    if (source->alias()) return source->alias()->object.ownDescriptor(key, out);
    const auto overlay = expandoFor(nativePropertyAnchor(source), false);
    const auto* descriptor = overlay ? overlay->ownProperty(key) : nullptr;
    if (descriptor != nullptr) { out = *descriptor; return true; }
    if (key.isSymbol() || !source->hasOwn(key.text())) return false;
    out = PropertyDescriptor::assignment(source->read(key.text()));
    const auto attributes = source->attributesOf(key.text());
    out.writable = attributes.writable && nativeOwnFieldsWritable(source);
    out.enumerable = attributes.enumerable;
    out.configurable = attributes.configurable;
    return true;
  }
  const auto* elements = nativeArrayOpsFor<Ref<T>>();
  if (elements != nullptr) {
    const bool frozen = elements->frozen(&source) || !nativeOwnFieldsWritable(source);
    if (!key.isSymbol() && key.text() == "length") {
      out = PropertyDescriptor::assignment(Value::box(Value::Tag::Number, static_cast<double>(elements->length(&source))));
      out.enumerable = out.configurable = false;
      out.writable = !frozen && (elements->writableLength == nullptr || elements->writableLength(&source));
      return true;
    }
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index) && elements->ownDescriptor != nullptr)
      return elements->ownDescriptor(&source, index, out);
  }
  const auto descriptor = nativeOwnPropertyDescriptor(source, key);
  if (!descriptor.has_value()) return false;
  out = *descriptor;
  return true;
}

template <typename T>
bool nativeDocumentHas(const Ref<T>& source, const PropertyKey& key, bool own) {
  if constexpr (std::is_same_v<T, DynamicObject>) return own ? source->ownProperty(key) != nullptr : source->hasProperty(key);
  if constexpr (std::is_same_v<T, Dictionary<Value>>) {
    if (const auto* owner = source->nativeOwner()) return owner->operations->has(owner->held, key, own);
    if (source->alias()) {
      if (!own) return source->alias()->object.hasProperty(key);
      PropertyDescriptor descriptor;
      return source->alias()->object.ownDescriptor(key, descriptor);
    }
    const auto overlay = expandoFor(nativePropertyAnchor(source), false);
    if (overlay && (own ? overlay->ownProperty(key) != nullptr : overlay->hasProperty(key))) return true;
    if (!key.isSymbol() && source->hasOwn(key.text())) return true;
    return !own && ordinaryObjectPrototypeHas(key);
  }
  if constexpr (TypedStringDictionaryTable<T>) {
    if (dictionaryTableAddresses<T>(key) && source->hasOwn(key.text())) return true;
  }
  if (const auto* origin = record::nativeViewRoute(refCastToVoid(source)); origin && origin->hasOwn)
    return own ? origin->hasOwn(origin->immediate, key)
               : origin->hasProperty && origin->hasProperty(origin->immediate, key);
  if constexpr (IsArrayPayload<Ref<T>>::value) {
    if (!key.isSymbol() && key.text() == "length") return true;
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) {
      if constexpr (requires { source->hasElementAtIndex(static_cast<long long>(index)); })
        return source->hasElementAtIndex(static_cast<long long>(index));
    }
  }
  if constexpr (NativeOwnFieldPresenceTable<T>) {
    bool present = false;
    if (source->gea_ownFieldPresent(key, present) && present) return true;
  } else if constexpr (NativeFieldTable<T>) {
    if constexpr (NativeOwnFieldPredicate<T>) {
      if (source->gea_matchesOwnField(key))
        host::throwRuntimeError("TypeError", "a native Document field has no presence-only protocol");
    }
  }
  if constexpr (NativeOwnIndexPresenceTable<T>) {
    bool present = false;
    if (source->gea_ownIndexPresent(key, present) && present) return true;
  }
  const auto overlay = expandoFor(nativePropertyAnchor(source), false);
  if (overlay && (own ? overlay->ownProperty(key) != nullptr : overlay->hasProperty(key))) return true;
  if (own) return false;
  if constexpr (requires { source->gea_hasPrototypeProperty(key); })
    if (source->gea_hasPrototypeProperty(key)) return true;
  if constexpr (IsArrayPayload<Ref<T>>::value) return dynamicArrayPrototypeHas(key) || ordinaryObjectPrototypeHas(key);
  if constexpr (IsMapPayload<Ref<T>>::value) return mapPrototypeChainHas(key);
  return ordinaryObjectPrototypeHas(key);
}

template <typename T>
std::vector<PropertyKey> nativeDocumentKeys(const Ref<T>& source) {
  if constexpr (std::is_same_v<T, DynamicObject>) return source->ownKeys();
  auto keys = nativeOwnPropertyKeys(source);
  if constexpr (TypedStringDictionaryTable<T>) {
    if (const auto* fields = nativeFieldOpsFor<Ref<T>>()) fields->ownKeys(&source, keys);
    return nativeOwnKeysInCreationOrder(source.get(), std::move(keys));
  }
  if constexpr (std::is_same_v<T, Dictionary<Value>>) {
    if (const auto* owner = source->nativeOwner()) return owner->operations->keys(owner->held);
    if (source->alias()) return source->alias()->object.ownPropertyKeys();
    for (const auto& name : source->creationKeys()) {
      const auto key = PropertyKey::string(name);
      if (std::find(keys.begin(), keys.end(), key) == keys.end()) keys.push_back(key);
    }
    return nativeOwnKeysInCreationOrder(source.get(), std::move(keys));
  }
  if (const auto* elements = nativeArrayOpsFor<Ref<T>>()) {
    auto properties = std::move(keys);
    keys.clear();
    for (std::size_t index = 0; index < elements->length(&source); ++index) {
      if (!nativeDocumentHas(source, PropertyKey::string(std::to_string(index)), true)) continue;
      const auto key = PropertyKey::string(std::to_string(index));
      if (std::find(keys.begin(), keys.end(), key) == keys.end()) keys.push_back(key);
    }
    const auto length = PropertyKey::string("length");
    if (std::find(keys.begin(), keys.end(), length) == keys.end()) keys.push_back(length);
    for (auto& key : properties)
      if (std::find(keys.begin(), keys.end(), key) == keys.end()) keys.push_back(std::move(key));
  }
  return ordinaryOwnPropertyKeyOrder(std::move(keys));
}

template <typename T>
bool nativeDocumentSet(const Ref<T>& source, const PropertyKey& key, const Value& value) {
  if constexpr (std::is_same_v<T, DynamicObject>) return source->setWithNativeReceiver(key, value, NativeCallReceiver::object(source));
  if constexpr (std::is_same_v<T, Dictionary<Value>>) {
    if (const auto* owner = source->nativeOwner()) return dictionary::nativeOwnerSet(owner, key, value);
    if (source->alias()) {
      auto object = source->alias()->object;
      return object.reflectSet(key, value, object);
    }
    if (!key.isSymbol()) {
      if (!source->hasOwn(key.text()) && !nativeIsExtensible(source)) return false;
      if (!nativeOwnFieldsWritable(source) && source->hasOwn(key.text())) return false;
      return source->setProperty(key.text(), value);
    }
  }
  if (const auto* elements = nativeArrayOpsFor<Ref<T>>()) {
    auto mutableSource = source;
    if (elements->frozen(&source) || !nativeOwnFieldsWritable(source)) return false;
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) return elements->setElement(&mutableSource, index, value);
    if (!key.isSymbol() && key.text() == "length") {
      const double length = dynamicToNumber(value);
      if (!std::isfinite(length) || length < 0 || length > 4294967295.0 || length != std::floor(length))
        host::throwRuntimeError("RangeError", "Invalid array length");
      elements->resize(&mutableSource, length);
      return true;
    }
  }
  const auto* fields = nativeFieldOpsFor<Ref<T>>();
  if (fields != nullptr) {
    if (fields->matchesField(&source, key))
      return nativeOwnFieldsWritable(source) && fields->write(const_cast<Ref<T>*>(&source), key, value, nativeIsExtensible(source));
    if (fields->matchesIndex(&source, key))
      return fields->writeIndex(const_cast<Ref<T>*>(&source), key, value, nativeIsExtensible(source));
  }
  const auto receiver = NativeCallReceiver::object(source);
  const auto existing = expandoFor(nativePropertyAnchor(source), false);
  if (existing && existing->ownProperty(key) != nullptr) return existing->setWithNativeReceiver(key, value, receiver);
  if constexpr (requires { source->gea_setPrototypePropertyNative(key, value, receiver); }) {
    const auto accepted = source->gea_setPrototypePropertyNative(key, value, receiver);
    if (accepted != NativePrototypeOps::SetResult::Absent) return accepted == NativePrototypeOps::SetResult::Accepted;
  } else if constexpr (NativePrototypeTable<T>) {
    if (source->gea_hasPrototypeProperty(key))
      host::throwRuntimeError("TypeError", "a native Document prototype setter has no native receiver protocol");
  }
  if (!nativeIsExtensible(source)) return false;
  if (!expandoFor(nativePropertyAnchor(source), true)->setWithNativeReceiver(key, value, receiver)) return false;
  noteNativeExpandoKeyCreated(source, key);
  return true;
}

template <typename T>
bool nativeDocumentDefine(const Ref<T>& source, const PropertyKey& key, const PropertyDescriptor& descriptor) {
  if constexpr (std::is_same_v<T, DynamicObject>) return source->defineOwnProperty(key, descriptor);
  if constexpr (std::is_same_v<T, Dictionary<Value>>) {
    if (const auto* owner = source->nativeOwner()) return dictionary::nativeOwnerDefine(owner, key, descriptor);
    if (source->alias()) return source->alias()->object.defineProperty(key, descriptor);
    if (source->viewAnchor() && descriptor.nativeValue)
      host::throwRuntimeError("TypeError", "a native descriptor needs the original dictionary entry writer");
    const auto existing = expandoFor(nativePropertyAnchor(source), false);
    if (existing && existing->ownProperty(key) != nullptr) return existing->defineOwnProperty(key, descriptor);
    PropertyDescriptor current;
    const bool present = nativeDocumentDescriptor(source, key, current);
    if (!compatibleProxyDescriptor(nativeIsExtensible(source), descriptor, present ? &current : nullptr)) return false;
    if (!key.isSymbol() && !descriptor.isAccessor() && !descriptor.nativeValue) {
      const auto attributes = present ? source->attributesOf(key.text()) : Dictionary<Value>::Attributes{false, false, false};
      return source->defineProperty(key.text(), descriptor.hasValue ? descriptor.dataValue() : (present ? current.dataValue() : Value()),
          {descriptor.hasWritable ? descriptor.writable : attributes.writable,
           descriptor.hasEnumerable ? descriptor.enumerable : attributes.enumerable,
           descriptor.hasConfigurable ? descriptor.configurable : attributes.configurable});
    }
    const auto prior = nativeDocumentKeys(source);
    auto completed = descriptor;
    if (present) {
      if (!completed.hasEnumerable) { completed.hasEnumerable = true; completed.enumerable = current.enumerable; }
      if (!completed.hasConfigurable) { completed.hasConfigurable = true; completed.configurable = current.configurable; }
    }
    if (!expandoFor(nativePropertyAnchor(source), true)->defineOwnProperty(key, completed)) return false;
    source->noteNativePropertyOverlay();
    if (!key.isSymbol() && present) source->erase(key.text());
    seedNativeOwnKeyOrder(nativePropertyAnchor(source), prior);
    if (!present) noteNativeExpandoKeyCreated(source, key);
    return true;
  }
  if (const auto* elements = nativeArrayOpsFor<Ref<T>>()) {
    auto mutableSource = source;
    if (!key.isSymbol() && key.text() == "length")
      return elements->defineLength != nullptr && elements->defineLength(&mutableSource, descriptor);
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) return elements->define != nullptr && elements->define(&mutableSource, index, descriptor);
  }
  return nativeDynamicDefineProperty(source, key, descriptor);
}

/** The lane check behind a `laneChecked` native-entry writer: a native entry
 * stored by index into an Array lands in that Array's own element lane. A
 * `Value` lane observes any native descriptor; a typed `ArrayObject<E>` lane
 * holds only an entry whose carrier is `E`, which its typed readers then read
 * natively. Any other entry is refused here, at the store, with the TypeError
 * the lane's later typed read would otherwise have thrown. Write path only. */
template <typename T>
void requireNativeEntryFitsArrayLane(const T& array, const NativeDescriptorData& value) {
  if constexpr (IsArrayObjectStruct<T>::value) {
    using Element = typename ArrayObjectElementOf<T>::type;
    if constexpr (!std::is_same_v<Element, Value>) {
      std::optional<Element> lane;
      NativeFieldRead read(lane);
      if (array.elementPolicy) read.requestedPolicy = array.elementPolicy;
      if (!value.read(read) || !lane)
        host::throwRuntimeError("TypeError", "a native entry does not fit this array's typed element lane");
    }
  }
}

/** The original object owns the holder. The full write adapter remains
 * available to a native setter or a differently projected fixed slot. */
template <typename T>
bool nativeDocumentSetNative(const Ref<T>& source, const PropertyKey& key,
                             const NativeDescriptorData& value, const NativeFieldWrite& written) {
  if constexpr (std::is_same_v<T, DynamicObject>)
    return source->setNativeDescriptorWithNativeReceiver(key, value, written, NativeCallReceiver::object(source));
  if constexpr (std::is_same_v<T, Dictionary<Value>>) {
    if (const auto* owner = source->nativeOwner())
      return owner->operations && owner->operations->setNative && owner->operations->setNative(owner->held, key, value, written);
    if (source->alias()) {
      const auto& object = source->alias()->object;
      if (object.isDynamicObject())
        return object.asDynamicObject()->setNativeDescriptorWithNativeReceiver(
            key, value, written, NativeCallReceiver::object(object.asDynamicObject()));
      if (!object.isProxy() && object.classObject() && object.nativeDocumentOperations() && object.nativeDocumentOperations()->setNative)
        return object.nativeDocumentOperations()->setNative(object.classObject(), key, value, written);
      host::throwRuntimeError("TypeError", "a Document native entry has no original owner writer");
    }
    if (source->viewAnchor())
      host::throwRuntimeError("TypeError", "a native entry needs the original dictionary storage writer");
    PropertyDescriptor current;
    const bool present = nativeDocumentDescriptor(source, key, current);
    if ((!present && !nativeIsExtensible(source)) || (present && !current.isAccessor() && !current.writable)) return false;
    const auto prior = nativeDocumentKeys(source);
    const auto overlay = documentOverlay(source.get(), true);
    if (present && overlay->ownProperty(key) == nullptr && !overlay->defineOwnProperty(key, current)) return false;
    if (!overlay->setNativeDescriptorWithNativeReceiver(key, value, written, NativeCallReceiver::object(source))) return false;
    if (overlay->ownProperty(key) != nullptr) {
      source->noteNativePropertyOverlay();
      if (!key.isSymbol() && source->hasStoredKey(key.text())) source->erase(key.text());
      seedNativeOwnKeyOrder(nativePropertyAnchor(source), prior);
      if (!present) noteNativeExpandoKeyCreated(source, key);
    }
    return true;
  }
  if (record::hasLiveFieldView(refCastToVoid(source))) return record::writeFieldView(refCastToVoid(source), key, written);
  if (const auto* elements = nativeArrayOpsFor<Ref<T>>()) {
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) {
      if (elements->frozen(&source) || !nativeOwnFieldsWritable(source)) return false;
      PropertyDescriptor current;
      const bool present = elements->ownDescriptor && elements->ownDescriptor(&source, index, current);
      if (present && current.isAccessor()) {
        if (!current.hasSet) return false;
        const auto receiver = NativeCallReceiver::object(source);
        if (current.nativeSet && current.nativeSet.write)
          return current.nativeSet.writeNative(receiver, written);
        if (current.nativeSet && current.nativeSet.dynamicWrite) {
          current.nativeSet.observeWrite(receiver, value.materialize());
          return true;
        }
        if (!current.set) return false;
        current.set(receiver.dynamicValue(), value.materialize());
        return true;
      }
      if (present && !current.writable) return false;
      requireNativeEntryFitsArrayLane(*source, value);
      auto descriptor = present ? PropertyDescriptor{} : PropertyDescriptor::assignment(Value{});
      descriptor.hasValue = true;
      descriptor.nativeValue = value;
      auto mutableSource = source;
      return elements->define && elements->define(&mutableSource, index, descriptor);
    }
    if (!key.isSymbol() && key.text() == "length")
      host::throwRuntimeError("TypeError", "a native Document length assignment needs a numeric entry writer");
  }
  if constexpr (requires { source->gea_matchesOwnField(key); source->gea_writeOwnFieldNative(key, written, true); })
    if (source->gea_matchesOwnField(key))
      return nativeOwnFieldsWritable(source) && source->gea_writeOwnFieldNative(key, written, nativeIsExtensible(source));
  if constexpr (requires { source->gea_matchesOwnIndex(key); source->gea_writeOwnIndexNative(key, written, true); })
    if (source->gea_matchesOwnIndex(key))
      return source->gea_writeOwnIndexNative(key, written, nativeIsExtensible(source));
  const auto* fields = nativeFieldOpsFor<Ref<T>>();
  if (fields && (fields->matchesField(&source, key) || fields->matchesIndex(&source, key)))
    host::throwRuntimeError("TypeError", "a Document native entry has no selected physical field writer");
  if constexpr (IsMapPayload<Ref<T>>::value)
    if ((!key.isSymbol() && key.text() == "size") ||
        (key.isSymbol() && key.symbolId() == static_cast<std::size_t>(WellKnownSymbol::ToStringTag))) return false;
  const auto receiver = NativeCallReceiver::object(source);
  const auto existing = expandoFor(nativePropertyAnchor(source), false);
  if (existing && existing->ownProperty(key))
    return existing->setNativeDescriptorWithNativeReceiver(key, value, written, receiver);
  if constexpr (requires { source->gea_setPrototypePropertyFieldNative(key, written, receiver); }) {
    const auto accepted = source->gea_setPrototypePropertyFieldNative(key, written, receiver);
    if (accepted != NativePrototypeOps::SetResult::Absent) return accepted == NativePrototypeOps::SetResult::Accepted;
  } else if constexpr (NativePrototypeTable<T>) {
    if (source->gea_hasPrototypeProperty(key))
      host::throwRuntimeError("TypeError", "a Document native entry has no selected prototype setter");
  }
  if (!nativeIsExtensible(source)) return false;
  const auto overlay = existing ? existing : expandoFor(nativePropertyAnchor(source), true);
  if (!overlay->setNativeDescriptorWithNativeReceiver(key, value, written, receiver)) return false;
  if (overlay->ownProperty(key)) noteNativeExpandoKeyCreated(source, key);
  return true;
}

template <typename T>
bool nativeDocumentDelete(const Ref<T>& source, const PropertyKey& key) {
  if constexpr (std::is_same_v<T, DynamicObject>) return source->deleteOwnProperty(key);
  if constexpr (std::is_same_v<T, Dictionary<Value>>) {
    if (const auto* owner = source->nativeOwner()) return dictionary::nativeOwnerDelete(owner, key);
    if (source->alias()) {
      auto object = source->alias()->object;
      return object.deleteProperty(key);
    }
    if (!key.isSymbol()) return source->deleteProperty(key.text());
  }
  if (const auto* elements = nativeArrayOpsFor<Ref<T>>()) {
    if (!key.isSymbol() && key.text() == "length") return false;
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) {
      auto mutableSource = source;
      return elements->remove(&mutableSource, index);
    }
  }
  return nativeDynamicDelete(source, key);
}

template <typename T>
bool nativeDocumentEnumerable(const Ref<T>& source, const PropertyKey& key) {
  if constexpr (std::is_same_v<T, DynamicObject>) {
    const auto* descriptor = source->ownProperty(key);
    return descriptor && descriptor->enumerable;
  }
  if constexpr (std::is_same_v<T, Dictionary<Value>>) {
    if (const auto* owner = source->nativeOwner()) return owner->operations->enumerable(owner->held, key);
    if (source->alias()) {
      PropertyDescriptor descriptor;
      return source->alias()->object.ownDescriptor(key, descriptor) && descriptor.enumerable;
    }
    if (!key.isSymbol() && source->hasOwn(key.text())) return source->attributesOf(key.text()).enumerable;
  }
  if constexpr (TypedStringDictionaryTable<T>)
    if (dictionaryTableAddresses<T>(key) && source->hasOwn(key.text())) return source->attributesOf(key.text()).enumerable;
  if constexpr (IsArrayPayload<Ref<T>>::value) {
    if (!key.isSymbol() && key.text() == "length") return false;
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) {
      PropertyDescriptor descriptor;
      const auto* elements = nativeArrayOpsFor<Ref<T>>();
      return elements && elements->ownDescriptor && elements->ownDescriptor(&source, index, descriptor) && descriptor.enumerable;
    }
  }
  if constexpr (NativeOwnFieldEnumerableTable<T>) {
    bool enumerable = false;
    if (source->gea_ownFieldEnumerable(key, enumerable)) return enumerable;
  }
  if constexpr (NativeOwnIndexEnumerableTable<T>) {
    bool enumerable = false;
    if (source->gea_ownIndexEnumerable(key, enumerable)) return enumerable;
  }
  const auto overlay = expandoFor(nativePropertyAnchor(source), false);
  const auto* descriptor = overlay ? overlay->ownProperty(key) : nullptr;
  if (descriptor) return descriptor->enumerable;
  if (nativeDocumentHas(source, key, true))
    host::throwRuntimeError("TypeError", "a native Document field has no enumerability-only protocol");
  return false;
}

template <typename T>
const NativeDocumentOps* nativeDocumentOpsFor() {
  if constexpr (std::is_void_v<T> || refStandalone<T>) return nullptr;
  else {
    Ref<Map<Value, Value>> (*mapView)(const Ref<void>&) = nullptr;
    if constexpr (IsMapPayload<Ref<T>>::value) {
      using K = typename MapTypes<T>::key;
      using V = typename MapTypes<T>::value;
      if constexpr (std::is_same_v<T, Map<Value, Value>>) mapView = +[](const Ref<void>& source) { return source.template staticCast<T>(); };
      else if constexpr (DynamicCarrier<K>::supported && DynamicCarrier<V>::supported)
        mapView = +[](const Ref<void>& source) {
          return makeRef<Map<Value, Value>>(std::make_shared<const DynamicMapSource<K, V>>(source.template staticCast<T>()));
        };
    }
    static const NativeDocumentOps operations{
      +[](const Ref<void>& source, const PropertyKey& key, Value& out) {
        return nativeDocumentRead(source.template staticCast<T>(), key, out);
      },
      +[](const Ref<void>& source, const PropertyKey& key, const Value& value) {
        return nativeDocumentSet(source.template staticCast<T>(), key, value);
      },
      +[](const Ref<void>& source, const PropertyKey& key, PropertyDescriptor& out) {
        return nativeDocumentDescriptor(source.template staticCast<T>(), key, out);
      },
      +[](const Ref<void>& source, const PropertyKey& key, const PropertyDescriptor& descriptor) {
        return nativeDocumentDefine(source.template staticCast<T>(), key, descriptor);
      },
      +[](const Ref<void>& source, const PropertyKey& key) {
        return nativeDocumentDelete(source.template staticCast<T>(), key);
      },
      +[](const Ref<void>& source, const PropertyKey& key, bool own) {
        return nativeDocumentHas(source.template staticCast<T>(), key, own);
      },
      +[](const Ref<void>& source) { return nativeDocumentKeys(source.template staticCast<T>()); },
      +[](const Ref<void>& source, const PropertyKey& key) { return nativeDocumentEnumerable(source.template staticCast<T>(), key); },
      +[](const Ref<void>& source) {
        if constexpr (std::is_same_v<T, DynamicObject>) return Value::fromDynamicObject(source.template staticCast<T>());
        else return Value::box(Value::Tag::Object, source.template staticCast<T>());
      },
      payloadTypeTagFor<Ref<T>>(), IsArrayPayload<Ref<T>>::value, IsMapPayload<Ref<T>>::value, mapView,
      +[](const Ref<void>& source, const PropertyKey& key, const NativeFieldRead& read) {
        return nativeDocumentReadNative(source.template staticCast<T>(), key, read);
      },
      +[](const Ref<void>& source, const PropertyKey& key, const NativeDescriptorData& value, const NativeFieldWrite& written) {
        return nativeDocumentSetNative(source.template staticCast<T>(), key, value, written);
      }
    };
    return &operations;
  }
}

inline Value observeNativeDocumentOwner(const NativeDocumentOwner& owner) {
  if (owner.held.isUndefined()) return Value();
  if (!owner.held) return Value::box(Value::Tag::Null, nullptr);
  if (owner.operations == nullptr) host::throwRuntimeError("TypeError", "a Document owner has no native property protocol");
  return owner.operations->observe(owner.held);
}

class NativeDocumentSource final : public DictionaryViewSource<Value> {
 public:
  explicit NativeDocumentSource(NativeDocumentOwner owner) : owner_(std::move(owner)) {}
  ~NativeDocumentSource() override { if (registered_) forgetAliasView(owner_.identity(), this); }
  void registerIdentity() const { registered_ = true; }
  Value read(std::string_view key) const override {
    Value result;
    owner_.operations->read(owner_.held, PropertyKey::string(std::string(key)), result);
    return result;
  }
  bool has(std::string_view key, bool own) const override {
    return owner_.operations->has(owner_.held, PropertyKey::string(std::string(key)), own);
  }
  void attributes(const std::string& key, bool& writable, bool& enumerable, bool& configurable) const override {
    PropertyDescriptor descriptor;
    if (!owner_.operations->descriptor(owner_.held, PropertyKey::string(key), descriptor)) return;
    writable = !descriptor.isAccessor() && descriptor.writable;
    enumerable = descriptor.enumerable;
    configurable = descriptor.configurable;
  }
  std::vector<std::string> keys(bool enumerableOnly, bool) const override {
    std::vector<std::string> result;
    for (const auto& key : owner_.operations->keys(owner_.held)) {
      if (key.isSymbol()) continue;
      if (enumerableOnly && !owner_.operations->enumerable(owner_.held, key)) continue;
      result.push_back(key.text());
    }
    return result;
  }
  const void* identity() const override { return owner_.identity(); }
  Ref<void> anchor() const override { return owner_.held; }
  Value dynamicValue() const override { return observeNativeDocumentOwner(owner_); }
  const NativeDocumentOwner* nativeOwner() const override { return &owner_; }
  void trace(RefVisitor& visitor) const override { traceRefs(owner_.held, visitor); }
  bool set(const std::string& key, const Value& value) const override {
    return owner_.operations->set(owner_.held, PropertyKey::string(key), value);
  }
  bool define(const std::string& key, const Value& value, std::optional<bool> writable,
              std::optional<bool> enumerable, std::optional<bool> configurable) const override {
    auto descriptor = PropertyDescriptor::assignment(value);
    descriptor.hasWritable = writable.has_value();
    if (writable) descriptor.writable = *writable;
    descriptor.hasEnumerable = enumerable.has_value();
    if (enumerable) descriptor.enumerable = *enumerable;
    descriptor.hasConfigurable = configurable.has_value();
    if (configurable) descriptor.configurable = *configurable;
    return owner_.operations->define(owner_.held, PropertyKey::string(key), descriptor);
  }
  bool remove(const std::string& key) const override {
    return owner_.operations->remove(owner_.held, PropertyKey::string(key));
  }
  void erase(const std::string& key) const override {
    if (!remove(key)) host::throwRuntimeError("TypeError", "Cannot delete a non-configurable Document property");
  }
 private:
  NativeDocumentOwner owner_;
  mutable bool registered_ = false;
};

}  // namespace gea::detail

namespace gea {
template <typename K, typename V>
bool Map<K, V>::dynamicViewValue(Value& out) const {
  if (!view_) return false;
  const auto* operations = view_->documentOperations();
  const auto anchor = view_->anchor();
  if (!anchor || operations == nullptr) host::throwRuntimeError("TypeError", "a Map view has no original native owner");
  out = operations->observe(anchor);
  return true;
}
}  // namespace gea

namespace gea::dictionary {
inline void requireDocument(const Ref<Dictionary<Value>>& table) {
  if (!table) host::throwRuntimeError("TypeError", "Cannot access a property of a nullish Document");
}

/** The adapter authenticates Value as the genuine source entry carrier. */
inline bool readDocumentField(const Ref<Dictionary<Value>>& table, const PropertyKey& key, const NativeFieldRead& read) {
  requireDocument(table);
  if (const auto native = detail::nativeDocumentReadNative(table, key, read)) {
    if (*native) return true;
    // A native entry of another layout than the reader's exact payload (a
    // generic instantiated twice, met through `any`) is observed as the
    // object it is and converted by the reader's selected dynamic arm.
    if (!read.template acceptsExact<Value, NativeFieldLeafPolicy>())
      host::throwRuntimeError("TypeError", "a Document native entry does not match its selected reader");
  }
  if (!read.template acceptsExact<Value, NativeFieldLeafPolicy>())
    host::throwRuntimeError("TypeError", "a Document field read has no selected entry conversion");
  Value value;
  detail::nativeDocumentRead(table, key, value);
  return read.assign(value);
}
/** The selected erased array reader can also return an already-native
 * indexed element. Only that separate physical string:any proof selects
 * this adapter; other live views cannot borrow Document entry observation. */
template <typename T>
bool readDocumentArrayEntry(const Ref<T>& source, const PropertyKey& key, const NativeFieldRead& read) {
  if (!source) host::throwRuntimeError("TypeError", "Cannot read a property of a nullish array entry");
  if (record::documentViewRoute(Ref<void>(source))) return record::readDocumentEntryView(Ref<void>(source), key, read);
  if (record::hasLiveFieldView(Ref<void>(source)) || key.isSymbol() || !read.template acceptsExact<Value, NativeFieldLeafPolicy>())
    host::throwRuntimeError("TypeError", "an array entry has no original dynamic index protocol");
  Value answer;
  detail::nativeDocumentRead(source, key, answer, true);
  return read.assign(answer);
}
inline bool writeDocumentField(const Ref<Dictionary<Value>>& table, const PropertyKey& key, const NativeFieldWrite& write) {
  requireDocument(table);
  std::optional<Value> value;
  if (!write.read(value)) host::throwRuntimeError("TypeError", "a Document field write has no selected entry conversion");
  return detail::nativeDocumentSet(table, key, *value);
}
template <typename T, typename Policy>
inline bool writeDocumentNativeEntry(const Ref<Dictionary<Value>>& table, const PropertyKey& key,
                                     const NativeFieldWrite& write, typename NativeDescriptorData::template Materializer<T> observe) {
  requireDocument(table);
  std::optional<T> value;
  if (!write.template read<Policy>(value))
    host::throwRuntimeError("TypeError", "a Document native entry write has no selected storage identity");
  return detail::nativeDocumentSetNative(table, key, NativeDescriptorData::make<T, Policy>(*value, observe), write);
}
inline bool defineDocumentField(const Ref<Dictionary<Value>>& table, const PropertyKey& key, const PropertyDescriptor& descriptor) {
  requireDocument(table);
  return detail::nativeDocumentDefine(table, key, descriptor);
}
inline bool hasOwnDocumentField(const Ref<Dictionary<Value>>& table, const PropertyKey& key) {
  requireDocument(table);
  return detail::nativeDocumentHas(table, key, true);
}
inline bool hasDocumentField(const Ref<Dictionary<Value>>& table, const PropertyKey& key) {
  requireDocument(table);
  return detail::nativeDocumentHas(table, key, false);
}
inline Ref<Map<Value, Value>> viewedDynamicMap(const Ref<Dictionary<Value>>& table, const char* site) {
  if (table.isUndefined()) return Ref<Map<Value, Value>>::undefined();
  if (!table) return {};
  const auto* owner = table->nativeOwner();
  if (owner != nullptr && owner->operations != nullptr && owner->operations->mapView != nullptr)
    return owner->operations->mapView(owner->held);
  if (table->alias() != nullptr) return detail::unboxDynamicMap(table->alias()->object, site);
  host::throwRuntimeError("TypeError", site);
}

inline Ref<Dictionary<Value>> nativeAliasOf(detail::NativeDocumentOwner owner) {
  using Table = Dictionary<Value>;
  if (owner.held.isUndefined()) return Ref<Table>::undefined();
  if (!owner.held) return {};
  if (owner.operations == nullptr) host::throwRuntimeError("TypeError", "a Document view needs the original native property protocol");
  const void* identity = owner.identity();
  const auto* existing = aliasViews().find(identity);
  if (existing != nullptr && detail::refCountsOf(existing->table)->strong != 0) return Ref<Table>::adopt(existing->table, true);
  auto source = std::make_shared<const detail::NativeDocumentSource>(std::move(owner));
  auto table = makeRef<Table>(source);
  aliasViews().assign(identity, AliasEntry{table.get(), source.get()});
  source->registerIdentity();
  return table;
}

}  // namespace gea::dictionary

#endif  // GEA_DOCUMENT_VIEW_H
