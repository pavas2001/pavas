@echo off
rem Thin wrapper so the Scheduled Task only has to point at one path (this file), which keeps the
rem schtasks command line simple even though "Program Files" itself contains a space.
rem %~dp0 is this file's own folder (with a trailing backslash), whatever drive/path it's installed to.
"%~dp0node\node.exe" "%~dp0app\scripts\closing-watch.js" %*
