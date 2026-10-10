#include "gea_runtime.h"
#include <cassert>
#include <cstdio>

struct Alarm {
  double id = 0;
  double hour = 0;
  bool enabled = false;
};
struct NarrowAlarm { double hour = 0; };
namespace gea::detail {
template <> struct NativeViewTarget<Alarm> : std::true_type {};
template <> struct NativeViewTarget<NarrowAlarm> : std::true_type {};
}
void gea_json_write(std::string& out, const Alarm& alarm) {
  out += "{\"id\":";
  gea_json_write(out, alarm.id);
  out += ",\"hour\":";
  gea_json_write(out, alarm.hour);
  out += ",\"enabled\":";
  gea_json_write(out, alarm.enabled);
  out += '}';
}
void gea_json_write(std::string& out, const NarrowAlarm& alarm) {
  out += "{\"hour\":";
  gea_json_write(out, alarm.hour);
  out += '}';
}

int main() {
  auto original = gea::makeRef<Alarm>();
  original->id = 3;
  original->hour = 12;
  original->enabled = true;
  auto view = gea::record::makeViewWithOrigin<Alarm>(original);
  auto narrow = gea::record::makeViewWithOrigin<NarrowAlarm>(view);
  assert(view->hour == 0 && narrow->hour == 0);
  for (int hour : {12, 17}) {
    original->hour = hour;
    std::string direct, sameType, narrowed;
    gea_json_write(direct, original);
    gea_json_write(sameType, view);
    gea_json_write(narrowed, narrow);
    assert(sameType == direct && narrowed == direct);
    assert(direct.find("\"id\":3") != std::string::npos);
    assert(direct.find("\"enabled\":true") != std::string::npos);
  }
  auto list = gea::makeRef<gea::ArrayObject<gea::Ref<Alarm>>>();
  list->push(view);
  std::string saved;
  gea_json_write(saved, list);
  assert(saved == "[{\"id\":3,\"hour\":17,\"enabled\":true}]");
  std::puts("native view JSON preserves original fields: passed");
}
