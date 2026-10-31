// Agent Substrate live demo: a real shell (for `agy`) on the left, a live
// view of the substrate cluster on the right.
//
//   PORT=3000 ATESPACE=ate-ant npm start

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ATESPACE = process.env.ATESPACE || ''; // empty = all atespaces
const POLL_MS = Number(process.env.POLL_MS || 1000); // delay between polls
// kubectl-ate port-forwards on every call (2-10s). Instead keep one tunnel to
// the ate-api service open and pass --endpoint. Set ATE_ENDPOINT to use your
// own, or ATE_PORT_FORWARD=0 to let kubectl-ate manage it.
const ATE_ENDPOINT = process.env.ATE_ENDPOINT || '';
const PORT_FORWARD = !ATE_ENDPOINT && process.env.ATE_PORT_FORWARD !== '0';
const PF_TARGET = process.env.ATE_API_SVC || 'ate-system/svc/api:443';
const PF_LOCAL_PORT = Number(process.env.ATE_PF_PORT || 18443);
// The env service (github.com/agent-substrate/env) serves each session's MCP
// tools; it is tunneled from the selected cluster like ate-api.
const ENV_API_SVC = process.env.ENV_API_SVC || 'ate-system/svc/ate-env-api:7777';
const ENV_PF_PORT = Number(process.env.ENV_PF_PORT || 7777);
const ATE_ENV = process.env.ATE_ENV || 'ate-env';
const SHELL = process.env.DEMO_SHELL || process.env.SHELL || '/bin/zsh';
const SHELL_CWD = process.env.DEMO_CWD || ROOT;
const KUBECTL = process.env.KUBECTL || 'kubectl';
// The kubeconfig context (cluster) every kubectl call targets; switchable from
// the page. Empty until resolved from `kubectl config current-context`.
let kubeContext = process.env.KUBE_CONTEXT || '';
let kubeContexts = [];
let contextGen = 0; // bumped on switch so in-flight polls of the old cluster are dropped
// Each terminal tab is an agy session; its shell exports the actor it owns (named by its UUID).
const ACTOR_ATESPACE = process.env.AGY_ACTOR_ATESPACE || ATESPACE || 'ate-ant';
const ACTOR_TEMPLATE = process.env.AGY_ACTOR_TEMPLATE || '';
const AGY_MODEL = process.env.AGY_MODEL || 'gemini-3.8-flash-medium';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Every agy also gets a per-session MCP server ({session} is the session UUID).
// Empty AGY_MCP_URL disables it.
const AGY_MCP_NAME = process.env.AGY_MCP_NAME || 'session-env';
const AGY_MCP_URL = process.env.AGY_MCP_URL ?? `http://localhost:${ENV_PF_PORT}/v1alpha/envs/{session}/mcp`;

const STATIC = {
  '/': ['public/index.html', 'text/html'],
  '/app.css': ['public/app.css', 'text/css'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/viz.js': ['public/viz.js', 'text/javascript'],
  '/img/logo.webp': ['public/img/logo.webp', 'image/webp'],
  '/img/mascot.webp': ['public/img/mascot.webp', 'image/webp'],
  '/img/favicon.png': ['public/img/favicon.png', 'image/png'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
  '/vendor/addon-web-links.js': ['node_modules/@xterm/addon-web-links/lib/addon-web-links.js', 'text/javascript'],
};

// ---------------------------------------------------------------------------
// Cluster polling

let cluster = { ok: false, error: 'not polled yet', updatedAt: null, actors: [], pools: [] };

const ctxArgs = () => (kubeContext ? ['--context', kubeContext] : []);

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(KUBECTL, [...args, ...ctxArgs()], { maxBuffer: 64 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const msg = (stderr || '').trim().split('\n').filter(l => l && !l.startsWith('Warning:')).join(' ');
      reject(new Error(msg || (err.killed ? `kubectl ${args.slice(0, 3).join(' ')} timed out` : err.message)));
    });
  });
}

// A kubectl port-forward to a service in the selected cluster that reopens
// when it dies and moves when the cluster changes.
class Tunnel {
  constructor(name, svc, localPort, onUp = () => {}) {
    [, this.ns, this.target, this.remote] = svc.match(/^([^/]+)\/(.+):(\d+)$/);
    Object.assign(this, { name, localPort, onUp, proc: null, ready: false, failures: 0 });
  }

  get endpoint() { return this.ready ? `localhost:${this.localPort}` : ''; }

  start() {
    const pf = spawn(KUBECTL, ['port-forward', '-n', this.ns, this.target, `${this.localPort}:${this.remote}`, ...ctxArgs()], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = pf;
    pf.stdout.on('data', d => {
      if (this.proc === pf && !this.ready && /Forwarding from/.test(d)) {
        this.ready = true;
        this.failures = 0;
        console.log(`port-forward ${this.ns}/${this.target} → ${this.endpoint}`);
        this.onUp();
      }
    });
    // kubectl logs "broken pipe" every time a client closes its connection.
    pf.stderr.on('data', d => {
      if (this.failures === 0 && !/broken pipe|connection reset/.test(d)) process.stderr.write(`[port-forward ${this.name}] ${d}`);
    });
    pf.on('exit', code => {
      if (this.proc !== pf) return; // replaced by a context switch
      this.ready = false;
      if (this.failures++ === 0) console.log(`port-forward ${this.name} exited (${code}); retrying every 3s`);
      setTimeout(() => { if (this.proc === pf) this.start(); }, 3000);
    });
  }

  // Wait for the old tunnel to release the local port before reopening it.
  restart() {
    const old = this.proc;
    this.proc = null;
    this.ready = false;
    this.failures = 0;
    if (old && old.exitCode === null) {
      old.once('exit', () => { if (!this.proc) this.start(); });
      old.kill();
    } else this.start();
  }
}

const apiTunnel = new Tunnel('ate-api', PF_TARGET, PF_LOCAL_PORT);
const ateEndpoint = () => ATE_ENDPOINT || apiTunnel.endpoint;
const envTunnel = new Tunnel('ate-env-api', ENV_API_SVC, ENV_PF_PORT, () => ensureEnvs());
const tunnels = AGY_MCP_URL ? [envTunnel] : [];
if (PORT_FORWARD) tunnels.push(apiTunnel);
process.on('exit', () => tunnels.forEach(t => t.proc?.kill()));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const STATE = {
  ACTOR_STATE_RESUMING: 'resuming',
  ACTOR_STATE_RUNNING: 'running',
  ACTOR_STATE_SUSPENDING: 'suspending',
  ACTOR_STATE_SUSPENDED: 'suspended',
  ACTOR_STATE_CRASHED: 'crashed',
  ACTOR_STATE_DELETING: 'suspending',
  ACTOR_STATE_REVERTING: 'resuming',
};

async function pollActors() {
  const scope = ATESPACE ? ['-a', ATESPACE] : ['-A'];
  const endpoint = ateEndpoint() ? ['--endpoint', ateEndpoint()] : [];
  const out = await run(['ate', 'get', 'actors', ...scope, ...endpoint, '-o', 'json']);
  const list = JSON.parse(out).actors || [];
  return list.map(a => {
    const st = a.status || {};
    const wa = st.workerAssignment || {};
    return {
      uid: a.metadata?.uid,
      name: a.metadata?.name,
      atespace: a.metadata?.atespace,
      template: a.actorTemplate?.name,
      createTime: a.metadata?.createTime,
      state: STATE[st.state] || 'suspended',
      rawState: st.state,
      snapshots: (st.snapshots || []).length,
      workerPod: wa.workerPod || null,
      workerPool: wa.workerPool || null,
      node: wa.nodeName || null,
    };
  }).sort((x, y) => (x.createTime || '').localeCompare(y.createTime || ''));
}

async function pollPools() {
  const out = await run(['get', 'workerpools', '-A', '-o', 'json']);
  return (JSON.parse(out).items || []).map(p => ({
    name: p.metadata.name,
    namespace: p.metadata.namespace,
    desired: p.spec?.replicas ?? 0,
    ready: p.status?.readyReplicas ?? 0,
    sandboxClass: (p.spec?.sandboxClasses || []).map(s => s.name).join(',') || null,
  }));
}

async function poll() {
  const gen = contextGen;
  let next;
  try {
    const [actors, pools] = await Promise.all([pollActors(), pollPools().catch(() => [])]);
    next = { ok: true, error: null, updatedAt: new Date().toISOString(), context: kubeContext, atespace: ATESPACE || null, actors, pools };
  } catch (e) {
    next = { ...cluster, ok: false, error: e.message, updatedAt: new Date().toISOString(), context: kubeContext };
  }
  if (gen === contextGen) {
    cluster = next;
    broadcast({ type: 'cluster', cluster });
  }
  setTimeout(poll, POLL_MS);
}

async function loadContexts() {
  const names = await new Promise(resolve =>
    execFile(KUBECTL, ['config', 'get-contexts', '-o', 'name'], (err, out) => resolve(err ? [] : out.split('\n').filter(Boolean))));
  if (!kubeContext) {
    kubeContext = await new Promise(resolve =>
      execFile(KUBECTL, ['config', 'current-context'], (err, out) => resolve(err ? '' : out.trim())));
  }
  kubeContexts = names;
  return contextsMsg();
}

const contextsMsg = () => ({ type: 'contexts', current: kubeContext, contexts: kubeContexts });

function switchContext(name) {
  if (name === kubeContext || !kubeContexts.includes(name)) return;
  console.log(`switching cluster: ${kubeContext || '(default)'} → ${name}`);
  kubeContext = name;
  contextGen++;
  cluster = { ok: false, error: 'not polled yet', updatedAt: null, context: name, actors: [], pools: [] };
  envReady.clear();
  tunnels.forEach(t => t.restart());
  broadcast(contextsMsg());
  broadcast({ type: 'cluster', cluster });
}

// ---------------------------------------------------------------------------
// HTTP

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/cluster') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(cluster));
  }
  const entry = STATIC[url.pathname];
  if (!entry) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(path.join(ROOT, entry[0]), (err, buf) => {
    if (err) { res.writeHead(500); return res.end(String(err)); }
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
    res.end(buf);
  });
});

// ---------------------------------------------------------------------------
// WebSockets: /ws/cluster pushes cluster state, /ws/pty is the shell.

const clusterWss = new WebSocketServer({ noServer: true });
const ptyWss = new WebSocketServer({ noServer: true });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clusterWss.clients) if (ws.readyState === 1) ws.send(data);
}

clusterWss.on('connection', async ws => {
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'context') switchContext(msg.name);
    } catch { /* ignore malformed messages */ }
  });
  ws.send(JSON.stringify(await loadContexts()));
  ws.send(JSON.stringify({ type: 'cluster', cluster }));
});

// agy only reads MCP servers from $HOME/.gemini/config/mcp_config.json, so each
// PTY gets an overlay home: symlinks to everything in the real home except that
// file, which holds the global servers plus the session's. Only agy runs with it.
const REAL_HOME = os.homedir();
const HOMES_DIR = path.join(os.tmpdir(), 'ate-demo-homes');
fs.rmSync(HOMES_DIR, { recursive: true, force: true }); // rm never follows symlinks
fs.mkdirSync(HOMES_DIR, { recursive: true });

function linkAllExcept(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (name !== skip) fs.symlinkSync(path.join(from, name), path.join(to, name));
  }
}

function makeAgyHome(session) {
  const home = fs.mkdtempSync(path.join(HOMES_DIR, `${session}-`));
  const gemini = path.join(REAL_HOME, '.gemini');
  const config = path.join(gemini, 'config');
  linkAllExcept(REAL_HOME, home, '.gemini');
  if (fs.existsSync(gemini)) linkAllExcept(gemini, path.join(home, '.gemini'), 'config');
  if (fs.existsSync(config)) linkAllExcept(config, path.join(home, '.gemini', 'config'), 'mcp_config.json');
  else fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  let mcp = { mcpServers: {} };
  try { mcp = JSON.parse(fs.readFileSync(path.join(config, 'mcp_config.json'), 'utf8')); } catch { /* none yet */ }
  mcp.mcpServers = { ...mcp.mcpServers, [AGY_MCP_NAME]: { serverUrl: AGY_MCP_URL.replaceAll('{session}', session) } };
  fs.writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify(mcp, null, 2));
  return home;
}

// Each open session needs an env named after it before its MCP URL works.
// Created once the env tunnel is up, and again in each newly selected cluster.
const openSessions = new Map(); // session -> open PTY count
const envReady = new Set();

function ensureEnv(session) {
  if (!envTunnel.ready || envReady.has(session)) return;
  envReady.add(session);
  execFile(ATE_ENV, ['create', session, '--api', envTunnel.endpoint], { timeout: 120000 }, (err, stdout, stderr) => {
    const out = `${stdout}${stderr}`.trim();
    if (!err) return console.log(`session ${session}: env created`);
    if (/already exists/i.test(out)) return;
    envReady.delete(session);
    console.error(`session ${session}: ate-env create failed: ${out || err.message}`);
  });
}

const ensureEnvs = () => openSessions.forEach((_, session) => ensureEnv(session));

ptyWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const cols = Number(url.searchParams.get('cols')) || 100;
  const rows = Number(url.searchParams.get('rows')) || 30;
  const session = url.searchParams.get('session') || '';
  if (!UUID_RE.test(session)) return ws.close(1008, 'session must be a lowercase UUID');
  let agyHome = REAL_HOME;
  if (AGY_MCP_URL) {
    try { agyHome = makeAgyHome(session); } catch (e) { console.error(`session ${session}: no MCP overlay home: ${e.message}`); }
  }
  const term = pty.spawn(SHELL, ['-l'], {
    name: 'xterm-256color',
    cols, rows,
    cwd: SHELL_CWD,
    env: {
      ...process.env,
      TERM: 'xterm-256color', COLORTERM: 'truecolor', ATE_DEMO: '1',
      AGY_SESSION_ID: session,
      ATE_ACTOR: session,
      ATE_ATESPACE: ACTOR_ATESPACE,
      ATE_ACTOR_TEMPLATE: ACTOR_TEMPLATE,
      ATE_CONTEXT: kubeContext,
      ATE_ENDPOINT: ateEndpoint(),
      AGY_MODEL,
      AGY_HOME: agyHome,
    },
  });
  console.log(`session ${session} opened`);
  if (AGY_MCP_URL) {
    openSessions.set(session, (openSessions.get(session) || 0) + 1);
    ensureEnv(session);
  }

  term.onData(d => { if (ws.readyState === 1) ws.send(d); });
  term.onExit(({ exitCode }) => {
    if (ws.readyState === 1) ws.send(`\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`);
    ws.close();
  });

  // Text frames are keystrokes; JSON control frames start with \x00.
  ws.on('message', (raw, isBinary) => {
    const s = raw.toString();
    if (!isBinary && s.charCodeAt(0) === 0) {
      try {
        const msg = JSON.parse(s.slice(1));
        if (msg.type === 'resize') term.resize(Math.max(2, msg.cols), Math.max(2, msg.rows));
      } catch { /* ignore malformed control frames */ }
      return;
    }
    term.write(s);
  });
  ws.on('close', () => {
    try { term.kill(); } catch { /* already gone */ }
    if (agyHome !== REAL_HOME) fs.rm(agyHome, { recursive: true, force: true }, () => {});
    const n = (openSessions.get(session) || 0) - 1;
    if (n > 0) openSessions.set(session, n);
    else openSessions.delete(session);
  });
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  // The shell is a full login shell on this machine; refuse cross-origin pages.
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return socket.destroy();
  const wss = pathname === '/ws/pty' ? ptyWss : pathname === '/ws/cluster' ? clusterWss : null;
  if (!wss) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

server.listen(PORT, HOST, async () => {
  await loadContexts();
  console.log(`ate demo → http://${HOST}:${PORT}  (shell: ${SHELL} in ${SHELL_CWD}, cluster: ${kubeContext || 'default'}, atespace: ${ATESPACE || 'all'}, agy model: ${AGY_MODEL})`);
  console.log(`agy sessions manage actors in ${ACTOR_ATESPACE} from template ${ACTOR_TEMPLATE || '(unset; set AGY_ACTOR_TEMPLATE)'}`);
  tunnels.forEach(t => t.start());
  poll();
});
