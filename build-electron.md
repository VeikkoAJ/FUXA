# Building FUXA Electron App for Windows

Personal build guide based on actual trial and error.

## Prerequisites

- Node.js **18 or 20 LTS** on Windows (Node 24 breaks sqlite3 native build)
- Git Bash on Windows
- Windows **Developer Mode** enabled (Settings → System → For developers → Developer Mode: On)
  - Required so 7-Zip can create symlinks when extracting winCodeSign

## Project structure the build expects

Before running electron-builder, `app/electron/` must contain:

```
app/electron/
  server/            ← copy of /server with Windows node_modules
  client/
    dist/            ← Angular build output from /client/dist
  main.js
  icons/
  ...
```

## Full build steps

Run all commands from the **project root** in Git Bash on Windows.

### 1. Install server dependencies (Windows-native)

```sh
cd server && npm install && cd ..
```

### 2. Build the client

```sh
cd client && npm install && npm run build && cd ..
```

### 3. Copy server into app/electron and install Windows deps

```sh
cp -r server app/electron/server

# If server/node_modules was installed on Linux (WSL), remove it first
rm -rf app/electron/server/node_modules

cd app/electron/server && npm install && cd ../..
```

### 4. Copy client build output

```sh
mkdir -p app/electron/client
cp -r client/dist app/electron/client/dist
```

### 5. Build the Electron app

```sh
cd app/electron && npm install
npm run package -- --win    # unpacked .exe, no installer
# or
npm run dist -- --win       # full NSIS installer
```

Output lands in `app/electron/dist/win-unpacked/FUXA.exe`.

## Notes

- The README says `cd ./app && npm run package` — this is **outdated**. The package.json is in `./app/electron`.
- `sqlite3` is a native module. It must be compiled/installed on Windows, not copied from WSL. That's why step 3 reinstalls it inside `app/electron/server/`.
- The `extraResources` in `package.json` packages `server/node_modules` into the app's resources directory at runtime — so those modules must be Windows binaries.
- Running from WSL directly requires Wine installed (`sudo apt install winehq-stable`), which is more hassle than just building natively on Windows.
