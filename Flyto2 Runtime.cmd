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
rem pnpm is found, never installed: enabling corepack needs write access next
rem to node, which most installs lack, and Node 25+ has no corepack. Same order
rem as src\flyto2\pnpm-command.ts.
pushd "%ROOT%" >nul
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
set "PNPM_VERSION="
for /f "usebackq delims=" %%v in (`node.exe -p "require('./package.json').packageManager.split('@')[1].split('+')[0]"`) do set "PNPM_VERSION=%%v"
set "PNPM="
where pnpm.cmd >nul 2>nul && set "PNPM=pnpm.cmd"
if not defined PNPM where corepack.cmd >nul 2>nul && set "PNPM=corepack.cmd pnpm"
if not defined PNPM if defined PNPM_VERSION where npm.cmd >nul 2>nul && set "PNPM=npm.cmd exec --yes --package=pnpm@%PNPM_VERSION% -- pnpm"
if not defined PNPM goto :missing_pnpm

echo Preparing Flyto2 Runtime...
call %PNPM% install --frozen-lockfile
if errorlevel 1 goto :install_failed
call %PNPM% build
if errorlevel 1 goto :build_failed
popd >nul

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
  rem init is a no-op once configured, so a first run is walked through setup.
  node.exe dist\cli.js init
  if not errorlevel 1 node.exe dist\cli.js service install
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
echo Flyto2 Runtime needs pnpm to build this source checkout, and neither
echo corepack nor npm is available to run it. Reinstall Node.js from https://nodejs.org.
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
