#include "gea_runtime.h"

#include <cassert>
#include <string>
#include <vector>

struct NativeSymbolRecord {
  std::string label = "native";
  gea::Symbol fixed;
  double fixedValue = 99;
  gea::SymbolDictionary<gea::Optional<double>> gea_dynamic;
  gea::NativeIndexAttributeTable<gea::Symbol> gea_dynamic_attributes;

  friend void geaTraceRefs(const NativeSymbolRecord& value, gea::detail::RefVisitor& visitor) {
    gea::detail::traceRefs(value.gea_dynamic, visitor);
  }

  bool gea_readOwnField(const gea::PropertyKey& key, gea::Value& out) const {
    if (key.isSymbol() && key.symbolId() == fixed.id()) {
      out = gea::Value::box(gea::Value::Tag::Number, fixedValue);
      return true;
    }
    if (key.isSymbol()) return false;
    if (key.text() != "label") return false;
    out = gea::Value::box(gea::Value::Tag::String, label);
    return true;
  }

  bool gea_writeOwnField(const gea::PropertyKey& key, const gea::Value& value, bool = true) {
    if (key.isSymbol() && key.symbolId() == fixed.id()) {
      fixedValue = value.as<double>();
      return true;
    }
    if (key.isSymbol()) return false;
    if (key.text() != "label") return false;
    label = value.as<std::string>();
    return true;
  }

  bool gea_ownFieldDescriptor(const gea::PropertyKey& key, gea::PropertyDescriptor& out) const {
    gea::Value value;
    if (!gea_readOwnField(key, value)) return false;
    out = gea::PropertyDescriptor::assignment(value);
    out.configurable = false;
    return true;
  }

  bool gea_readOwnIndex(const gea::PropertyKey& key, gea::Value& out) const {
    if (!key.isSymbol()) return false;
    const gea::Symbol symbol(static_cast<std::uint32_t>(key.symbolId()));
    if (!gea_dynamic.has(symbol)) return false;
    const gea::Optional<double> value = gea_dynamic.read(symbol);
    out = value.has_value() ? gea::Value::box(gea::Value::Tag::Number, *value) : gea::Value();
    return true;
  }

  bool gea_matchesOwnIndex(const gea::PropertyKey& key) const { return key.isSymbol(); }

  bool gea_writeOwnIndex(const gea::PropertyKey& key, const gea::Value& value, bool extensible) {
    if (!key.isSymbol()) return false;
    const gea::Symbol symbol(static_cast<std::uint32_t>(key.symbolId()));
    const bool exists = gea_dynamic.has(symbol);
    if ((!exists && !extensible) || (exists && !gea_dynamic_attributes.attributes(symbol).writable) ||
        !gea::detail::DynamicCarrier<gea::Optional<double>>::accepts(value)) return false;
    gea_dynamic[symbol] = gea::detail::DynamicCarrier<gea::Optional<double>>::in(value, 0);
    return true;
  }

  bool gea_ownIndexDescriptor(const gea::PropertyKey& key, gea::PropertyDescriptor& out) const {
    if (!key.isSymbol()) return false;
    const gea::Symbol symbol(static_cast<std::uint32_t>(key.symbolId()));
    if (!gea_dynamic.has(symbol)) return false;
    out = gea::PropertyDescriptor::assignment(gea::detail::DynamicCarrier<gea::Optional<double>>::out(gea_dynamic.read(symbol)));
    const gea::NativeIndexAttributes attributes = gea_dynamic_attributes.attributes(symbol);
    out.writable = attributes.writable;
    out.enumerable = attributes.enumerable;
    out.configurable = attributes.configurable;
    return true;
  }

  bool gea_defineOwnIndex(const gea::PropertyKey& key, const gea::PropertyDescriptor& descriptor, bool extensible) {
    if (!key.isSymbol()) return false;
    const gea::Symbol symbol(static_cast<std::uint32_t>(key.symbolId()));
    const bool exists = gea_dynamic.has(symbol);
    gea::PropertyDescriptor current;
    if (exists && !gea_ownIndexDescriptor(key, current)) return false;
    gea::PropertyDescriptor applied;
    if (!gea::applyNativeIndexDataDescriptor(exists, extensible, current, descriptor, applied) ||
        !gea::detail::DynamicCarrier<gea::Optional<double>>::accepts(applied.value)) return false;
    gea_dynamic[symbol] = gea::detail::DynamicCarrier<gea::Optional<double>>::in(applied.value, 0);
    gea_dynamic_attributes.set(symbol, gea::NativeIndexAttributes{applied.writable, applied.enumerable, applied.configurable});
    return true;
  }

  bool gea_deleteOwnIndex(const gea::PropertyKey& key) {
    if (!key.isSymbol()) return false;
    const gea::Symbol symbol(static_cast<std::uint32_t>(key.symbolId()));
    if (gea_dynamic.has(symbol) && !gea_dynamic_attributes.deleteAllowed(symbol)) return false;
    gea_dynamic.erase(symbol);
    gea_dynamic_attributes.erase(symbol);
    return true;
  }

  void gea_freezeOwnIndex() {
    for (const auto& entry : gea_dynamic) gea_dynamic_attributes.freeze(entry.first);
  }

  void gea_ownFieldKeys(std::vector<gea::PropertyKey>& out) const {
    out.push_back(gea::PropertyKey::string("label"));
    out.push_back(gea::PropertyKey::symbol(fixed));
    for (const auto& entry : gea_dynamic) out.push_back(gea::PropertyKey::symbol(entry.first));
  }
};

int main() {
  const gea::Symbol state = gea::makeSymbol("state");
  const gea::Symbol sameDescription = gea::makeSymbol("state");
  const gea::Symbol fixed = gea::makeSymbol("state");
  assert(state != sameDescription);
  assert(state != fixed);

  auto record = gea::makeRef<NativeSymbolRecord>();
  record->fixed = fixed;
  record->gea_dynamic[state] = 41;
  // Presence and value are independent: this is an own symbol property whose
  // value is undefined, not a missing key.
  record->gea_dynamic[sameDescription] = gea::Optional<double>();

  std::vector<gea::PropertyKey> full;
  record->gea_ownFieldKeys(full);
  assert(full.size() == 4);
  assert(!full[0].isSymbol() && full[0].text() == "label");
  assert(full[1].isSymbol() && full[1].symbolId() == fixed.id());
  assert(full[2].isSymbol() && full[2].symbolId() == state.id());
  assert(full[3].isSymbol() && full[3].symbolId() == sameDescription.id());

  const std::vector<std::string> nativeStrings = gea::nativeDynamicKeys(record);
  assert(nativeStrings == std::vector<std::string>{"label"});

  gea::Value boxed = gea::Value::box(gea::Value::Tag::Object, record);
  const std::vector<gea::PropertyKey> reflected = boxed.ownPropertyKeys();
  assert(reflected.size() == 4);
  assert(reflected[1].isSymbol() && reflected[1].symbolId() == fixed.id());
  assert(reflected[2].isSymbol() && reflected[2].symbolId() == state.id());
  assert(reflected[3].isSymbol() && reflected[3].symbolId() == sameDescription.id());
  assert(boxed.ownEnumerableStringKeys() == std::vector<std::string>{"label"});

  gea::Optional<gea::PropertyDescriptor> descriptor = gea::nativeOwnPropertyDescriptor(record, gea::PropertyKey::symbol(state));
  assert(descriptor.has_value());
  assert(descriptor->configurable && descriptor->enumerable && descriptor->writable);
  descriptor = gea::nativeOwnPropertyDescriptor(record, gea::PropertyKey::symbol(sameDescription));
  assert(descriptor.has_value() && descriptor->value.tag() == gea::Value::Tag::Undefined);
  assert(boxed.hasProperty(gea::PropertyKey::symbol(sameDescription)));
  descriptor = gea::nativeOwnPropertyDescriptor(record, gea::PropertyKey::symbol(fixed));
  assert(descriptor.has_value() && !descriptor->configurable && descriptor->enumerable && descriptor->writable);
  descriptor = gea::nativeOwnPropertyDescriptor(record, gea::PropertyKey::string("label"));
  assert(descriptor.has_value() && !descriptor->configurable && descriptor->enumerable && descriptor->writable);

  // A sealed, non-enumerable typed index entry keeps its value native while
  // its attributes remain observable and enforce mutation/deletion.
  const gea::Symbol sealed = gea::makeSymbol("sealed");
  gea::PropertyDescriptor sealedDescriptor;
  sealedDescriptor.hasValue = true;
  sealedDescriptor.value = gea::Value::box(gea::Value::Tag::Number, 7.0);
  sealedDescriptor.hasWritable = sealedDescriptor.hasEnumerable = sealedDescriptor.hasConfigurable = true;
  sealedDescriptor.writable = false;
  sealedDescriptor.enumerable = false;
  sealedDescriptor.configurable = false;
  assert(gea::nativeDynamicDefineProperty(record, gea::PropertyKey::symbol(sealed), sealedDescriptor));
  descriptor = gea::nativeOwnPropertyDescriptor(record, gea::PropertyKey::symbol(sealed));
  assert(descriptor.has_value() && descriptor->value.as<double>() == 7.0 && !descriptor->writable && !descriptor->enumerable &&
         !descriptor->configurable);
  assert(!gea::nativeDynamicSet(record, gea::PropertyKey::symbol(sealed), gea::Value::box(gea::Value::Tag::Number, 8.0)));
  assert(!gea::nativeDynamicDelete(record, gea::PropertyKey::symbol(sealed)));
  assert(!boxed.deleteProperty(gea::PropertyKey::symbol(sealed)));
  gea::PropertyDescriptor incompatible;
  incompatible.hasEnumerable = true;
  incompatible.enumerable = true;
  assert(!gea::nativeDynamicDefineProperty(record, gea::PropertyKey::symbol(sealed), incompatible));
  assert(gea::nativeDynamicDefineProperty(record, gea::PropertyKey::symbol(sealed), gea::PropertyDescriptor{}));

  // Native and boxed paths agree: index entries delete, while a fixed symbol
  // and a fixed text field retain their non-configurable identity.
  assert(gea::nativeDynamicDelete(record, gea::PropertyKey::symbol(state)));
  assert(!gea::nativeDynamicHas(record, gea::PropertyKey::symbol(state)));
  record->gea_dynamic[state] = 41;
  assert(!gea::nativeDynamicDelete(record, gea::PropertyKey::symbol(fixed)));
  assert(!gea::nativeDynamicDelete(record, gea::PropertyKey::string("label")));
  assert(boxed.deleteProperty(gea::PropertyKey::symbol(state)));
  assert(!boxed.hasProperty(gea::PropertyKey::symbol(state)));
  assert(!boxed.deleteProperty(gea::PropertyKey::symbol(fixed)));
  assert(!boxed.deleteProperty(gea::PropertyKey::string("label")));
  // Deleting a missing symbol through an index signature remains true.
  assert(boxed.deleteProperty(gea::PropertyKey::symbol(state)));

  std::string json;
  gea_json_write(json, boxed);
  assert(json == "{\"label\":\"native\"}");

  gea::SymbolDictionary<gea::Optional<double>> spread;
  record->gea_dynamic.copyInto(spread, [](const gea::Optional<double>& value) { return value; });
  assert(!spread.has(state));
  assert(spread.has(sameDescription) && !spread.read(sameDescription).has_value());
}
