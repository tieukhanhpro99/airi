@echo off
:: AIRI Update Helper
:: Pulls upstream changes (dasilva333/airi) into local `main`, then rebases
:: your `feat/discord-voice` branch on top so the voice feature stays in sync.
::
:: Remote layout:
::   upstream  -> https://github.com/dasilva333/airi.git   (read-only source)
::   origin    -> https://github.com/tieukhanhpro99/airi.git (your fork / backup)

setlocal enabledelayedexpansion

echo.
echo === AIRI Update Helper ===
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [!] git is not on PATH. Install Git for Windows first.
    exit /b 1
)

:: Verify both remotes exist
git remote get-url upstream >nul 2>nul
if errorlevel 1 (
    echo [!] Remote 'upstream' is missing. Re-add with:
    echo     git remote add upstream https://github.com/dasilva333/airi.git
    exit /b 1
)
git remote get-url origin >nul 2>nul
if errorlevel 1 (
    echo [!] Remote 'origin' is missing. Re-add with:
    echo     git remote add origin https://github.com/tieukhanhpro99/airi.git
    exit /b 1
)

:: Refuse to run if there are uncommitted changes
git diff --quiet
if errorlevel 1 goto dirty
git diff --cached --quiet
if errorlevel 1 goto dirty
goto clean

:dirty
echo [!] You have uncommitted changes. Commit or stash them first:
echo     git status
echo     git stash --include-untracked   ^(restore later with: git stash pop^)
exit /b 1

:clean

echo [1/5] Fetching upstream (dasilva333/airi)...
git fetch upstream
if errorlevel 1 exit /b 1

echo.
echo [2/5] Updating local main from upstream/main...
git checkout main
if errorlevel 1 exit /b 1
git merge --ff-only upstream/main
if errorlevel 1 (
    echo [!] Could not fast-forward main. main has diverged from upstream/main.
    echo     Inspect: git log upstream/main..main
    echo     Reset hard ^(loses local main commits^): git reset --hard upstream/main
    exit /b 1
)

echo.
echo [3/5] Rebasing feat/discord-voice on top of new main...
git checkout feat/discord-voice
if errorlevel 1 (
    echo [!] feat/discord-voice branch missing.
    exit /b 1
)
git rebase main
if errorlevel 1 (
    echo.
    echo [!] Rebase paused with conflicts. Resolve in the listed files, then:
    echo         git add ^<file^>
    echo         git rebase --continue
    echo     Or abort: git rebase --abort
    exit /b 1
)

echo.
echo [4/5] Pushing both branches to your fork (origin = tieukhanhpro99/airi)...
git push origin main
if errorlevel 1 (
    echo [!] Push of main failed. You may need to: git push --force-with-lease origin main
)
git push --force-with-lease origin feat/discord-voice
if errorlevel 1 (
    echo [!] Push of feat/discord-voice failed.
)

echo.
echo [5/5] Reinstalling dependencies in case package.json moved...
call pnpm install --no-frozen-lockfile
if errorlevel 1 (
    echo [!] pnpm install failed. Check the output above.
    exit /b 1
)

echo.
echo === Update complete. On branch feat/discord-voice with latest upstream main. ===
echo.

endlocal
