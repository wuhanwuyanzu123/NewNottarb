@echo off
REM LAST live lifecycle: start the sender only for a fresh bridge-validated route.
setlocal
cd /d "%~dp0"
node.exe "%~dp0last-notarb-supervisor.mjs" --config="%~dp0notarb-last-grpc-live.toml" --assert="%~dp0assert-last-live.mjs" --runner="%~dp0run-notarb-last-target-live.cmd" --state="%~dp0.last-notarb-live-supervisor-state.json" 1>>"%~dp0last-notarb-live-supervisor.stdout.log" 2>>"%~dp0last-notarb-live-supervisor.stderr.log"
