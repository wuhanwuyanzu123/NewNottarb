@echo off
REM LAST activity lifecycle: observer/bridge stay resident; this process starts
REM the target-only no-send dry-run only for a fresh, bridge-validated route.
setlocal
cd /d "%~dp0"
node.exe "%~dp0last-notarb-supervisor.mjs" 1>>"%~dp0last-notarb-supervisor.stdout.log" 2>>"%~dp0last-notarb-supervisor.stderr.log"
