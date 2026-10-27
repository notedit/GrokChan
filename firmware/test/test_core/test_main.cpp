// Host unit tests for lib/grokchan_core.  Run: pio test -e native
#include <unity.h>

void run_core_tests();
void run_audio_tests();
void run_device_tests();
void run_voice_tests();
void run_face_tests();

void setUp() {}
void tearDown() {}

int main(int, char**) {
  UNITY_BEGIN();
  run_core_tests();
  run_audio_tests();
  run_device_tests();
  run_voice_tests();
  run_face_tests();
  return UNITY_END();
}
