import { Viz, createSimulator } from './viz.js';
import { TraceView } from './trace.js';

const wsURL = p => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${p}`;
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------
// Terminal (left)

const THEMES = {};
THEMES.dark = {
  background: '#0e130f',
  foreground: '#e4ebe6',
  cursor: '#64d86b',
  cursorAccent: '#0e130f',
  selectionBackground: 'rgba(100, 216, 107, 0.25)',
  black: '#1a221c', brightBlack: '#6e7d73',
  red: '#e77cb2', brightRed: '#f0a0c8',
  green: '#61d76b', brightGreen: '#95f294',
  yellow: '#f3f17b', brightYellow: '#f8f6a8',
  blue: '#64b9de', brightBlue: '#94d0ea',
  magenta: '#b99cf0', brightMagenta: '#d2c0f6',
  cyan: '#6fd6c7', brightCyan: '#a2e8de',
  white: '#c8d3cb', brightWhite: '#f4f8f5',
};
// On white, normal colors are ≥5:1 and the brighter variants ≥4:1; agy draws
// its secondary text in bright black.
THEMES.light = {
  background: '#ffffff',
  foreground: '#1b231d',
  cursor: '#1c8a32',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(28, 138, 50, 0.18)',
  black: '#1b231d', brightBlack: '#5f6e64',
  red: '#b4286f', brightRed: '#d0458c',
  green: '#1c7f2f', brightGreen: '#2a9a3c',
  yellow: '#8f5f00', brightYellow: '#a97300',
  blue: '#1667a8', brightBlue: '#2a7fc4',
  magenta: '#7443c9', brightMagenta: '#8d5fe0',
  cyan: '#0e7468', brightCyan: '#178c7e',
  white: '#6b7a70', brightWhite: '#46524a',
};
const theme = () => document.documentElement.dataset.theme || 'dark';

await document.fonts.load('13px "Geist Mono"').catch(() => {});

const viz = new Viz(document.getElementById('viz'));
const traceDialog = document.getElementById('trace');
const traceView = new TraceView(traceDialog);

// Each tab is its own xterm + WebSocket, and so its own PTY on the server.
// A tab is an agy session identified by a UUID; the server exports it and the
// actor of the same name into the shell's environment, and starts agy in it.
// ▶ agy types this to start it again, with the picked model if there is one
// (option values are model ids the server listed, so they need no quoting).
const agyCmd = () => `HOME="$AGY_HOME" agy --model ${modelPicker.value || '"$AGY_MODEL"'} \${AGY_SETTINGS:+--settings} \${AGY_SETTINGS:+"$AGY_SETTINGS"}\r`;
// The model new shells start agy with; empty means the server's default.
const modelPicker = document.getElementById('model-select');
let agyModel = localStorage.getItem('agyModel') || '';
const termBody = document.getElementById('terminal');
const tabsEl = document.getElementById('term-tabs');
const newTabBtn = document.getElementById('term-new');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sessions = [];
let active = null;
const DEFAULT_FONT_SIZE = 15;
let fontSize = Number(localStorage.getItem('termFontSize')) || DEFAULT_FONT_SIZE;
let nextId = 1;

class Session {
  constructor(saved) {
    this.id = saved?.id ?? nextId++;
    this.sessionId = saved?.sessionId ?? crypto.randomUUID();
    this.label = `agy ${this.id}`;
    this.el = document.createElement('div');
    this.el.className = 'as-term__pane';
    termBody.appendChild(this.el);

    this.term = new window.Terminal({
      fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: THEMES[theme()],
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    this.term.open(this.el);
    this.term.onData(d => this.send(d));
    this.term.onResize(({ cols, rows }) => this.send('\x00' + JSON.stringify({ type: 'resize', cols, rows })));

    this.tab = document.createElement('div');
    this.tab.className = 'as-tab mono';
    this.tab.setAttribute('role', 'tab');
    this.tab.innerHTML = '<span class="as-live-dot blink"></span><span class="as-tab__label"></span><span class="as-tab__sid"></span><button type="button" class="as-tab__close" aria-label="Close session">×</button>';
    this.tab.querySelector('.as-tab__label').textContent = this.label;
    this.tab.querySelector('.as-tab__sid').textContent = this.sessionId.slice(0, 8);
    this.tab.title = `session ${this.sessionId}\nmanages actor/${this.sessionId}`;
    this.tab.onclick = e => (e.target.closest('.as-tab__close') ? closeSession(this) : activate(this));
    this.tab.onauxclick = e => { if (e.button === 1) closeSession(this); };
    tabsEl.insertBefore(this.tab, newTabBtn);
  }

  connect() {
    this.sock?.close();
    this.term.reset();
    if (this.el.offsetParent) this.fit.fit();
    const s = new WebSocket(wsURL(`/ws/pty?session=${this.sessionId}&cols=${this.term.cols}&rows=${this.term.rows}&model=${encodeURIComponent(agyModel)}`));
    this.sock = s;
    s.onopen = () => {
      this.setDead(false);
      if (active === this) this.term.focus();
    };
    s.onmessage = e => {
      this.term.write(e.data);
    };
    s.onclose = () => {
      if (this.sock !== s) return;
      this.setDead(true);
      this.term.write('\r\n\x1b[2mshell disconnected — click ↻ restart\x1b[0m\r\n');
    };
  }

  send(d) { if (this.sock?.readyState === 1) this.sock.send(d); }
  setDead(dead) { this.tab.querySelector('.as-live-dot').classList.toggle('is-dead', dead); }

  dispose() {
    const s = this.sock;
    this.sock = null;
    s?.close();
    this.term.dispose();
    this.el.remove();
    this.tab.remove();
  }
}

function activate(s) {
  active = s;
  for (const x of sessions) {
    const on = x === s;
    x.el.hidden = !on;
    x.tab.classList.toggle('is-active', on);
    x.tab.setAttribute('aria-selected', on);
  }
  s.fit.fit();
  s.term.focus();
  s.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  saveTabs();
}

// Open tabs survive a reload; each reconnects to its session's env.
function saveTabs() {
  localStorage.setItem('tabs', JSON.stringify({
    tabs: sessions.map(s => ({ id: s.id, sessionId: s.sessionId })),
    active: active?.sessionId,
  }));
}

function loadTabs() {
  try {
    const { tabs, active } = JSON.parse(localStorage.getItem('tabs'));
    return { tabs: tabs.filter(t => Number.isInteger(t.id) && UUID_RE.test(t.sessionId)), active };
  } catch { return { tabs: [] }; }
}

const syncSessions = () => viz.setSessions(new Map(sessions.map(s => [s.sessionId, s.label])));

function openSession(saved) {
  const s = new Session(saved);
  sessions.push(s);
  activate(s);
  s.connect();
  syncSessions();
  return s;
}

function closeSession(s) {
  const i = sessions.indexOf(s);
  sessions.splice(i, 1);
  s.dispose();
  syncSessions();
  saveTabs();
  if (!sessions.length) return openSession();
  if (active === s) activate(sessions[Math.min(i, sessions.length - 1)]);
}

// Applies to every tab; hidden tabs refit when activated.
function setFontSize(size) {
  fontSize = Math.min(24, Math.max(10, size));
  localStorage.setItem('termFontSize', fontSize);
  for (const s of sessions) s.term.options.fontSize = fontSize;
  active?.fit.fit();
}

new ResizeObserver(() => active?.fit.fit()).observe(termBody);
document.getElementById('term-font-down').onclick = () => setFontSize(fontSize - 1);
document.getElementById('term-font-up').onclick = () => setFontSize(fontSize + 1);
newTabBtn.onclick = () => openSession();
document.getElementById('term-restart').onclick = () => active?.connect();
document.getElementById('term-run-agy').onclick = () => { active?.send(agyCmd()); active?.term.focus(); };

// Model picker: agy reads its model at startup, so a pick applies to new
// tabs, ↻ restart and ▶ agy, not to agy sessions already running.
function renderModels({ default: def, models }) {
  if (models.length && !models.some(m => m.id === def)) models = [{ id: def, label: def }, ...models];
  if (!models.some(m => m.id === agyModel)) agyModel = def;
  modelPicker.replaceChildren(...models.map(m =>
    new Option(m.id === def ? `${m.label} · default` : m.label, m.id, false, m.id === agyModel)));
  modelPicker.title = 'agy model for new sessions';
  modelPicker.hidden = !models.length;
}

modelPicker.onchange = () => {
  agyModel = modelPicker.value;
  localStorage.setItem('agyModel', agyModel);
  active?.term.focus();
};

// Alt+T new session, Alt+W close, Alt+1..9 switch, Alt+=/-/0 text size.
// (Cmd/Ctrl+T belong to the browser.)
document.addEventListener('keydown', e => {
  if (!e.altKey || e.metaKey || e.ctrlKey) return;
  const n = Number(e.code.replace('Digit', ''));
  if (e.code === 'KeyT') openSession();
  else if (e.code === 'KeyW' && active) closeSession(active);
  else if (e.code === 'Equal') setFontSize(fontSize + 1);
  else if (e.code === 'Minus') setFontSize(fontSize - 1);
  else if (e.code === 'Digit0') setFontSize(DEFAULT_FONT_SIZE);
  else if (n >= 1 && n <= 9 && sessions[n - 1]) activate(sessions[n - 1]);
  else return;
  e.preventDefault();
  e.stopPropagation();
}, true);

const saved = loadTabs();
nextId = Math.max(0, ...saved.tabs.map(t => t.id)) + 1;
for (const t of saved.tabs) openSession(t);
if (!sessions.length) openSession();
activate(sessions.find(s => s.sessionId === saved.active) || sessions[0]);

const themeBtn = document.getElementById('theme-toggle');
function setTheme(t) {
  if (t === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  localStorage.setItem('theme', t);
  themeBtn.textContent = t === 'light' ? '☾' : '☀';
  themeBtn.title = t === 'light' ? 'Dark theme' : 'Light theme';
  for (const s of sessions) s.term.options.theme = THEMES[t];
}
setTheme(theme());
themeBtn.onclick = () => setTheme(theme() === 'light' ? 'dark' : 'light');

// ---------------------------------------------------------------------------
// Cluster visualization (right)

const conn = document.getElementById('conn-status');
const setConn = (state, text) => {
  conn.dataset.state = state;
  conn.querySelector('[data-conn-text]').textContent = text;
};

let sim = null;
let everLive = false;
let failures = 0;
const FAILURES_BEFORE_SIM = 3;

function startSim(reason) {
  if (sim) return;
  setConn('demo', 'simulated cluster');
  sim = createSimulator(snap => viz.update({ ...snap, mode: 'demo', detail: reason }));
}

function stopSim() {
  if (!sim) return;
  sim.stop();
  sim = null;
  viz.reset();
}

// Cluster picker: one option per kubeconfig context, GKE contexts
// (gke_<project>_<zone>_<cluster>) grouped by project.
const picker = document.getElementById('cluster-select');
let clusterWs = null;
let currentContext = null;

function renderContexts(current, contexts) {
  picker.replaceChildren();
  const groups = new Map();
  for (const name of contexts) {
    const m = name.match(/^gke_([^_]+)_([^_]+)_(.+)$/);
    const opt = new Option(m ? m[3] : name, name, false, name === current);
    opt.title = m ? `${m[3]} · ${m[1]} · ${m[2]}` : name;
    const group = m ? m[1] : '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(opt);
  }
  for (const [label, opts] of groups) {
    if (!label) { picker.append(...opts); continue; }
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...opts);
    picker.append(g);
  }
  picker.title = current ? `kubeconfig context: ${current}` : 'kubeconfig context';
  picker.hidden = !contexts.length;
}

picker.onchange = () => {
  if (clusterWs?.readyState === 1) clusterWs.send(JSON.stringify({ type: 'context', name: picker.value }));
};

// Router button: rollout-restarts atenet-router in the selected cluster.
const routerBtn = document.getElementById('router-restart');
const clock = iso => new Date(iso).toLocaleTimeString([], { hour12: false });

function renderRouter({ state, error, at }) {
  routerBtn.disabled = state === 'restarting';
  routerBtn.dataset.state = state;
  routerBtn.textContent = state === 'restarting' ? '↻ restarting…' : '↻ router';
  routerBtn.title = state === 'restarting' ? `Restarting atenet-router since ${clock(at)}`
    : state === 'error' ? `Router restart failed at ${clock(at)}: ${error}`
    : state === 'ok' ? `Router restarted at ${clock(at)}. Click to restart again.`
    : 'Restart atenet-router if the demo gets stuck';
}

routerBtn.onclick = () => {
  if (clusterWs?.readyState !== 1) return;
  if (!confirm(`Restart atenet-router on ${currentContext}? Open actor connections will drop.`)) return;
  clusterWs.send(JSON.stringify({ type: 'restart-router' }));
};

// Simulated actors have no traces, so only live actors open the trace view.
viz.onActorClick = a => { if (!sim) traceView.open(a); };
traceDialog.addEventListener('close', () => active?.term.focus());

if (params.has('demo')) {
  startSim('simulated · ?demo');
} else {
  const connectCluster = () => {
    const ws = new WebSocket(wsURL('/ws/cluster'));
    clusterWs = ws;
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'models') return renderModels(msg);
      if (msg.type === 'router') return renderRouter(msg);
      if (msg.type === 'contexts') {
        renderContexts(msg.current, msg.contexts);
        routerBtn.hidden = !msg.current;
        // Sessions are bound to the old cluster's actors and endpoint; restart them.
        if (currentContext !== null && msg.current !== currentContext) {
          viz.reset();
          for (const s of sessions) s.connect();
        }
        currentContext = msg.current;
        return;
      }
      const { cluster } = msg;
      if (cluster.ok) {
        stopSim();
        everLive = true;
        failures = 0;
        const ctx = cluster.pools?.[0]?.namespace ? `ns ${cluster.pools[0].namespace}` : 'kubectl';
        setConn('live', `live · ${ctx}`);
        viz.update({ ...cluster, mode: 'live', detail: `kubectl ate · ${new Date(cluster.updatedAt).toLocaleTimeString([], { hour12: false })}` });
      } else if (!everLive) {
        if (cluster.updatedAt && ++failures >= FAILURES_BEFORE_SIM) startSim(`no cluster: ${cluster.error.slice(0, 60)}`);
        else if (!sim) setConn('down', 'connecting to cluster…');
      } else if (!cluster.updatedAt) {
        setConn('down', 'connecting to cluster…');
      } else {
        setConn('down', 'cluster unreachable');
        viz.update({ ...cluster, mode: 'down', detail: cluster.error.slice(0, 70) });
      }
    };
    ws.onclose = () => {
      if (!sim) setConn('down', 'server disconnected');
      setTimeout(connectCluster, 2000);
    };
  };
  connectCluster();
}
