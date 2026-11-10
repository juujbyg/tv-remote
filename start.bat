@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
start "" http://localhost:8787/
node server.js
