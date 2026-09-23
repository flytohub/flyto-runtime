@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "MODE=%~1"
if not defined MODE set "MODE=menu"

where node.exe >nul 2>nul
if errorlevel 1 goto :missing_node

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit((a>22||(a===22&&b>=19))&&a<27?0:1)" >nul 2>nul
if errorlevel 1 goto :bad_node

if /I "%MODE%"=="install" (
  if exist "%ROOT%\pnpm-lock.yaml" goto :prepare_source
  if exist "%ROOT%\dist\cli.js" goto :run
)
if exist "%ROOT%\dist\cli.js" goto :run

:prepare_source
where pnpm.cmd >nul 2>nul
if errorlevel 1 (
  where corepack.cmd >nul 2>nul
  if not errorlevel 1 corepack enable >nul 2>nul
)
where pnpm.cmd >nul 2>nul
if errorlevel 1 goto :missing_pnpm

echo Preparing Flyto2 Runtime...
call pnpm.cmd install --frozen-lockfile
if errorlevel 1 goto :install_failed
call pnpm.cmd build
if errorlevel 1 goto :build_failed

:run
if not exist "%ROOT%\dist\cli.js" goto :missing_build
pushd "%ROOT%" >nul
if /I "%MODE%"=="menu" (
  node.exe dist\cli.js menu
) else if /I "%MODE%"=="start" (
  node.exe dist\cli.js service start
) else if /I "%MODE%"=="doctor" (
  node.exe dist\cli.js doctor
) else if /I "%MODE%"=="setup" (
  node.exe dist\cli.js init --force
) else if /I "%MODE%"=="launcher-install" (
  node.exe dist\cli.js launcher install
) else if /I "%MODE%"=="install" (
  node.exe dist\cli.js service install
  if not errorlevel 1 node.exe dist\cli.js launcher install
) else (
  node.exe dist\cli.js %*
)
set "RESULT=%ERRORLEVEL%"
popd >nul
if not "%RESULT%"=="0" (
  echo.
  echo Flyto2 Runtime exited with code %RESULT%.
  pause
)
exit /b %RESULT%

:missing_node
echo.
echo Flyto2 Runtime failed to start: Node.js was not found.
echo Install Node.js ^>=22.19 and ^<27 first.
pause
exit /b 1

:bad_node
for /f "delims=" %%V in ('node -v 2^>nul') do set "NODE_VERSION=%%V"
echo.
echo Flyto2 Runtime failed to start: unsupported Node.js version %NODE_VERSION%.
echo Required: ^>=22.19 ^<27.
pause
exit /b 1

:missing_pnpm
echo.
echo Flyto2 Runtime needs pnpm to build this source checkout.
echo Run: corepack enable
pause
exit /b 1

:install_failed
echo.
echo Flyto2 Runtime dependency installation failed.
pause
exit /b 1

:build_failed
echo.
echo Flyto2 Runtime build failed.
pause
exit /b 1

:missing_build
echo.
echo Flyto2 Runtime build is missing.
echo Run Install.cmd or pnpm build.
pause
exit /b 1
