/* ProxyProof – Bluetooth attendance (web prototype)
   Layers:  Server (verification + storage)  |  Radio (BLE transport)  |  UI (organiser / student)  */

// ---------- utils ----------
const $ = s => document.querySelector(s);
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const hmac = async (key, msg) => {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg))).slice(0, 12);
};
const rid = () => crypto.randomUUID().slice(0, 8);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => new Date(t).toLocaleString();
const TOKEN_MS = 5000;   // token rotates every 5 s
const RSSI_MIN = -75;    // weaker than this = outside the room

// ---------- SERVER (mock backend persisted in localStorage) ----------
const DB = {
  get: () => JSON.parse(localStorage.getItem('pp_db') || '{"users":{},"sessions":{}}'),
  set: d => localStorage.setItem('pp_db', JSON.stringify(d)),
  tx(fn) { const d = this.get(); try { return fn(d); } finally { this.set(d); } }
};

const Server = {
  async register(id, name, pass, role, dev) {
    const h = await sha(pass);
    DB.tx(d => {
      if (d.users[id]) throw 'That ID is already registered';
      if (role === 'student' && Object.values(d.users).some(u => u.dev === dev)) throw 'This phone is already bound to another student';
      d.users[id] = { id, name, role, pass: h, dev: role === 'student' ? dev : null, pending: null, joined: Date.now() };
    });
  },
  async login(id, pass, dev) {
    const h = await sha(pass);
    return DB.tx(d => {
      const u = d.users[id];
      if (!u || u.pass !== h) throw 'Wrong ID or password';
      if (u.role === 'student' && u.dev !== dev) {
        if (Object.values(d.users).some(x => x.dev === dev)) throw 'This phone is bound to another student';
        u.pending = dev;
        throw 'New phone detected. A device-switch request was sent to the organiser. Log in again after approval.';
      }
      return u;
    });
  },
  decideDevice(id, approve) { DB.tx(d => { const u = d.users[id]; if (approve) u.dev = u.pending; u.pending = null; }); },
  startSession(org, title, mins) {
    return DB.tx(d => {
      const s = { id: rid(), title, org, secret: crypto.randomUUID(), start: Date.now(), end: Date.now() + mins * 60000, closed: false, marks: {} };
      d.sessions[s.id] = s; return s;
    });
  },
  token: (s, t = Date.now()) => hmac(s.secret, s.id + ':' + Math.floor(t / TOKEN_MS)),
  active: s => !!s && !s.closed && Date.now() < s.end,

  // The core anti-proxy check
  async mark({ sessionId, token, studentId, dev, rssi }) {
    const s0 = DB.get().sessions[sessionId];
    const fresh = s0 ? [await this.token(s0), await this.token(s0, Date.now() - TOKEN_MS)] : [];
    return DB.tx(d => {
      const u = d.users[studentId], s = d.sessions[sessionId];
      if (!u || u.role !== 'student') return 'Rejected: not a registered student';
      if (!this.active(s)) return 'Rejected: session is not active';
      if (u.dev !== dev) return 'Rejected: request is not from the registered phone';
      if (!fresh.includes(token)) return 'Rejected: token expired or replayed';
      if (rssi < RSSI_MIN) return `Rejected: too far away (RSSI ${rssi} dBm)`;
      if (s.marks[studentId]) return 'Already marked';
      if (Object.values(s.marks).some(m => m.dev === dev)) return 'Rejected: this phone already marked someone';
      s.marks[studentId] = { t: Date.now(), rssi, dev, manual: false };
      return 'Marked present';
    });
  },
  manual(sid, stu, add) { DB.tx(d => { const m = d.sessions[sid].marks; add ? (m[stu] = { t: Date.now(), rssi: null, dev: null, manual: true }) : delete m[stu]; }); },
  close(sid) { DB.tx(d => { d.sessions[sid].closed = true; }); },
  students: () => Object.values(DB.get().users).filter(u => u.role === 'student'),
  sessions: () => Object.values(DB.get().sessions).sort((a, b) => b.start - a.start),
  csv(list) {
    const st = this.students(), rows = [['session_id', 'title', 'date', 'student_id', 'name', 'status', 'rssi', 'marked_at', 'manual']];
    list.forEach(s => st.forEach(u => {
      const m = s.marks[u.id];
      rows.push([s.id, s.title, fmt(s.start), u.id, u.name, m ? 'Present' : 'Absent', m?.rssi ?? '', m ? fmt(m.t) : '', m?.manual ? 'yes' : '']);
    }));
    const text = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: `attendance_${Date.now()}.csv` });
    a.click();
  }
};

// ---------- RADIO (BLE layer) ----------
// Browsers cannot broadcast BLE, so the web demo carries the advertisement
// between tabs with BroadcastChannel. In a native app, swap these two
// functions for a BLE advertiser / scanner; everything else stays the same.
const Radio = {
  ch: new BroadcastChannel('proxyproof-ble'),
  advertise(pkt) { this.ch.postMessage(pkt); },       // pkt = { sid, tok }  (fits in a 31-byte BLE advert)
  onScan(cb) { this.ch.onmessage = e => cb(e.data); }
};
const rssiAt = m => Math.round(-59 - 20 * Math.log10(Math.max(m, 0.1))); // path-loss model, -59 dBm at 1 m

// ---------- client state ----------
if (!sessionStorage.pp_dev) sessionStorage.pp_dev = 'PHONE-' + rid().toUpperCase(); // each tab = one phone
const me = () => sessionStorage.pp_user ? DB.get().users[sessionStorage.pp_user] : null;
let bcast = null, lastTok = '', scanning = true, lastTry = {}, seen = [];

function render() {
  const u = me();
  if (!u) { stopBroadcast(); return renderAuth(); }
  $('#who').innerHTML = `<span class="tag">${esc(u.name)} (${u.role})</span><span class="tag">${sessionStorage.pp_dev}</span><button class="quiet" onclick="logout()">Log out</button>`;
  u.role === 'organiser' ? renderOrganiser() : renderStudent();
}
function logout() { delete sessionStorage.pp_user; render(); }
function newPhone() { sessionStorage.pp_dev = 'PHONE-' + rid().toUpperCase(); logout(); }

// ---------- auth ----------
function renderAuth(msg = '', good = false) {
  $('#who').innerHTML = `<span class="tag">This tab is ${sessionStorage.pp_dev}</span><button class="quiet" onclick="newPhone()">Switch to a new phone</button>`;
  $('#app').innerHTML = `
  <section><h2>Log in</h2>
    <div class="row"><input id="lid" placeholder="ID, e.g. 26BCE0001"><input id="lpw" type="password" placeholder="Password"><button onclick="doLogin()">Log in</button></div>
  </section>
  <section><h2>Create an account</h2>
    <div class="row"><input id="regid" placeholder="ID (letters and numbers)"><input id="rname" placeholder="Full name"><input id="rpw" type="password" placeholder="Password">
    <select id="rrole"><option value="student">Student</option><option value="organiser">Organiser</option></select><button onclick="doRegister()">Create account</button></div>
    <p class="soft">A student account is locked to the phone it was created on.</p>
  </section>
  ${msg ? `<section class="${good ? 'ok' : 'bad'}">${esc(msg)}</section>` : ''}`;
}
async function doLogin() {
  try { const u = await Server.login($('#lid').value.trim(), $('#lpw').value, sessionStorage.pp_dev); sessionStorage.pp_user = u.id; render(); }
  catch (e) { renderAuth(String(e)); }
}
async function doRegister() {
  const id = $('#regid').value.trim(), n = $('#rname').value.trim(), p = $('#rpw').value;
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !n || !p) return renderAuth('Fill every field. The ID can only use letters, numbers, - and _.');
  try { await Server.register(id, n, p, $('#rrole').value, sessionStorage.pp_dev); renderAuth('Account created. Log in above.', true); }
  catch (e) { renderAuth(String(e)); }
}

// ---------- organiser ----------
function renderOrganiser() {
  $('#app').innerHTML = `
  <section><h2>Start a session</h2>
    <div class="row"><input id="stitle" placeholder="Title, e.g. Biochem lecture"><input id="smins" type="number" value="5" min="1" style="width:80px"> minutes <button onclick="startSess()">Start broadcasting</button></div>
  </section>
  <section><h2>Live dashboard</h2><div id="live"></div></section>
  <section><h2>Phone-switch requests</h2><div id="pend"></div></section>
  <section><h2>Past sessions</h2><div id="hist"></div></section>`;
  refreshOrg();
}
const myLive = () => Server.sessions().find(s => s.org === me().id && Server.active(s));
function startSess() {
  if (myLive()) return alert('Close the current session first.');
  const s = Server.startSession(me().id, $('#stitle').value.trim() || 'Class', Math.max(1, +$('#smins').value || 5));
  startBroadcast(s); refreshOrg();
}
function startBroadcast(s) {
  stopBroadcast();
  const loop = async () => {
    const cur = DB.get().sessions[s.id];
    if (!Server.active(cur)) { stopBroadcast(); return refreshOrg(); }
    lastTok = await Server.token(cur);
    Radio.advertise({ sid: cur.id, tok: lastTok });
    if (!$('#tok')) return;
    const left = cur.end - Date.now();
    $('#tok').textContent = lastTok;
    $('#timer').textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')} left`;
    $('#rot').style.width = ((TOKEN_MS - Date.now() % TOKEN_MS) / TOKEN_MS * 100) + '%';
  };
  loop(); bcast = setInterval(loop, 1000);
}
function stopBroadcast() { clearInterval(bcast); bcast = null; }

function refreshOrg() {
  if (!$('#live')) return;
  const u = me(), st = Server.students(), live = myLive();
  $('#live').innerHTML = !live ? '<p class="soft">No session running. Start one above and nearby students get marked automatically.</p>' : `
    <div class="row" style="justify-content:space-between"><strong>${esc(live.title)}</strong><span class="tag" id="timer"></span></div>
    <div class="beacon"><div class="dot" aria-hidden="true"></div>
      <div style="flex:1"><div class="soft">Broadcasting session <code>${live.id}</code>. Current token:</div>
      <div class="token" id="tok">${lastTok || '…'}</div><div class="bar"><div id="rot"></div></div></div></div>
    <p><span class="big">${Object.keys(live.marks).length}</span> of ${st.length} students present</p>
    <table><tr><th>Student</th><th>Status</th><th>RSSI</th><th></th></tr>
    ${st.map(s => { const m = live.marks[s.id]; return `<tr><td>${esc(s.name)}<br><span class="soft">${s.id}</span></td>
      <td class="${m ? 'ok' : 'soft'}">${m ? (m.manual ? 'Present (added by hand)' : 'Present') : 'Not yet'}</td><td>${m?.rssi ?? '–'}</td>
      <td><button class="quiet" onclick="Server.manual('${live.id}','${s.id}',${!m});refreshOrg()">${m ? 'Remove' : 'Add'}</button></td></tr>`; }).join('')}
    </table>
    <div class="row" style="margin-top:12px"><button class="stop" onclick="Server.close('${live.id}');stopBroadcast();refreshOrg()">Close session</button>
      <button class="quiet" onclick="Server.csv([DB.get().sessions['${live.id}']])">Export CSV</button></div>`;
  if (live && !bcast) startBroadcast(live);

  const pend = st.filter(s => s.pending);
  $('#pend').innerHTML = !pend.length ? '<p class="soft">No requests.</p>' : pend.map(s => `
    <div class="row" style="margin-bottom:8px"><span>${esc(s.name)} (${s.id}) wants to move from <code>${s.dev}</code> to <code>${s.pending}</code></span>
    <button onclick="Server.decideDevice('${s.id}',true);refreshOrg()">Approve</button>
    <button class="quiet" onclick="Server.decideDevice('${s.id}',false);refreshOrg()">Reject</button></div>`).join('');

  const mine = Server.sessions().filter(s => s.org === u.id);
  $('#hist').innerHTML = !mine.length ? '<p class="soft">Sessions you run will show up here.</p>' : `
    <table><tr><th>Session</th><th>Started</th><th>Present</th><th></th></tr>
    ${mine.map(s => `<tr><td>${esc(s.title)}</td><td>${fmt(s.start)}</td><td>${Object.keys(s.marks).length}/${st.length}</td>
      <td><button class="quiet" onclick="Server.csv([DB.get().sessions['${s.id}']])">CSV</button></td></tr>`).join('')}</table>
    <button style="margin-top:12px" onclick="Server.csv(Server.sessions().filter(s=>s.org==='${u.id}'))">Export all as CSV</button>`;
}

// ---------- student ----------
function renderStudent() {
  $('#app').innerHTML = `
  <section><h2>Bluetooth</h2>
    <label class="row"><input type="checkbox" checked onchange="scanning=this.checked"> Scan and mark me automatically</label>
    <p>Distance from the organiser (simulated): <strong id="dist"></strong> m, signal <strong id="rssi"></strong> dBm <span class="soft">(needs ${RSSI_MIN} or stronger)</span></p>
    <input type="range" id="dslider" min="0.5" max="20" step="0.5" value="2" oninput="updDist()" aria-label="Distance from organiser">
    <p id="status" class="soft">Listening for a session…</p>
    <div class="log" id="log"></div>
  </section>
  <section><h2>My attendance</h2><div id="hist"></div></section>
  <section><h2>Try to cheat</h2>
    <p class="soft">Each of these should be rejected by the server. Results appear in the log above.</p>
    <div class="row"><input id="friend" placeholder="Friend's student ID"><button class="quiet" onclick="proxyFriend()">Mark my friend from this phone</button></div>
    <div class="row" style="margin-top:8px"><button class="quiet" onclick="replay()">Reuse a token from 10+ seconds ago</button>
      <button class="quiet" onclick="attack('deadbeef1234','Made-up token')">Send a made-up token</button></div>
  </section>`;
  updDist(); refreshStu();
}
const curRssi = () => rssiAt(+$('#dslider').value);
function updDist() { $('#dist').textContent = $('#dslider').value; const r = curRssi(); $('#rssi').textContent = r; $('#rssi').className = r >= RSSI_MIN ? 'ok' : 'bad'; }
function log(msg) { const l = $('#log'); if (l) l.innerHTML = `<div>${new Date().toLocaleTimeString()}  ${esc(msg)}</div>` + l.innerHTML; }

Radio.onScan(async pkt => {
  const u = me(); if (!u || u.role !== 'student' || !$('#log')) return;
  seen.push({ ...pkt, at: Date.now() }); seen = seen.slice(-60);
  if (!scanning) return;
  const s = DB.get().sessions[pkt.sid];
  if (s?.marks[u.id]) return $('#status').innerHTML = `<span class="ok">You are marked present in "${esc(s.title)}".</span>`;
  $('#status').textContent = `Heard session ${pkt.sid}, token ${pkt.tok}`;
  if (Date.now() - (lastTry[pkt.sid] || 0) < 3000) return;   // retry at most every 3 s
  lastTry[pkt.sid] = Date.now();
  log(await Server.mark({ sessionId: pkt.sid, token: pkt.tok, studentId: u.id, dev: sessionStorage.pp_dev, rssi: curRssi() }));
  refreshStu();
});

async function attack(tok, label, who = me().id) {
  const p = seen.at(-1); if (!p) return log('No session heard yet. Start one in the organiser tab.');
  log(`${label}: ` + await Server.mark({ sessionId: p.sid, token: tok ?? p.tok, studentId: who, dev: sessionStorage.pp_dev, rssi: curRssi() }));
}
const proxyFriend = () => attack(null, `Proxy for ${$('#friend').value.trim()}`, $('#friend').value.trim());
function replay() {
  const old = seen.find(x => Date.now() - x.at >= 10000);
  old ? attack(old.tok, `Replayed token ${old.tok}`) : log('Wait about 10 seconds so there is an old token to reuse.');
}

function refreshStu() {
  if (!$('#hist')) return;
  const u = me(), ss = Server.sessions().filter(s => s.start >= u.joined);
  const att = ss.filter(s => s.marks[u.id]).length, pct = ss.length ? Math.round(att / ss.length * 100) : 0;
  $('#hist').innerHTML = !ss.length ? '<p class="soft">No sessions yet.</p>' : `
    <p><span class="big ${pct >= 75 ? 'ok' : 'bad'}">${pct}%</span> <span class="soft">${att} of ${ss.length} sessions attended</span></p>
    <table><tr><th>Session</th><th>Date</th><th>Status</th></tr>
    ${ss.map(s => `<tr><td>${esc(s.title)}</td><td>${fmt(s.start)}</td><td class="${s.marks[u.id] ? 'ok' : 'bad'}">${s.marks[u.id] ? 'Present' : (Server.active(s) ? 'Not yet' : 'Absent')}</td></tr>`).join('')}</table>`;
}

// live updates when another tab changes the "server"
window.addEventListener('storage', e => {
  if (e.key !== 'pp_db') return;
  const u = me(); if (!u) return;
  u.role === 'organiser' ? refreshOrg() : refreshStu();
});
render();
