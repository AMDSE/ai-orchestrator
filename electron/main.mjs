// electron/main.mjs — Electron 桌面版主进程
// 启动内置 Express 后端服务，并在无边框窗口中加载前端控制台
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { startServer } from '../backend/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 错误日志（便于诊断打包后问题） ─────────────────────────────
const logFile = path.join(os.tmpdir(), 'ai-orchestrator-electron.log');
function log(msg) {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch {}
}
process.on('uncaughtException', (e) => log('uncaughtException: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.stack || e)));
log('app starting...');

let mainWindow = null;
let serverHandle = null;

async function createWindow() {
  try {
    // 启动内置后端服务
    if (!serverHandle) {
      serverHandle = await startServer(process.env.PORT || 3000);
      log('server started on port ' + serverHandle.port);
    }
    const port = serverHandle.port;

    mainWindow = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 1024,
      minHeight: 680,
      frame: false,
      show: false,
      backgroundColor: '#0d1017',
      title: 'AI Orchestrator',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    await mainWindow.loadURL(`http://localhost:${port}`);
    log('renderer loaded');
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });
  } catch (e) {
    log('createWindow error: ' + (e && e.stack || e));
  }
}

// ── 窗口控制 IPC ─────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

app.whenReady().then(async () => {
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { serverHandle?.server?.close(); } catch {}
});
