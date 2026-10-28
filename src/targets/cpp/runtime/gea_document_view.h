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
    refuseReassignedPrototype(sidecar, key);
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

/**
 * The document protocol of an `ArrayObject<E>`, written once for every `E`.
 *
 * An array's own properties are its elements, `length` and its expando, and
 * its element access is already type-erased behind `NativeArrayOps`; the
 * element type changes nothing else. Instantiating the generic
 * `nativeDocument*` templates per element type compiled ~20 KB of identical
 * code into the binary for every array type a program boxes. What really
 * depends on the type is the handful of guards below, which are small.
 *
 * `payload` is the handle's address, the convention every erased table
 * already takes from `Value::payload()`: a `Ref<void>` word read as the
 * `Ref<ArrayObject<E>>` it holds. `source` is the same handle. Each function
 * is the generic template's array path, unchanged.
 */
struct NativeArrayDocumentBridge {
  const NativeArrayOps* (*elements)();
  bool (*fieldsWritable)(const void* payload);
  bool (*extensible)(const void* payload);
  NativeCallReceiver (*receiver)(const void* payload);
  void (*requireLane)(const void* payload, const NativeDescriptorData& value);
};

inline void noteArrayExpandoKeyCreated(const Ref<void>& source, const PropertyKey& key) {
  noteNativeOwnKeyCreated(source, key, [](std::vector<PropertyKey>&) {});
}

[[gnu::noinline]] inline bool arrayDocumentHas(const Ref<void>& source, const void* payload, const NativeArrayDocumentBridge& bridge,
                                               const PropertyKey& key, bool own) {
  const auto* elements = bridge.elements();
  if (const auto* origin = record::nativeViewRoute(source); origin && origin->hasOwn)
    return own ? origin->hasOwn(origin->immediate, key) : origin->hasProperty && origin->hasProperty(origin->immediate, key);
  if (!key.isSymbol() && key.text() == "length") return true;
  std::size_t index = 0;
  if (arrayIndexOfKey(key, index)) return index < elements->length(payload) && elements->has(payload, index);
  const auto overlay = expandoFor(elements->owner(payload), false);
  if (overlay && (own ? overlay->ownProperty(key) != nullptr : overlay->hasProperty(key))) return true;
  if (own) return false;
  return dynamicArrayPrototypeHas(key) || ordinaryObjectPrototypeHas(key);
}

[[gnu::noinline]] inline bool arrayDocumentRead(const Ref<void>&, const void* payload, const NativeArrayDocumentBridge& bridge,
                                                const PropertyKey& key, Value& out) {
  const auto* elements = bridge.elements();
  if (!key.isSymbol() && key.text() == "length") {
    out = Value::box(Value::Tag::Number, static_cast<double>(elements->length(payload)));
    return true;
  }
  std::size_t index = 0;
  if (arrayIndexOfKey(key, index)) {
    elements->element(payload, index, out);
    return true;
  }
  const auto sidecar = expandoFor(elements->owner(payload), false);
  if (sidecar && sidecar->hasProperty(key)) {
    out = sidecar->getWithNativeReceiver(key, bridge.receiver(payload));
    return true;
  }
  refuseReassignedPrototype(sidecar, key);
  out = dynamicArrayPrototypeGet(key);
  return out.tag() != Value::Tag::Undefined;
}

[[gnu::noinline]] inline bool arrayDocumentDescriptor(const Ref<void>& source, const void* payload, const NativeArrayDocumentBridge& bridge,
                                                      const PropertyKey& key, PropertyDescriptor& out) {
  const auto* elements = bridge.elements();
  const bool frozen = elements->frozen(payload) || !bridge.fieldsWritable(payload);
  if (!key.isSymbol() && key.text() == "length") {
    out = PropertyDescriptor::assignment(Value::box(Value::Tag::Number, static_cast<double>(elements->length(payload))));
    out.enumerable = out.configurable = false;
    out.writable = !frozen && (elements->writableLength == nullptr || elements->writableLength(payload));
    return true;
  }
  std::size_t index = 0;
  if (arrayIndexOfKey(key, index)) return elements->ownDescriptor(payload, index, out);
  if (!source) return false;
  Optional<PropertyDescriptor> original;
  if (record::ownNativeViewDescriptor(source, key, original)) {
    if (!original.has_value()) return false;
    out = *original;
    return true;
  }
  const Ref<DynamicObject> expando = expandoFor(elements->owner(payload), false);
  const PropertyDescriptor* descriptor = expando ? expando->ownProperty(key) : nullptr;
  if (descriptor == nullptr) return false;
  out = *descriptor;
  return true;
}

[[gnu::noinline]] inline std::vector<PropertyKey> arrayDocumentKeys(const Ref<void>& source, const void* payload,
                                                                    const NativeArrayDocumentBridge& bridge) {
  const auto* elements = bridge.elements();
  std::vector<PropertyKey> properties;
  if (source) {
    for (std::size_t index = 0; index < elements->length(payload); ++index)
      if (elements->has(payload, index)) properties.push_back(arrayIndexedKey(index));
    properties.push_back(PropertyKey::string("length"));
    if (const auto expando = expandoFor(elements->owner(payload), false))
      for (const auto& key : expando->ownKeys())
        if (std::find(properties.begin(), properties.end(), key) == properties.end()) properties.push_back(key);
  }
  std::vector<PropertyKey> keys;
  for (std::size_t index = 0; index < elements->length(payload); ++index) {
    const auto key = PropertyKey::string(std::to_string(index));
    if (!arrayDocumentHas(source, payload, bridge, key, true)) continue;
    if (std::find(keys.begin(), keys.end(), key) == keys.end()) keys.push_back(key);
  }
  const auto length = PropertyKey::string("length");
  if (std::find(keys.begin(), keys.end(), length) == keys.end()) keys.push_back(length);
  for (auto& key : properties)
    if (std::find(keys.begin(), keys.end(), key) == keys.end()) keys.push_back(std::move(key));
  return ordinaryOwnPropertyKeyOrder(std::move(keys));
}

[[gnu::noinline]] inline bool arrayDocumentSet(const Ref<void>& source, void* payload, const NativeArrayDocumentBridge& bridge,
                                               const PropertyKey& key, const Value& value) {
  const auto* elements = bridge.elements();
  if (elements->frozen(payload) || !bridge.fieldsWritable(payload)) return false;
  std::size_t index = 0;
  if (arrayIndexOfKey(key, index)) return elements->setElement(payload, index, value);
  if (!key.isSymbol() && key.text() == "length") {
    const double length = dynamicToNumber(value);
    if (!std::isfinite(length) || length < 0 || length > 4294967295.0 || length != std::floor(length))
      host::throwRuntimeError("RangeError", "Invalid array length");
    elements->resize(payload, length);
    return true;
  }
  const auto receiver = bridge.receiver(payload);
  const auto anchor = elements->owner(payload);
  const auto existing = expandoFor(anchor, false);
  if (existing && existing->ownProperty(key) != nullptr) return existing->setWithNativeReceiver(key, value, receiver);
  if (!bridge.extensible(payload)) return false;
  if (!expandoFor(anchor, true)->setWithNativeReceiver(key, value, receiver)) return false;
  noteArrayExpandoKeyCreated(source, key);
  return true;
}

[[gnu::noinline]] inline bool arrayDocumentDefine(const Ref<void>& source, void* payload, const NativeArrayDocumentBridge& bridge,
                                                  const PropertyKey& key, const PropertyDescriptor& descriptor) {
  const auto* elements = bridge.elements();
  if (!key.isSymbol() && key.text() == "length") return elements->defineLength(payload, descriptor);
  std::size_t index = 0;
  if (arrayIndexOfKey(key, index)) return elements->define(payload, index, descriptor);
  if (!source) return false;
  if (record::immutableDescriptorSnapshotView(source))
    host::throwRuntimeError("TypeError", "a native descriptor snapshot definition has no certified source protocol");
  if (const auto defined = record::defineDocumentView(source, key, descriptor)) return *defined;
  const auto anchor = elements->owner(payload);
  const Ref<DynamicObject> existing = expandoFor(anchor, false);
  if (existing && existing->ownProperty(key) != nullptr) return existing->defineOwnProperty(key, descriptor);
  if (!bridge.extensible(payload)) return false;
  if (!expandoFor(anchor, true)->defineOwnProperty(key, descriptor)) return false;
  noteArrayExpandoKeyCreated(source, key);
  return true;
}

[[gnu::noinline]] inline bool arrayDocumentDelete(const Ref<void>& source, void* payload, const NativeArrayDocumentBridge& bridge,
                                                  const PropertyKey& key) {
  const auto* elements = bridge.elements();
  if (!key.isSymbol() && key.text() == "length") return false;
  std::size_t index = 0;
  if (arrayIndexOfKey(key, index)) return elements->remove(payload, index);
  if (!source) return true;
  if (record::immutableDescriptorSnapshotView(source))
    host::throwRuntimeError("TypeError", "a native descriptor snapshot deletion has no certified source protocol");
  if (const auto* document = record::documentViewRoute(source)) return document->document->remove(document->held, key);
  const Ref<DynamicObject> expando = expandoFor(elements->owner(payload), false);
  return expando ? expando->deleteOwnProperty(key) : true;
}

[[gnu::noinline]] inline bool arrayDocumentEnumerable(const Ref<void>& source, const void* payload, const NativeArrayDocumentBridge& bridge,
                                                      const PropertyKey& key) {
  const auto* elements = bridge.elements();
  if (!key.isSymbol() && key.text() == "length") return false;
  std::size_t index = 0;
  if (arrayIndexOfKey(key, index)) {
    PropertyDescriptor descriptor;
    return elements->ownDescriptor(payload, index, descriptor) && descriptor.enumerable;
  }
  const auto overlay = expandoFor(elements->owner(payload), false);
  const auto* descriptor = overlay ? overlay->ownProperty(key) : nullptr;
  if (descriptor) return descriptor->enumerable;
  if (arrayDocumentHas(source, payload, bridge, key, true))
    host::throwRuntimeError("TypeError", "a native Document field has no enumerability-only protocol");
  return false;
}

[[gnu::noinline]] inline std::optional<bool> arrayDocumentReadNative(const Ref<void>& source, const void* payload,
                                                                     const NativeArrayDocumentBridge& bridge, const PropertyKey& key,
                                                                     const NativeFieldRead& read) {
  const auto* elements = bridge.elements();
  if (record::hasLiveFieldView(source)) return record::readFieldView(source, key, read);
  std::size_t index = 0;
  if (arrayIndexOfKey(key, index)) {
    PropertyDescriptor descriptor;
    if (!elements->ownDescriptor(payload, index, descriptor)) return std::nullopt;
    if (!descriptor.isAccessor())
      return descriptor.nativeValue ? std::optional<bool>(descriptor.nativeValue.read(read)) : std::nullopt;
    if (descriptor.nativeGet && descriptor.nativeGet.read != nullptr) return descriptor.nativeGet.readNative(bridge.receiver(payload), read);
    return std::nullopt;
  }
  const auto sidecar = expandoFor(elements->owner(payload), false);
  return sidecar ? readDocumentNativeObject(sidecar, key, bridge.receiver(payload), read) : std::nullopt;
}

[[gnu::noinline]] inline bool arrayDocumentSetNative(const Ref<void>& source, void* payload, const NativeArrayDocumentBridge& bridge,
                                                     const PropertyKey& key, const NativeDescriptorData& value,
                                                     const NativeFieldWrite& written) {
  const auto* elements = bridge.elements();
  if (record::hasLiveFieldView(source)) return record::writeFieldView(source, key, written);
  std::size_t index = 0;
  if (arrayIndexOfKey(key, index)) {
    if (elements->frozen(payload) || !bridge.fieldsWritable(payload)) return false;
    PropertyDescriptor current;
    const bool present = elements->ownDescriptor(payload, index, current);
    if (present && current.isAccessor()) {
      if (!current.hasSet) return false;
      const auto receiver = bridge.receiver(payload);
      if (current.nativeSet && current.nativeSet.write) return current.nativeSet.writeNative(receiver, written);
      if (current.nativeSet && current.nativeSet.dynamicWrite) {
        current.nativeSet.observeWrite(receiver, value.materialize());
        return true;
      }
      if (!current.set) return false;
      current.set(receiver.dynamicValue(), value.materialize());
      return true;
    }
    if (present && !current.writable) return false;
    bridge.requireLane(payload, value);
    auto descriptor = present ? PropertyDescriptor{} : PropertyDescriptor::assignment(Value{});
    descriptor.hasValue = true;
    descriptor.nativeValue = value;
    return elements->define(payload, index, descriptor);
  }
  if (!key.isSymbol() && key.text() == "length")
    host::throwRuntimeError("TypeError", "a native Document length assignment needs a numeric entry writer");
  const auto receiver = bridge.receiver(payload);
  const auto anchor = elements->owner(payload);
  const auto existing = expandoFor(anchor, false);
  if (existing && existing->ownProperty(key)) return existing->setNativeDescriptorWithNativeReceiver(key, value, written, receiver);
  if (!bridge.extensible(payload)) return false;
  const auto overlay = existing ? existing : expandoFor(anchor, true);
  if (!overlay->setNativeDescriptorWithNativeReceiver(key, value, written, receiver)) return false;
  if (overlay->ownProperty(key)) noteArrayExpandoKeyCreated(source, key);
  return true;
}

template <typename T>
constexpr bool sharedArrayDocument() {
  // The shared functions transcribe the generic templates' path for a type
  // with none of these member protocols; a type that gains one must not be
  // routed through them.
  static_assert(!NativeFieldTable<T> && !TypedStringDictionaryTable<T> && !NativePrototypeTable<T> && !NativeOwnFieldPredicate<T> &&
                    !NativeOwnFieldPresenceTable<T> && !NativeOwnIndexPresenceTable<T> && !NativeOwnFieldEnumerableTable<T> &&
                    !NativeOwnIndexEnumerableTable<T> && !NativeOwnKeysTable<T> && !IsMapPayload<Ref<T>>::value,
                "an array type with its own field protocol needs the generic document templates");
  return true;
}

template <typename T>
inline constexpr NativeArrayDocumentBridge arrayDocumentBridge{
    &nativeArrayOpsFor<Ref<T>>,
    [](const void* payload) { return nativeOwnFieldsWritable(*static_cast<const Ref<T>*>(payload)); },
    [](const void* payload) { return nativeIsExtensible(*static_cast<const Ref<T>*>(payload)); },
    [](const void* payload) { return NativeCallReceiver::object(*static_cast<const Ref<T>*>(payload)); },
    [](const void* payload, const NativeDescriptorData& value) { requireNativeEntryFitsArrayLane(**static_cast<const Ref<T>*>(payload), value); }};

template <typename T>
const NativeDocumentOps* nativeArrayDocumentOpsFor() {
  static_assert(sharedArrayDocument<T>());
  static const NativeDocumentOps operations{
      +[](const Ref<void>& source, const PropertyKey& key, Value& out) { return arrayDocumentRead(source, &source, arrayDocumentBridge<T>, key, out); },
      +[](const Ref<void>& source, const PropertyKey& key, const Value& value) {
        return arrayDocumentSet(source, const_cast<Ref<void>*>(&source), arrayDocumentBridge<T>, key, value);
      },
      +[](const Ref<void>& source, const PropertyKey& key, PropertyDescriptor& out) {
        return arrayDocumentDescriptor(source, &source, arrayDocumentBridge<T>, key, out);
      },
      +[](const Ref<void>& source, const PropertyKey& key, const PropertyDescriptor& descriptor) {
        return arrayDocumentDefine(source, const_cast<Ref<void>*>(&source), arrayDocumentBridge<T>, key, descriptor);
      },
      +[](const Ref<void>& source, const PropertyKey& key) {
        return arrayDocumentDelete(source, const_cast<Ref<void>*>(&source), arrayDocumentBridge<T>, key);
      },
      +[](const Ref<void>& source, const PropertyKey& key, bool own) { return arrayDocumentHas(source, &source, arrayDocumentBridge<T>, key, own); },
      +[](const Ref<void>& source) { return arrayDocumentKeys(source, &source, arrayDocumentBridge<T>); },
      +[](const Ref<void>& source, const PropertyKey& key) { return arrayDocumentEnumerable(source, &source, arrayDocumentBridge<T>, key); },
      +[](const Ref<void>& source) { return Value::box(Value::Tag::Object, source.template staticCast<T>()); },
      payloadTypeTagFor<Ref<T>>(), IsArrayPayload<Ref<T>>::value, false, nullptr,
      +[](const Ref<void>& source, const PropertyKey& key, const NativeFieldRead& read) {
        return arrayDocumentReadNative(source, &source, arrayDocumentBridge<T>, key, read);
      },
      +[](const Ref<void>& source, const PropertyKey& key, const NativeDescriptorData& value, const NativeFieldWrite& written) {
        return arrayDocumentSetNative(source, const_cast<Ref<void>*>(&source), arrayDocumentBridge<T>, key, value, written);
      }};
  return &operations;
}

/**
 * The document protocol of every other native object -- a generated record or
 * class, or a runtime type such as `Error` or `TypedArray` -- written once.
 *
 * The generic `nativeDocument*` templates ask each type at compile time which
 * member hooks it states (`gea_ownFieldPresent`, `gea_readPrototypeProperty`,
 * ...) and were instantiated per type: 10-22 KB of mostly identical key
 * checks, expando and view routing, prototype fallbacks and refusals for
 * every class or record a program reads dynamically. Here each hook is a
 * pointer, null when the type does not state it, so `if constexpr (hook)`
 * becomes `if (bridge.hook)` and only the hook calls stay per type.
 *
 * Hooks take the erased handle and read it as the `Ref<T>` it holds -- the
 * convention every erased table already takes from `Value::payload()`.
 */
struct NativeRecordDocumentBridge {
  bool (*fieldsWritable)(const Ref<void>& source);
  bool (*extensible)(const Ref<void>& source);
  NativeCallReceiver (*receiver)(const Ref<void>& source);
  void (*keyCreated)(const Ref<void>& source, const PropertyKey& key);
  const NativeFieldOps* (*fields)();
  // A positional tuple is an Array exotic object as well: its element table,
  // consulted first exactly where the generic templates consult it. Null for
  // every other type.
  const NativeArrayOps* (*elements)();
  bool fieldTable;
  bool indexFieldTable;
  bool wholeOwnFieldProtocol;
  bool prototypeTable;
  bool ownFieldPredicate;
  bool (*ownFieldPresent)(const Ref<void>&, const PropertyKey&, bool&);
  bool (*ownIndexPresent)(const Ref<void>&, const PropertyKey&, bool&);
  bool (*ownFieldEnumerable)(const Ref<void>&, const PropertyKey&, bool&);
  bool (*ownIndexEnumerable)(const Ref<void>&, const PropertyKey&, bool&);
  bool (*matchesOwnField)(const Ref<void>&, const PropertyKey&);
  bool (*matchesOwnIndex)(const Ref<void>&, const PropertyKey&);
  bool (*readOwnField)(const Ref<void>&, const PropertyKey&, Value&);
  bool (*readOwnIndex)(const Ref<void>&, const PropertyKey&, Value&);
  bool (*ownFieldDescriptor)(const Ref<void>&, const PropertyKey&, PropertyDescriptor&);
  bool (*ownIndexDescriptor)(const Ref<void>&, const PropertyKey&, PropertyDescriptor&);
  void (*ownFieldKeys)(const Ref<void>&, std::vector<PropertyKey>&);
  bool (*defineOwnField)(const Ref<void>&, const PropertyKey&, const PropertyDescriptor&, bool extensible);
  bool (*defineOwnIndex)(const Ref<void>&, const PropertyKey&, const PropertyDescriptor&, bool extensible);
  bool (*deleteOwnField)(const Ref<void>&, const PropertyKey&);
  bool (*deleteOwnIndex)(const Ref<void>&, const PropertyKey&);
  // Each native field hook is stated only together with its predicate.
  bool (*readOwnFieldNative)(const Ref<void>&, const PropertyKey&, NativeFieldRead&);
  bool (*readOwnIndexNative)(const Ref<void>&, const PropertyKey&, NativeFieldRead&);
  bool (*writeOwnFieldNative)(const Ref<void>&, const PropertyKey&, const NativeFieldWrite&, bool extensible);
  bool (*writeOwnIndexNative)(const Ref<void>&, const PropertyKey&, const NativeFieldWrite&, bool extensible);
  bool (*readPrototypeProperty)(const Ref<void>&, const PropertyKey&, Value&);
  bool (*hasPrototypeProperty)(const Ref<void>&, const PropertyKey&);
  NativePrototypeOps::SetResult (*setPrototypePropertyNative)(const Ref<void>&, const PropertyKey&, const Value&, const NativeCallReceiver&);
  NativePrototypeOps::SetResult (*setPrototypePropertyFieldNative)(const Ref<void>&, const PropertyKey&, const NativeFieldWrite&,
                                                                   const NativeCallReceiver&);
};

[[gnu::noinline]] inline bool recordDocumentHas(const Ref<void>& source, const NativeRecordDocumentBridge& bridge, const PropertyKey& key,
                                                bool own) {
  if (const auto* origin = record::nativeViewRoute(source); origin && origin->hasOwn)
    return own ? origin->hasOwn(origin->immediate, key) : origin->hasProperty && origin->hasProperty(origin->immediate, key);
  if (bridge.elements && !key.isSymbol() && key.text() == "length") return true;
  if (bridge.ownFieldPresent) {
    bool present = false;
    if (bridge.ownFieldPresent(source, key, present) && present) return true;
  } else if (bridge.fieldTable && bridge.ownFieldPredicate) {
    if (bridge.matchesOwnField(source, key)) host::throwRuntimeError("TypeError", "a native Document field has no presence-only protocol");
  }
  if (bridge.ownIndexPresent) {
    bool present = false;
    if (bridge.ownIndexPresent(source, key, present) && present) return true;
  }
  const auto overlay = expandoFor(source, false);
  if (overlay && (own ? overlay->ownProperty(key) != nullptr : overlay->hasProperty(key))) return true;
  if (own) return false;
  if (bridge.hasPrototypeProperty && bridge.hasPrototypeProperty(source, key)) return true;
  if (bridge.elements) return dynamicArrayPrototypeHas(key) || ordinaryObjectPrototypeHas(key);
  return ordinaryObjectPrototypeHas(key);
}

[[gnu::noinline]] inline bool recordDocumentRead(const Ref<void>& source, const NativeRecordDocumentBridge& bridge, const PropertyKey& key,
                                                 Value& out) {
  const auto* elements = bridge.elements ? bridge.elements() : nullptr;
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
  if (const auto* fields = bridge.fields()) {
    if (fields->read(&source, key, out) || fields->readIndex(&source, key, out)) return true;
    if (fields->matchesField(&source, key) || fields->matchesIndex(&source, key)) return false;
  }
  if (bridge.ownFieldPresent) {
    bool present = false;
    if (bridge.ownFieldPresent(source, key, present) && present)
      host::throwRuntimeError("TypeError", "a native Document field has no published value protocol");
  }
  const auto sidecar = expandoFor(source, false);
  if (sidecar && sidecar->hasProperty(key)) {
    out = sidecar->getWithNativeReceiver(key, bridge.receiver(source));
    return true;
  }
  if (elements != nullptr) {
    refuseReassignedPrototype(sidecar, key);
    out = dynamicArrayPrototypeGet(key);
    return out.tag() != Value::Tag::Undefined;
  }
  if (bridge.readPrototypeProperty && bridge.readPrototypeProperty(source, key, out)) return true;
  if (bridge.hasPrototypeProperty && bridge.hasPrototypeProperty(source, key))
    host::throwRuntimeError("TypeError", "a native Document prototype property has no published read protocol");
  return false;
}

[[gnu::noinline]] inline bool recordDocumentDescriptor(const Ref<void>& source, const NativeRecordDocumentBridge& bridge,
                                                       const PropertyKey& key, PropertyDescriptor& out) {
  if (const auto* elements = bridge.elements ? bridge.elements() : nullptr) {
    const bool frozen = elements->frozen(&source) || !bridge.fieldsWritable(source);
    if (!key.isSymbol() && key.text() == "length") {
      out = PropertyDescriptor::assignment(Value::box(Value::Tag::Number, static_cast<double>(elements->length(&source))));
      out.enumerable = out.configurable = false;
      out.writable = !frozen && (elements->writableLength == nullptr || elements->writableLength(&source));
      return true;
    }
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index) && elements->ownDescriptor != nullptr) return elements->ownDescriptor(&source, index, out);
  }
  return recordOwnDescriptor(source, bridge, key, out);
}

/** `nativeOwnPropertyDescriptor` of a shared-record type. */
[[gnu::noinline]] inline bool recordOwnDescriptor(const Ref<void>& source, const NativeRecordDocumentBridge& bridge, const PropertyKey& key,
                                                  PropertyDescriptor& out) {
  if (!source) return false;
  Optional<PropertyDescriptor> original;
  if (record::ownNativeViewDescriptor(source, key, original)) {
    if (!original.has_value()) return false;
    out = *original;
    return true;
  }
  if (bridge.ownFieldDescriptor) {
    PropertyDescriptor descriptor;
    if (bridge.ownFieldDescriptor(source, key, descriptor)) {
      if (!bridge.fieldsWritable(source)) descriptor.writable = false;
      out = descriptor;
      return true;
    }
  }
  if (bridge.wholeOwnFieldProtocol && bridge.matchesOwnField(source, key)) return false;
  if (bridge.fieldTable) {
    Value found;
    if (bridge.readOwnField(source, key, found)) {
      out = PropertyDescriptor::assignment(found);
      out.configurable = false;
      out.writable = bridge.fieldsWritable(source);
      return true;
    }
    if (bridge.indexFieldTable) {
      PropertyDescriptor descriptor;
      if (bridge.ownIndexDescriptor(source, key, descriptor)) {
        out = descriptor;
        return true;
      }
      if (bridge.matchesOwnIndex(source, key)) return false;
    }
  }
  const Ref<DynamicObject> expando = expandoFor(source, false);
  const PropertyDescriptor* descriptor = expando ? expando->ownProperty(key) : nullptr;
  if (descriptor == nullptr) return false;
  out = *descriptor;
  return true;
}

[[gnu::noinline]] inline std::vector<PropertyKey> recordDocumentOwnKeys(const Ref<void>& source, const NativeRecordDocumentBridge& bridge) {
  std::vector<PropertyKey> keys;
  if (!source) return keys;
  if (record::ownNativeViewKeys(source, keys, false)) return keys;
  keys.reserve(16);
  if (bridge.ownFieldKeys) bridge.ownFieldKeys(source, keys);
  if (const Ref<DynamicObject> expando = expandoFor(source, false)) {
    const std::size_t layout = keys.size();
    for (const PropertyKey& key : expando->ownKeys()) {
      if (std::find(keys.begin(), keys.begin() + static_cast<std::ptrdiff_t>(layout), key) == keys.begin() + static_cast<std::ptrdiff_t>(layout))
        keys.push_back(key);
    }
  }
  return nativeOwnKeysInCreationOrder(source.get(), std::move(keys));
}

[[gnu::noinline]] inline std::vector<PropertyKey> recordDocumentKeys(const Ref<void>& source, const NativeRecordDocumentBridge& bridge) {
  auto keys = recordDocumentOwnKeys(source, bridge);
  if (const auto* elements = bridge.elements ? bridge.elements() : nullptr) {
    auto properties = std::move(keys);
    keys.clear();
    for (std::size_t index = 0; index < elements->length(&source); ++index) {
      if (!recordDocumentHas(source, bridge, PropertyKey::string(std::to_string(index)), true)) continue;
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

[[gnu::noinline]] inline bool recordDocumentSet(const Ref<void>& source, const NativeRecordDocumentBridge& bridge, const PropertyKey& key,
                                                const Value& value) {
  if (const auto* elements = bridge.elements ? bridge.elements() : nullptr) {
    auto mutableSource = source;
    if (elements->frozen(&source) || !bridge.fieldsWritable(source)) return false;
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
  if (const auto* fields = bridge.fields()) {
    auto* payload = const_cast<Ref<void>*>(&source);
    if (fields->matchesField(&source, key))
      return bridge.fieldsWritable(source) && fields->write(payload, key, value, bridge.extensible(source));
    if (fields->matchesIndex(&source, key)) return fields->writeIndex(payload, key, value, bridge.extensible(source));
  }
  const auto receiver = bridge.receiver(source);
  const auto existing = expandoFor(source, false);
  if (existing && existing->ownProperty(key) != nullptr) return existing->setWithNativeReceiver(key, value, receiver);
  if (bridge.setPrototypePropertyNative) {
    const auto accepted = bridge.setPrototypePropertyNative(source, key, value, receiver);
    if (accepted != NativePrototypeOps::SetResult::Absent) return accepted == NativePrototypeOps::SetResult::Accepted;
  } else if (bridge.prototypeTable) {
    if (bridge.hasPrototypeProperty(source, key))
      host::throwRuntimeError("TypeError", "a native Document prototype setter has no native receiver protocol");
  }
  if (!bridge.extensible(source)) return false;
  if (!expandoFor(source, true)->setWithNativeReceiver(key, value, receiver)) return false;
  bridge.keyCreated(source, key);
  return true;
}

[[gnu::noinline]] inline bool recordDocumentDefine(const Ref<void>& source, const NativeRecordDocumentBridge& bridge, const PropertyKey& key,
                                                   const PropertyDescriptor& descriptor) {
  if (const auto* elements = bridge.elements ? bridge.elements() : nullptr) {
    auto mutableSource = source;
    if (!key.isSymbol() && key.text() == "length")
      return elements->defineLength != nullptr && elements->defineLength(&mutableSource, descriptor);
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) return elements->define != nullptr && elements->define(&mutableSource, index, descriptor);
  }
  return recordDynamicDefine(source, bridge, key, descriptor);
}

/** `nativeDynamicDefineProperty` of a shared-record type. */
[[gnu::noinline]] inline bool recordDynamicDefine(const Ref<void>& source, const NativeRecordDocumentBridge& bridge, const PropertyKey& key,
                                                  const PropertyDescriptor& descriptor) {
  if (!source) return false;
  if (record::immutableDescriptorSnapshotView(source))
    host::throwRuntimeError("TypeError", "a native descriptor snapshot definition has no certified source protocol");
  if (const auto defined = record::defineDocumentView(source, key, descriptor)) return *defined;
  if (bridge.fieldTable) {
    if (bridge.wholeOwnFieldProtocol) {
      if (bridge.matchesOwnField(source, key)) return bridge.defineOwnField(source, key, descriptor, bridge.extensible(source));
    } else {
      Value fixed;
      if (bridge.readOwnField(source, key, fixed)) return false;
    }
    if (bridge.indexFieldTable && bridge.matchesOwnIndex(source, key))
      return bridge.defineOwnIndex(source, key, descriptor, bridge.extensible(source));
  }
  const Ref<DynamicObject> existing = expandoFor(source, false);
  if (existing && existing->ownProperty(key) != nullptr) return existing->defineOwnProperty(key, descriptor);
  if (!bridge.extensible(source)) return false;
  if (!expandoFor(source, true)->defineOwnProperty(key, descriptor)) return false;
  bridge.keyCreated(source, key);
  return true;
}

[[gnu::noinline]] inline bool recordDocumentDelete(const Ref<void>& source, const NativeRecordDocumentBridge& bridge, const PropertyKey& key) {
  if (!source) return true;
  if (record::immutableDescriptorSnapshotView(source))
    host::throwRuntimeError("TypeError", "a native descriptor snapshot deletion has no certified source protocol");
  if (const auto* document = record::documentViewRoute(source)) return document->document->remove(document->held, key);
  if (bridge.deleteOwnField) {
    if (bridge.matchesOwnField(source, key)) {
      if (!bridge.deleteOwnField(source, key)) return false;
      forgetNativeOwnKey(source.get(), key);
      return true;
    }
  } else if (bridge.fieldTable) {
    Value probe;
    if (bridge.readOwnField(source, key, probe)) return false;
  }
  if (bridge.deleteOwnIndex && bridge.matchesOwnIndex(source, key)) return bridge.deleteOwnIndex(source, key);
  const Ref<DynamicObject> expando = expandoFor(source, false);
  return expando ? expando->deleteOwnProperty(key) : true;
}

[[gnu::noinline]] inline bool recordDocumentEnumerable(const Ref<void>& source, const NativeRecordDocumentBridge& bridge,
                                                       const PropertyKey& key) {
  if (bridge.elements) {
    if (!key.isSymbol() && key.text() == "length") return false;
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) {
      PropertyDescriptor descriptor;
      const auto* elements = bridge.elements();
      return elements && elements->ownDescriptor && elements->ownDescriptor(&source, index, descriptor) && descriptor.enumerable;
    }
  }
  if (bridge.ownFieldEnumerable) {
    bool enumerable = false;
    if (bridge.ownFieldEnumerable(source, key, enumerable)) return enumerable;
  }
  if (bridge.ownIndexEnumerable) {
    bool enumerable = false;
    if (bridge.ownIndexEnumerable(source, key, enumerable)) return enumerable;
  }
  const auto overlay = expandoFor(source, false);
  const auto* descriptor = overlay ? overlay->ownProperty(key) : nullptr;
  if (descriptor) return descriptor->enumerable;
  if (recordDocumentHas(source, bridge, key, true))
    host::throwRuntimeError("TypeError", "a native Document field has no enumerability-only protocol");
  return false;
}

[[gnu::noinline]] inline std::optional<bool> recordDocumentReadNative(const Ref<void>& source, const NativeRecordDocumentBridge& bridge,
                                                                      const PropertyKey& key, const NativeFieldRead& read) {
  if (record::hasLiveFieldView(source)) return record::readFieldView(source, key, read);
  if (const auto* elements = bridge.elements ? bridge.elements() : nullptr) {
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) {
      PropertyDescriptor descriptor;
      if (elements->ownDescriptor == nullptr || !elements->ownDescriptor(&source, index, descriptor)) return std::nullopt;
      if (!descriptor.isAccessor()) return descriptor.nativeValue ? std::optional<bool>(descriptor.nativeValue.read(read)) : std::nullopt;
      if (descriptor.nativeGet && descriptor.nativeGet.read != nullptr) return descriptor.nativeGet.readNative(bridge.receiver(source), read);
      return std::nullopt;
    }
  }
  auto mutableRead = read;
  if (bridge.readOwnFieldNative && bridge.matchesOwnField(source, key)) {
    bool present = true;
    if (bridge.ownFieldPresent && bridge.ownFieldPresent(source, key, present) && !present) return std::nullopt;
    return bridge.readOwnFieldNative(source, key, mutableRead);
  }
  if (bridge.readOwnIndexNative && bridge.matchesOwnIndex(source, key)) {
    bool present = true;
    if (bridge.ownIndexPresent && bridge.ownIndexPresent(source, key, present) && !present) return std::nullopt;
    return bridge.readOwnIndexNative(source, key, mutableRead);
  }
  const auto sidecar = expandoFor(source, false);
  return sidecar ? readDocumentNativeObject(sidecar, key, bridge.receiver(source), read) : std::nullopt;
}

[[gnu::noinline]] inline bool recordDocumentSetNative(const Ref<void>& source, const NativeRecordDocumentBridge& bridge, const PropertyKey& key,
                                                      const NativeDescriptorData& value, const NativeFieldWrite& written) {
  if (record::hasLiveFieldView(source)) return record::writeFieldView(source, key, written);
  if (const auto* elements = bridge.elements ? bridge.elements() : nullptr) {
    std::size_t index = 0;
    if (arrayIndexOfKey(key, index)) {
      if (elements->frozen(&source) || !bridge.fieldsWritable(source)) return false;
      PropertyDescriptor current;
      const bool present = elements->ownDescriptor && elements->ownDescriptor(&source, index, current);
      if (present && current.isAccessor()) {
        if (!current.hasSet) return false;
        const auto receiver = bridge.receiver(source);
        if (current.nativeSet && current.nativeSet.write) return current.nativeSet.writeNative(receiver, written);
        if (current.nativeSet && current.nativeSet.dynamicWrite) {
          current.nativeSet.observeWrite(receiver, value.materialize());
          return true;
        }
        if (!current.set) return false;
        current.set(receiver.dynamicValue(), value.materialize());
        return true;
      }
      if (present && !current.writable) return false;
      // A tuple's lane is its declared slot: `requireNativeEntryFitsArrayLane`
      // checks only an `ArrayObject`'s element lane.
      auto descriptor = present ? PropertyDescriptor{} : PropertyDescriptor::assignment(Value{});
      descriptor.hasValue = true;
      descriptor.nativeValue = value;
      auto mutableSource = source;
      return elements->define && elements->define(&mutableSource, index, descriptor);
    }
    if (!key.isSymbol() && key.text() == "length")
      host::throwRuntimeError("TypeError", "a native Document length assignment needs a numeric entry writer");
  }
  if (bridge.writeOwnFieldNative && bridge.matchesOwnField(source, key))
    return bridge.fieldsWritable(source) && bridge.writeOwnFieldNative(source, key, written, bridge.extensible(source));
  if (bridge.writeOwnIndexNative && bridge.matchesOwnIndex(source, key))
    return bridge.writeOwnIndexNative(source, key, written, bridge.extensible(source));
  const auto* fields = bridge.fields();
  if (fields && (fields->matchesField(&source, key) || fields->matchesIndex(&source, key)))
    host::throwRuntimeError("TypeError", "a Document native entry has no selected physical field writer");
  const auto receiver = bridge.receiver(source);
  const auto existing = expandoFor(source, false);
  if (existing && existing->ownProperty(key)) return existing->setNativeDescriptorWithNativeReceiver(key, value, written, receiver);
  if (bridge.setPrototypePropertyFieldNative) {
    const auto accepted = bridge.setPrototypePropertyFieldNative(source, key, written, receiver);
    if (accepted != NativePrototypeOps::SetResult::Absent) return accepted == NativePrototypeOps::SetResult::Accepted;
  } else if (bridge.prototypeTable) {
    if (bridge.hasPrototypeProperty(source, key)) host::throwRuntimeError("TypeError", "a Document native entry has no selected prototype setter");
  }
  if (!bridge.extensible(source)) return false;
  const auto overlay = existing ? existing : expandoFor(source, true);
  if (!overlay->setNativeDescriptorWithNativeReceiver(key, value, written, receiver)) return false;
  if (overlay->ownProperty(key)) bridge.keyCreated(source, key);
  return true;
}

/** `nativeDynamicHas` of a shared-record type. */
[[gnu::noinline]] inline bool recordDynamicHas(const Ref<void>& source, const NativeRecordDocumentBridge& bridge, const PropertyKey& key) {
  if (!source) return false;
  if (record::hasLiveFieldView(source)) return record::hasOwnFieldView(source, key);
  if (bridge.ownFieldPresent) {
    bool present = false;
    if (bridge.ownFieldPresent(source, key, present)) return present;
  }
  if (bridge.ownIndexPresent) {
    bool present = false;
    if (bridge.ownIndexPresent(source, key, present)) return present;
  }
  Value probe;
  if (bridge.fieldTable) {
    if (bridge.readOwnField(source, key, probe)) return true;
    if (bridge.wholeOwnFieldProtocol && bridge.matchesOwnField(source, key)) return false;
    if (bridge.indexFieldTable) {
      if (bridge.readOwnIndex(source, key, probe)) return true;
      if (bridge.matchesOwnIndex(source, key)) return false;
    }
  }
  const Ref<DynamicObject> expando = expandoFor(source, false);
  return expando ? expando->hasProperty(key) : false;
}

/** `nativeEnumerableStringKeys` of a shared-record type. */
[[gnu::noinline]] inline std::vector<PropertyKey> recordEnumerableStringKeys(const Ref<void>& source, const NativeRecordDocumentBridge& bridge) {
  std::vector<PropertyKey> original;
  if (record::ownNativeViewKeys(source, original, true)) return original;
  std::vector<PropertyKey> keys = recordDocumentOwnKeys(source, bridge);
  std::size_t kept = 0;
  for (std::size_t at = 0; at < keys.size(); ++at) {
    const PropertyKey& key = keys[at];
    if (key.isSymbol()) continue;
    bool enumerable = false;
    bool known = false;
    if (bridge.ownFieldEnumerable) known = bridge.ownFieldEnumerable(source, key, enumerable);
    if (!known && bridge.ownIndexEnumerable) known = bridge.ownIndexEnumerable(source, key, enumerable);
    if (!known) {
      PropertyDescriptor descriptor;
      enumerable = recordOwnDescriptor(source, bridge, key, descriptor) && descriptor.enumerable;
    }
    if (!enumerable) continue;
    if (kept != at) keys[kept] = std::move(keys[at]);
    ++kept;
  }
  keys.erase(keys.begin() + static_cast<std::ptrdiff_t>(kept), keys.end());
  return keys;
}

template <typename T>
const Ref<T>& recordDocumentHandle(const Ref<void>& source) {
  return *static_cast<const Ref<T>*>(static_cast<const void*>(&source));
}

template <typename T>
inline constexpr NativeRecordDocumentBridge recordDocumentBridge{
    [](const Ref<void>& source) { return nativeOwnFieldsWritable(recordDocumentHandle<T>(source)); },
    [](const Ref<void>& source) { return nativeIsExtensible(recordDocumentHandle<T>(source)); },
    [](const Ref<void>& source) { return NativeCallReceiver::object(recordDocumentHandle<T>(source)); },
    [](const Ref<void>& source, const PropertyKey& key) { noteNativeExpandoKeyCreated(recordDocumentHandle<T>(source), key); },
    &nativeFieldOpsFor<Ref<T>>,
    IsArrayPayload<Ref<T>>::value ? &nativeArrayOpsFor<Ref<T>> : nullptr,
    NativeFieldTable<T>,
    NativeFieldTable<T> && NativeIndexFieldTable<T>,
    wholeNativeOwnFieldProtocol<T>(),
    NativePrototypeTable<T>,
    NativeOwnFieldPredicate<T>,
    [] {
      if constexpr (NativeOwnFieldPresenceTable<T>)
        return +[](const Ref<void>& source, const PropertyKey& key, bool& present) {
          return recordDocumentHandle<T>(source)->gea_ownFieldPresent(key, present);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, bool&)>(nullptr);
    }(),
    [] {
      if constexpr (NativeOwnIndexPresenceTable<T>)
        return +[](const Ref<void>& source, const PropertyKey& key, bool& present) {
          return recordDocumentHandle<T>(source)->gea_ownIndexPresent(key, present);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, bool&)>(nullptr);
    }(),
    [] {
      if constexpr (NativeOwnFieldEnumerableTable<T>)
        return +[](const Ref<void>& source, const PropertyKey& key, bool& enumerable) {
          return recordDocumentHandle<T>(source)->gea_ownFieldEnumerable(key, enumerable);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, bool&)>(nullptr);
    }(),
    [] {
      if constexpr (NativeOwnIndexEnumerableTable<T>)
        return +[](const Ref<void>& source, const PropertyKey& key, bool& enumerable) {
          return recordDocumentHandle<T>(source)->gea_ownIndexEnumerable(key, enumerable);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, bool&)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& reader, const PropertyKey& key) { reader.gea_matchesOwnField(key); })
        return +[](const Ref<void>& source, const PropertyKey& key) { return recordDocumentHandle<T>(source)->gea_matchesOwnField(key); };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& reader, const PropertyKey& key) { reader.gea_matchesOwnIndex(key); })
        return +[](const Ref<void>& source, const PropertyKey& key) { return recordDocumentHandle<T>(source)->gea_matchesOwnIndex(key); };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&)>(nullptr);
    }(),
    [] {
      if constexpr (NativeFieldTable<T>)
        return +[](const Ref<void>& source, const PropertyKey& key, Value& out) {
          return recordDocumentHandle<T>(source)->gea_readOwnField(key, out);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, Value&)>(nullptr);
    }(),
    [] {
      if constexpr (NativeFieldTable<T> && NativeIndexFieldTable<T>)
        return +[](const Ref<void>& source, const PropertyKey& key, Value& out) {
          return recordDocumentHandle<T>(source)->gea_readOwnIndex(key, out);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, Value&)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& reader, const PropertyKey& key, PropertyDescriptor& descriptor) {
                      reader.gea_ownFieldDescriptor(key, descriptor);
                    })
        return +[](const Ref<void>& source, const PropertyKey& key, PropertyDescriptor& out) {
          return recordDocumentHandle<T>(source)->gea_ownFieldDescriptor(key, out);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, PropertyDescriptor&)>(nullptr);
    }(),
    [] {
      if constexpr (NativeFieldTable<T> && NativeIndexFieldTable<T>)
        return +[](const Ref<void>& source, const PropertyKey& key, PropertyDescriptor& out) {
          return recordDocumentHandle<T>(source)->gea_ownIndexDescriptor(key, out);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, PropertyDescriptor&)>(nullptr);
    }(),
    [] {
      if constexpr (NativeOwnKeysTable<T>)
        return +[](const Ref<void>& source, std::vector<PropertyKey>& keys) { recordDocumentHandle<T>(source)->gea_ownFieldKeys(keys); };
      else return static_cast<void (*)(const Ref<void>&, std::vector<PropertyKey>&)>(nullptr);
    }(),
    [] {
      if constexpr (NativeFieldTable<T> && wholeNativeOwnFieldProtocol<T>())
        return +[](const Ref<void>& source, const PropertyKey& key, const PropertyDescriptor& descriptor, bool extensible) {
          return nativeDefineOwnField(*recordDocumentHandle<T>(source), key, descriptor, extensible, source);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, const PropertyDescriptor&, bool)>(nullptr);
    }(),
    [] {
      if constexpr (NativeFieldTable<T> && NativeIndexFieldTable<T>)
        return +[](const Ref<void>& source, const PropertyKey& key, const PropertyDescriptor& descriptor, bool extensible) {
          return recordDocumentHandle<T>(source)->gea_defineOwnIndex(key, descriptor, extensible);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, const PropertyDescriptor&, bool)>(nullptr);
    }(),
    [] {
      if constexpr (NativeOwnFieldPredicate<T> && NativeOwnFieldDeletion<T>)
        return +[](const Ref<void>& source, const PropertyKey& key) { return recordDocumentHandle<T>(source)->gea_deleteOwnField(key); };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& writer, const PropertyKey& key) {
                      writer.gea_matchesOwnIndex(key);
                      writer.gea_deleteOwnIndex(key);
                    })
        return +[](const Ref<void>& source, const PropertyKey& key) { return recordDocumentHandle<T>(source)->gea_deleteOwnIndex(key); };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& reader, const PropertyKey& key, NativeFieldRead& read) {
                      reader.gea_matchesOwnField(key);
                      reader.gea_readOwnFieldNative(key, read);
                    })
        return +[](const Ref<void>& source, const PropertyKey& key, NativeFieldRead& read) {
          return recordDocumentHandle<T>(source)->gea_readOwnFieldNative(key, read);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, NativeFieldRead&)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& reader, const PropertyKey& key, NativeFieldRead& read) {
                      reader.gea_matchesOwnIndex(key);
                      reader.gea_readOwnIndexNative(key, read);
                    })
        return +[](const Ref<void>& source, const PropertyKey& key, NativeFieldRead& read) {
          return recordDocumentHandle<T>(source)->gea_readOwnIndexNative(key, read);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, NativeFieldRead&)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& writer, const PropertyKey& key, const NativeFieldWrite& written) {
                      writer.gea_matchesOwnField(key);
                      writer.gea_writeOwnFieldNative(key, written, true);
                    })
        return +[](const Ref<void>& source, const PropertyKey& key, const NativeFieldWrite& written, bool extensible) {
          return recordDocumentHandle<T>(source)->gea_writeOwnFieldNative(key, written, extensible);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, const NativeFieldWrite&, bool)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& writer, const PropertyKey& key, const NativeFieldWrite& written) {
                      writer.gea_matchesOwnIndex(key);
                      writer.gea_writeOwnIndexNative(key, written, true);
                    })
        return +[](const Ref<void>& source, const PropertyKey& key, const NativeFieldWrite& written, bool extensible) {
          return recordDocumentHandle<T>(source)->gea_writeOwnIndexNative(key, written, extensible);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, const NativeFieldWrite&, bool)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& reader, const PropertyKey& key, Value& out) { reader.gea_readPrototypeProperty(key, out); })
        return +[](const Ref<void>& source, const PropertyKey& key, Value& out) {
          return recordDocumentHandle<T>(source)->gea_readPrototypeProperty(key, out);
        };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&, Value&)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& reader, const PropertyKey& key) { reader.gea_hasPrototypeProperty(key); })
        return +[](const Ref<void>& source, const PropertyKey& key) { return recordDocumentHandle<T>(source)->gea_hasPrototypeProperty(key); };
      else return static_cast<bool (*)(const Ref<void>&, const PropertyKey&)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& writer, const PropertyKey& key, const Value& value, const NativeCallReceiver& receiver) {
                      writer.gea_setPrototypePropertyNative(key, value, receiver);
                    })
        return +[](const Ref<void>& source, const PropertyKey& key, const Value& value, const NativeCallReceiver& receiver) {
          return recordDocumentHandle<T>(source)->gea_setPrototypePropertyNative(key, value, receiver);
        };
      else return static_cast<NativePrototypeOps::SetResult (*)(const Ref<void>&, const PropertyKey&, const Value&, const NativeCallReceiver&)>(nullptr);
    }(),
    [] {
      if constexpr (requires(T& writer, const PropertyKey& key, const NativeFieldWrite& written, const NativeCallReceiver& receiver) {
                      writer.gea_setPrototypePropertyFieldNative(key, written, receiver);
                    })
        return +[](const Ref<void>& source, const PropertyKey& key, const NativeFieldWrite& written, const NativeCallReceiver& receiver) {
          return recordDocumentHandle<T>(source)->gea_setPrototypePropertyFieldNative(key, written, receiver);
        };
      else return static_cast<NativePrototypeOps::SetResult (*)(const Ref<void>&, const PropertyKey&, const NativeFieldWrite&,
                                                                const NativeCallReceiver&)>(nullptr);
    }()};

template <typename T>
const NativeRecordDocumentBridge& recordDocumentBridgeOf() {
  return recordDocumentBridge<T>;
}

template <typename T>
const NativeDocumentOps* nativeRecordDocumentOpsFor() {
  static const NativeDocumentOps operations{
      +[](const Ref<void>& source, const PropertyKey& key, Value& out) { return recordDocumentRead(source, recordDocumentBridge<T>, key, out); },
      +[](const Ref<void>& source, const PropertyKey& key, const Value& value) {
        return recordDocumentSet(source, recordDocumentBridge<T>, key, value);
      },
      +[](const Ref<void>& source, const PropertyKey& key, PropertyDescriptor& out) {
        return recordDocumentDescriptor(source, recordDocumentBridge<T>, key, out);
      },
      +[](const Ref<void>& source, const PropertyKey& key, const PropertyDescriptor& descriptor) {
        return recordDocumentDefine(source, recordDocumentBridge<T>, key, descriptor);
      },
      +[](const Ref<void>& source, const PropertyKey& key) { return recordDocumentDelete(source, recordDocumentBridge<T>, key); },
      +[](const Ref<void>& source, const PropertyKey& key, bool own) { return recordDocumentHas(source, recordDocumentBridge<T>, key, own); },
      +[](const Ref<void>& source) { return recordDocumentKeys(source, recordDocumentBridge<T>); },
      +[](const Ref<void>& source, const PropertyKey& key) { return recordDocumentEnumerable(source, recordDocumentBridge<T>, key); },
      +[](const Ref<void>& source) { return Value::box(Value::Tag::Object, source.template staticCast<T>()); },
      payloadTypeTagFor<Ref<T>>(), IsArrayPayload<Ref<T>>::value, false, nullptr,
      +[](const Ref<void>& source, const PropertyKey& key, const NativeFieldRead& read) {
        return recordDocumentReadNative(source, recordDocumentBridge<T>, key, read);
      },
      +[](const Ref<void>& source, const PropertyKey& key, const NativeDescriptorData& value, const NativeFieldWrite& written) {
        return recordDocumentSetNative(source, recordDocumentBridge<T>, key, value, written);
      }};
  return &operations;
}

template <typename T>
const NativeDocumentOps* nativeDocumentOpsFor() {
  if constexpr (std::is_void_v<T> || refStandalone<T>) return nullptr;
  else if constexpr (IsArrayObjectStruct<T>::value) return nativeArrayDocumentOpsFor<T>();
  else if constexpr (sharedRecordDocument<T>) return nativeRecordDocumentOpsFor<T>();
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
