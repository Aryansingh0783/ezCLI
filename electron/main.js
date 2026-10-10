'use strict';

const path = require('path');
const { app, BrowserWindow, shell, Menu } = require('electron');

const server = require('../server.js');

let mainWindow = null;
let serverHandle = null;

async function createWindow() {
  // Port 0 asks the OS for a free one, so we never collide with
  // another ezCLI the user may be running from the terminal.
  serverHandle = await server.start({ host: '127.0.0.1', port: 0, quiet: true });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#000000',
    title: 'ezCLI',
    icon: path.join(
      __dirname,
      '..',
      'docs',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    ),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Any new-window request (links in CLI output, etc.) opens in the
  // user's real browser rather than inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverHandle.url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  await mainWindow.loadURL(serverHandle.url);
}

app.whenReady().then(createWindow).catch((err) => {
  console.error('ezCLI failed to start:', err);
  app.quit();
});

app.on('window-all-closed', async () => {
  if (serverHandle) {
    try {
      await serverHandle.close();
    } catch {
      /* already gone */
    }
    serverHandle = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
