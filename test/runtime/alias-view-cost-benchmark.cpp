// The instruction cost of minting and dropping an open-Document view of an
// array or Map: a binary-document serializer mints one per nested container
// per command.
// Build against the runtime header and read `instructions:u` from perf stat.
#include "gea_runtime.h"
#include <cstdio>
#include <cstdlib>

int main(int argc, char** argv) {
  const long rounds = argc > 1 ? std::atol(argv[1]) : 200000;
  auto array = gea::makeRef<gea::ArrayObject<gea::Value>>();
  const gea::Value boxed = gea::Value::box(gea::Value::Tag::Object, array);
  auto map = gea::makeRef<gea::Map<gea::Value, gea::Value>>();
  const gea::Value boxedMap = gea::Value::box(gea::Value::Tag::Object, map);
  long checksum = 0;
  for (long round = 0; round < rounds; ++round) {
    auto view = gea::dictionary::aliasOf(boxed);
    // A second request while the first view lives answers the same table.
    auto again = gea::dictionary::aliasOf(boxed);
    checksum += view.get() == again.get();
    auto mapView = gea::dictionary::aliasOf(boxedMap);
    checksum += mapView->alias() != nullptr;
  }
  std::printf("%ld\n", checksum);
  return checksum == rounds * 2 ? 0 : 1;
}
