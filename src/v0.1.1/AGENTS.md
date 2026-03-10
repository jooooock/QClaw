# apps/electron - Electron Desktop Application

> Generated: 2026-02-26
> Analysis Scope: Full subpackage analysis

## Project Overview

This is the Electron desktop application package for GuanjiaClaw - a desktop wrapper that manages the OpenClaw AI Gateway service. The application provides a native desktop experience for controlling and monitoring the OpenClaw service, including process lifecycle management, configuration editing, and chat interface capabilities.

**Core Responsibilities**:
- Manage OpenClaw Gateway process lifecycle (start/stop/restart)
- Provide IPC bridge between renderer (UI) and main process
- Handle application configuration persistence and backups
- Expose chat API through the running OpenClaw service
- Auto-update functionality (planned)

## Technology Stack

| Category | Technology |
|----------|------------|
| Runtime | Electron 37.0 |
| Build Tool | electron-vite 3.0 |
| Bundler | Rollup (via electron-vite) |
| Language | TypeScript 5.6 |
| Package Manager | pnpm workspace |
| Distribution | electron-builder 25.0 |
| Auto Updates | electron-updater 6.6.2 |
| Utilities | @electron-toolkit/utils 3.0 |

**Internal Dependencies**:
- `@guanjia-openclaw/shared` - Shared types and Zod schemas

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron Application                      │
├─────────────────────────────────────────────────────────────┤
│  Renderer Process (UI)                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  React/Vue UI (loaded from ../ui or dev server)    │    │
│  │  Access: window.electronAPI                         │    │
│  └─────────────────────────────────────────────────────┘    │
│                          ↕ IPC                               │
├─────────────────────────────────────────────────────────────┤
│  Preload Script                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  contextBridge.exposeInMainWorld('electronAPI')    │    │
│  │  Type-safe IPC wrappers                             │    │
│  └─────────────────────────────────────────────────────┘    │
│                          ↕ IPC                               │
├─────────────────────────────────────────────────────────────┤
│  Main Process                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  src/main/index.ts         - Application entry     │    │
│  │  src/main/ipc/             - IPC handlers          │    │
│  │  src/main/server/          - Business logic        │    │
│  │    ├── process/            - OpenClaw management   │    │
│  │    ├── config/             - Config management     │    │
│  │    ├── chat/               - Chat service client   │    │
│  │    └── models/             - Model management      │    │
│  └─────────────────────────────────────────────────────┘    │
│                          ↓ spawn                             │
├─────────────────────────────────────────────────────────────┤
│  OpenClaw Gateway (child process)                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  resources/openclaw/node_modules/openclaw          │    │
│  │  Node.js process running OpenClaw Gateway          │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
apps/electron/
├── src/
│   ├── main/                    # Main process code
│   │   ├── index.ts             # Application entry point
│   │   ├── ipc/
│   │   │   └── index.ts         # IPC handler registration
│   │   ├── server/              # Business logic modules
│   │   │   ├── index.ts         # Module exports
│   │   │   ├── process/         # Process management
│   │   │   │   ├── process-manager.ts   # Lifecycle coordinator
│   │   │   │   ├── openclaw-service.ts  # OpenClaw process wrapper
│   │   │   │   ├── health-check.ts      # Health check utilities
│   │   │   │   └── paths.ts             # Path resolution
│   │   │   ├── config/          # Configuration management
│   │   │   │   ├── manager.ts   # Config CRUD + backups
│   │   │   │   └── index.ts     # Exports
│   │   │   ├── chat/            # Chat API client
│   │   │   │   ├── chatService.ts  # SSE stream handler
│   │   │   │   └── index.ts
│   │   │   └── models/          # Model management
│   │   │       └── index.ts     # List/set default model
│   │   └── auto-updater.ts      # Auto-update setup (planned)
│   └── preload/                 # Preload script
│       ├── index.ts             # contextBridge API exposure
│       └── index.d.ts           # Window interface extension
├── resources/
│   └── openclaw/                # Bundled OpenClaw package
│       └── package.json         # Depends on openclaw npm
├── scripts/
│   └── afterPack.js             # Build optimization hook
├── electron.vite.config.ts      # Vite build config
├── electron-builder.yml         # Distribution config
├── tsconfig.json                # TypeScript project refs
└── tsconfig.node.json           # Main/preload TS config
```

## Core Modules

### 1. Main Process Entry (`src/main/index.ts`)

**Responsibilities**:
- Create and configure the main BrowserWindow
- Set up IPC handlers on app ready
- Manage window lifecycle (show, close, quit)
- Auto-start OpenClaw service on window ready
- Clean up OpenClaw service on app quit

**Window Configuration**:
```typescript
{
  width: 1200,
  height: 800,
  minWidth: 800,
  minHeight: 600,
  titleBarStyle: 'hiddenInset',      // macOS style
  trafficLightPosition: { x: 15, y: 10 },
  webPreferences: {
    preload: '../preload/index.mjs',
    sandbox: false,
    contextIsolation: true,           // Security: enabled
    nodeIntegration: false            // Security: disabled
  }
}
```

### 2. IPC Layer (`src/main/ipc/index.ts`)

**Design Pattern**: Registration layer only - delegates business logic to server modules.

**IPC Channels**:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `process:start` | invoke | Start OpenClaw service |
| `process:stop` | invoke | Stop OpenClaw service |
| `process:restart` | invoke | Restart OpenClaw service |
| `process:getStatus` | invoke | Get current process status |
| `process:status` | send | Status change events (push) |
| `process:log` | send | Log events (push) |
| `config:get` | invoke | Get current configuration |
| `config:set` | invoke | Update configuration |
| `config:validate` | invoke | Validate config without saving |
| `config:getBackups` | invoke | List backup files |
| `config:rollback` | invoke | Restore latest backup |
| `config:restoreBackup` | invoke | Restore specific backup |
| `chat:completions` | invoke | Non-streaming chat (TODO) |
| `chat:completions-stream` | invoke | Streaming chat request |
| `chat:stream` | send | Stream chunks (push) |
| `models:list` | invoke | List available models |
| `models:setDefault` | invoke | Set default model |

**Event Forwarding Pattern**:
```typescript
// Push events from ProcessManager to all windows
processManager.onStatusChange((status) => {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('process:status', status)
  })
})
```

### 3. Preload Script (`src/preload/index.ts`)

**Purpose**: Securely expose main process APIs to renderer via contextBridge.

**Security Model**:
- Uses `contextIsolation: true`
- Uses `contextBridge.exposeInMainWorld()`
- No direct Node.js access in renderer

**API Structure** (matches `@guanjia-openclaw/shared` types):
```typescript
window.electronAPI = {
  process: {
    start(options?), stop(), restart(), getStatus(),
    onLog(callback), onStatusChange(callback)
  },
  config: {
    get(), set(config), validate(config),
    getBackups(), rollback(), restoreBackup(filename)
  },
  chat: {
    completions(request),
    completionsStream(request, onChunk)
  },
  models: {
    list(), setDefault(modelId)
  },
  platform: 'darwin' | 'win32' | 'linux'
}
```

### 4. Process Manager (`src/main/server/process/`)

**OpenClawService** (`openclaw-service.ts`):
- Extends EventEmitter for status/log events
- Spawns OpenClaw Gateway as child process
- Manages process lifecycle with timeout handling
- Handles stdout/stderr stream parsing
- Implements graceful shutdown (SIGTERM -> SIGKILL fallback)

**ProcessManager** (`process-manager.ts`):
- Singleton pattern via `getProcessManager()`
- Wraps OpenClawService with application lifecycle hooks
- Handles app quit, window close, process signals
- Error recovery for uncaught exceptions

**Health Check** (`health-check.ts`):
- HTTP GET to `http://127.0.0.1:{port}/v1/health`
- Retry mechanism with configurable attempts
- Used to verify service startup

**Path Resolution** (`paths.ts`):
```typescript
// Production: resources/openclaw/node_modules/openclaw
// Development: apps/electron/resources/openclaw/node_modules/openclaw
getOpenClawPath(): string

// Default: ~/.openclaw/openclaw.json
getConfigPath(): string
```

### 5. Configuration Manager (`src/main/server/config/manager.ts`)

**Features**:
- JSON file persistence at `~/.openclaw/openclaw.json`
- Zod schema validation via `OpenClawConfigSchema`
- Deep merge for partial updates
- Automatic backup before changes (keeps 5 most recent)
- Rollback and restore capabilities

**Default Configuration**:
```json
{
  "gateway": {
    "port": 18789,
    "bind": "loopback",
    "auth": { "mode": "none" }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "claude-sonnet-4.5" }
    }
  },
  "providers": {}
}
```

### 6. Chat Service (`src/main/server/chat/chatService.ts`)

**Purpose**: SSE (Server-Sent Events) client for OpenClaw chat API.

**Features**:
- Streaming responses via `fetch` + `ReadableStream`
- SSE parsing (`data: {...}` format)
- AbortController for cancellation
- Returns cleanup handle for resource management

### 7. Models Management (`src/main/server/models/index.ts`)

**Features**:
- List available models (currently hardcoded)
- Set default model in configuration
- Syncs with ConfigManager

## IPC Communication Patterns

### Request-Response (invoke/handle)
```typescript
// Renderer
const status = await window.electronAPI.process.getStatus()

// Main
ipcMain.handle('process:getStatus', async () => {
  return processManager.getStatus()
})
```

### Server-Sent Events (send/on)
```typescript
// Main: Broadcast to all windows
processManager.onLog((log) => {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('process:log', log)
  })
})

// Preload: Subscribe with cleanup
onLog: (callback) => {
  const handler = (_, log) => callback(log)
  ipcRenderer.on('process:log', handler)
  return () => ipcRenderer.removeListener('process:log', handler)
}
```

### Streaming API Pattern
```typescript
// Preload: Streaming chat
completionsStream: (request, onChunk) => {
  const handler = (_, chunk) => onChunk(chunk)
  ipcRenderer.on('chat:stream', handler)
  ipcRenderer.invoke('chat:completions-stream', request)
  return () => ipcRenderer.removeListener('chat:stream', handler)
}
```

## Window Management

**Single Window Application**:
- One main window created on app ready
- macOS: Recreate window on activate (Dock click)
- Non-macOS: Quit on all windows closed

**URL Loading**:
- Development: `http://localhost:5175` (Vite dev server)
- Production: `file://.../renderer/index.html`

**External Links**:
- Opened in default browser via `shell.openExternal()`
- Blocked from opening in Electron window

## Build and Distribution

### Build Tools

**electron-vite**:
- Separate builds for main and preload scripts
- Rollup bundling with externalization
- Outputs to `./out/` directory

**electron-builder**:
- DMG for macOS (x64 + arm64)
- NSIS installer for Windows (x64)
- Bundles OpenClaw as extraResource

### Build Optimization

The `afterPack.js` hook aggressively reduces bundle size:

| Optimization | Savings |
|-------------|---------|
| Remove unused .lproj locales | ~50-55 MB |
| Remove node_modules docs/tests | ~20+ MB |
| Remove source maps (.map) | ~62 MB |
| Remove TypeScript definitions | ~2.7 MB |
| Remove Chromium LICENSES | ~15 MB |

**Supported Languages**: en, zh_CN, zh_TW

### Resource Bundling

OpenClaw is bundled via `pnpm deploy`:
```
resources/openclaw/
├── package.json          # Depends on "openclaw" npm
└── node_modules/
    └── openclaw/         # Actual OpenClaw package
```

## Development Workflow

### Commands

```bash
# Development (hot reload)
pnpm dev

# Build main + preload
pnpm build

# Build macOS installer
pnpm build:mac

# Build Windows installer
pnpm build:win
```

### Environment Detection

```typescript
import { is } from '@electron-toolkit/utils'

if (is.dev) {
  mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
} else {
  mainWindow.loadFile(getUIPath())
}
```

## Security Considerations

1. **Context Isolation**: Enabled - renderer cannot access Node.js directly
2. **Node Integration**: Disabled in renderer
3. **Sandbox**: Disabled (required for preload script functionality)
4. **External Navigation**: Blocked, opens in system browser
5. **IPC Validation**: Types enforced via TypeScript + shared types

## Error Handling

### Process Lifecycle
- Startup timeout (30 seconds)
- Graceful shutdown with SIGTERM, fallback to SIGKILL (5 seconds)
- Uncaught exception handling with cleanup

### Configuration
- Zod validation before persistence
- Automatic backup before changes
- Rollback on write failure

### IPC
- Try-catch in handlers
- Error propagation to renderer via rejected promises

## Known Limitations / TODOs

1. **Chat API**: Currently returns mock responses - needs HTTP client implementation
2. **Auto-updater**: Setup exists but update server URL is placeholder
3. **Model List**: Hardcoded models - should fetch from OpenClaw API
4. **Health Check**: Not integrated into startup flow (service starts without verification)

## Dependencies

### Production
- `@electron-toolkit/utils` - Electron dev/prod utilities
- `electron-updater` - Auto-update functionality

### Development
- `electron` - Electron runtime
- `electron-builder` - Distribution builder
- `electron-vite` - Build tooling
- `typescript` - Type checking

### Internal
- `@guanjia-openclaw/shared` - Type definitions and Zod schemas

## Related Files

- `../shared/` - Shared types and validation schemas
- `../ui/` - Renderer UI (loaded as web content)
- Root `AGENTS.md` - Monorepo overview
