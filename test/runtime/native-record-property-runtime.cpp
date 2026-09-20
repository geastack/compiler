#include "gea_runtime.h"

#include <cassert>

struct Record {
  gea::Value name = gea::Value::box(gea::Value::Tag::String, std::string("fastify"));

  bool gea_readOwnField(const gea::PropertyKey& key, gea::Value& out) const {
    if (key.isSymbol() || key.text() != "name") return false;
    out = name;
    return true;
  }
  bool gea_writeOwnField(const gea::PropertyKey&, const gea::Value&, bool) { return false; }
  bool gea_ownFieldDescriptor(const gea::PropertyKey& key, gea::PropertyDescriptor& out) const {
    if (key.isSymbol() || key.text() != "name") return false;
    out = gea::PropertyDescriptor::assignment(name);
    return true;
  }
  void gea_ownFieldKeys(std::vector<gea::PropertyKey>& keys) const { keys.push_back(gea::PropertyKey::string("name")); }
};

int main() {
  const auto record = gea::makeRef<Record>();
  const gea::PropertyKey name = gea::PropertyKey::string("name");
  const gea::PropertyKey route = gea::PropertyKey::string("route");

  // The record stays native: declared fields and expandos share one sidecar,
  // while `in` additionally observes Object.prototype.
  assert(gea::nativeDynamicHasProperty(record, name));
  assert(!gea::nativeDynamicHasProperty(record, route));
  gea::nativeDynamicSet(record, route, gea::Value::box(gea::Value::Tag::String, std::string("/")));
  assert(gea::nativeDynamicHasProperty(record, route));
  assert(gea::nativeDynamicHasProperty(record, gea::PropertyKey::string("toString")));

  // Enumeration's recheck remains own-only: Object.prototype must not turn a
  // removed enumerable key into a second visit.
  assert(gea::nativeDynamicDelete(record, route));
  assert(!gea::nativeDynamicHas(record, route));
  assert(gea::nativeDynamicHasProperty(record, gea::PropertyKey::string("toString")));
}
