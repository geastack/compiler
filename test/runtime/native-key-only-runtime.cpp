#include "gea_runtime.h"

#include <cassert>
#include <vector>

// This type intentionally has no Value-bearing field read, write, or
// descriptor hook.  Own-key enumeration must still be a usable native
// capability for Object.keys/Reflect.ownKeys.
struct KeyOnlyRecord {
  gea::Symbol symbol = gea::makeSymbol("symbol");
  bool visiblePresent = true;
  bool hiddenPresent = true;

  void gea_ownFieldKeys(std::vector<gea::PropertyKey>& keys) const {
    if (visiblePresent) {
      keys.push_back(gea::PropertyKey::string("10"));
      keys.push_back(gea::PropertyKey::string("2"));
      keys.push_back(gea::PropertyKey::string("visible"));
    }
    if (hiddenPresent) keys.push_back(gea::PropertyKey::string("hidden"));
    keys.push_back(gea::PropertyKey::symbol(symbol));
  }

  bool gea_ownFieldEnumerable(const gea::PropertyKey& key, bool& enumerable) const {
    if (key.isSymbol()) return false;
    if (key.text() == "10" || key.text() == "2" || key.text() == "visible") {
      enumerable = true;
      return true;
    }
    if (key.text() == "hidden") {
      enumerable = false;
      return true;
    }
    return false;
  }

  bool gea_ownFieldPresent(const gea::PropertyKey& key, bool& present) const {
    if (!key.isSymbol()) {
      if (key.text() == "10" || key.text() == "2" || key.text() == "visible") {
        present = visiblePresent;
        return true;
      }
      if (key.text() == "hidden") {
        present = hiddenPresent;
        return true;
      }
      return false;
    }
    if (key.symbolId() != symbol.id()) return false;
    present = true;
    return true;
  }
};

// A second carrier exercises the compatibility path: typed numeric index
// storage and an ordinary Value expando must share one ordered own-key view.
struct IndexedRecord {
  double fixed = 1;
  gea::NumericDictionary<double> index;
  gea::NativeIndexAttributeTable<std::string> attributes;

  static bool isIndex(const gea::PropertyKey& key) {
    return !key.isSymbol() && (key.text() == "2" || key.text() == "10");
  }

  bool gea_readOwnField(const gea::PropertyKey& key, gea::Value& out) const {
    if (key.isSymbol() || key.text() != "fixed") return false;
    out = gea::Value::box(gea::Value::Tag::Number, fixed);
    return true;
  }
  bool gea_writeOwnField(const gea::PropertyKey& key, const gea::Value& value, bool) {
    if (key.isSymbol() || key.text() != "fixed") return false;
    fixed = value.as<double>();
    return true;
  }
  bool gea_ownFieldDescriptor(const gea::PropertyKey& key, gea::PropertyDescriptor& out) const {
    if (key.isSymbol() || key.text() != "fixed") return false;
    out = gea::PropertyDescriptor::assignment(gea::Value::box(gea::Value::Tag::Number, fixed));
    out.configurable = false;
    return true;
  }
  bool gea_matchesOwnField(const gea::PropertyKey& key) const { return !key.isSymbol() && key.text() == "fixed"; }
  bool gea_defineOwnField(const gea::PropertyKey&, const gea::PropertyDescriptor&, bool) { return false; }
  bool gea_deleteOwnField(const gea::PropertyKey&) { return false; }

  bool gea_readOwnIndex(const gea::PropertyKey& key, gea::Value& out) const {
    if (!isIndex(key) || !index.has(key.text())) return false;
    out = gea::Value::box(gea::Value::Tag::Number, index.read(key.text()));
    return true;
  }
  bool gea_matchesOwnIndex(const gea::PropertyKey& key) const { return isIndex(key); }
  bool gea_writeOwnIndex(const gea::PropertyKey& key, const gea::Value& value, bool) {
    if (!isIndex(key) || (index.has(key.text()) && !attributes.attributes(key.text()).writable)) return false;
    index[key.text()] = value.as<double>();
    return true;
  }
  bool gea_ownIndexDescriptor(const gea::PropertyKey& key, gea::PropertyDescriptor& out) const {
    if (!isIndex(key) || !index.has(key.text())) return false;
    out = gea::PropertyDescriptor::assignment(gea::Value::box(gea::Value::Tag::Number, index.read(key.text())));
    const auto current = attributes.attributes(key.text());
    out.writable = current.writable;
    out.enumerable = current.enumerable;
    out.configurable = current.configurable;
    return true;
  }
  bool gea_defineOwnIndex(const gea::PropertyKey&, const gea::PropertyDescriptor&, bool) { return false; }
  bool gea_deleteOwnIndex(const gea::PropertyKey& key) {
    if (!isIndex(key) || (index.has(key.text()) && !attributes.deleteAllowed(key.text()))) return false;
    index.erase(key.text());
    attributes.erase(key.text());
    return true;
  }
  void gea_freezeOwnIndex() {}

  bool gea_ownFieldEnumerable(const gea::PropertyKey& key, bool& enumerable) const {
    if (!gea_matchesOwnField(key)) return false;
    enumerable = true;
    return true;
  }
  bool gea_ownIndexEnumerable(const gea::PropertyKey& key, bool& enumerable) const {
    if (!isIndex(key)) return false;
    enumerable = attributes.attributes(key.text()).enumerable;
    return true;
  }
  bool gea_ownFieldPresent(const gea::PropertyKey& key, bool& present) const {
    if (!gea_matchesOwnField(key)) return false;
    present = true;
    return true;
  }
  bool gea_ownIndexPresent(const gea::PropertyKey& key, bool& present) const {
    if (!isIndex(key)) return false;
    present = index.has(key.text());
    return true;
  }
  void gea_ownFieldKeys(std::vector<gea::PropertyKey>& keys) const {
    keys.push_back(gea::PropertyKey::string("fixed"));
    for (const auto& entry : index) keys.push_back(gea::PropertyKey::string(entry.first));
  }
};

static_assert(gea::detail::NativeOwnKeysTable<KeyOnlyRecord>);
static_assert(gea::detail::NativeOwnFieldEnumerableTable<KeyOnlyRecord>);
static_assert(gea::detail::NativeOwnFieldPresenceTable<KeyOnlyRecord>);
static_assert(!gea::detail::NativeFieldTable<KeyOnlyRecord>);
static_assert(gea::detail::NativeIndexFieldTable<IndexedRecord>);

int main() {
  const auto record = gea::makeRef<KeyOnlyRecord>();
  const auto ownKeys = gea::nativeOwnPropertyKeys(record);
  assert(ownKeys.size() == 5);
  assert(ownKeys[0].text() == "2");
  assert(ownKeys[1].text() == "10");
  assert(ownKeys[2].text() == "visible");
  assert(ownKeys[3].text() == "hidden");
  assert(ownKeys[4].isSymbol());

  const auto names = gea::nativeOwnPropertyNames(record);
  assert((names == std::vector<std::string>{"2", "10", "visible", "hidden"}));

  const auto enumerable = gea::nativeDynamicKeys(record);
  assert((enumerable == std::vector<std::string>{"2", "10", "visible"}));
  assert(!gea::nativeDynamicHas(record, gea::PropertyKey::string("toString")));
  assert(gea::nativeDynamicHasProperty(record, gea::PropertyKey::string("toString")));
  assert(gea::nativeDynamicHas(record, gea::PropertyKey::string("visible")));
  assert(gea::nativeDynamicHas(record, gea::PropertyKey::string("hidden")));
  assert(gea::nativeDynamicHas(record, gea::PropertyKey::symbol(record->symbol)));
  assert(!gea::nativeDynamicHas(record, gea::PropertyKey::string("missing")));

  // An absent fixed slot is removed from own keys and hasOwn, while an
  // unrelated inherited prototype name remains non-own.
  record->visiblePresent = false;
  const auto afterDelete = gea::nativeOwnPropertyKeys(record);
  assert(afterDelete.size() == 2);
  assert(afterDelete[0].text() == "hidden");
  assert(afterDelete[1].isSymbol());
  assert(!gea::nativeDynamicHas(record, gea::PropertyKey::string("visible")));
  assert((gea::nativeDynamicKeys(record) == std::vector<std::string>{}));

  auto indexed = gea::makeRef<IndexedRecord>();
  indexed->index["10"] = 10;
  indexed->index["2"] = 2;
  indexed->attributes.set("10", gea::NativeIndexAttributes{true, false, true});
  assert(gea::nativeDynamicSet(indexed, gea::PropertyKey::string("extra"),
                               gea::Value::box(gea::Value::Tag::String, std::string("expando"))));
  auto indexedKeys = gea::nativeOwnPropertyKeys(indexed);
  assert(indexedKeys.size() == 4);
  assert(indexedKeys[0].text() == "2");
  assert(indexedKeys[1].text() == "10");
  assert(indexedKeys[2].text() == "fixed");
  assert(indexedKeys[3].text() == "extra");
  assert((gea::nativeDynamicKeys(indexed) == std::vector<std::string>{"2", "fixed", "extra"}));
  assert(gea::nativeDynamicHas(indexed, gea::PropertyKey::string("2")));
  assert(!gea::nativeDynamicHas(indexed, gea::PropertyKey::string("missing")));
  assert(gea::nativeDynamicHasProperty(indexed, gea::PropertyKey::string("toString")));
  assert(!gea::nativeDynamicHas(indexed, gea::PropertyKey::string("toString")));
  assert(gea::nativeDynamicDelete(indexed, gea::PropertyKey::string("extra")));
  assert(!gea::nativeDynamicHas(indexed, gea::PropertyKey::string("extra")));
  assert(gea::nativeDynamicDelete(indexed, gea::PropertyKey::string("missing")));
}
