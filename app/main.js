const { app, BrowserWindow, ipcMain, shell, safeStorage, clipboard } = require("electron");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Tunnel = require("./tunnel");
const { SERVER_URL } = require("./config");

let win, tunnel, loginServer;
const U = (f) => path.join(app.getPath("userData"), f);
const push = (ch, v) => win && !win.isDestroyed() && win.webContents.send(ch, v);

// ---- session (token encrypted with the OS keychain) ----
const readSession = () => {
  try { const b = fs.readFileSync(U("session.bin")); return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString()); }
  catch { return null; }
};
const writeSession = (s) => {
  const t = JSON.stringify(s);
  fs.writeFileSync(U("session.bin"), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(t) : t);
};
function doLogout() { tunnel && tunnel.stop(); tunnel = null; try { fs.unlinkSync(U("session.bin")); } catch {} }

// ---- settings ----
const DEF = { theme: "dark", autoStart: false, autoConnect: false, reconnect: true, localHost: "127.0.0.1", lastPort: "", want: 0 };
let settings = { ...DEF };
try { settings = { ...DEF, ...JSON.parse(fs.readFileSync(U("settings.json"), "utf8")) }; } catch {}
const saveSettings = () => fs.writeFileSync(U("settings.json"), JSON.stringify(settings));

function startTunnel(localPort, localHost) {
  const s = readSession();
  if (!s) return { ok: false, error: "ابتدا وارد شوید" };
  tunnel && tunnel.stop();
  const same = String(settings.lastPort) === String(localPort);
  settings.lastPort = String(localPort); if (!same) settings.want = 0; saveSettings();
  tunnel = new Tunnel({ host: s.host, controlPort: s.controlPort, token: s.token, localHost: localHost || settings.localHost, localPort: +localPort, want: settings.want, reconnect: settings.reconnect });
  tunnel.on("status", (v) => {
    if (v.state === "connected") { settings.want = v.port; saveSettings(); }
    push("status", v);
  });
  tunnel.on("stats", (v) => push("stats", v));
  return { ok: true };
}

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 680, minWidth: 880, minHeight: 620, autoHideMenuBar: true, backgroundColor: "#000000", title: "بیاوصل شو",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile("index.html");
  win.webContents.once("did-finish-load", () => {
    if (settings.autoConnect && settings.lastPort && readSession()) { startTunnel(settings.lastPort); push("autostarted", settings.lastPort); }
  });
}

// ---- browser login: temporary loopback server receives the token ----
ipcMain.handle("login", () => new Promise((resolve) => {
  loginServer && loginServer.close();
  const state = crypto.randomBytes(16).toString("hex");
  const srv = (loginServer = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname !== "/callback" || u.searchParams.get("state") !== state) { res.writeHead(404); return res.end(); }
    const token = u.searchParams.get("token"), email = u.searchParams.get("email") || "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<meta charset="utf-8"><body style="font:20px Tahoma;text-align:center;padding-top:20vh;background:#000;color:#fff" dir="rtl">وصل شدید! به برنامه برگردید.</body>');
    srv.close(); loginServer = null;
    fetch(SERVER_URL + "/api/info").then((r) => r.json()).then((info) => {
      writeSession({ token, email, host: info.host, controlPort: +info.control_port });
      win.show(); win.focus(); resolve({ ok: true });
    }).catch(() => resolve({ ok: false, error: "سرور در دسترس نیست" }));
  }));
  srv.listen(0, "127.0.0.1", () => shell.openExternal(`${SERVER_URL}/connect?port=${srv.address().port}&state=${state}`));
  setTimeout(() => { if (loginServer === srv) { srv.close(); loginServer = null; resolve({ ok: false, error: "زمان ورود تمام شد" }); } }, 5 * 60 * 1000);
}));

ipcMain.handle("session", () => { const s = readSession(); return { loggedIn: !!s, email: s ? s.email : "" }; });
ipcMain.handle("logout", () => { doLogout(); return true; });
ipcMain.handle("copy", (_, t) => clipboard.writeText(t));
ipcMain.handle("openSite", () => shell.openExternal(SERVER_URL));
ipcMain.handle("start", (_, { localPort, localHost }) => startTunnel(localPort, localHost));
ipcMain.handle("stop", () => { tunnel && tunnel.stop(); tunnel = null; return true; });
ipcMain.handle("settings:get", () => ({ ...settings, serverUrl: SERVER_URL }));
ipcMain.handle("settings:set", (_, patch) => {
  Object.keys(patch).forEach((k) => k in DEF && (settings[k] = patch[k]));
  if ("autoStart" in patch) app.setLoginItemSettings({ openAtLogin: !!patch.autoStart });
  saveSettings(); return settings;
});

// ---- account management (server API with the app's bearer token) ----
ipcMain.handle("account", async (_, op, body) => {
  const s = readSession();
  if (!s) return { ok: false, error: "وارد نشده‌اید" };
  const url = { password: "/api/password", revoke: "/api/revoke-all", delete: "/api/delete-account" }[op];
  try {
    const r = await fetch(SERVER_URL + url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.token }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.error || "خطا" };
    if (op !== "password") doLogout();
    return { ok: true };
  } catch { return { ok: false, error: "سرور در دسترس نیست" }; }
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
