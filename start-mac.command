#!/bin/bash
# Starts a local web server for BrewBot and opens it in Chrome (or the default browser).
# Voice input needs the page to be served from localhost (not opened as a file).
cd "$(dirname "$0")"
(sleep 1; open -a "Google Chrome" http://localhost:8000 || open http://localhost:8000) &
python3 -m http.server 8000
