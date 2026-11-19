@echo off
REM Starts a local web server for BrewBot and opens it in the default browser.
REM Voice input needs the page to be served from localhost (not opened as a file).
cd /d "%~dp0"
start "" http://localhost:8000
python -m http.server 8000 || py -m http.server 8000
pause
