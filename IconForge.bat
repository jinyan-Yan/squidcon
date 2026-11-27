@echo off
pushd "%~dp0"
echo Starting IconForge...

if "%~1"=="" (
  call npm start
) else (
  call npm start -- %*
)

if errorlevel 1 (
  echo.
  echo Failed to start. Check the error above.
  pause
)

popd
