@echo off
rem Pixberry Signal counter display for a Windows PC or mini-PC at the counter.
rem Opens the display full screen. To start it automatically, put a shortcut to this file in
rem the Startup folder (press Win+R, type shell:startup, press Enter).
rem Change the address below to your Pixberry address. Press Alt+F4 to close the display.

set PIXBERRY_URL=https://pos.mycafe.in

rem Keep the screen on while plugged in
powercfg /change monitor-timeout-ac 0 >nul 2>&1

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --kiosk "%PIXBERRY_URL%/signal" --edge-kiosk-type=fullscreen --no-first-run --autoplay-policy=no-user-gesture-required
) else (
  start "" chrome --kiosk "%PIXBERRY_URL%/signal" --no-first-run --autoplay-policy=no-user-gesture-required
)
