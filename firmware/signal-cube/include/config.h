// Pixberry Signal Cube — board pins and tuning. Change these to match your build.
#pragma once
#include <CubeLogic.h>

#define FIRMWARE_VERSION "0.1.0"

// ---- Pins (ESP32-C3 SuperMini / DevKitM-1; see README for wiring) ----
#define PIN_I2C_SDA 8
#define PIN_I2C_SCL 9
#define PIN_LEDS 10          // WS2812B / SK6812 data in
#define PIN_BATTERY_ADC 3    // battery + through a 100k/100k divider (reads half the cell voltage)
#define PIN_ON_COASTER 4     // HIGH while the wireless charger is powering the cube (charger "power good")
#define ON_COASTER_ACTIVE HIGH

// ---- LEDs ----
#define LED_COUNT 12
#define LED_MAX_BRIGHTNESS 160  // 0–255; caps current draw and glare

// ---- Accelerometer (LIS3DH) ----
#define LIS3DH_I2C_ADDR 0x18    // 0x19 if SDO is tied high
#define SAMPLE_INTERVAL_MS 20   // 50 Hz

// ---- Behaviour ----
#define FACE_SETTLE_MS 1000     // the face must stay on top this long before it is sent
#define BATTERY_DIVIDER 2.0f    // battery volts = ADC volts × this

// ---- Closed-café sleep ----
// The server tells the cube how long the café will stay closed for (POST responses include
// "sleep_for_s"). Below this many seconds it's not worth the deep-sleep/reboot cost, so the cube
// just keeps its normal slow heartbeat instead.
#define MIN_DEEP_SLEEP_S 300

// Which face is on top for each accelerometer axis pointing up.
// Order: +X, -X, +Y, -Y, +Z, -Z. Set it on the device instead with the `map <face>` serial command.
static const cube::Face DEFAULT_AXIS_MAP[6] = {
  cube::FACE_SERVICE, cube::FACE_BILL,   // +X, -X
  cube::FACE_WATER,   cube::FACE_TOGO,   // +Y, -Y
  cube::FACE_REST,    cube::FACE_ORDER,  // +Z (board flat, Candle face up), -Z
};
