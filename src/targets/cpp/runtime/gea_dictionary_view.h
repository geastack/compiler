// SPDX-License-Identifier: Apache-2.0
#ifndef GEA_DICTIONARY_VIEW_H
#define GEA_DICTIONARY_VIEW_H

namespace gea::detail {

/**
 * A view read of a key the viewed object does not have. The source table's
 * own missing read cannot answer it: its value-initialized entry would pass
 * through the entry reader as a present value. A carrier that spells
 * `undefined` answers it; any other carrier has no value for the missing
 * property and the read is a TypeError, never a zero or an empty string.
 */
template <typename V>
V absentViewEntry() {
  if constexpr (std::is_same_v<V, Value>) return Value();
  else if constexpr (is_optional_v<V>) return V();
  else if constexpr (IsRefPayload<V>::value) return V::undefined();
  else host::throwRuntimeError("TypeError", "a dictionary view has no entry for this key and its entry carrier has no absence");
}

/** Retains the original native allocation; only entry values cross an adapter. */
template <typename V, typename Source, typename Read>
class ReadingDictionarySource : public DictionaryViewSource<V> {
 public:
  ReadingDictionarySource(Ref<Source> source, Read read) : source_(std::move(source)), read_(std::move(read)) {
    static_assert(std::is_empty_v<Read>, "dictionary entry recipes must not retain untraced capture environments");
  }
  V read(std::string_view key) const override { return source_->has(key) ? read_(source_->read(key)) : absentViewEntry<V>(); }
  bool has(std::string_view key, bool own) const override { return own ? source_->hasOwn(key) : source_->has(key); }
  void attributes(const std::string& key, bool& writable, bool& enumerable, bool& configurable) const override {
    const auto attributes = source_->attributesOf(key);
    writable = attributes.writable;
    enumerable = attributes.enumerable;
    configurable = attributes.configurable;
  }
  std::vector<std::string> keys(bool enumerableOnly, bool creationOrder) const override {
    if (!creationOrder) return enumerableOnly ? source_->enumerableKeys() : source_->propertyKeys();
    std::vector<std::string> keys = source_->creationKeys();
    if (enumerableOnly) {
      keys.erase(std::remove_if(keys.begin(), keys.end(), [&](const std::string& key) {
        return !source_->attributesOf(key).enumerable;
      }), keys.end());
    }
    return keys;
  }
  const void* identity() const override { return source_->identity(); }
  Ref<void> anchor() const override {
    const Ref<void> origin = source_->viewAnchor();
    return origin ? origin : source_.template staticCast<void>();
  }
  void trace(RefVisitor& visitor) const override { traceRefs(source_, visitor); }
  const NativeDocumentOwner* nativeOwner() const override { return source_->nativeOwner(); }
  // The original object is the source's own original when the source is
  // itself a view, and otherwise the source table: boxing that handle keeps
  // its native storage and identity, so dynamic operations land in it.
  Value dynamicValue() const override {
    Value original;
    if (source_->dynamicViewValue(original)) return original;
    return DynamicCarrier<Ref<Source>>::out(source_);
  }

 protected:
  Ref<Source> source_;
 private:
  Read read_;
};

template <typename V, typename Source, typename Read, typename Write>
class WritingDictionarySource final : public ReadingDictionarySource<V, Source, Read> {
 public:
  WritingDictionarySource(Ref<Source> source, Read read, Write write)
      : ReadingDictionarySource<V, Source, Read>(std::move(source), std::move(read)), write_(std::move(write)) {
    static_assert(std::is_empty_v<Write>, "dictionary entry recipes must not retain untraced capture environments");
  }
  bool set(const std::string& key, const V& value) const override { return this->source_->setProperty(key, write_(value)); }
  bool define(const std::string& key, const V& value, std::optional<bool> writable, std::optional<bool> enumerable,
              std::optional<bool> configurable) const override {
    return this->source_->definePropertyFrom(key, write_(value), writable, enumerable, configurable);
  }
  bool remove(const std::string& key) const override { return this->source_->deleteProperty(key); }
  void erase(const std::string& key) const override { this->source_->erase(key); }
 private:
  Write write_;
};

template <typename T>
struct IsNativeDictionaryTable : std::false_type {};
template <typename V>
struct IsNativeDictionaryTable<Dictionary<V>> : std::true_type {};
template <typename V>
struct IsNativeDictionaryTable<NumericDictionary<V>> : std::true_type {};

}  // namespace gea::detail

namespace gea {
template <typename V>
bool Dictionary<V>::dynamicViewValue(Value& out) const {
  if (!view_) return false;
  out = view_->dynamicValue();
  return true;
}
}  // namespace gea

namespace gea::dictionary {

/** A future entry mismatch is a program-visible checked view failure. */
template <typename Target>
Ref<Target> checkedClassEntry(const Value& value) {
  if (value.tag() == Value::Tag::Undefined) return Ref<Target>::undefined();
  if (value.tag() == Value::Tag::Null) return Ref<Target>();
  const auto* target = &detail::RefOperationsFor<Target>::table;
  if (value.tag() != Value::Tag::Object || !value.classObject() ||
      (!detail::classIdentityExtends(value.classIdentity(), target) && value.classIdentity() != &detail::PlainObjectOperationsFor<Target>::table))
    host::throwRuntimeError("TypeError", "dictionary entry is not the declared native class");
  return value.classObject().template staticCast<Target>();
}

template <typename Target, typename Source, typename Read, typename Write>
Ref<Target> nativeView(const Ref<Source>& source, Read read, Write write);

template <typename Target>
struct TypedDictionaryEntry : std::false_type {};
template <typename V>
struct TypedDictionaryEntry<Ref<Dictionary<V>>> : std::bool_constant<!std::is_same_v<V, Value> && detail::DynamicCarrier<V>::supported> {
  using Element = V;
};

template <typename Target>
Target checkedPayloadEntry(const Value& value, Value::Tag expected) {
  // An open Document entry (what `JSON.parse` builds for an object) read as a
  // typed `Record<string, V>` is that Document, viewed: each entry is checked
  // as a V when it is read and every write lands in the original table, so
  // the read stays live -- never a copy of its entries.
  if constexpr (TypedDictionaryEntry<Target>::value) {
    using V = typename TypedDictionaryEntry<Target>::Element;
    if (expected == Value::Tag::Object && value.tag() == Value::Tag::Object &&
        value.payloadType() == detail::payloadTypeTagFor<Ref<Dictionary<Value>>>())
      return nativeView<Dictionary<V>>(
          value.as<Ref<Dictionary<Value>>>(),
          [](const Value& entry) -> V {
            if (!detail::DynamicCarrier<V>::accepts(entry))
              host::throwRuntimeError("TypeError", "dictionary entry is not the declared native payload");
            return detail::DynamicCarrier<V>::in(entry, 0);
          },
          [](const V& entry) -> Value { return detail::DynamicCarrier<V>::out(entry); });
  }
  // An object entry read as an open `Document` is that object, viewed --
  // the same rule `unboxValue` applies to every dynamic -> Document load.
  if constexpr (std::is_same_v<Target, Ref<Dictionary<Value>>>) {
    if (expected == Value::Tag::Object && value.isNativeFieldPayload() && value.payloadType() != detail::payloadTypeTagFor<Target>())
      return aliasOf(value);
  }
  if (value.tag() != expected || value.payloadType() != detail::payloadTypeTagFor<Target>())
    host::throwRuntimeError("TypeError", "dictionary entry is not the declared native payload");
  if constexpr (std::is_same_v<Target, std::string>) return detail::duplicateString(value.as<Target>());
  else return Target(value.as<Target>());
}

/** Every legal target write is widened into the same source table. */
template <typename Target, typename Source, typename Read, typename Write>
Ref<Target> nativeView(const Ref<Source>& source, Read read, Write write) {
  static_assert(detail::IsNativeDictionaryTable<Target>::value && detail::IsNativeDictionaryTable<Source>::value);
  if (source.isUndefined()) return Ref<Target>::undefined();
  if (!source) return Ref<Target>();
  using V = typename Target::value_type;
  return makeRef<Target>(std::make_shared<const detail::WritingDictionarySource<V, Source, Read, Write>>(
      source, std::move(read), std::move(write)));
}

/** Admission additionally requires a closed SSA-use proof; this object exposes no writer. */
template <typename Target, typename Source, typename Read>
Ref<Target> nativeReadOnlyView(const Ref<Source>& source, Read read) {
  static_assert(detail::IsNativeDictionaryTable<Target>::value && detail::IsNativeDictionaryTable<Source>::value);
  if (source.isUndefined()) return Ref<Target>::undefined();
  if (!source) return Ref<Target>();
  using V = typename Target::value_type;
  return makeRef<Target>(std::make_shared<const detail::ReadingDictionarySource<V, Source, Read>>(source, std::move(read)));
}

}  // namespace gea::dictionary

namespace gea {

template <typename V, typename W>
bool operator==(const Ref<Dictionary<V>>& left, const Ref<Dictionary<W>>& right) {
  if (left.isUndefined() || right.isUndefined()) return left.isUndefined() && right.isUndefined();
  if (!left || !right) return !left && !right;
  return left->identity() == right->identity();
}
template <typename V, typename W>
bool operator!=(const Ref<Dictionary<V>>& left, const Ref<Dictionary<W>>& right) { return !(left == right); }
template <typename V, typename W>
bool operator==(const Ref<NumericDictionary<V>>& left, const Ref<NumericDictionary<W>>& right) {
  if (left.isUndefined() || right.isUndefined()) return left.isUndefined() && right.isUndefined();
  if (!left || !right) return !left && !right;
  return left->identity() == right->identity();
}
template <typename V, typename W>
bool operator!=(const Ref<NumericDictionary<V>>& left, const Ref<NumericDictionary<W>>& right) { return !(left == right); }

}  // namespace gea

#endif  // GEA_DICTIONARY_VIEW_H
