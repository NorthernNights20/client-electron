const { contextBridge, ipcRenderer } = require("electron");

const textDecoder = new TextDecoder("utf-8");
let syncInFlight = false;
let pollTimer = null;

function normalizeVirtualPath(p) {
	if (typeof p !== "string") return null;
	const normalized = p.replace(/\\/g, "/").trim();
	if (!normalized || !normalized.toLowerCase().endsWith(".txt")) return null;
	return normalized.replace(/^\/+/, "");
}

function asText(value) {
	if (typeof value === "string") return value;
	if (value == null) return "";
	if (value instanceof ArrayBuffer) {
		return textDecoder.decode(new Uint8Array(value));
	}
	if (ArrayBuffer.isView(value)) {
		return textDecoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	}
	if (typeof value === "object") {
		if (typeof value.content === "string") return value.content;
		if (typeof value.contents === "string") return value.contents;
		if (value.content instanceof ArrayBuffer || ArrayBuffer.isView(value.content)) {
			return asText(value.content);
		}
		if (value.contents instanceof ArrayBuffer || ArrayBuffer.isView(value.contents)) {
			return asText(value.contents);
		}
	}

	return "";
}

function collectTxtFromGodotFs() {
	const FS = window.FS || window.Module?.FS;
	if (!FS) return null;

	const isDir =
		typeof FS.isDir === "function"
			? FS.isDir
			: (mode) => (typeof mode === "number" ? (mode & 0o170000) === 0o040000 : false);

	const collected = [];
	const visited = new Set();

	function walk(dirPath) {
		if (visited.has(dirPath)) return;
		visited.add(dirPath);

		let children = [];
		try {
			children = FS.readdir(dirPath);
		} catch {
			return;
		}

		for (const name of children) {
			if (name === "." || name === "..") continue;
			const childPath = dirPath === "/" ? `/${name}` : `${dirPath}/${name}`;

			let stat;
			try {
				stat = FS.stat(childPath);
			} catch {
				continue;
			}

			if (isDir(stat.mode)) {
				walk(childPath);
				continue;
			}

			const relativePath = normalizeVirtualPath(childPath);
			if (!relativePath) continue;

			try {
				const content = FS.readFile(childPath, { encoding: "utf8" });
				collected.push({ path: relativePath, content: String(content) });
			} catch {
				// Ignore unreadable files and continue.
			}
		}
	}

	walk("/");
	return collected;
}

function findTxtCandidatesFromRaw(key, value) {
	const out = [];

	const keyAsPath = typeof key === "string" ? normalizeVirtualPath(key) : null;
	if (keyAsPath) {
		out.push({ path: keyAsPath, content: asText(value) });
	}

	if (value && typeof value === "object") {
		const pathValue =
			normalizeVirtualPath(value.path) ||
			normalizeVirtualPath(value.name) ||
			normalizeVirtualPath(value.filename) ||
			normalizeVirtualPath(value.key);

		if (pathValue) {
			out.push({
				path: pathValue,
				content: asText(value.content ?? value.contents ?? value.data ?? value.value),
			});
		}
	}

	return out.filter((candidate) => candidate.path);
}

async function collectTxtFromIndexedDbRaw() {
	if (typeof indexedDB === "undefined") return [];
	if (typeof indexedDB.databases !== "function") return [];

	const databaseInfos = await indexedDB.databases();
	const map = new Map();

	for (const dbInfo of databaseInfos || []) {
		if (!dbInfo?.name) continue;

		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open(dbInfo.name, dbInfo.version);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error || new Error("open failed"));
			request.onblocked = () => reject(new Error("open blocked"));
		}).catch(() => null);

		if (!db) continue;

		try {
			for (const storeName of db.objectStoreNames) {
				const rows = await new Promise((resolve) => {
					const tx = db.transaction(storeName, "readonly");
					const store = tx.objectStore(storeName);
					const getAllReq = store.getAll();
					const getAllKeysReq = store.getAllKeys();

					tx.oncomplete = () => {
						const values = Array.isArray(getAllReq.result) ? getAllReq.result : [];
						const keys = Array.isArray(getAllKeysReq.result) ? getAllKeysReq.result : [];
						resolve({ values, keys });
					};

					tx.onerror = () => resolve({ values: [], keys: [] });
				});

				for (let i = 0; i < rows.values.length; i += 1) {
					const candidates = findTxtCandidatesFromRaw(rows.keys[i], rows.values[i]);
					for (const candidate of candidates) {
						map.set(candidate.path, candidate.content);
					}
				}
			}
		} finally {
			db.close();
		}
	}

	return [...map.entries()].map(([path, content]) => ({ path, content }));
}

async function collectTxtSnapshot() {
	const fromFs = collectTxtFromGodotFs();
	if (Array.isArray(fromFs) && fromFs.length > 0) {
		return fromFs;
	}

	return collectTxtFromIndexedDbRaw();
}

async function syncNow() {
	if (syncInFlight) return;
	syncInFlight = true;

	try {
		const txtFiles = await collectTxtSnapshot();
		if (!Array.isArray(txtFiles) || txtFiles.length === 0) return;

		await ipcRenderer.invoke("sync:txt-files", txtFiles);
	} catch (error) {
		console.error("[sync] snapshot failed", error);
	} finally {
		syncInFlight = false;
	}
}

async function startSyncLoop() {
	const config = await ipcRenderer.invoke("sync:config").catch(() => null);
	const intervalMs = Number(config?.pollIntervalMs) > 0 ? Number(config.pollIntervalMs) : 5000;

	await syncNow();
	pollTimer = setInterval(syncNow, intervalMs);
}

window.addEventListener("DOMContentLoaded", () => {
	startSyncLoop().catch((error) => {
		console.error("[sync] loop init failed", error);
	});
});

window.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") {
		syncNow();
	}
});

window.addEventListener("beforeunload", () => {
	syncNow();
});

contextBridge.exposeInMainWorld("electronGodotSync", {
	flushTxtNow: () => syncNow(),
	stop: () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	},
});
