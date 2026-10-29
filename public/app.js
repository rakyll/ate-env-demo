import { Viz, createSimulator } from './viz.js';

const wsURL = p => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${p}`;
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------
// Terminal (left)

const THEME = {
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

await document.fonts.load('13px "Geist Mono"').catch(() => {});

const term = new window.Terminal({
  fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13.5,
  lineHeight: 1.25,
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 10000,
  theme: THEME,
});
const fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
term.open(document.getElementById('terminal'));
fit.fit();

const termDot = document.getElementById('term-dot');
let sock = null;

function connectShell() {
  sock?.close();
  term.reset();
  const s = new WebSocket(wsURL(`/ws/pty?cols=${term.cols}&rows=${term.rows}`));
  sock = s;
  s.onopen = () => { termDot.classList.remove('is-dead'); term.focus(); };
  s.onmessage = e => term.write(e.data);
  s.onclose = () => {
    if (sock !== s) return;
    termDot.classList.add('is-dead');
    term.write('\r\n\x1b[2mshell disconnected — click ↻ restart\x1b[0m\r\n');
  };
}

const send = d => sock?.readyState === 1 && sock.send(d);
term.onData(send);
term.onResize(({ cols, rows }) => send('\x00' + JSON.stringify({ type: 'resize', cols, rows })));
new ResizeObserver(() => fit.fit()).observe(document.getElementById('terminal'));

document.getElementById('term-restart').onclick = connectShell;
document.getElementById('term-run-agy').onclick = () => { send('agy\r'); term.focus(); };
connectShell();

// ---------------------------------------------------------------------------
// Cluster visualization (right)

const viz = new Viz(document.getElementById('viz'));
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

if (params.has('demo')) {
  startSim('simulated · ?demo');
} else {
  const connectCluster = () => {
    const ws = new WebSocket(wsURL('/ws/cluster'));
    ws.onmessage = e => {
      const { cluster } = JSON.parse(e.data);
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
