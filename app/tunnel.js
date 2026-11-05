const net = require("net");
const { EventEmitter } = require("events");

// One Tunnel = one control connection. Per visitor the server sends {"type":"conn","id"};
// we open a local socket + a data socket to the server and pipe them (counting bytes).
class Tunnel extends EventEmitter {
  constructor({ host, controlPort, token, localHost, localPort, want, reconnect = true }) {
    super();
    Object.assign(this, { host, controlPort, token, localHost, localPort, want: want || 0, reconnect });
    this.stopped = false; this.conns = 0; this.delay = 1000; this.rtt = null;
    this.rx = 0; this.tx = 0; let pr = 0, pt = 0;
    this.stats = setInterval(() => {
      this.emit("stats", { ping: this.rtt, down: this.rx - pr, up: this.tx - pt, totDown: this.rx, totUp: this.tx, conns: this.conns });
      pr = this.rx; pt = this.tx;
    }, 1000);
    this.connect();
  }
  connect() {
    if (this.stopped) return;
    this.emit("status", { state: "connecting" });
    const c = (this.ctl = net.connect(this.controlPort, this.host));
    c.setKeepAlive(true, 30000);
    let buf = "";
    c.on("connect", () => c.write(JSON.stringify({ type: "auth", token: this.token, want: this.want }) + "\n"));
    c.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { this.onMsg(JSON.parse(line)); } catch {}
      }
    });
    c.on("error", () => {});
    c.on("close", () => {
      clearInterval(this.pingTimer); this.rtt = null;
      if (this.stopped) return;
      if (!this.reconnect) { this.stopped = true; return this.emit("status", { state: "lost", final: true }); }
      this.emit("status", { state: "lost" });
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 15000);
    });
  }
  onMsg(m) {
    if (m.type === "ready") {
      this.want = m.port; this.delay = 1000; this.lastPong = Date.now();
      const ping = () => {
        if (Date.now() - this.lastPong > 16000) return this.ctl.destroy(); // silent drop → reconnect
        this.ctl.write(JSON.stringify({ type: "ping", t: Date.now() }) + "\n");
      };
      ping(); this.pingTimer = setInterval(ping, 5000);
      this.emit("status", { state: "connected", host: m.host, port: m.port });
    } else if (m.type === "pong") {
      this.lastPong = Date.now(); this.rtt = Date.now() - m.t;
    } else if (m.type === "error") {
      this.stopped = true; this.ctl.destroy();
      this.emit("status", { state: "error", error: m.error });
    } else if (m.type === "conn") this.pipe(m.id);
  }
  pipe(id) {
    const local = net.connect(this.localPort, this.localHost);
    const data = net.connect(this.controlPort, this.host);
    let up = false;
    const end = () => { local.destroy(); data.destroy(); if (up) { up = false; this.conns--; } };
    local.on("error", end); data.on("error", end); local.on("close", end); data.on("close", end);
    local.on("connect", () => {
      up = true; this.conns++;
      data.write(JSON.stringify({ type: "data", id }) + "\n");
      data.on("data", (d) => (this.rx += d.length)); // visitors → your PC  (download)
      local.on("data", (d) => (this.tx += d.length)); // your PC → visitors  (upload)
      local.pipe(data); data.pipe(local);
    });
  }
  stop() {
    this.stopped = true; clearInterval(this.pingTimer); clearInterval(this.stats);
    this.ctl && this.ctl.destroy(); this.emit("status", { state: "stopped" });
  }
}
module.exports = Tunnel;
