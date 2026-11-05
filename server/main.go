// بیاوصل شو — server. Stdlib only, needs Go 1.24+.
// Build: go build -o biavasl-server .
// Run:   PUBLIC_HOST=1.2.3.4 ./biavasl-server -http :8080 -control :7000
package main

import (
	"bufio"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/mail"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

const (
	portMin, portMax = 20000, 40000
	maxTunnels       = 5
)

// ---------- storage (single JSON file) ----------

type User struct {
	Salt string `json:"salt"`
	Hash string `json:"hash"`
}
type DB struct {
	Users    map[string]User   `json:"users"`
	Tokens   map[string]string `json:"tokens"`   // sha256(token) -> email  (desktop app)
	Sessions map[string]string `json:"sessions"` // sha256(sid)   -> email  (website)
}

var (
	db      = DB{Users: map[string]User{}, Tokens: map[string]string{}, Sessions: map[string]string{}}
	dbMu    sync.Mutex
	dbFile  string
	publicH string
	ctlPort string
)

func load() {
	if b, err := os.ReadFile(dbFile); err == nil {
		json.Unmarshal(b, &db)
	}
}
func save() { // call with dbMu held
	b, _ := json.MarshalIndent(db, "", " ")
	os.WriteFile(dbFile+".tmp", b, 0600)
	os.Rename(dbFile+".tmp", dbFile)
}
func rnd(n int) string { b := make([]byte, n); rand.Read(b); return hex.EncodeToString(b) }
func sum(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func pw(p, salt string) string {
	k, _ := pbkdf2.Key(sha256.New, p, []byte(salt), 200000, 32)
	return hex.EncodeToString(k)
}

// ---------- website + API ----------

func jsonOut(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func sessionUser(r *http.Request) string {
	c, err := r.Cookie("sid")
	if err != nil {
		return ""
	}
	dbMu.Lock()
	defer dbMu.Unlock()
	return db.Sessions[sum(c.Value)]
}

func setSession(w http.ResponseWriter, r *http.Request, email string) {
	sid := rnd(32)
	dbMu.Lock()
	db.Sessions[sum(sid)] = email
	save()
	dbMu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "sid", Value: sid, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: 30 * 86400,
		Secure: r.Header.Get("X-Forwarded-Proto") == "https" || r.TLS != nil})
}

// authedUser accepts the website cookie or the desktop app's bearer token.
func authedUser(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		dbMu.Lock()
		defer dbMu.Unlock()
		return db.Tokens[sum(strings.TrimPrefix(h, "Bearer "))]
	}
	return sessionUser(r)
}

func checkPW(email, p string) bool {
	dbMu.Lock()
	u, ok := db.Users[email]
	dbMu.Unlock()
	return ok && subtle.ConstantTimeCompare([]byte(pw(p, u.Salt)), []byte(u.Hash)) == 1
}

func revokeAll(email string) { // dbMu held
	for k, v := range db.Tokens {
		if v == email {
			delete(db.Tokens, k)
		}
	}
	for k, v := range db.Sessions {
		if v == email {
			delete(db.Sessions, k)
		}
	}
}

type creds struct{ Email, Password string }

func readCreds(r *http.Request) (creds, string) {
	var c creds
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&c) != nil {
		return c, "درخواست نامعتبر است"
	}
	a, err := mail.ParseAddress(strings.TrimSpace(c.Email))
	if err != nil {
		return c, "ایمیل معتبر نیست"
	}
	c.Email = strings.ToLower(a.Address)
	return c, ""
}

func routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFS, "web")
	mux.Handle("/fonts/", http.FileServer(http.FS(sub)))
	page := func(w http.ResponseWriter, r *http.Request) {
		b, _ := fs.ReadFile(sub, "index.html")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(b)
	}
	mux.HandleFunc("/{$}", page)
	mux.HandleFunc("/connect", page)

	mux.HandleFunc("GET /api/info", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, 200, map[string]any{"host": publicH, "control_port": ctlPort})
	})
	mux.HandleFunc("GET /api/me", func(w http.ResponseWriter, r *http.Request) {
		if e := authedUser(r); e != "" {
			jsonOut(w, 200, map[string]string{"email": e})
			return
		}
		jsonOut(w, 401, map[string]string{"error": "وارد نشده‌اید"})
	})
	mux.HandleFunc("POST /api/signup", func(w http.ResponseWriter, r *http.Request) {
		c, msg := readCreds(r)
		if msg == "" && len(c.Password) < 8 {
			msg = "رمز عبور باید حداقل ۸ کاراکتر باشد"
		}
		if msg != "" {
			jsonOut(w, 400, map[string]string{"error": msg})
			return
		}
		dbMu.Lock()
		if _, ok := db.Users[c.Email]; ok {
			dbMu.Unlock()
			jsonOut(w, 409, map[string]string{"error": "این ایمیل قبلاً ثبت شده است"})
			return
		}
		salt := rnd(16)
		db.Users[c.Email] = User{Salt: salt, Hash: pw(c.Password, salt)}
		save()
		dbMu.Unlock()
		setSession(w, r, c.Email)
		jsonOut(w, 200, map[string]string{"email": c.Email})
	})
	mux.HandleFunc("POST /api/signin", func(w http.ResponseWriter, r *http.Request) {
		c, msg := readCreds(r)
		if msg != "" {
			jsonOut(w, 400, map[string]string{"error": msg})
			return
		}
		dbMu.Lock()
		u, ok := db.Users[c.Email]
		dbMu.Unlock()
		good := ok && subtle.ConstantTimeCompare([]byte(pw(c.Password, u.Salt)), []byte(u.Hash)) == 1
		if !good {
			time.Sleep(500 * time.Millisecond)
			jsonOut(w, 401, map[string]string{"error": "ایمیل یا رمز عبور اشتباه است"})
			return
		}
		setSession(w, r, c.Email)
		jsonOut(w, 200, map[string]string{"email": c.Email})
	})
	mux.HandleFunc("POST /api/signout", func(w http.ResponseWriter, r *http.Request) {
		if c, err := r.Cookie("sid"); err == nil {
			dbMu.Lock()
			delete(db.Sessions, sum(c.Value))
			save()
			dbMu.Unlock()
		}
		http.SetCookie(w, &http.Cookie{Name: "sid", Path: "/", MaxAge: -1})
		jsonOut(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/password", func(w http.ResponseWriter, r *http.Request) {
		e := authedUser(r)
		var b struct{ Old, New string }
		if e == "" {
			jsonOut(w, 401, map[string]string{"error": "وارد نشده‌اید"})
			return
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&b) != nil || len(b.New) < 8 {
			jsonOut(w, 400, map[string]string{"error": "رمز جدید باید حداقل ۸ کاراکتر باشد"})
			return
		}
		if !checkPW(e, b.Old) {
			time.Sleep(500 * time.Millisecond)
			jsonOut(w, 403, map[string]string{"error": "رمز فعلی اشتباه است"})
			return
		}
		salt := rnd(16)
		dbMu.Lock()
		db.Users[e] = User{Salt: salt, Hash: pw(b.New, salt)}
		save()
		dbMu.Unlock()
		jsonOut(w, 200, map[string]bool{"ok": true})
	})
	// sign out everywhere: invalidates every website session and app token of this user
	mux.HandleFunc("POST /api/revoke-all", func(w http.ResponseWriter, r *http.Request) {
		e := authedUser(r)
		if e == "" {
			jsonOut(w, 401, map[string]string{"error": "وارد نشده‌اید"})
			return
		}
		dbMu.Lock()
		revokeAll(e)
		save()
		dbMu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: "sid", Path: "/", MaxAge: -1})
		jsonOut(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/delete-account", func(w http.ResponseWriter, r *http.Request) {
		e := authedUser(r)
		var b struct{ Password string }
		if e == "" {
			jsonOut(w, 401, map[string]string{"error": "وارد نشده‌اید"})
			return
		}
		json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&b)
		if !checkPW(e, b.Password) {
			time.Sleep(500 * time.Millisecond)
			jsonOut(w, 403, map[string]string{"error": "رمز عبور اشتباه است"})
			return
		}
		dbMu.Lock()
		delete(db.Users, e)
		revokeAll(e)
		save()
		dbMu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: "sid", Path: "/", MaxAge: -1})
		jsonOut(w, 200, map[string]bool{"ok": true})
	})
	// Called by the website after login when the desktop app opened it: mints an app token.
	mux.HandleFunc("POST /api/authorize", func(w http.ResponseWriter, r *http.Request) {
		e := sessionUser(r)
		if e == "" {
			jsonOut(w, 401, map[string]string{"error": "وارد نشده‌اید"})
			return
		}
		t := rnd(32)
		dbMu.Lock()
		db.Tokens[sum(t)] = e
		save()
		dbMu.Unlock()
		jsonOut(w, 200, map[string]string{"token": t, "email": e})
	})
	return mux
}

// ---------- tunnel ----------

type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufConn) Read(p []byte) (int, error) { return b.r.Read(p) }

var (
	pending   = map[string]chan net.Conn{}
	pendingMu sync.Mutex
	active    = map[string]int{}
	activeMu  sync.Mutex
)

type msg struct {
	Type  string `json:"type"`
	Token string `json:"token,omitempty"`
	ID    string `json:"id,omitempty"`
	T     int64  `json:"t,omitempty"`
	Want  int    `json:"want,omitempty"`
	Port  int    `json:"port,omitempty"`
	Host  string `json:"host,omitempty"`
	Error string `json:"error,omitempty"`
}

func listenPublic(want int) (net.Listener, int) {
	if want >= portMin && want <= portMax {
		if l, err := net.Listen("tcp", ":"+strconv.Itoa(want)); err == nil {
			return l, want
		}
	}
	for i := 0; i < 200; i++ {
		var b [2]byte
		rand.Read(b[:])
		p := portMin + int(uint16(b[0])<<8|uint16(b[1]))%(portMax-portMin)
		if l, err := net.Listen("tcp", ":"+strconv.Itoa(p)); err == nil {
			return l, p
		}
	}
	return nil, 0
}

func handleControl(raw net.Conn) {
	if tc, ok := raw.(*net.TCPConn); ok {
		tc.SetKeepAlive(true)
		tc.SetKeepAlivePeriod(30 * time.Second)
	}
	br := bufio.NewReader(raw)
	raw.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := br.ReadBytes('\n')
	if err != nil {
		raw.Close()
		return
	}
	var m msg
	if json.Unmarshal(line, &m) != nil {
		raw.Close()
		return
	}
	switch m.Type {
	case "data": // second connection from the app, carrying one visitor's traffic
		raw.SetReadDeadline(time.Time{})
		pendingMu.Lock()
		ch := pending[m.ID]
		delete(pending, m.ID)
		pendingMu.Unlock()
		if ch == nil {
			raw.Close()
			return
		}
		ch <- &bufConn{raw, br}
	case "auth":
		runTunnel(raw, br, m)
	default:
		raw.Close()
	}
}

func runTunnel(c net.Conn, br *bufio.Reader, m msg) {
	defer c.Close()
	var wmu sync.Mutex
	send := func(v msg) {
		wmu.Lock()
		defer wmu.Unlock()
		b, _ := json.Marshal(v)
		c.Write(append(b, '\n'))
	}
	dbMu.Lock()
	email := db.Tokens[sum(m.Token)]
	dbMu.Unlock()
	if email == "" {
		send(msg{Type: "error", Error: "unauthorized"})
		return
	}
	activeMu.Lock()
	if active[email] >= maxTunnels {
		activeMu.Unlock()
		send(msg{Type: "error", Error: "too_many_tunnels"})
		return
	}
	active[email]++
	activeMu.Unlock()
	defer func() { activeMu.Lock(); active[email]--; activeMu.Unlock() }()

	ln, port := listenPublic(m.Want)
	if ln == nil {
		send(msg{Type: "error", Error: "no_free_port"})
		return
	}
	defer ln.Close()
	log.Printf("tunnel up: %s -> :%d", email, port)
	defer log.Printf("tunnel down: %s :%d", email, port)
	send(msg{Type: "ready", Port: port, Host: publicH})

	go func() { // visitors
		for {
			v, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer v.Close()
				id := rnd(8)
				ch := make(chan net.Conn, 1)
				pendingMu.Lock()
				pending[id] = ch
				pendingMu.Unlock()
				send(msg{Type: "conn", ID: id})
				select {
				case d := <-ch:
					defer d.Close()
					done := make(chan struct{}, 2)
					go func() { io.Copy(d, v); done <- struct{}{} }()
					go func() { io.Copy(v, d); done <- struct{}{} }()
					<-done
				case <-time.After(10 * time.Second):
					pendingMu.Lock()
					delete(pending, id)
					pendingMu.Unlock()
				}
			}()
		}
	}()

	for { // the app pings every 5s; we echo it back so it can measure latency
		c.SetReadDeadline(time.Now().Add(60 * time.Second))
		l, err := br.ReadBytes('\n')
		if err != nil {
			return
		}
		var p msg
		if json.Unmarshal(l, &p) == nil && p.Type == "ping" {
			send(msg{Type: "pong", T: p.T})
		}
	}
}

func main() {
	httpAddr := flag.String("http", ":8080", "website/API address (put HTTPS reverse proxy in front)")
	ctlAddr := flag.String("control", ":7000", "tunnel control address")
	flag.StringVar(&dbFile, "db", "data.json", "storage file")
	flag.Parse()
	publicH = os.Getenv("PUBLIC_HOST")
	if publicH == "" {
		log.Fatal("set PUBLIC_HOST to this server's public IP or domain")
	}
	_, ctlPort, _ = net.SplitHostPort(*ctlAddr)
	load()

	ln, err := net.Listen("tcp", *ctlAddr)
	if err != nil {
		log.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				continue
			}
			go handleControl(c)
		}
	}()
	fmt.Printf("بیاوصل شو  web %s  control %s  public host %s\n", *httpAddr, *ctlAddr, publicH)
	log.Fatal(http.ListenAndServe(*httpAddr, routes()))
}
