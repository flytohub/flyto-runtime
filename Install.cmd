@echo off
setlocal
call "%~dp0Flyto2 Runtime.cmd" install
exit /b %ERRORLEVEL%
