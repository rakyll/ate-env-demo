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
const ENV_API_SVC = process.env.ENV_API_SVC || 'ate-env/svc/ate-env-api:7777';
const ENV_PF_PORT = Number(process.env.ENV_PF_PORT || 7777);
const ATE_ENV = process.env.ATE_ENV || 'ate-env';
// Clicking an actor shows its traces from the cluster's Jaeger (v2, query API v3).
const JAEGER_SVC = process.env.JAEGER_SVC || 'otel-system/svc/jaeger:16686';
const JAEGER_PF_PORT = Number(process.env.JAEGER_PF_PORT || 18686);
const TRACE_LOOKBACK_MS = 6 * 3600 * 1000;
// The trace view shows an actor's lifecycle; reads and snapshot reports are noise.
const LIFECYCLE_OPS = new Set(['CreateActor', 'SuspendActor', 'ResumeActor']);
const SHELL = process.env.DEMO_SHELL || process.env.SHELL || '/bin/zsh';
const SHELL_CWD = process.env.DEMO_CWD || ROOT;
// Each shell starts agy as its first command, then becomes a login shell when agy exits.
// One expansion per word: zsh doesn't split ${X:+--flag "$X"}.
const AGY_RUN = 'HOME="$AGY_HOME" agy --model "$AGY_MODEL" ${AGY_SETTINGS:+--settings} ${AGY_SETTINGS:+"$AGY_SETTINGS"}; exec "$SHELL" -l';
const KUBECTL = process.env.KUBECTL || 'kubectl';
// The page's router button rollout-restarts this deployment. The router's envoy
// can stay drained after the router container restarts, leaving the service
// without endpoints (connection refused) until the pod is replaced.
const ROUTER_DEPLOY = process.env.ROUTER_DEPLOY || 'ate-system/deploy/atenet-router';
// The kubeconfig context (cluster) every kubectl call targets; switchable from
// the page. Starts on DEFAULT_CONTEXT if the kubeconfig has it, else on
// `kubectl config current-context`.
const DEFAULT_CONTEXT = 'kind-env';
let kubeContext = process.env.KUBE_CONTEXT || '';
let kubeContexts = [];
let contextGen = 0; // bumped on switch so in-flight polls of the old cluster are dropped
// Each terminal tab runs agy; its shell exports the actor it owns (named by its UUID).
const ACTOR_ATESPACE = process.env.AGY_ACTOR_ATESPACE || ATESPACE || 'ate-ant';
const ACTOR_TEMPLATE = process.env.AGY_ACTOR_TEMPLATE || '';
const AGY_MODEL = process.env.AGY_MODEL || 'gemini-3.8-flash-low';
// The page's model picker offers agy's Flash models; a tab may start agy with any of them.
let agyModels = [];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Every tab also gets a per-session MCP server ({session} is the session UUID).
// agy reaches it through /mcp/<session> on this server (see proxyMCP).
// Empty AGY_MCP_URL disables it.
const AGY_MCP_NAME = process.env.AGY_MCP_NAME || 'env';
const AGY_MCP_URL = process.env.AGY_MCP_URL ?? `http://localhost:${ENV_PF_PORT}/v1alpha/envs/{session}/mcp`;
// Appended to agy's instructions so its file and shell work runs in the session's actor.
const SESSION_RULES = `Your workspace is the Agent Substrate environment behind the \`${AGY_MCP_NAME}\` MCP server, not this machine.
Always use its tools: \`read_file\` and \`write_file\` for every file system operation, and \`shell\` for every shell or bash command.
Never use your built-in file, edit, search, or terminal tools. They act on the local machine.
`;

const STATIC = {
  '/': ['public/index.html', 'text/html'],
  '/app.css': ['public/app.css', 'text/css'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/viz.js': ['public/viz.js', 'text/javascript'],
  '/trace.js': ['public/trace.js', 'text/javascript'],
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

// Actor states the MCP proxy sees before a poll can: a tool call wakes the
// session's actor and suspendEnv puts it back, often within one poll.
const activity = new Map(); // session -> 'running' | 'suspending'
const withActivity = c => (activity.size
  ? { ...c, actors: c.actors.map(a => (activity.has(a.name) ? { ...a, state: activity.get(a.name) } : a)) }
  : c);
const broadcastCluster = () => broadcast({ type: 'cluster', cluster: withActivity(cluster) });

function setActivity(session, state) {
  if (state) activity.set(session, state);
  else activity.delete(session);
  broadcastCluster();
}

const ctxArgs = () => (kubeContext ? ['--context', kubeContext] : []);

function run(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(KUBECTL, [...args, ...ctxArgs()], { maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
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

  // Wait for the old tunnel to release the local port before reopening it,
  // including one still exiting from a previous switch.
  restart() {
    const old = this.proc || this.exiting;
    this.proc = null;
    this.ready = false;
    this.failures = 0;
    if (old && old.exitCode === null && old.signalCode === null) {
      this.exiting = old;
      old.once('exit', () => {
        if (this.exiting === old) this.exiting = null;
        if (!this.proc) this.start();
      });
      old.kill();
    } else this.start();
  }
}

const apiTunnel = new Tunnel('ate-api', PF_TARGET, PF_LOCAL_PORT);
const ateEndpoint = () => ATE_ENDPOINT || apiTunnel.endpoint;
const envTunnel = new Tunnel('ate-env-api', ENV_API_SVC, ENV_PF_PORT, () => ensureEnvs());
const jaegerTunnel = new Tunnel('jaeger', JAEGER_SVC, JAEGER_PF_PORT);
const tunnels = AGY_MCP_URL ? [envTunnel, jaegerTunnel] : [jaegerTunnel];
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
    broadcastCluster();
  }
  setTimeout(poll, POLL_MS);
}

async function loadContexts() {
  const names = await new Promise(resolve =>
    execFile(KUBECTL, ['config', 'get-contexts', '-o', 'name'], (err, out) => resolve(err ? [] : out.split('\n').filter(Boolean))));
  if (!kubeContext && names.includes(DEFAULT_CONTEXT)) kubeContext = DEFAULT_CONTEXT;
  if (!kubeContext) {
    kubeContext = await new Promise(resolve =>
      execFile(KUBECTL, ['config', 'current-context'], (err, out) => resolve(err ? '' : out.trim())));
  }
  kubeContexts = names;
  return contextsMsg();
}

const contextsMsg = () => ({ type: 'contexts', current: kubeContext, contexts: kubeContexts });

// `agy models` prints "<id>\t<label>" lines after a progress line. Only the
// Flash models are offered; the others are too slow for a live demo.
function loadModels() {
  execFile('agy', ['models'], { timeout: 60000 }, (err, out) => {
    if (err) return console.error(`agy models failed: ${err.message}`);
    agyModels = out.split('\n').map(l => l.split('\t'))
      .filter(([id, label]) => label && /^[\w.-]*flash[\w.-]*$/.test(id))
      .map(([id, label]) => ({ id, label: label.trim() }));
    broadcast(modelsMsg());
  });
}

const modelsMsg = () => ({ type: 'models', default: AGY_MODEL, models: agyModels });
const pickModel = m => (agyModels.some(x => x.id === m) ? m : AGY_MODEL);

let router = { state: 'idle', error: null, at: null }; // 'idle' | 'restarting' | 'ok' | 'error'
const routerMsg = () => ({ type: 'router', ...router });

async function restartRouter() {
  if (router.state === 'restarting') return;
  const [ns, ...rest] = ROUTER_DEPLOY.split('/');
  const deploy = rest.join('/');
  console.log(`restarting ${ROUTER_DEPLOY} on ${kubeContext || '(default)'}`);
  router = { state: 'restarting', error: null, at: new Date().toISOString() };
  broadcast(routerMsg());
  try {
    await run(['-n', ns, 'rollout', 'restart', deploy]);
    await run(['-n', ns, 'rollout', 'status', deploy, '--timeout=120s'], 130000);
    router = { state: 'ok', error: null, at: new Date().toISOString() };
  } catch (e) {
    console.error(`router restart failed: ${e.message}`);
    router = { state: 'error', error: e.message, at: new Date().toISOString() };
  }
  broadcast(routerMsg());
}

function switchContext(name) {
  if (name === kubeContext || !kubeContexts.includes(name)) return;
  console.log(`switching cluster: ${kubeContext || '(default)'} → ${name}`);
  kubeContext = name;
  contextGen++;
  cluster = { ok: false, error: 'not polled yet', updatedAt: null, context: name, actors: [], pools: [] };
  envReady.clear();
  activity.clear();
  tunnels.forEach(t => t.restart());
  broadcast(contextsMsg());
  broadcast({ type: 'cluster', cluster });
}

// ---------------------------------------------------------------------------
// Traces: ateapi tags its spans with the actor, so searching its spans by
// ate.actor.name finds every trace that touched the actor (create, resume
// through the router, suspend, ...). Jaeger returns OTLP JSON.

async function jaeger(pathname, query = {}) {
  if (!jaegerTunnel.ready) throw new Error(`no Jaeger at ${JAEGER_SVC} in ${kubeContext || 'this cluster'}`);
  const url = new URL(pathname, `http://${jaegerTunnel.endpoint}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (res.status === 404 || body.error?.httpCode === 404) return [];
  if (!res.ok) throw new Error(body.error?.message || `Jaeger: HTTP ${res.status}`);
  return otlpSpans(body.result?.resourceSpans || []);
}

const attrValue = v => v.stringValue ?? v.boolValue ?? v.doubleValue ?? (v.intValue != null ? Number(v.intValue) : JSON.stringify(v));
const micros = ns => Number(BigInt(ns) / 1000n);

function otlpSpans(resourceSpans) {
  const spans = [];
  for (const r of resourceSpans) {
    const service = r.resource?.attributes?.find(a => a.key === 'service.name')?.value.stringValue || '?';
    for (const ss of r.scopeSpans || []) {
      for (const s of ss.spans || []) {
        spans.push({
          traceId: s.traceId,
          id: s.spanId,
          parent: s.parentSpanId || null,
          service,
          name: s.name,
          start: micros(s.startTimeUnixNano),
          end: micros(s.endTimeUnixNano),
          error: s.status?.code === 2,
          attrs: Object.fromEntries((s.attributes || []).filter(a => !a.key.startsWith('@')).map(a => [a.key, attrValue(a.value)])),
        });
      }
    }
  }
  return spans;
}

async function actorTraces(actor, atespace) {
  const attrs = { 'ate.actor.name': actor, ...(atespace && { 'ate.atespace': atespace }) };
  const now = Date.now();
  const spans = await jaeger('/api/v3/traces', {
    'query.service_name': 'ateapi',
    'query.attributes': JSON.stringify(attrs),
    'query.start_time_min': new Date(now - TRACE_LOOKBACK_MS).toISOString(),
    'query.start_time_max': new Date(now + 60000).toISOString(),
    'query.search_depth': '200',
  });
  const byTrace = new Map();
  for (const s of spans) {
    if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, []);
    byTrace.get(s.traceId).push(s);
  }
  // One event per lifecycle call: the ateapi RPC span, plus who started the
  // trace (the router resumes on ingress, the controller suspends idle actors).
  const events = [];
  for (const [id, list] of byTrace) {
    const op = list.filter(s => s.service === 'ateapi' && s.attrs['rpc.method']).sort((a, b) => a.start - b.start)[0];
    const name = op?.name.replace(/^.*\//, '');
    if (!LIFECYCLE_OPS.has(name)) continue;
    const ids = new Set(list.map(s => s.id));
    const root = list.filter(s => !ids.has(s.parent)).sort((a, b) => a.start - b.start)[0];
    // The router calls ResumeActor before every request it routes, mostly to
    // look up the worker; only the calls that reach atelet actually resume.
    const lookup = name === 'ResumeActor' && !list.some(s => s.name === 'step.CallAteletRestore');
    // The request behind it, e.g. "GetProcess" for a router-initiated resume.
    const via = root.attrs['grpc.path']?.replace(/^.*\//, '') || (root.attrs['http.method'] && `${root.attrs['http.method']} ${new URL(root.attrs['http.url'] || '/', 'http://x').pathname}`) || '';
    events.push({ id, name, start: op.start, duration: op.end - op.start, by: root.service, via, lookup, error: op.error, attrs: op.attrs });
  }
  return events.sort((a, b) => a.start - b.start);
}

function sendJSON(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// HTTP

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const mcp = url.pathname.match(/^\/mcp\/([^/]+)$/);
  if (mcp && AGY_MCP_URL) {
    // Agents run on this machine; refuse cross-origin pages.
    const origin = req.headers.origin;
    if (!UUID_RE.test(mcp[1]) || (origin && new URL(origin).host !== req.headers.host)) { res.writeHead(403); return res.end(); }
    return proxyMCP(req, res, mcp[1]);
  }
  if (url.pathname === '/api/traces') {
    const actor = url.searchParams.get('actor') || '';
    const atespace = url.searchParams.get('atespace') || '';
    if (!/^[\w.-]+$/.test(actor) || !/^[\w.-]*$/.test(atespace)) return sendJSON(res, 400, { error: 'bad actor' });
    return actorTraces(actor, atespace).then(events => sendJSON(res, 200, { events }), e => sendJSON(res, 502, { error: e.message }));
  }
  if (url.pathname === '/api/cluster') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(withActivity(cluster)));
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
      if (msg.type === 'restart-router') restartRouter();
    } catch { /* ignore malformed messages */ }
  });
  ws.send(JSON.stringify(modelsMsg()));
  ws.send(JSON.stringify(routerMsg()));
  ws.send(JSON.stringify(await loadContexts()));
  ws.send(JSON.stringify({ type: 'cluster', cluster: withActivity(cluster) }));
});

// agy only reads MCP servers from $HOME/.gemini/config/mcp_config.json and
// global rules from $HOME/.gemini/GEMINI.md, so agy gets an overlay home:
// symlinks to everything in the real home except those files. The copies add
// the session's server and SESSION_RULES. Only agy runs with it.
const REAL_HOME = os.homedir();
const HOMES_DIR = path.join(os.tmpdir(), 'ate-demo-homes');
fs.rmSync(HOMES_DIR, { recursive: true, force: true }); // rm never follows symlinks
fs.mkdirSync(HOMES_DIR, { recursive: true });

function linkAllExcept(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (!skip.includes(name)) fs.symlinkSync(path.join(from, name), path.join(to, name));
  }
}

const readOr = (file, fallback) => { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } };

function makeAgyHome(home, url) {
  const gemini = path.join(REAL_HOME, '.gemini');
  const config = path.join(gemini, 'config');
  linkAllExcept(REAL_HOME, home, ['.gemini']);
  if (fs.existsSync(gemini)) linkAllExcept(gemini, path.join(home, '.gemini'), ['config', 'GEMINI.md']);
  if (fs.existsSync(config)) linkAllExcept(config, path.join(home, '.gemini', 'config'), ['mcp_config.json']);
  else fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  const mcp = JSON.parse(readOr(path.join(config, 'mcp_config.json'), '{"mcpServers":{}}'));
  mcp.mcpServers = { ...mcp.mcpServers, [AGY_MCP_NAME]: { serverUrl: url } };
  fs.writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify(mcp, null, 2));
  const rules = readOr(path.join(gemini, 'GEMINI.md'), '');
  fs.writeFileSync(path.join(home, '.gemini', 'GEMINI.md'), `${rules}${rules && !rules.endsWith('\n') ? '\n' : ''}${SESSION_RULES}`);
}

// Returns the session's temp dir and the env vars the agy command reads.
// agy may call the session's MCP tools without asking.
function makeSessionDir(session) {
  const dir = fs.mkdtempSync(path.join(HOMES_DIR, `${session}-`));
  const url = `http://127.0.0.1:${PORT}/mcp/${session}`;
  const home = path.join(dir, 'home');
  makeAgyHome(home, url);
  return { dir, env: { AGY_HOME: home, AGY_SETTINGS: JSON.stringify({ permissions: { allow: [`mcp(${AGY_MCP_NAME}/*)`] } }) } };
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

// Forwards a session's MCP request to AGY_MCP_URL and suspends the session's
// actor once no tool calls are in flight, so it only runs while serving one.
const toolCallsInFlight = new Map(); // session -> count

function isToolCall(body) {
  try {
    const msg = JSON.parse(body);
    return (Array.isArray(msg) ? msg : [msg]).some(m => m?.method === 'tools/call');
  } catch { return false; }
}

function suspendEnv(session) {
  setActivity(session, 'suspending');
  execFile(ATE_ENV, ['suspend', session, '--api', envTunnel.endpoint], { timeout: 120000 }, (err, stdout, stderr) => {
    // A new tool call may have woken it meanwhile.
    if (activity.get(session) === 'suspending') setActivity(session, null);
    if (err) console.error(`session ${session}: ate-env suspend failed: ${`${stdout}${stderr}`.trim() || err.message}`);
  });
}

function proxyMCP(req, res, session) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let toolCall = req.method === 'POST' && isToolCall(body.toString());
    if (toolCall) {
      toolCallsInFlight.set(session, (toolCallsInFlight.get(session) || 0) + 1);
      setActivity(session, 'running');
    }
    const done = () => {
      if (!toolCall) return;
      toolCall = false;
      const n = toolCallsInFlight.get(session) - 1;
      if (n > 0) return toolCallsInFlight.set(session, n);
      toolCallsInFlight.delete(session);
      suspendEnv(session);
    };
    const { host, ...headers } = req.headers;
    const up = http.request(AGY_MCP_URL.replaceAll('{session}', session), { method: req.method, headers }, upRes => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
      upRes.on('close', done);
    });
    up.on('error', e => {
      done();
      if (!res.headersSent) res.writeHead(502);
      res.end(e.message);
    });
    res.on('close', () => up.destroy());
    up.end(body);
  });
}

ptyWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const cols = Number(url.searchParams.get('cols')) || 100;
  const rows = Number(url.searchParams.get('rows')) || 30;
  const session = url.searchParams.get('session') || '';
  if (!UUID_RE.test(session)) return ws.close(1008, 'session must be a lowercase UUID');
  const model = pickModel(url.searchParams.get('model'));
  let sessionDir = null;
  let agentEnv = { AGY_HOME: REAL_HOME };
  if (AGY_MCP_URL) {
    try {
      ({ dir: sessionDir, env: agentEnv } = makeSessionDir(session));
    } catch (e) { console.error(`session ${session}: no MCP config: ${e.message}`); }
  }
  const term = pty.spawn(SHELL, ['-l', '-i', '-c', AGY_RUN], {
    name: 'xterm-256color',
    cols, rows,
    cwd: SHELL_CWD,
    env: {
      ...process.env,
      SHELL,
      TERM: 'xterm-256color', COLORTERM: 'truecolor', ATE_DEMO: '1',
      AGY_SESSION_ID: session,
      ATE_ACTOR: session,
      ATE_ATESPACE: ACTOR_ATESPACE,
      ATE_ACTOR_TEMPLATE: ACTOR_TEMPLATE,
      ATE_CONTEXT: kubeContext,
      ATE_ENDPOINT: ateEndpoint(),
      AGY_MODEL: model,
      ...agentEnv,
    },
  });
  console.log(`session ${session} opened (agy model: ${model})`);
  if (AGY_MCP_URL) {
    openSessions.set(session, (openSessions.get(session) || 0) + 1);
    ensureEnv(session);
  }

  // agy's banner tags itself "(Googler Dogfood)"; blank it out for the demo.
  // Same-width spaces, not deletion: agy places the next logo row by moving
  // the cursor back a fixed number of columns from the end of this line.
  term.onData(d => { if (ws.readyState === 1) ws.send(d.replace(/ \(Googler Dogfood\)/g, m => ' '.repeat(m.length))); });
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
    if (sessionDir) fs.rm(sessionDir, { recursive: true, force: true }, () => {});
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
  loadModels();
  poll();
});
