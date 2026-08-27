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
  const { app, BrowserWindow, ipcMain } = require("electron");
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

  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    win.loadURL("https://client.northboundproject.uk/web/");
  });
}