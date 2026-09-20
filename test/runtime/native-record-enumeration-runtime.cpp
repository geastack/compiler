#include "gea_runtime.h"

#include <cassert>
#include <functional>
#include <string>
#include <vector>

struct Record {
  gea::Value alpha = gea::Value::box(gea::Value::Tag::Number, 1.0);
  gea::Value beta = gea::Value::box(gea::Value::Tag::Number, 2.0);

  bool gea_readOwnField(const gea::PropertyKey& key, gea::Value& out) const {
    if (key.isSymbol()) return false;
    if (key.text() == "alpha") {
      out = alpha;
      return true;
    }
    if (key.text() == "beta") {
      out = beta;
      return true;
    }
    return false;
  }

  bool gea_writeOwnField(const gea::PropertyKey&, const gea::Value&, bool) { return false; }

  bool gea_ownFieldDescriptor(const gea::PropertyKey& key, gea::PropertyDescriptor& out) const {
    gea::Value value;
    if (!gea_readOwnField(key, value)) return false;
    out = gea::PropertyDescriptor::assignment(value);
    return true;
  }

  void gea_ownFieldKeys(std::vector<gea::PropertyKey>& keys) const {
    keys.push_back(gea::PropertyKey::string("alpha"));
    keys.push_back(gea::PropertyKey::string("beta"));
  }
};

int main() {
  const auto record = gea::makeRef<Record>();
  const gea::PropertyKey late = gea::PropertyKey::string("late");
  assert(gea::nativeDynamicSet(record, late, gea::Value::box(gea::Value::Tag::Number, 3.0)));

  // This is the cursor emitted for `for (const key in record)`: it snapshots
  // the native record's own keys without changing the record's typed carrier.
  gea::Iterator<std::string> cursor(
      gea::nativeDynamicKeys(record),
      std::function<bool(const std::string&)>([record](const std::string& key) {
        return gea::nativeDynamicHas(record, gea::PropertyKey::string(key));
      }));

  // Enumeration has a snapshot, but each future key is rechecked. The expando
  // was in that snapshot and must disappear after its own deletion, while the
  // native fields remain in their declared order and ownership stays `Ref<Record>`.
  assert(gea::nativeDynamicDelete(record, late));
  std::vector<std::string> keys;
  for (;;) {
    const std::string key = cursor.arrayNext();
    if (cursor.done()) break;
    keys.push_back(key);
  }
  assert((keys == std::vector<std::string>{"alpha", "beta"}));
}
