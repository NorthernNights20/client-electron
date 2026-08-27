const path = require("path");

const POLL_INTERVAL_MS = 5000;

if (!process.versions.electron) {
  const { spawn } = require("child_process");
  const electronBinary = require("electron");

  const child = spawn(electronBinary, [__filename], {
    stdio: "inherit",
  });

  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  const { app, BrowserWindow, ipcMain, shell } = require("electron");
  const fs = require("fs");
  const fsp = require("fs/promises");
  const crypto = require("crypto");

  const lastWrittenHashes = new Map();

  function sanitizeRelativeTxtPath(inputPath) {
    if (typeof inputPath !== "string") return null;
    const normalized = inputPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || !normalized.toLowerCase().endsWith(".txt")) return null;
    if (normalized.split("/").includes("..")) return null;
    return normalized;
  }

  function contentHash(text) {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
  }

  async function writeTxtFilesToUserData(files) {
    if (!Array.isArray(files) || files.length === 0) {
      return { written: 0, skipped: 0, errors: 0 };
    }

    const savesDir = path.join(app.getPath("userData"), "saves");
    await fsp.mkdir(savesDir, { recursive: true });

    let written = 0;
    let skipped = 0;
    let errors = 0;

    for (const file of files) {
      const relativePath = sanitizeRelativeTxtPath(file?.path);
      if (!relativePath) {
        skipped += 1;
        continue;
      }

      const content = typeof file?.content === "string" ? file.content : "";
      const nextHash = contentHash(content);
      const previousHash = lastWrittenHashes.get(relativePath);

      if (previousHash === nextHash) {
        skipped += 1;
        continue;
      }

      const targetPath = path.join(savesDir, relativePath);
      const targetDir = path.dirname(targetPath);

      try {
        await fsp.mkdir(targetDir, { recursive: true });

        const tmpPath = `${targetPath}.tmp`;
        await fsp.writeFile(tmpPath, content, "utf8");
        await fsp.rename(tmpPath, targetPath);

        lastWrittenHashes.set(relativePath, nextHash);
        written += 1;
      } catch (error) {
        errors += 1;
        console.error("[sync] failed writing txt", relativePath, error);

        try {
          const tmpPath = `${targetPath}.tmp`;
          if (fs.existsSync(tmpPath)) {
            await fsp.unlink(tmpPath);
          }
        } catch {
          // Best effort cleanup.
        }
      }
    }

    return { written, skipped, errors };
  }

  app.setPath(
    "userData",
    path.join(app.getPath("appData"), "Northbound")
  );

  ipcMain.handle("sync:txt-files", async (_event, files) => {
    return writeTxtFilesToUserData(files);
  });

  ipcMain.handle("sync:config", () => {
    return {
      pollIntervalMs: POLL_INTERVAL_MS,
      appUserDataPath: app.getPath("userData"),
    };
  });

  const { BrowserView } = require("electron");

  const tabViews = new Map();
  let mainWindow;

  ipcMain.on("tab:create", (event, { tabId, url }) => {
    const view = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, "preload-view.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    tabViews.set(tabId, view);
    mainWindow.addBrowserView(view);

    const { width, height } = mainWindow.getContentBounds();
    view.setBounds({
      x: 0,
      y: 40,
      width: width,
      height: height - 40,
    });

    view.webContents.on("page-title-updated", (event, title) => {
      mainWindow.webContents.send("tab:title-updated", { tabId, title });
    });

    view.webContents.loadURL(url);
  });

  ipcMain.on("view-title-changed", (event, title) => {
    // Find which tab this came from and send to mainWindow
    for (const [tabId, view] of tabViews.entries()) {
      if (view.webContents === event.sender) {
        mainWindow.webContents.send("tab:title-updated", { tabId, title });
        break;
      }
    }
  });

  ipcMain.on("tab:close", (event, tabId) => {
    const view = tabViews.get(tabId);
    if (view) {
      mainWindow.removeBrowserView(view);
      view.webContents.destroy();
      tabViews.delete(tabId);
    }
  });

  ipcMain.on("tab:show", (event, tabId) => {
    tabViews.forEach((view) => {
      view.setBounds({ x: 0, y: -10000, width: 0, height: 0 });
    });

    const view = tabViews.get(tabId);
    if (view) {
      const { width, height } = mainWindow.getContentBounds();
      view.setBounds({
        x: 0,
        y: 40,
        width: width,
        height: height - 40,
      });
    }
  });

  ipcMain.on("open-saves-dir", () => {
    const savesDir = path.join(app.getPath("userData"), "saves/userfs/godot/app_userdata/WorldWriters");
    shell.openPath(savesDir);
  });

  app.whenReady().then(() => {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    mainWindow.loadFile("tabs.html");

    mainWindow.on("resize", () => {
      const { width, height } = mainWindow.getContentBounds();
      const activeView = Array.from(tabViews.values()).find((v) => {
        const bounds = v.getBounds();
        return bounds.y >= 0;
      });
      if (activeView) {
        activeView.setBounds({
          x: 0,
          y: 40,
          width: width,
          height: height - 40,
        });
      }
    });
  });
}