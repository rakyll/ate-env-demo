// Agent Substrate live demo: a real shell (for `agy`) on the left, a live
// view of the substrate cluster on the right.
//
//   PORT=3000 ATESPACE=ate-ant npm start

import http from 'node:http';
import fs from 'node:fs';
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
let ateEndpoint = process.env.ATE_ENDPOINT || '';
const PORT_FORWARD = !ateEndpoint && process.env.ATE_PORT_FORWARD !== '0';
const PF_TARGET = (process.env.ATE_API_SVC || 'ate-system/svc/api:443').match(/^([^/]+)\/(.+):(\d+)$/);
const PF_LOCAL_PORT = Number(process.env.ATE_PF_PORT || 18443);
const SHELL = process.env.DEMO_SHELL || process.env.SHELL || '/bin/zsh';
const SHELL_CWD = process.env.DEMO_CWD || ROOT;
const KUBECTL = process.env.KUBECTL || 'kubectl';
// Each terminal tab is an agy session that owns the actor named by its UUID.
const ACTOR_ATESPACE = process.env.AGY_ACTOR_ATESPACE || ATESPACE || 'ate-ant';
const ACTOR_TEMPLATE = process.env.AGY_ACTOR_TEMPLATE || '';
const AGY_MODEL = process.env.AGY_MODEL || 'gemini-3.8-flash-medium';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionPrompt(id) {
  const ep = ateEndpoint ? ` --endpoint ${ateEndpoint}` : '';
  const create = ACTOR_TEMPLATE
    ? `If it does not exist yet, create it with \`kubectl ate create actor ${id} -a ${ACTOR_ATESPACE} --template ${ACTOR_TEMPLATE}${ep}\`.`
    : `No actor template is configured; ask me which template to use before creating it with \`kubectl ate create actor ${id} -a ${ACTOR_ATESPACE} --template <template>${ep}\`.`;
  return [
    `Your session ID is ${id}.`,
    `In this session you manage exactly one Agent Substrate actor: the actor named ${id} in atespace ${ACTOR_ATESPACE}.`,
    create,
    `Manage its lifecycle with kubectl ate, e.g. \`kubectl ate get actor ${id} -a ${ACTOR_ATESPACE}${ep}\`, \`kubectl ate resume actor ${id} -a ${ACTOR_ATESPACE}${ep}\`, \`kubectl ate suspend actor ${id} -a ${ACTOR_ATESPACE}${ep}\`.`,
    `Never create, modify, suspend, or delete any other actor.`,
    `The same values are in the environment as $AGY_SESSION_ID, $ATE_ACTOR, $ATE_ATESPACE, $ATE_ACTOR_TEMPLATE and $ATE_ENDPOINT.`,
    `Check the actor's current state, report it in one line, then wait for my instructions.`,
  ].join(' ');
}

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

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(KUBECTL, args, { maxBuffer: 64 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const msg = (stderr || '').trim().split('\n').filter(l => l && !l.startsWith('Warning:')).join(' ');
      reject(new Error(msg || (err.killed ? `kubectl ${args.slice(0, 3).join(' ')} timed out` : err.message)));
    });
  });
}

function startPortForward() {
  const [, ns, target, remote] = PF_TARGET;
  const pf = spawn(KUBECTL, ['port-forward', '-n', ns, target, `${PF_LOCAL_PORT}:${remote}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  pf.stdout.on('data', d => {
    if (!ateEndpoint && /Forwarding from/.test(d)) {
      ateEndpoint = `localhost:${PF_LOCAL_PORT}`;
      console.log(`port-forward ${ns}/${target} → ${ateEndpoint}`);
    }
  });
  // kubectl logs "broken pipe" every time kubectl-ate closes its connection.
  pf.stderr.on('data', d => { if (!/broken pipe|connection reset/.test(d)) process.stderr.write(`[port-forward] ${d}`); });
  pf.on('exit', code => {
    ateEndpoint = '';
    console.log(`port-forward exited (${code}); falling back to kubectl-ate tunnels, retrying in 3s`);
    setTimeout(startPortForward, 3000);
  });
  pfProc = pf;
}
let pfProc = null;
process.on('exit', () => pfProc?.kill());
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
  const endpoint = ateEndpoint ? ['--endpoint', ateEndpoint] : [];
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
  try {
    const [actors, pools] = await Promise.all([pollActors(), pollPools().catch(() => [])]);
    cluster = { ok: true, error: null, updatedAt: new Date().toISOString(), atespace: ATESPACE || null, actors, pools };
  } catch (e) {
    cluster = { ...cluster, ok: false, error: e.message, updatedAt: new Date().toISOString() };
  }
  broadcast({ type: 'cluster', cluster });
  setTimeout(poll, POLL_MS);
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

clusterWss.on('connection', ws => ws.send(JSON.stringify({ type: 'cluster', cluster })));

ptyWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const cols = Number(url.searchParams.get('cols')) || 100;
  const rows = Number(url.searchParams.get('rows')) || 30;
  const session = url.searchParams.get('session') || '';
  if (!UUID_RE.test(session)) return ws.close(1008, 'session must be a lowercase UUID');
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
      ATE_ENDPOINT: ateEndpoint,
      AGY_SESSION_PROMPT: sessionPrompt(session),
      AGY_MODEL,
    },
  });
  console.log(`session ${session} opened`);

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
  ws.on('close', () => { try { term.kill(); } catch { /* already gone */ } });
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

server.listen(PORT, HOST, () => {
  console.log(`ate demo → http://${HOST}:${PORT}  (shell: ${SHELL} in ${SHELL_CWD}, atespace: ${ATESPACE || 'all'}, agy model: ${AGY_MODEL})`);
  console.log(`agy sessions manage actors in ${ACTOR_ATESPACE} from template ${ACTOR_TEMPLATE || '(unset: agy will ask; set AGY_ACTOR_TEMPLATE)'}`);
  if (PORT_FORWARD) startPortForward();
  poll();
});
