#include "panel_bridge.hpp"
#include <cstdio>

static double stored = 0;
double pbGet(double index) { return 41 + index; }
double pbGetOverride(double index) { return 83 + index; }
void pbSet(double value) { stored = value; }

void __gea_top_level();
int main() {
  __gea_top_level();
  std::printf("%.0f\n", stored);
  return stored == 42 || stored == 84 ? 0 : 1;
}
