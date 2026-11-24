// Unit tests for the cube logic. Run on a computer: pio test -e native
#include <CubeLogic.h>
#include <unity.h>

using namespace cube;

static const Face MAP[6] = {FACE_SERVICE, FACE_BILL, FACE_WATER, FACE_TOGO, FACE_REST, FACE_ORDER};
static const Vec3 UP_Z = {0.02f, -0.03f, 1.0f}, UP_NEG_Z = {0, 0, -1.0f}, UP_Y = {0.05f, 0.99f, 0.03f}, UP_X = {1.0f, 0, 0};
static const Vec3 TILTED = {0.6f, 0, 0.8f}, JOLT = {2.6f, 0.4f, 1.0f};

void setUp() {}
void tearDown() {}

void test_up_axis() {
  TEST_ASSERT_EQUAL(4, upAxis(UP_Z));
  TEST_ASSERT_EQUAL(5, upAxis(UP_NEG_Z));
  TEST_ASSERT_EQUAL(2, upAxis(UP_Y));
  TEST_ASSERT_EQUAL(0, upAxis(UP_X));
  TEST_ASSERT_EQUAL(-1, upAxis(TILTED));
}

void test_face_needs_one_second_still() {
  FaceDetector d(MAP, 1000);
  uint32_t t = 0;
  for (; t < 980; t += 20) TEST_ASSERT_EQUAL(FACE_NONE, d.update(UP_Y, t));
  Face got = FACE_NONE;
  for (; t <= 1100 && got == FACE_NONE; t += 20) got = d.update(UP_Y, t);
  TEST_ASSERT_EQUAL(FACE_WATER, got);
  // reported once only
  for (int i = 0; i < 100; i++, t += 20) TEST_ASSERT_EQUAL(FACE_NONE, d.update(UP_Y, t));
}

void test_passing_faces_are_not_sent() {
  FaceDetector d(MAP, 1000);
  uint32_t t = 0;
  // Turn through Service and Bill quickly (300 ms each), then settle on Water
  for (int i = 0; i < 15; i++, t += 20) TEST_ASSERT_EQUAL(FACE_NONE, d.update(UP_X, t));
  for (int i = 0; i < 15; i++, t += 20) TEST_ASSERT_EQUAL(FACE_NONE, d.update({-1, 0, 0}, t));
  for (int i = 0; i < 5; i++, t += 20) TEST_ASSERT_EQUAL(FACE_NONE, d.update(TILTED, t));
  Face got = FACE_NONE;
  for (int i = 0; i < 60 && got == FACE_NONE; i++, t += 20) got = d.update(UP_Y, t);
  TEST_ASSERT_EQUAL(FACE_WATER, got);
}

void test_movement_resets_the_timer() {
  FaceDetector d(MAP, 1000);
  uint32_t t = 0;
  for (int i = 0; i < 40; i++, t += 20) d.update(UP_Z, t);   // 800 ms
  d.update(JOLT, t); t += 20;                                  // bumped
  for (int i = 0; i < 40; i++, t += 20) TEST_ASSERT_EQUAL(FACE_NONE, d.update(UP_Z, t));  // only 800 ms again
  Face got = FACE_NONE;
  for (int i = 0; i < 20 && got == FACE_NONE; i++, t += 20) got = d.update(UP_Z, t);
  TEST_ASSERT_EQUAL(FACE_REST, got);
}

void test_flip_back_reports_again() {
  FaceDetector d(MAP, 500);
  uint32_t t = 0;
  Face a = FACE_NONE, b = FACE_NONE, c = FACE_NONE;
  for (int i = 0; i < 40; i++, t += 20) { Face f = d.update(UP_Y, t); if (f != FACE_NONE) a = f; }
  for (int i = 0; i < 40; i++, t += 20) { Face f = d.update(UP_Z, t); if (f != FACE_NONE) b = f; }
  for (int i = 0; i < 40; i++, t += 20) { Face f = d.update(UP_Y, t); if (f != FACE_NONE) c = f; }
  TEST_ASSERT_EQUAL(FACE_WATER, a);
  TEST_ASSERT_EQUAL(FACE_REST, b);
  TEST_ASSERT_EQUAL(FACE_WATER, c);
}

void test_shake_cancels_but_a_bump_does_not() {
  ShakeDetector s(2.0f, 4, 1500, 80, 2000);
  uint32_t t = 0;
  // one bump: no cancel
  TEST_ASSERT_FALSE(s.update(JOLT, t)); t += 20;
  for (int i = 0; i < 100; i++, t += 20) TEST_ASSERT_FALSE(s.update(UP_Z, t));
  // two quick shakes = 4 jolts ~150 ms apart
  bool fired = false;
  for (int k = 0; k < 4; k++) {
    fired |= s.update(JOLT, t); t += 20;
    for (int i = 0; i < 6; i++, t += 20) fired |= s.update(UP_Z, t);
  }
  TEST_ASSERT_TRUE(fired);
  // cooldown: shaking again straight away doesn't fire twice
  bool again = false;
  for (int k = 0; k < 4; k++) { again |= s.update(JOLT, t); t += 20; for (int i = 0; i < 6; i++, t += 20) again |= s.update(UP_Z, t); }
  TEST_ASSERT_FALSE(again);
}

void test_face_names_round_trip() {
  for (int i = 0; i < FACE_COUNT; i++) TEST_ASSERT_EQUAL(i, faceFromName(faceName((Face)i)));
  TEST_ASSERT_EQUAL(FACE_NONE, faceFromName("juggle"));
  TEST_ASSERT_EQUAL_STRING("service", faceName(FACE_SERVICE));
  TEST_ASSERT_EQUAL_STRING("rest", faceName(FACE_REST));
}

void test_server_light_and_colours() {
  TEST_ASSERT_EQUAL(LIGHT_REQUEST, modeFromServer("request"));
  TEST_ASSERT_EQUAL(LIGHT_ACK, modeFromServer("acknowledged"));
  TEST_ASSERT_EQUAL(LIGHT_LATE, modeFromServer("late"));
  TEST_ASSERT_EQUAL(LIGHT_CANDLE, modeFromServer("candle"));
  TEST_ASSERT_EQUAL(LIGHT_OFF, modeFromServer("off"));
  TEST_ASSERT_EQUAL(LIGHT_OFF, modeFromServer(nullptr));
  TEST_ASSERT_EQUAL_HEX32(COLOR_SERVICE, colorForType("waiter"));
  TEST_ASSERT_EQUAL_HEX32(COLOR_WATER, colorForType("water"));
  TEST_ASSERT_EQUAL_HEX32(COLOR_TOGO, colorForFace(FACE_TOGO));
}

void test_light_patterns() {
  RGB c = pixel(LIGHT_REQUEST, COLOR_WATER, 0, 12, 1234);
  TEST_ASSERT_EQUAL(0x11, c.r); TEST_ASSERT_EQUAL(0xB5, c.g); TEST_ASSERT_EQUAL(0xE4, c.b);
  RGB off = pixel(LIGHT_OFF, COLOR_WATER, 0, 12, 1234);
  TEST_ASSERT_EQUAL(0, off.r + off.g + off.b);
  // breathe: dimmest at t=0, brightest at half period, never fully dark
  RGB dim = pixel(LIGHT_ACK, 0xFFFFFF, 0, 12, 0), bright = pixel(LIGHT_ACK, 0xFFFFFF, 0, 12, 2000);
  TEST_ASSERT_TRUE(dim.r > 30 && dim.r < 70);
  TEST_ASSERT_EQUAL(255, bright.r);
  // spinner: exactly one LED at full colour
  int full = 0;
  for (int i = 0; i < 12; i++) { RGB p = pixel(LIGHT_SENDING, 0xFF0000, i, 12, 700); if (p.r == 255) full++; }
  TEST_ASSERT_EQUAL(1, full);
  // error: three blinks, then finished
  TEST_ASSERT_EQUAL(255, pixel(LIGHT_ERROR, 0, 0, 12, 1100, 1000).r);
  TEST_ASSERT_EQUAL(0, pixel(LIGHT_ERROR, 0, 0, 12, 1400, 1000).r);
  TEST_ASSERT_FALSE(errorFinished(2400, 1000));
  TEST_ASSERT_TRUE(errorFinished(2500, 1000));
  // candle stays warm and within range
  for (uint32_t t = 0; t < 5000; t += 37) {
    RGB p = pixel(LIGHT_CANDLE, 0, 3, 12, t);
    TEST_ASSERT_TRUE(p.r >= p.g && p.g >= p.b);
    TEST_ASSERT_TRUE(p.r > 80);
  }
}

void test_battery_curve() {
  TEST_ASSERT_EQUAL(100, batteryPercent(4.25f));
  TEST_ASSERT_EQUAL(100, batteryPercent(4.20f));
  TEST_ASSERT_EQUAL(0, batteryPercent(3.2f));
  TEST_ASSERT_INT_WITHIN(1, 45, batteryPercent(3.80f));
  TEST_ASSERT_INT_WITHIN(2, 84, batteryPercent(4.05f));
}

void test_timing() {
  TEST_ASSERT_EQUAL_UINT32(8000, pollIntervalMs(LIGHT_REQUEST));
  TEST_ASSERT_EQUAL_UINT32(8000, pollIntervalMs(LIGHT_LATE));
  TEST_ASSERT_EQUAL_UINT32(15000, pollIntervalMs(LIGHT_ACK));
  TEST_ASSERT_EQUAL_UINT32(180000, pollIntervalMs(LIGHT_OFF));
  TEST_ASSERT_EQUAL_UINT32(1000, backoffMs(0));
  TEST_ASSERT_EQUAL_UINT32(8000, backoffMs(3));
  TEST_ASSERT_EQUAL_UINT32(60000, backoffMs(6));
  TEST_ASSERT_EQUAL_UINT32(60000, backoffMs(20));
}

void test_closed_cafe_sleep() {
  // too short a closure to bother sleeping
  TEST_ASSERT_EQUAL_UINT32(0, sleepSeconds(60, 300, 21600));
  TEST_ASSERT_EQUAL_UINT32(0, sleepSeconds(0, 300, 21600));
  // a closure shorter than the cap sleeps for exactly that long
  TEST_ASSERT_EQUAL_UINT32(5 * 3600, sleepSeconds(5 * 3600, 300, 6 * 3600));
  // never sleeps longer than the cap, even over a long holiday
  TEST_ASSERT_EQUAL_UINT32(6 * 3600, sleepSeconds(3 * 86400, 300, 6 * 3600));
  // right at the threshold
  TEST_ASSERT_EQUAL_UINT32(300, sleepSeconds(300, 300, 21600));
  TEST_ASSERT_EQUAL_UINT32(0, sleepSeconds(299, 300, 21600));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_up_axis);
  RUN_TEST(test_face_needs_one_second_still);
  RUN_TEST(test_passing_faces_are_not_sent);
  RUN_TEST(test_movement_resets_the_timer);
  RUN_TEST(test_flip_back_reports_again);
  RUN_TEST(test_shake_cancels_but_a_bump_does_not);
  RUN_TEST(test_face_names_round_trip);
  RUN_TEST(test_server_light_and_colours);
  RUN_TEST(test_light_patterns);
  RUN_TEST(test_battery_curve);
  RUN_TEST(test_timing);
  RUN_TEST(test_closed_cafe_sleep);
  return UNITY_END();
}
