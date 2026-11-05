const $ = (id) => document.getElementById(id), $$ = (s) => [...document.querySelectorAll(s)];
const fa = (v, d = 0) => Number(v).toLocaleString("fa-IR", { useGrouping: false, maximumFractionDigits: d, minimumFractionDigits: d });
let st = { running: false, state: "idle", loggedIn: false, addr: "" }, settings = {};

function toast(t) { const e = $("toast"); e.textContent = t; e.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove("on"), 2400); }
function speed(b) { // bytes/s → value + unit
  if (b >= 1048576) return [fa(b / 1048576, 1), "MB/s"];
  return [fa(b / 1024, b < 10240 ? 1 : 0), "KB/s"];
}
function size(b) { return b >= 1073741824 ? fa(b / 1073741824, 2) + " GB" : b >= 1048576 ? fa(b / 1048576, 1) + " MB" : b > 0 ? fa(b / 1024, 0) + " KB" : ""; }

// ---- navigation ----
$$(".nav").forEach((b) => (b.onclick = () => {
  $$(".nav").forEach((x) => x.classList.toggle("on", x === b));
  $$(".page").forEach((p) => p.classList.toggle("on", p.id === "p-" + b.dataset.p));
}));

// ---- state → UI ----
const LABEL = { idle: ["آمادهٔ اتصال", ""], connecting: ["در حال اتصال…", "warn"], connected: ["متصل", "ok"], lost: ["ارتباط قطع شد", "bad"] };
function setState(s, msg = "") {
  st.state = s; Orbs.setState(s);
  const [t, cls] = LABEL[s]; $("chip").textContent = t; $("chip").className = "chip " + cls; $("msg").textContent = msg;
  const srv = $("d-srv"); srv.className = { connected: "ok", connecting: "warn", lost: "bad" }[s] || "";
  $("t-srv").textContent = { connected: "وصل", connecting: "…", lost: "قطع" }[s] || "—";
  if (s !== "connected") { $("addr").textContent = ""; $("copy").hidden = true; resetStats(); }
  const on = s === "connecting" || s === "connected" || (s === "lost" && st.running);
  st.running = on;
  $("go").textContent = on ? "قطع اتصال" : "اتصال"; $("go").classList.toggle("stop", on);
  $("port").disabled = $("lhost").disabled = on;
}
function resetStats() {
  $("s-ping").textContent = "—"; $("s-ping").className = ""; $("s-down").textContent = $("s-up").textContent = fa(0); $("s-conns").textContent = fa(0);
  $("tot-down").textContent = $("tot-up").textContent = ""; Orbs.setRates(0, 0, 0);
}
function netState() {
  const on = navigator.onLine; $("d-net").className = on ? "ok" : "bad"; $("t-net").textContent = on ? "آنلاین" : "آفلاین";
  if (!on && st.running) $("msg").textContent = "اینترنت کامپیوتر قطع است";
}
addEventListener("online", netState); addEventListener("offline", netState); netState();

api.on("status", (s) => {
  if (s.state === "connected") {
    st.addr = `${s.host}:${s.port}`; setState("connected"); $("addr").textContent = st.addr; $("copy").hidden = false; Orbs.burst();
  } else if (s.state === "connecting") setState("connecting");
  else if (s.state === "lost") { st.running = !s.final; setState("lost", s.final ? "" : "در حال تلاش مجدد…"); }
  else if (s.state === "error") { st.running = false; setState("idle"); $("err").textContent = { unauthorized: "نشست منقضی شده؛ دوباره وارد شوید", too_many_tunnels: "تعداد اتصال‌های هم‌زمان به حد مجاز رسیده", no_free_port: "پورت آزادی روی سرور نیست" }[s.error] || s.error; }
  else if (s.state === "stopped") setState("idle");
});
api.on("stats", (s) => {
  if (st.state !== "connected") return;
  const p = $("s-ping"); p.textContent = s.ping == null ? "—" : fa(s.ping);
  p.className = s.ping == null ? "" : s.ping < 80 ? "ok" : s.ping < 200 ? "warn" : "bad";
  const [dv, du] = speed(s.down), [uv, uu] = speed(s.up);
  $("s-down").textContent = dv; $("u-down").textContent = du; $("s-up").textContent = uv; $("u-up").textContent = uu;
  $("tot-down").textContent = size(s.totDown); $("tot-up").textContent = size(s.totUp); $("s-conns").textContent = fa(s.conns);
  Orbs.setRates(s.down, s.up, s.ping || 0);
});
api.on("autostarted", (p) => { $("port").value = p; setState("connecting"); });

// ---- connect / login ----
$("go").onclick = async () => {
  $("err").textContent = "";
  if (st.running) { await api.stop(); st.running = false; return setState("idle"); }
  const port = +$("port").value;
  if (!(port > 0 && port < 65536)) return ($("err").textContent = "شمارهٔ پورت معتبر نیست");
  const r = await api.start({ localPort: port, localHost: $("lhost").value.trim() });
  if (!r.ok) $("err").textContent = r.error;
};
$("copy").onclick = async () => { await api.copy(st.addr); toast("آدرس کپی شد"); };
async function login(btn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = "منتظر ورود در مرورگر…";
  const r = await api.login(); btn.disabled = false; btn.textContent = old;
  r.ok ? refreshSession() : ($("login-err").textContent = r.error);
}
$("login1").onclick = () => login($("login1")); $("login2").onclick = () => login($("login2"));

async function refreshSession() {
  const s = await api.session(); st.loggedIn = s.loggedIn;
  $("connect").hidden = !s.loggedIn; $("needlogin").hidden = s.loggedIn;
  $("acc-in").hidden = !s.loggedIn; $("acc-out").hidden = s.loggedIn;
  $("a-email").textContent = s.email; $("avatar").textContent = (s.email[0] || "؟").toUpperCase();
}

// ---- account ----
$("logout").onclick = async () => { await api.logout(); setState("idle"); refreshSession(); };
$("revoke").onclick = async () => {
  if (!confirm("از همهٔ دستگاه‌ها خارج شوید؟")) return;
  const r = await api.account("revoke"); r.ok ? (setState("idle"), refreshSession(), toast("از همه خارج شدید")) : toast(r.error);
};
$("del").onclick = async () => {
  if (!confirm("حساب برای همیشه حذف شود؟")) return;
  const r = await api.account("delete", { password: $("dp").value }); r.ok ? (setState("idle"), refreshSession(), toast("حساب حذف شد")) : toast(r.error);
};
$("chg").onclick = async () => {
  $("perr").textContent = "";
  const r = await api.account("password", { old: $("op").value, new: $("np").value });
  if (r.ok) { $("op").value = $("np").value = ""; toast("رمز عبور تغییر کرد"); } else $("perr").textContent = r.error;
};
$("site").onclick = () => api.openSite();

// ---- settings ----
function applyTheme(t) { document.documentElement.dataset.theme = t; $$("#theme button").forEach((b) => b.classList.toggle("on", b.dataset.v === t)); }
$$("#theme button").forEach((b) => (b.onclick = () => { applyTheme(b.dataset.v); api.setSettings({ theme: b.dataset.v }); }));
[["st-reconnect", "reconnect"], ["st-auto", "autoConnect"], ["st-start", "autoStart"]].forEach(([id, k]) => ($(id).onchange = (e) => api.setSettings({ [k]: e.target.checked })));
$("st-host").onchange = (e) => { api.setSettings({ localHost: e.target.value.trim() || "127.0.0.1" }); $("lhost").placeholder = e.target.value.trim() || "127.0.0.1"; };

(async () => {
  settings = await api.getSettings(); applyTheme(settings.theme);
  $("st-reconnect").checked = settings.reconnect; $("st-auto").checked = settings.autoConnect; $("st-start").checked = settings.autoStart;
  $("st-host").value = settings.localHost; $("lhost").placeholder = settings.localHost; $("st-server").textContent = settings.serverUrl;
  if (settings.lastPort) $("port").value = settings.lastPort;
  await refreshSession(); setState("idle");
})();
