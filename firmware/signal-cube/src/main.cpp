// Pixberry Signal Cube firmware (ESP32-C3 + LIS3DH accelerometer + WS2812 LED ring).
//
// What it does:
//   • Watches which face is on top. When a face has been still for 1 s, it tells the Pixberry server
//     (POST /api/device/face). The Candle face ("rest") cancels the cube's request.
//   • Two quick shakes cancel the request (POST /api/device/cancel).
//   • Asks the server what the light should show: every 8 s while waiting for staff, every 15 s once
//     someone is on the way, and every 3 min otherwise (POST /api/device/heartbeat, also reports battery).
//   • Sensors and LEDs run in the main loop; all network calls run in a separate task so the light
//     never freezes while Wi-Fi is slow.
//
// Set it up once over USB serial (115200 baud): type `help`.

#include <Arduino.h>
#include <Adafruit_LIS3DH.h>
#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <esp_sleep.h>

#include "ca_cert.h"
#include "config.h"

using namespace cube;

// ---------------- Settings (stored in flash) ----------------
struct Settings {
  String ssid, pass, url, key;
  Face axisMap[6];
} cfg;
Preferences prefs;

void loadSettings() {
  prefs.begin("signal", true);
  cfg.ssid = prefs.getString("ssid", "");
  cfg.pass = prefs.getString("pass", "");
  cfg.url = prefs.getString("url", "");
  cfg.key = prefs.getString("key", "");
  uint8_t raw[6];
  if (prefs.getBytes("map", raw, 6) == 6) for (int i = 0; i < 6; i++) cfg.axisMap[i] = (Face)raw[i];
  else memcpy(cfg.axisMap, DEFAULT_AXIS_MAP, sizeof(cfg.axisMap));
  prefs.end();
}
void saveString(const char* k, const String& v) { prefs.begin("signal", false); prefs.putString(k, v); prefs.end(); }
void saveMap() {
  uint8_t raw[6];
  for (int i = 0; i < 6; i++) raw[i] = (uint8_t)cfg.axisMap[i];
  prefs.begin("signal", false); prefs.putBytes("map", raw, 6); prefs.end();
}
bool configured() { return cfg.ssid.length() && cfg.url.length() && cfg.key.length(); }

// ---------------- Hardware ----------------
Adafruit_LIS3DH accel;
Adafruit_NeoPixel ring(LED_COUNT, PIN_LEDS, NEO_GRB + NEO_KHZ800);
bool accelOk = false;

Vec3 readAccel() {
  sensors_event_t ev;
  accel.getEvent(&ev);
  const float g = 9.80665f;
  return {ev.acceleration.x / g, ev.acceleration.y / g, ev.acceleration.z / g};
}
float batteryVolts() {
  uint32_t mv = 0;
  for (int i = 0; i < 8; i++) mv += analogReadMilliVolts(PIN_BATTERY_ADC);
  return (mv / 8.0f / 1000.0f) * BATTERY_DIVIDER;
}
bool onCoaster() { return digitalRead(PIN_ON_COASTER) == ON_COASTER_ACTIVE; }

// ---------------- Shared state between the main loop and the network task ----------------
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
struct Shared {
  LightMode mode = LIGHT_OFF;      // what the LEDs show
  uint32_t color = COLOR_IDLE;
  uint32_t modeSince = 0;
  LightMode afterError = LIGHT_OFF;  // mode to return to after the error blinks
  uint32_t afterErrorColor = COLOR_IDLE;
  int8_t pendingFace = FACE_NONE;  // face waiting to be sent (latest wins)
  bool pendingCancel = false;
  bool wantPoll = true;
  char table[24] = "";             // table label from the server (fixed buffer: no allocation inside the lock)
} sh;
TaskHandle_t netTask = nullptr;

void setLight(LightMode m, uint32_t color) {
  portENTER_CRITICAL(&mux);
  if (sh.mode != m || sh.color != color) { sh.mode = m; sh.color = color; sh.modeSince = millis(); }
  portEXIT_CRITICAL(&mux);
}
void showError() {
  portENTER_CRITICAL(&mux);
  if (sh.mode != LIGHT_ERROR) { sh.afterError = sh.mode; sh.afterErrorColor = sh.color; }  // a pending send keeps spinning after the blinks
  sh.mode = LIGHT_ERROR; sh.modeSince = millis();
  portEXIT_CRITICAL(&mux);
}
void wakeNet() { if (netTask) xTaskNotifyGive(netTask); }

// ---------------- Network ----------------
bool ensureWifi(uint32_t timeoutMs = 15000) {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (!cfg.ssid.length()) return false;
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);  // modem sleep between calls
  WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  const uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) vTaskDelay(pdMS_TO_TICKS(200));
  return WiFi.status() == WL_CONNECTED;
}

// POST {path} with the device key. Returns the HTTP status (or a negative error) and fills `out`.
int post(const char* path, JsonDocument& body, JsonDocument& out) {
  if (!ensureWifi()) return -100;
  String url = cfg.url;
  if (url.endsWith("/")) url.remove(url.length() - 1);
  url += path;
  String payload;
  serializeJson(body, payload);

  HTTPClient http;
  WiFiClientSecure tls;
  WiFiClient plain;
  bool ok;
  if (url.startsWith("https://")) { tls.setCACert(ROOT_CA_PEM); ok = http.begin(tls, url); }
  else ok = http.begin(plain, url);  // plain http: only on a trusted local network
  if (!ok) return -101;
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", cfg.key);
  const int code = http.POST(payload);
  if (code > 0) {
    const String resp = http.getString();
    out.clear();
    deserializeJson(out, resp);
  }
  http.end();
  return code;
}

void addTelemetry(JsonDocument& body) {
  body["battery"] = batteryPercent(batteryVolts());
  body["on_coaster"] = onCoaster();
  body["firmware"] = FIRMWARE_VERSION;
  if (WiFi.status() == WL_CONNECTED) body["rssi"] = WiFi.RSSI();
}

// Apply the server's answer to the light
void applyState(JsonDocument& out) {
  const char* light = out["light"] | "off";
  const char* type = out["request"]["type"].as<const char*>();
  LightMode m = modeFromServer(light);
  setLight(m, m == LIGHT_CANDLE ? COLOR_CANDLE : colorForType(type));
  const char* table = out["table"] | "";
  portENTER_CRITICAL(&mux);
  strncpy(sh.table, table, sizeof(sh.table) - 1);
  sh.table[sizeof(sh.table) - 1] = 0;
  portEXIT_CRITICAL(&mux);
}

// If the server says the café is closed, go to deep sleep instead of polling every few seconds.
// On wake the chip reboots from setup(), reconnects, and asks again — so a shorter closure than
// expected, a changed schedule or a holiday that ends early all sort themselves out on the next wake.
void maybeDeepSleep(JsonDocument& out) {
  const uint32_t sleepS = sleepSeconds(out["sleep_for_s"] | 0, MIN_DEEP_SLEEP_S, 6 * 3600);
  if (sleepS == 0) return;
  Serial.printf("Cafe closed. Deep sleep for %lu s.\n", (unsigned long)sleepS);
  Serial.flush();
  ring.clear();
  ring.show();
  WiFi.disconnect(true);
  esp_sleep_enable_timer_wakeup((uint64_t)sleepS * 1000000ULL);
  esp_deep_sleep_start();  // does not return; the chip restarts from setup() on wake
}

void networkTask(void*) {
  uint32_t nextPoll = 0;
  int failures = 0;
  uint32_t retryAt = 0;
  for (;;) {
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
    if (!configured()) continue;
    const uint32_t now = millis();
    if (failures && now < retryAt) continue;

    portENTER_CRITICAL(&mux);
    const int8_t face = sh.pendingFace;
    const bool cancel = sh.pendingCancel;
    const bool poll = sh.wantPoll || (int32_t)(now - nextPoll) >= 0;
    portEXIT_CRITICAL(&mux);
    if (face == FACE_NONE && !cancel && !poll) continue;

    JsonDocument body, out;
    addTelemetry(body);
    int code;
    if (cancel) code = post("/api/device/cancel", body, out);
    else if (face != FACE_NONE) { body["face"] = faceName((Face)face); code = post("/api/device/face", body, out); }
    else code = post("/api/device/heartbeat", body, out);

    if (code == 200) {
      failures = 0;
      portENTER_CRITICAL(&mux);
      if (cancel) sh.pendingCancel = false;
      else if (face != FACE_NONE && sh.pendingFace == face) sh.pendingFace = FACE_NONE;  // a newer flip may have arrived
      sh.wantPoll = false;
      portEXIT_CRITICAL(&mux);
      applyState(out);
      maybeDeepSleep(out);  // doesn't return if it decides to sleep
      nextPoll = millis() + pollIntervalMs(modeFromServer(out["light"] | "off"));
    } else if (code == 401 || code == 400 || code == 409) {
      // Not retryable: unknown/removed key, bad face, or cube not assigned to a table
      Serial.printf("[net] %d %s\n", code, (const char*)(out["error"] | ""));
      portENTER_CRITICAL(&mux);
      sh.pendingFace = FACE_NONE; sh.pendingCancel = false; sh.wantPoll = false;
      portEXIT_CRITICAL(&mux);
      showError();
      nextPoll = millis() + 60000;
    } else {
      failures++;
      retryAt = millis() + backoffMs(failures - 1);
      Serial.printf("[net] call failed (%d), retry in %lus\n", code, (unsigned long)(backoffMs(failures - 1) / 1000));
      if (face != FACE_NONE || cancel) showError();
    }
  }
}

// ---------------- Serial console ----------------
void printHelp() {
  Serial.println(F(
    "Pixberry Signal Cube " FIRMWARE_VERSION "\n"
    "  wifi <ssid> <password>   Wi-Fi network (password may contain spaces)\n"
    "  server <url>             Pixberry address, e.g. https://pos.mycafe.in\n"
    "  key <device key>         Key from the staff app (Cubes > Pair a new cube)\n"
    "  map <face>               Put <face> on top, then run this to teach the cube that side\n"
    "                           faces: rest service bill water order togo\n"
    "  status                   Show settings, battery, face and connection\n"
    "  test <face|cancel>       Send a face or cancel without moving the cube\n"
    "  reboot | forget          Restart | erase all settings"));
}
void printStatus(Face face) {
  char table[24];
  portENTER_CRITICAL(&mux);
  memcpy(table, sh.table, sizeof(table));
  const LightMode mode = sh.mode;
  portEXIT_CRITICAL(&mux);
  Serial.printf("Wi-Fi: %s (%s)\n", cfg.ssid.length() ? cfg.ssid.c_str() : "not set", WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "not connected");
  Serial.printf("Server: %s\nKey: %s\n", cfg.url.length() ? cfg.url.c_str() : "not set", cfg.key.length() ? "set" : "not set");
  Serial.printf("Table: %s  Face: %s  Light mode: %d\n", table[0] ? table : "?", faceName(face), (int)mode);
  Serial.printf("Battery: %.2f V (%d%%)  On coaster: %s  Accelerometer: %s\n", batteryVolts(), batteryPercent(batteryVolts()), onCoaster() ? "yes" : "no", accelOk ? "ok" : "NOT FOUND");
  Serial.print("Axis map (+X -X +Y -Y +Z -Z): ");
  for (int i = 0; i < 6; i++) Serial.printf("%s ", faceName(cfg.axisMap[i]));
  Serial.println();
}

FaceDetector* faces = nullptr;
String line;
void handleCommand(String cmd) {
  cmd.trim();
  const int sp = cmd.indexOf(' ');
  const String op = sp < 0 ? cmd : cmd.substring(0, sp);
  String arg = sp < 0 ? "" : cmd.substring(sp + 1);
  arg.trim();
  if (op == "help" || op == "") printHelp();
  else if (op == "wifi") {
    const int s2 = arg.indexOf(' ');
    cfg.ssid = s2 < 0 ? arg : arg.substring(0, s2);
    cfg.pass = s2 < 0 ? "" : arg.substring(s2 + 1);
    saveString("ssid", cfg.ssid); saveString("pass", cfg.pass);
    WiFi.disconnect(); Serial.println("Wi-Fi saved."); wakeNet();
  } else if (op == "server") {
    if (!arg.startsWith("http://") && !arg.startsWith("https://")) { Serial.println("Address must start with https:// (or http:// on a local network)."); return; }
    cfg.url = arg; saveString("url", arg); Serial.println("Server saved.");
    portENTER_CRITICAL(&mux); sh.wantPoll = true; portEXIT_CRITICAL(&mux); wakeNet();
  } else if (op == "key") {
    if (!arg.startsWith("pbd_")) { Serial.println("That doesn't look like a cube key (it starts with pbd_)."); return; }
    cfg.key = arg; saveString("key", arg); Serial.println("Key saved.");
    portENTER_CRITICAL(&mux); sh.wantPoll = true; portEXIT_CRITICAL(&mux); wakeNet();
  } else if (op == "map") {
    const Face f = faceFromName(arg.c_str());
    if (f == FACE_NONE) { Serial.println("Unknown face. Use: rest service bill water order togo"); return; }
    const int ax = accelOk ? upAxis(readAccel()) : -1;
    if (ax < 0) { Serial.println("Put the cube flat with that face on top and keep it still, then try again."); return; }
    for (int i = 0; i < 6; i++) if (cfg.axisMap[i] == f) cfg.axisMap[i] = FACE_NONE;
    cfg.axisMap[ax] = f; saveMap();
    Serial.printf("Saved: axis %d = %s. Reboot when all six faces are mapped.\n", ax, faceName(f));
  } else if (op == "status") printStatus(faces ? faces->reported() : FACE_NONE);
  else if (op == "test") {
    portENTER_CRITICAL(&mux);
    const Face tf = faceFromName(arg.c_str());
    if (arg == "cancel") sh.pendingCancel = true;
    else if (tf != FACE_NONE) sh.pendingFace = tf;
    portEXIT_CRITICAL(&mux);
    if (arg != "cancel" && tf == FACE_NONE) { Serial.println("Use: test rest|service|bill|water|order|togo|cancel"); return; }
    wakeNet(); Serial.println("Sending…");
  } else if (op == "reboot") ESP.restart();
  else if (op == "forget") { prefs.begin("signal", false); prefs.clear(); prefs.end(); Serial.println("Settings erased."); ESP.restart(); }
  else Serial.println("Unknown command. Type help.");
}
void readSerial() {
  while (Serial.available()) {
    const char c = Serial.read();
    if (c == '\n' || c == '\r') { if (line.length()) handleCommand(line); line = ""; }
    else if (line.length() < 200) line += c;
  }
}

// ---------------- Main loop ----------------
ShakeDetector shake;

void renderLeds() {
  const uint32_t now = millis();
  portENTER_CRITICAL(&mux);
  LightMode mode = sh.mode;
  uint32_t color = sh.color, since = sh.modeSince;
  if (mode == LIGHT_ERROR && errorFinished(now, since)) { sh.mode = sh.afterError; sh.color = sh.afterErrorColor; sh.modeSince = now; mode = sh.mode; color = sh.color; }
  portEXIT_CRITICAL(&mux);
  for (int i = 0; i < LED_COUNT; i++) {
    const RGB c = pixel(mode, color, i, LED_COUNT, now, since);
    ring.setPixelColor(i, c.r, c.g, c.b);
  }
  ring.show();
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_ON_COASTER, INPUT);
  analogReadResolution(12);
  ring.begin();
  ring.setBrightness(LED_MAX_BRIGHTNESS);
  ring.clear(); ring.show();

  loadSettings();
  faces = new FaceDetector(cfg.axisMap, FACE_SETTLE_MS);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  accelOk = accel.begin(LIS3DH_I2C_ADDR);
  if (accelOk) { accel.setRange(LIS3DH_RANGE_4_G); accel.setDataRate(LIS3DH_DATARATE_100_HZ); }
  else { Serial.println("Accelerometer not found. Check wiring (SDA/SCL) and address."); showError(); }

  xTaskCreate(networkTask, "net", 8192, nullptr, 1, &netTask);
  delay(300);
  printHelp();
  if (!configured()) { Serial.println("\nNot set up yet: run wifi, server and key."); setLight(LIGHT_SENDING, 0x666666); }
}

void loop() {
  static uint32_t lastSample = 0, lastLed = 0;
  readSerial();
  const uint32_t now = millis();

  if (accelOk && now - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = now;
    const Vec3 a = readAccel();
    if (shake.update(a, now)) {
      Serial.println("Shake: cancel");
      portENTER_CRITICAL(&mux); sh.pendingCancel = true; sh.pendingFace = FACE_NONE; portEXIT_CRITICAL(&mux);
      setLight(LIGHT_SENDING, COLOR_CANDLE);
      // The cube still lies on the same face; it stays "reported", so it isn't sent again until flipped.
      wakeNet();
    } else if (!shake.recentlyMoving(now)) {
      const Face f = faces->update(a, now);
      if (f != FACE_NONE) {
        Serial.printf("Face: %s\n", faceName(f));
        portENTER_CRITICAL(&mux); sh.pendingFace = f; portEXIT_CRITICAL(&mux);
        // Instant feedback: spin in the request colour until the server answers
        if (f == FACE_REST) setLight(LIGHT_OFF, COLOR_IDLE);
        else setLight(LIGHT_SENDING, colorForFace(f));
        wakeNet();
      }
    }
  }
  if (now - lastLed >= 20) { lastLed = now; renderLeds(); }
  delay(2);
}
