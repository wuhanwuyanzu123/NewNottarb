@echo off
REM Safe local bridge runner: it only reads LAST evidence and the local :18899
REM read-RPC tunnel, then regenerates target market/ALT files. It never sends.
setlocal
cd /d "%~dp0"
node.exe "%~dp0last-route-to-notarb.mjs" --interval=15000 1>>"%~dp0last-route-to-notarb.active.stdout.log" 2>>"%~dp0last-route-to-notarb.active.stderr.log"
