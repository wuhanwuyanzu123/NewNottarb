@echo off
REM Read-only Yellowstone observer for the single watched LAST address.
setlocal
cd /d "%~dp0"
node.exe "%~dp0grpc-last.mjs" 1>>"%~dp0last-grpc.stdout.log" 2>>"%~dp0last-grpc.stderr.log"
