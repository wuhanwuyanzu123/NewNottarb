@echo off
REM Safe local bridge runner: it only reads LAST evidence and the local :18899
REM read-RPC tunnel, then regenerates target market/ALT files. It never sends.
setlocal
cd /d "%~dp0"
node.exe "%~dp0last-route-to-notarb.mjs" --interval=5000 --max-observer-staleness-seconds=30 1>>"%~dp0last-route-to-notarb.stdout.log" 2>>"%~dp0last-route-to-notarb.stderr.log"
