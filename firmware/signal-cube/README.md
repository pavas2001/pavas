# Signal Cube firmware

Firmware for the prototype **Pixberry Signal Cube**. Guests flip the cube to ask for something. The cube tells the Pixberry server, and its light shows whether staff have seen the request.

It talks to the device API described in the main [README](../../README.md#connecting-cubes).

## Parts for one prototype cube

| Part | Example | Notes |
| --- | --- | --- |
| Microcontroller | ESP32-C3 SuperMini (or ESP32-C3-DevKitM-1) | Wi-Fi, USB-C for flashing |
| Accelerometer | LIS3DH breakout (I²C) | Tells which face is up and detects shakes |
| LEDs | 12 × WS2812B / SK6812 ring, about 37 mm | Use a 3.3 V-tolerant ring, or add a level shifter |
| Battery | 1-cell Li-ion/LiPo, 1000–2000 mAh | With protection circuit |
| Charging | Qi receiver coil + charger board (e.g. TP4056 with a "power good" or charging output) | Charges on the coaster |
| Voltage divider | 2 × 100 kΩ resistors | Battery voltage into the ADC |
| Case | 58 mm frosted cube, 3D-printed (PETG, frosted) or cast acrylic | Icons on each face |

## Wiring (default pins, change them in `include/config.h`)

| Signal | ESP32-C3 pin |
| --- | --- |
| LIS3DH SDA / SCL | GPIO 8 / GPIO 9 (plus 3V3 and GND) |
| LED ring data in | GPIO 10 |
| Battery + through 100k/100k divider | GPIO 3 (the midpoint of the divider) |
| Charger "power good" (HIGH while on the coaster) | GPIO 4 |

Mount the board flat with the accelerometer's **+Z axis pointing up through the Candle face**. If you mount it differently, use the `map` command (below) to teach the cube which side is which.

## Build and flash

You need [PlatformIO](https://platformio.org/install/cli) (the command line, or the VS Code extension).

```bash
cd firmware/signal-cube
pio run -e esp32c3 -t upload     # build and flash over USB
pio device monitor -e esp32c3    # open the serial console (115200 baud)
pio test -e native               # run the logic tests on your computer
```

## Set up a cube

1. In the Pixberry staff app, open **Cubes › Pair a new cube**, choose the table, and copy the key.
2. Connect the cube by USB, open the serial console, and type:

```
wifi CafeWiFi our wifi password
server https://pos.mycafe.in
key pbd_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
status
```

3. Optional, only if the faces don't match: put each face on top in turn and type `map <face>` (`rest`, `service`, `bill`, `water`, `order`, `togo`). Then type `reboot`.
4. Run `test water` to send a request without moving the cube. Check that it appears on the counter display.

Settings are kept in flash. `forget` erases them.

## What the cube does

| Guest action | Cube | Server call |
| --- | --- | --- |
| Turns a face to the top and leaves it for 1 s | The ring spins in the request colour, then stays lit | `POST /api/device/face` |
| Turns it past other faces on the way | Nothing is sent for faces that weren't held still for 1 s | none |
| Turns the Candle face up | Light off (or candle flicker in evening mode); the request is cancelled | `POST /api/device/face` with `rest` |
| Shakes it twice | The request is cancelled; the face stays as it is until flipped | `POST /api/device/cancel` |

The light then follows what staff do. The cube asks the server every 8 s while waiting, every 15 s once someone is coming, and every 3 min otherwise. That last call also reports battery, coaster and Wi-Fi signal.

| Light | Meaning |
| --- | --- |
| Steady colour | Request sent, waiting for staff |
| Slow breathing | A waiter tapped "On my way" |
| Fast pulse | Late: nobody has answered yet |
| Warm flicker | Evening mode, nothing requested |
| Spinning | Sending |
| Three red blinks | The send failed. It retries automatically: 1 s, 2 s, 4 s and so on, up to 1 min. If the key was removed or the cube has no table, it stops and blinks again on the next try. |
| Off, then asleep | The café is closed. The light turns off and, once the server says it will stay closed for at least 5 more minutes, the cube goes into deep sleep until roughly then (capped at 6 hours, so it still checks in if the schedule changes). Flipping a face while closed is simply ignored — nobody is there to answer. |

Network calls run in their own task, so the light keeps animating even when Wi-Fi is slow.

## Security

- Every call carries the cube's key in `X-Device-Key`. The server stores only a hash of it. Removing the cube in the staff app stops the key working.
- For `https://` servers, the cube checks the server certificate against the root in `include/ca_cert.h`. That is **ISRG Root X1** (Let's Encrypt), which most hosts use. If your host uses another certificate authority, replace it with that root certificate.
- `http://` is allowed only for a server on the café's own network. The key is sent unencrypted there, so prefer https.

## Closed hours

Opening hours are set once, on the server, under **Settings › Opening hours** — nothing to configure on the cube. Every response from the server (`face`, `cancel`, `heartbeat`) includes how long the café will stay closed for, and the cube acts on that on its own.

## Known limits of this prototype

- **Battery life during opening hours isn't optimised yet.** While the café is open, the cube stays awake with Wi-Fi in modem sleep and polls while a request is open. Overnight sleep (above) already saves most of the idle time; the next step is to also use the accelerometer's motion interrupt to doze between flips during the day, with Wi-Fi off between calls.
- **Setup is over USB serial.** A phone setup screen (Bluetooth or a temporary Wi-Fi hotspot) would make pairing easier in a café.
- **No haptic motor or light sensor yet.** The light pins and timings are in `config.h` ready for them.
