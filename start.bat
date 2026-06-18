@echo off
REM CodeFlow one-command launcher (Windows). Requires Docker Desktop running.
cd /d "%~dp0"

if not exist codeflow.env (
  echo First run: create codeflow.env with your Gemini key, e.g.
  echo     echo GEMINI_API_KEY=your-key-here^> codeflow.env
  echo Get a free key at https://aistudio.google.com/apikey
  exit /b 1
)

echo Building + starting CodeFlow (first build takes a few minutes)...
docker compose --env-file codeflow.env -f docker-compose.app.yml up -d --build
if errorlevel 1 exit /b 1

echo.
echo CodeFlow is starting -^> open http://localhost:5173
echo Logs:  docker compose -f docker-compose.app.yml logs -f
echo Stop:  docker compose -f docker-compose.app.yml down   (add -v to also wipe the database)
