// Pixberry Signal Cube — hardware-free logic (face detection, shake detection, light patterns, battery).
// Kept free of Arduino headers so it can be unit-tested on a computer: `pio test -e native`.
#pragma once
#include <math.h>
#include <stdint.h>
#include <string.h>

namespace cube {

// ---------- Faces ----------
enum Face : int8_t { FACE_NONE = -1, FACE_REST = 0, FACE_SERVICE, FACE_BILL, FACE_WATER, FACE_ORDER, FACE_TOGO, FACE_COUNT };

// Names the server expects in POST /api/device/face
inline const char* faceName(Face f) {
  static const char* names[] = {"rest", "service", "bill", "water", "order", "togo"};
  return (f >= 0 && f < FACE_COUNT) ? names[f] : "none";
}
inline Face faceFromName(const char* s) {
  for (int i = 0; i < FACE_COUNT; i++) if (s && strcmp(s, faceName((Face)i)) == 0) return (Face)i;
  return FACE_NONE;
}

struct Vec3 { float x, y, z; };
inline float magnitude(Vec3 a) { return sqrtf(a.x * a.x + a.y * a.y + a.z * a.z); }

// Axis pointing up, from an accelerometer reading in g (a still sensor reads +1 g on the axis that points up).
// Returns 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z, or -1 when the cube is tilted (not resting flat on a face).
inline int upAxis(Vec3 a, float minDominant = 0.80f, float maxOther = 0.40f) {
  const float v[3] = {a.x, a.y, a.z};
  int best = 0;
  for (int i = 1; i < 3; i++) if (fabsf(v[i]) > fabsf(v[best])) best = i;
  if (fabsf(v[best]) < minDominant) return -1;
  for (int i = 0; i < 3; i++) if (i != best && fabsf(v[i]) > maxOther) return -1;
  return best * 2 + (v[best] < 0 ? 1 : 0);
}

// Reports a face once it has been on top, flat and still, for `settleMs`.
// Turning the cube past other faces on the way never reports them.
class FaceDetector {
 public:
  FaceDetector(const Face axisMap[6], uint32_t settleMs = 1000) : settle_(settleMs) { memcpy(map_, axisMap, sizeof(map_)); }

  // Feed every sample. Returns the newly settled face, or FACE_NONE when nothing changed.
  Face update(Vec3 a, uint32_t nowMs) {
    const float m = magnitude(a);
    Face f = FACE_NONE;
    if (m > 0.85f && m < 1.15f) {  // only while still (no hand movement)
      const int ax = upAxis(a);
      if (ax >= 0) f = map_[ax];
    }
    if (f != candidate_) { candidate_ = f; since_ = nowMs; return FACE_NONE; }
    if (f == FACE_NONE || f == reported_) return FACE_NONE;
    if (nowMs - since_ >= settle_) { reported_ = f; return f; }
    return FACE_NONE;
  }
  Face reported() const { return reported_; }
  // Forget the last report (e.g. after a shake-cancel) so the same face can be sent again.
  void forget() { reported_ = FACE_NONE; candidate_ = FACE_NONE; }
  // Treat the current face as reported without sending it (after a cancel, the cube stays where it is).
  void markReported(Face f) { reported_ = f; }

 private:
  Face map_[6];
  uint32_t settle_;
  Face candidate_ = FACE_NONE;
  uint32_t since_ = 0;
  Face reported_ = FACE_NONE;
};

// Two quick shakes = cancel. Counts strong jolts (|a| above `peakG`); `peaks` of them within `windowMs`.
class ShakeDetector {
 public:
  ShakeDetector(float peakG = 2.0f, int peaks = 4, uint32_t windowMs = 1500, uint32_t minGapMs = 80, uint32_t cooldownMs = 2000)
      : peakG_(peakG), need_(peaks), window_(windowMs), gap_(minGapMs), cooldown_(cooldownMs) {}

  bool update(Vec3 a, uint32_t nowMs) {
    const float m = magnitude(a);
    if (hasEvent_ && nowMs - lastEvent_ < cooldown_) { inPeak_ = m > peakG_; return false; }
    if (m > peakG_) {
      if (!inPeak_) {
        inPeak_ = true;
        if (count_ == 0 || nowMs - first_ > window_) { count_ = 1; first_ = nowMs; last_ = nowMs; }
        else if (nowMs - last_ >= gap_) { count_++; last_ = nowMs; }
        if (count_ >= need_) { count_ = 0; lastEvent_ = nowMs; hasEvent_ = true; return true; }
      }
    } else if (m < peakG_ * 0.7f) {
      inPeak_ = false;
    }
    return false;
  }
  // True for a short while after any strong jolt, so face detection can ignore a shake in progress.
  bool recentlyMoving(uint32_t nowMs, uint32_t holdMs = 600) const { return count_ > 0 && nowMs - last_ < holdMs; }

 private:
  float peakG_;
  int need_;
  uint32_t window_, gap_, cooldown_;
  bool inPeak_ = false, hasEvent_ = false;
  int count_ = 0;
  uint32_t first_ = 0, last_ = 0, lastEvent_ = 0;
};

// ---------- Light ----------
struct RGB { uint8_t r, g, b; };
inline RGB rgb(uint32_t hex) { return {uint8_t(hex >> 16), uint8_t(hex >> 8), uint8_t(hex)}; }
inline RGB scale(RGB c, float k) {
  if (k < 0) k = 0;
  if (k > 1) k = 1;
  return {uint8_t(c.r * k + 0.5f), uint8_t(c.g * k + 0.5f), uint8_t(c.b * k + 0.5f)};
}

// off | request (steady) | acknowledged (slow breathe) | late (fast pulse) | candle (flicker) |
// sending (spinner while talking to the server) | error (three red blinks, then back to the previous mode)
enum LightMode : uint8_t { LIGHT_OFF, LIGHT_REQUEST, LIGHT_ACK, LIGHT_LATE, LIGHT_CANDLE, LIGHT_SENDING, LIGHT_ERROR };

inline LightMode modeFromServer(const char* light) {
  if (!light) return LIGHT_OFF;
  if (!strcmp(light, "request")) return LIGHT_REQUEST;
  if (!strcmp(light, "acknowledged")) return LIGHT_ACK;
  if (!strcmp(light, "late")) return LIGHT_LATE;
  if (!strcmp(light, "candle")) return LIGHT_CANDLE;
  return LIGHT_OFF;
}

// Request colours, matching the counter display and staff app.
constexpr uint32_t COLOR_SERVICE = 0xFF4F5E, COLOR_BILL = 0x3F7DFF, COLOR_WATER = 0x11B5E4, COLOR_ORDER = 0x2FC46F,
                   COLOR_TOGO = 0xA35DFF, COLOR_CANDLE = 0xFF9329, COLOR_ERROR = 0xFF2000, COLOR_IDLE = 0x000000;

// Server request type → colour ("waiter" is the Service face)
inline uint32_t colorForType(const char* type) {
  if (!type) return COLOR_IDLE;
  if (!strcmp(type, "waiter")) return COLOR_SERVICE;
  if (!strcmp(type, "bill")) return COLOR_BILL;
  if (!strcmp(type, "water")) return COLOR_WATER;
  if (!strcmp(type, "order")) return COLOR_ORDER;
  if (!strcmp(type, "togo")) return COLOR_TOGO;
  return COLOR_SERVICE;
}
inline uint32_t colorForFace(Face f) {
  switch (f) {
    case FACE_SERVICE: return COLOR_SERVICE;
    case FACE_BILL: return COLOR_BILL;
    case FACE_WATER: return COLOR_WATER;
    case FACE_ORDER: return COLOR_ORDER;
    case FACE_TOGO: return COLOR_TOGO;
    default: return COLOR_IDLE;
  }
}

// Smooth pseudo-random value in [0,1] for the candle flicker (no rand(), so it is repeatable in tests).
inline float noise1(uint32_t t) {
  auto h = [](uint32_t x) { x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16; return (x & 0xffff) / 65535.0f; };
  const uint32_t step = 90, i = t / step;
  const float f = float(t % step) / step, s = f * f * (3 - 2 * f);
  return h(i) * (1 - s) + h(i + 1) * s;
}

// Colour of LED `i` of `n` at time `nowMs`. `modeStartMs` is when the mode began (for the error blinks).
inline RGB pixel(LightMode mode, uint32_t color, int i, int n, uint32_t nowMs, uint32_t modeStartMs = 0) {
  const RGB c = rgb(color);
  const float pi = 3.14159265f;
  switch (mode) {
    case LIGHT_REQUEST: return c;
    case LIGHT_ACK: {  // slow breathe, 4 s period, never fully dark
      const float k = 0.20f + 0.80f * (0.5f - 0.5f * cosf(2 * pi * (nowMs % 4000) / 4000.0f));
      return scale(c, k);
    }
    case LIGHT_LATE: {  // urgent pulse, 0.8 s period
      const float k = 0.15f + 0.85f * (0.5f - 0.5f * cosf(2 * pi * (nowMs % 800) / 800.0f));
      return scale(c, k);
    }
    case LIGHT_CANDLE: {  // warm flicker, slightly different per LED
      const float k = 0.35f + 0.45f * noise1(nowMs + uint32_t(i) * 977U);
      return scale(rgb(COLOR_CANDLE), k);
    }
    case LIGHT_SENDING: {  // one bright LED chasing round the ring, with a short tail
      if (n <= 0) return c;
      const int head = int((nowMs / 70) % uint32_t(n));
      const int d = (head - i + n) % n;
      return d == 0 ? c : d == 1 ? scale(c, 0.35f) : d == 2 ? scale(c, 0.12f) : RGB{0, 0, 0};
    }
    case LIGHT_ERROR: {  // three red blinks
      const uint32_t t = nowMs - modeStartMs;
      return (t < 1500 && (t % 500) < 250) ? rgb(COLOR_ERROR) : RGB{0, 0, 0};
    }
    default: return {0, 0, 0};
  }
}
inline bool errorFinished(uint32_t nowMs, uint32_t modeStartMs) { return nowMs - modeStartMs >= 1500; }

// ---------- Battery ----------
// Single-cell Li-ion/LiPo voltage → percent (resting voltage curve, linear between points).
inline int batteryPercent(float volts) {
  static const float v[] = {3.30f, 3.50f, 3.60f, 3.70f, 3.75f, 3.80f, 3.85f, 3.90f, 4.00f, 4.10f, 4.20f};
  static const int p[] = {0, 5, 10, 22, 33, 45, 55, 64, 78, 90, 100};
  if (volts <= v[0]) return 0;
  for (int i = 1; i < 11; i++)
    if (volts <= v[i]) return int(p[i - 1] + (p[i] - p[i - 1]) * (volts - v[i - 1]) / (v[i] - v[i - 1]) + 0.5f);
  return 100;
}

// ---------- Timing ----------
// How long to wait before asking the server again. Waiting for staff → often; idle → rarely.
inline uint32_t pollIntervalMs(LightMode m) {
  switch (m) {
    case LIGHT_REQUEST: case LIGHT_LATE: return 8000;  // learn quickly when staff say "On my way"
    case LIGHT_ACK: return 15000;                       // learn when it's done
    default: return 180000;                             // heartbeat every 3 minutes
  }
}
// Retry delay after a failed call: 1 s, 2 s, 4 s … capped at 60 s.
inline uint32_t backoffMs(int attempt) {
  if (attempt < 0) attempt = 0;
  if (attempt > 6) return 60000;
  const uint32_t ms = 1000U << attempt;
  return ms > 60000 ? 60000 : ms;
}

// How long to deep-sleep when the server says the café is closed for `serverSeconds`.
// Below `minS` it isn't worth the reboot-on-wake cost, so this returns 0 (stay awake, normal
// heartbeat). Clamped to `capS` so the cube still checks back occasionally even on a long closure
// or a misconfigured server.
inline uint32_t sleepSeconds(uint32_t serverSeconds, uint32_t minS, uint32_t capS) {
  if (serverSeconds < minS) return 0;
  return serverSeconds > capS ? capS : serverSeconds;
}

}  // namespace cube
