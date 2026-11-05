// Renders the "atespace / …" cluster visualization from ate.dev, driven by
// snapshots of { actors, pools, atespace } coming from the server (or the
// simulator below when no cluster is reachable).

const COLORS = ['green', 'blue', 'yellow', 'red'];
const ACTIVE = new Set(['running', 'resuming', 'suspending']);
const POD_SLOTS = 8;
const LINGER_MS = 900;      // keep a vacated pod visibly "suspending" this long
const RESUME_FLASH_MS = 950; // show resume animation when a poll skips RESUMING
const MAX_EVENTS = 80;
const MAX_CALLS = 5; // rows in the tool calls panel; finished calls stay until pushed out
const MAX_CALL_HISTORY = 100; // calls kept for the expanded view
const DONE_HOLD_MS = 2000; // a finished call stays bright this long before fading

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const colorOf = a => COLORS[hash(a.uid || a.name) % COLORS.length];
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const clock = d => d.toLocaleTimeString([], { hour12: false });
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const setText = (n, text) => { if (n.textContent !== text) n.textContent = text; };
// Puts rows into a list, touching the DOM only if they changed, so rows that
// stay don't restart their animations.
const showRows = (list, rows) => {
  const shown = list.children;
  if (shown.length !== rows.length || rows.some((r, i) => shown[i] !== r)) list.replaceChildren(...rows);
};

function since(ms) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export class Viz {
  constructor(root) {
    this.root = root;
    this.$ = sel => root.querySelector(sel);
    this.dotsEl = this.$('#viz-dots');
    this.podsEl = this.$('#viz-pods');
    this.eventsEl = this.$('#viz-events');
    this.callsEl = this.$('#viz-calls');
    this.routerEl = this.$('.as-viz__router');

    this.actors = new Map();   // uid -> actor (latest)
    this.since = new Map();    // uid -> ms timestamp the current state was first seen
    this.flash = new Map();    // uid -> { until, kind } client-side transitional visuals
    this.calls = new Map();    // actor uid:call id -> { name, arg, startedAt, endedAt, actor }
    this.slots = new Array(POD_SLOTS).fill(null); // uid or null
    this.dotEls = new Map();
    this.loaded = false;
    this.pools = [];
    this.sessions = new Map(); // actor name -> tab label, for actors owned by open agy tabs
    this.onActorClick = null;  // set by the page; called with the clicked dot's or pod's actor
    this.onActorColors = null; // set by the page; called with actor name -> color after each update
    this.onCallsClick = null;  // set by the page; called when the tool calls panel is clicked
    this.bigCalls = null;      // { list, sub } of the expanded tool calls view while it's open

    this.tip = el('div', 'as-tip');
    this.tip.hidden = true;
    document.body.appendChild(this.tip);
    this.bindHover();
    this.addEvent('ev-suspended', null, 'waiting for cluster state…', true);

    setInterval(() => { this.renderPods(); this.renderCalls(); }, 250);
  }

  // Actors whose name is an open tab's session ID are highlighted as owned by it.
  setSessions(sessions) {
    this.sessions = sessions;
    if (!this.loaded) return;
    this.assignSlots(Date.now());
    this.renderDots();
    this.renderPods();
  }

  // Forget everything (used when switching from simulated to live data).
  reset() {
    this.actors.clear();
    this.since.clear();
    this.flash.clear();
    this.calls.clear();
    this.dotEls.clear();
    this.slots.fill(null);
    this.loaded = false;
  }

  // ---------------------------------------------------------------------
  // data in

  update({ actors, pools = [], atespace, mode, detail }) {
    const now = Date.now();
    const next = new Map(actors.map(a => [a.uid, { ...a, color: colorOf(a) }]));

    if (!this.loaded) {
      this.eventsEl.replaceChildren();
      const spaces = [...new Set(actors.map(a => a.atespace))];
      this.addEvent('ev-created', null, `connected · ${actors.length} actors in ${spaces.join(', ') || atespace || 'cluster'}`);
    }

    for (const [uid, a] of next) {
      for (const t of a.tools || []) {
        const key = `${uid}:${t.id}`;
        if (!this.calls.has(key)) this.calls.set(key, { ...t, endedAt: null, actor: a });
      }
      const prev = this.actors.get(uid);
      if (!prev) {
        this.since.set(uid, now);
        if (this.loaded) {
          this.addEvent('ev-created', a, 'created', false, a.template ? `from ${a.template}` : '');
          this.markNew(uid);
          this.route(a);
        }
        continue;
      }
      this.endTools(prev, a, now);
      if (prev.state === a.state) continue;
      this.since.set(uid, now);
      this.onTransition(prev, a, now);
    }
    for (const c of this.calls.values()) {
      if (!c.endedAt && !next.get(c.actor.uid)?.tools?.some(t => t.id === c.id)) c.endedAt = now;
    }
    for (const [uid, prev] of this.actors) {
      if (next.has(uid)) continue;
      this.addEvent('ev-deleted', prev, 'deleted');
      this.since.delete(uid);
      if (ACTIVE.has(prev.state)) this.flash.set(uid, { until: now + LINGER_MS, kind: 'suspending', actor: prev });
    }

    this.actors = next;
    this.pools = pools;
    this.loaded = true;
    this.assignSlots(now);
    this.renderHeader(atespace, mode, detail);
    this.renderDots();
    this.renderPods();
    this.renderCalls();
    this.onActorColors?.(new Map([...next.values()].map(a => [a.name, a.color])));
  }

  // Tool calls (MCP tools/call through the server's proxy) that were in flight
  // on the previous snapshot and no longer are have finished.
  endTools(prev, a, now) {
    const still = new Set((a.tools || []).map(t => t.id));
    for (const t of prev.tools || []) {
      if (!still.has(t.id)) this.addEvent('ev-tool', a, t.name, false, `${t.arg ? clip(t.arg, 60) + ' · ' : ''}${since(now - t.startedAt)}`);
    }
  }

  onTransition(prev, a, now) {
    const where = a.workerPod ? `on ${a.workerPod}` : '';
    switch (a.state) {
      case 'resuming':
        this.addEvent('ev-resuming', a, 'resuming', false, where);
        this.route(a);
        break;
      case 'running':
        if (prev.state !== 'resuming') {
          // The resume finished between polls; still show it happening.
          this.flash.set(a.uid, { until: now + RESUME_FLASH_MS, kind: 'resuming' });
          this.route(a);
        }
        this.addEvent('ev-running', a, prev.state === 'suspended' || prev.state === 'resuming' ? 'resumed' : 'running', false, where);
        break;
      case 'suspending':
        this.addEvent('ev-suspending', a, 'suspending', false, prev.workerPod ? `from ${prev.workerPod}` : '');
        break;
      case 'suspended':
        if (ACTIVE.has(prev.state)) this.flash.set(a.uid, { until: now + LINGER_MS, kind: 'suspending', actor: prev });
        this.addEvent('ev-suspended', a, 'suspended', false, 'snapshot saved · 0 pods');
        break;
      case 'crashed':
        this.addEvent('ev-crashed', a, 'crashed');
        break;
      default:
        this.addEvent('ev-suspended', a, a.state);
    }
  }

  // ---------------------------------------------------------------------
  // header / counts

  renderHeader(atespace, mode, detail) {
    const all = [...this.actors.values()];
    const count = s => all.filter(a => a.state === s).length;
    const spaces = [...new Set(all.map(a => a.atespace).filter(Boolean))];
    this.$('[data-viz-atespace]').textContent = atespace || (spaces.length === 1 ? spaces[0] : spaces.length ? 'all' : 'ate-demo');
    this.$('[data-viz-total]').textContent = all.length;
    this.$('[data-viz-running]').textContent = count('running');
    this.$('[data-viz-resuming]').textContent = count('resuming');
    this.$('[data-viz-suspending]').textContent = count('suspending');

    const ready = this.pools.reduce((n, p) => n + p.ready, 0);
    const desired = this.pools.reduce((n, p) => n + p.desired, 0);
    this.$('[data-viz-warm]').textContent = this.pools.length ? ready : POD_SLOTS;
    const classes = [...new Set(this.pools.map(p => p.sandboxClass).filter(Boolean))];
    this.$('[data-viz-pool]').textContent = this.pools.length
      ? `${ready}/${desired} ready${classes.length ? ' · ' + classes.join(', ') : ''} · 1 actor each`
      : 'each hosts 1 active actor';

    const live = this.$('[data-viz-live]');
    live.classList.toggle('is-demo', mode === 'demo');
    live.classList.toggle('is-down', mode === 'down');
    this.$('[data-viz-mode]').textContent = detail || '';
    this.$('[data-viz-updated]').textContent = mode === 'live' ? `updated ${clock(new Date())}` : mode === 'demo' ? 'simulated' : 'stale';
  }

  // ---------------------------------------------------------------------
  // actor dots

  columns() {
    return getComputedStyle(this.dotsEl).gridTemplateColumns.split(' ').length || 10;
  }

  markNew(uid) {
    this.newUids = this.newUids || new Set();
    this.newUids.add(uid);
  }

  renderDots() {
    const now = Date.now();
    const cols = this.columns();
    const list = [...this.actors.values()];
    const cells = Math.max(cols * 4, Math.ceil((list.length + 1) / cols) * cols);
    const frag = document.createDocumentFragment();
    const seen = new Set();

    list.forEach((a, i) => {
      let d = this.dotEls.get(a.uid);
      if (!d) {
        d = el('span');
        this.dotEls.set(a.uid, d);
      }
      seen.add(a.uid);
      const fl = this.flash.get(a.uid);
      const state = fl && fl.until > now && fl.kind === 'resuming' ? 'resuming' : a.state;
      let cls = 'as-viz__dot';
      if (state === 'running' || state === 'resuming' || state === 'suspending' || state === 'crashed') cls += ` as-viz__dot--${state}`;
      else if (a.snapshots > 0) cls += ' as-viz__dot--snapshot';
      if (state === 'resuming') cls += ' pulse';
      if (this.newUids?.has(a.uid)) cls += ' as-viz__dot--new';
      if (this.sessions.has(a.name)) cls += ' as-viz__dot--owned';
      d.className = cls;
      d.dataset.uid = a.uid;
      d.dataset.actorColor = a.color;
      d.dataset.index = i;
      frag.appendChild(d);
    });
    for (let i = list.length; i < cells; i++) frag.appendChild(el('span', 'as-viz__dot as-viz__dot--empty'));
    for (const uid of this.dotEls.keys()) if (!seen.has(uid)) this.dotEls.delete(uid);
    this.newUids?.clear();
    this.dotsEl.replaceChildren(frag);

    // Re-render once transient resume flashes expire.
    const pending = [...this.flash.values()].filter(f => f.kind === 'resuming' && f.until > now);
    if (pending.length) {
      clearTimeout(this.dotTimer);
      this.dotTimer = setTimeout(() => this.renderDots(), Math.max(...pending.map(f => f.until)) - now + 20);
    }
  }

  // ---------------------------------------------------------------------
  // worker pods

  assignSlots(now) {
    const holds = uid => {
      const a = this.actors.get(uid);
      if (a && (ACTIVE.has(a.state) || a.workerPod)) return true;
      const f = this.flash.get(uid);
      return !!(f && f.kind === 'suspending' && f.until > now);
    };
    this.slots = this.slots.map(uid => (uid && holds(uid) ? uid : null));
    const placed = new Set(this.slots.filter(Boolean));
    const order = { resuming: 0, running: 1, suspending: 2 };
    const waiting = [...this.actors.values()]
      .filter(a => (ACTIVE.has(a.state) || a.workerPod) && !placed.has(a.uid))
      .sort((x, y) => (this.sessions.has(y.name) - this.sessions.has(x.name)) || (order[x.state] ?? 3) - (order[y.state] ?? 3));
    for (const a of waiting) {
      const free = this.slots.indexOf(null);
      if (free < 0) break;
      this.slots[free] = a.uid;
      placed.add(a.uid);
    }
    this.overflow = waiting.filter(a => !placed.has(a.uid)).length;
  }

  renderPods() {
    if (!this.loaded) return;
    const now = Date.now();
    let expired = false;
    for (const [uid, f] of this.flash) if (f.until <= now) { this.flash.delete(uid); expired = true; }
    if (expired) this.assignSlots(now);

    const poolName = this.pools[0]?.name || 'worker';
    const frag = document.createDocumentFragment();
    this.slots.forEach((uid, i) => {
      const live = uid && this.actors.get(uid);
      const fl = uid && this.flash.get(uid);
      let a = live;
      let state = live?.state;
      if (fl?.kind === 'suspending' && (!live || !ACTIVE.has(live.state))) { a = fl.actor; state = 'suspending'; }
      else if (fl?.kind === 'resuming') state = 'resuming';
      if (a && !ACTIVE.has(state)) state = 'running'; // has a worker but unusual state

      const pod = el('div', `as-viz__pod as-viz__pod--${a ? state : 'idle'}`);
      const top = el('div', 'as-viz__pod-top');
      const id = el('span', 'as-viz__pod-id mono', a?.workerPod || `worker-${i + 1}`);
      id.title = a?.workerPod || poolName;
      top.appendChild(id);
      const owner = a && this.sessions.get(a.name);
      if (owner) top.appendChild(el('span', 'as-viz__pod-owner mono', owner));
      top.append(el('span', `as-viz__pod-dot as-viz__pod-dot--${a ? state : 'idle'}${state === 'resuming' ? ' pulse' : ''}`));
      pod.appendChild(top);

      const track = el('div', 'as-viz__pod-track');
      const bar = el('div', 'as-viz__pod-bar');
      track.appendChild(bar);

      if (!a) {
        pod.append(el('span', 'as-viz__pod-name mono', 'warm · idle'), el('span', 'as-viz__pod-sub mono', 'ready for any actor'), track);
        bar.style.width = '0%';
      } else {
        pod.dataset.actorColor = a.color;
        pod.dataset.uid = a.uid;
        const name = el('span', 'as-viz__pod-name mono', `actor/${a.name}`);
        name.title = `${a.atespace}/${a.name}`;
        const elapsed = now - (this.since.get(a.uid) || now);
        const tool = state !== 'suspending' && a.tools?.at(-1);
        const sub = state === 'resuming' ? `↻ resuming${tool ? ` for ${tool.name}` : ''} · ${since(fl?.kind === 'resuming' ? RESUME_FLASH_MS - (fl.until - now) : elapsed)}`
          : state === 'suspending' ? '⏸ suspending state'
          : tool ? `⚙ ${tool.name} · ${since(now - tool.startedAt)}${tool.arg ? ` · ${clip(tool.arg, 40)}` : ''}`
          : `running · ${since(elapsed)}`;
        const subEl = el('span', `as-viz__pod-sub mono${tool ? ' as-viz__pod-sub--tool' : ''}`, sub);
        if (tool) subEl.title = `${tool.name}${tool.arg ? `: ${tool.arg}` : ''}`;
        pod.append(name, subEl, track);
        if (state === 'running') {
          const base = 60 + (hash(a.uid) % 26);
          bar.style.width = `${base + Math.round(Math.sin(now / 1400 + i) * 6)}%`;
        } else {
          bar.classList.add(`as-viz__pod-bar--${state}`);
          // Keep the CSS animation from restarting on every 250ms re-render.
          const started = state === 'resuming' && fl?.kind === 'resuming' ? RESUME_FLASH_MS - (fl.until - now)
            : state === 'suspending' && fl ? LINGER_MS - (fl.until - now) : elapsed;
          bar.style.animationDelay = `-${Math.max(0, started)}ms`;
        }
      }
      frag.appendChild(pod);
    });
    if (this.overflow > 0) frag.appendChild(el('div', 'as-viz__pods-more mono', `+${this.overflow} more active actors`));
    this.podsEl.replaceChildren(frag);
    if (this.hoverUid) this.pair(this.hoverUid, true);
  }

  // ---------------------------------------------------------------------
  // tool calls: in flight first, then the most recent finished ones

  // Rows are kept per call and updated in place every tick, so only new rows
  // animate and the idle line stays put.
  renderCalls() {
    const now = Date.now();
    const calls = [...this.calls.values()].sort((x, y) => (!!x.endedAt - !!y.endedAt) || y.startedAt - x.startedAt);
    for (const c of calls.slice(MAX_CALL_HISTORY)) if (c.endedAt) this.calls.delete(`${c.actor.uid}:${c.id}`);
    const inFlight = calls.filter(c => !c.endedAt).length;
    setText(this.$('[data-viz-calls]'), String(inFlight));
    if (this.bigCalls) this.renderBigCalls(calls.slice(0, MAX_CALL_HISTORY), inFlight, now);
    const rows = calls.length ? calls.slice(0, MAX_CALLS).map(c => this.callRow(c, now))
      : [this.idleCallsEl ||= el('li', 'is-empty')];
    if (!calls.length) setText(rows[0], this.loaded ? 'idle · tool calls will show up here' : '…');
    showRows(this.callsEl, rows);
  }

  // The expanded view (opened from the panel) lists every kept call with its
  // full command and start time.
  showCalls(list, sub) {
    this.bigCalls = { list, sub };
    this.renderCalls();
  }

  hideCalls() { this.bigCalls = null; }

  renderBigCalls(calls, inFlight, now) {
    const { list, sub } = this.bigCalls;
    setText(sub, `${inFlight} in flight · ${calls.length - inFlight} recent · newest first`);
    if (!calls.length) {
      showRows(list, [this.idleBigCallsEl ||= el('li', 'is-empty', 'idle · tool calls will show up here')]);
      return;
    }
    showRows(list, calls.map(c => this.callRow(c, now, true)));
  }

  callRow(c, now, big = false) {
    const key = big ? 'bigRow' : 'row';
    if (!c[key]) {
      const li = el('li', 'is-new');
      li.dataset.actorColor = c.actor.color;
      li.dataset.uid = c.actor.uid;
      li.addEventListener('animationend', () => li.classList.remove('is-new'), { once: true });
      const arg = el('span', 'as-viz__call-arg', c.arg || '—');
      arg.title = c.arg;
      const row = c[key] = { li, dot: el('span'), actor: el('span', 'as-viz__call-actor'), time: el('span', 'as-viz__call-time') };
      li.append(row.dot);
      if (big) li.append(el('span', 'as-calls__time', clock(new Date(c.startedAt))));
      li.append(el('span', 'as-viz__call-name', c.name), arg, row.actor, row.time);
      row.actor.title = `${c.actor.atespace}/${c.actor.name}`;
    }
    const { li, dot, actor, time } = c[key];
    li.classList.toggle('is-done', !!c.endedAt && now - c.endedAt > DONE_HOLD_MS);
    const dotCls = `as-viz__call-dot${c.endedAt ? ' is-ended' : ' pulse'}`;
    if (dot.className !== dotCls) dot.className = dotCls;
    const owner = this.sessions.get(c.actor.name);
    setText(actor, `${owner ? owner + ' · ' : ''}actor/${c.actor.name.slice(0, 8)}`);
    setText(time, c.endedAt ? `✓ ${since(c.endedAt - c.startedAt)}` : since(now - c.startedAt));
    return li;
  }


  // ---------------------------------------------------------------------
  // router + events

  route(a) {
    this.routerEl.dataset.actorColor = a.color;
    this.routerEl.classList.add('is-routing');
    this.$('[data-viz-router-sub]').textContent = `routing → actor/${a.name.slice(0, 18)}${a.name.length > 18 ? '…' : ''}`;
    clearTimeout(this.routeTimer);
    this.routeTimer = setTimeout(() => {
      this.routerEl.classList.remove('is-routing');
      this.$('[data-viz-router-sub]').textContent = 'routes & resumes on request';
    }, 1400);
  }

  addEvent(cls, actor, verb, placeholder = false, detail = '') {
    const li = el('li', placeholder ? 'is-empty' : '');
    li.appendChild(el('time', null, clock(new Date())));
    li.appendChild(el('span', cls, verb));
    if (actor) {
      const b = el('b', null, `actor/${actor.name}`);
      li.dataset.actorColor = actor.color || colorOf(actor);
      li.appendChild(b);
    }
    if (detail) li.appendChild(el('span', null, detail));
    const owner = actor && this.sessions.get(actor.name);
    if (owner) li.appendChild(el('span', 'as-viz__event-owner', owner));
    this.eventsEl.prepend(li);
    while (this.eventsEl.children.length > MAX_EVENTS) this.eventsEl.lastChild.remove();
  }

  // ---------------------------------------------------------------------
  // hover pairing between dots and pods

  bindHover() {
    const over = e => {
      const t = e.target.closest('[data-uid]');
      const uid = t?.dataset.uid || null;
      if (uid !== this.hoverUid) {
        if (this.hoverUid) this.pair(this.hoverUid, false);
        this.hoverUid = uid;
        if (uid) this.pair(uid, true);
      }
      const a = uid && this.actors.get(uid);
      if (a && t.classList.contains('as-viz__dot')) {
        this.tip.innerHTML = '';
        const owner = this.sessions.get(a.name);
        this.tip.append(`actor/${a.name}`, el('br'), el('span', null, `${owner ? owner + ' · ' : ''}${a.state}${a.workerPod ? ' · ' + a.workerPod : ''}${a.template ? ' · ' + a.template : ''}`));
        if (this.onActorClick) this.tip.append(el('br'), el('span', null, 'click for traces'));
        this.tip.hidden = false;
        const r = t.getBoundingClientRect();
        const w = this.tip.offsetWidth;
        this.tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
        this.tip.style.top = `${r.top - this.tip.offsetHeight - 8}px`;
      } else this.tip.hidden = true;
    };
    this.root.addEventListener('mouseover', over);
    this.root.addEventListener('click', e => {
      if (e.target.closest('#viz-calls') && this.onCallsClick) return this.onCallsClick();
      const t = e.target.closest('.as-viz__dot[data-uid], .as-viz__pod[data-uid]');
      const a = t && this.actors.get(t.dataset.uid);
      if (a && this.onActorClick) {
        this.tip.hidden = true;
        this.onActorClick(a);
      }
    });
    this.root.addEventListener('mouseleave', () => {
      if (this.hoverUid) this.pair(this.hoverUid, false);
      this.hoverUid = null;
      this.tip.hidden = true;
    });
  }

  pair(uid, on) {
    for (const n of this.root.querySelectorAll(`[data-uid="${CSS.escape(uid)}"]`)) n.classList.toggle('is-paired-hover', on);
  }
}

// -------------------------------------------------------------------------
// Simulator: mirrors ate.dev's animated demo when no cluster is reachable.

export function createSimulator(onUpdate, { total = 250, targetActive = 7 } = {}) {
  const kinds = ['counter', 'claude', 'sandbox', 'adk', 'mcp', 'hermes', 'codex', 'agent', 'agy'];
  const t0 = Date.now() - total * 1000;
  const actors = Array.from({ length: total }, (_, i) => ({
    uid: `sim-${i}`,
    name: `${kinds[hash(String(i)) % kinds.length]}-${i}`,
    atespace: 'ate-demo',
    template: 'ate-demo/agent-template',
    createTime: new Date(t0 + i * 1000).toISOString(),
    state: 'suspended',
    snapshots: hash(`s${i}`) % 3 === 0 ? 1 : 0,
    workerPod: null,
  }));
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const calls = [['shell', 'npm test'], ['shell', 'ls -la'], ['shell', 'git status --short'], ['shell', 'python3 main.py --check'],
    ['read_file', 'src/index.ts'], ['read_file', 'package.json'], ['write_file', 'README.md'], ['write_file', 'src/app.py']];
  const toolCall = () => { const [name, arg] = pick(calls); return [{ id: ++toolSeq, name, arg, startedAt: Date.now() }]; };
  let toolSeq = 0;
  let worker = 0;
  const emit = () => onUpdate({ actors: actors.map(a => ({ ...a, tools: a.tools && [...a.tools] })), pools: [], atespace: 'ate-demo' });

  const later = (ms, fn) => setTimeout(() => { fn(); emit(); }, ms);
  const tick = () => {
    const active = actors.filter(a => a.state !== 'suspended');
    const idle = actors.filter(a => a.state === 'suspended');
    if (active.length < targetActive || (Math.random() < 0.5 && active.length <= targetActive)) {
      const a = pick(idle);
      a.state = 'resuming';
      a.workerPod = `worker-${(worker++ % 50) + 1}`;
      a.tools = toolCall();
      later(950, () => { a.state = 'running'; a.snapshots = Math.max(1, a.snapshots); });
    } else {
      const a = pick(actors.filter(x => x.state === 'running'));
      if (a) {
        a.state = 'suspending';
        a.tools = [];
        later(750, () => { a.state = 'suspended'; a.workerPod = null; });
      }
    }
    emit();
  };
  for (let i = 0; i < targetActive - 1; i++) {
    const a = actors[(i * 37 + 14) % total];
    a.state = 'running';
    a.workerPod = `worker-${(worker++ % 50) + 1}`;
  }
  emit();
  const timer = setInterval(tick, 1600);
  return { stop: () => clearInterval(timer) };
}
