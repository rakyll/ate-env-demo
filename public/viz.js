// Renders the "atespace / …" cluster visualization from ate.dev, driven by
// snapshots of { actors, pools, atespace } coming from the server (or the
// simulator below when no cluster is reachable).

const COLORS = ['green', 'blue', 'yellow', 'red'];
const ACTIVE = new Set(['running', 'resuming', 'suspending']);
const POD_SLOTS = 8;
const LINGER_MS = 900;      // keep a vacated pod visibly "suspending" this long
const RESUME_FLASH_MS = 950; // show resume animation when a poll skips RESUMING
const MAX_EVENTS = 80;

const ROUTER_COLORS = {
  green: ['#61D76B', 'rgba(97,215,107,.45)'],
  blue: ['#64b9de', 'rgba(100,185,222,.45)'],
  yellow: ['#F3F17B', 'rgba(243,241,123,.45)'],
  red: ['#E77CB2', 'rgba(231,124,178,.45)'],
};

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
    this.routerEl = this.$('.as-viz__router');

    this.actors = new Map();   // uid -> actor (latest)
    this.since = new Map();    // uid -> ms timestamp the current state was first seen
    this.flash = new Map();    // uid -> { until, kind } client-side transitional visuals
    this.slots = new Array(POD_SLOTS).fill(null); // uid or null
    this.dotEls = new Map();
    this.loaded = false;
    this.pools = [];
    this.sessions = new Map(); // actor name -> tab label, for actors owned by open agy tabs

    this.tip = el('div', 'as-tip');
    this.tip.hidden = true;
    document.body.appendChild(this.tip);
    this.bindHover();
    this.addEvent('ev-suspended', null, 'waiting for cluster state…', true);

    setInterval(() => this.renderPods(), 250);
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
      if (prev.state === a.state) continue;
      this.since.set(uid, now);
      this.onTransition(prev, a, now);
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
        const sub = state === 'resuming' ? `↻ resuming · ${since(fl?.kind === 'resuming' ? RESUME_FLASH_MS - (fl.until - now) : elapsed)}`
          : state === 'suspending' ? '⏸ suspending state'
          : `running · ${since(elapsed)}`;
        pod.append(name, el('span', 'as-viz__pod-sub mono', sub), track);
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
  // router + events

  route(a) {
    const [c, g] = ROUTER_COLORS[a.color] || ROUTER_COLORS.blue;
    this.routerEl.style.setProperty('--router-accent', c);
    this.routerEl.style.setProperty('--router-glow', g);
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
        this.tip.hidden = false;
        const r = t.getBoundingClientRect();
        const w = this.tip.offsetWidth;
        this.tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
        this.tip.style.top = `${r.top - this.tip.offsetHeight - 8}px`;
      } else this.tip.hidden = true;
    };
    this.root.addEventListener('mouseover', over);
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
  let worker = 0;
  const emit = () => onUpdate({ actors: actors.map(a => ({ ...a })), pools: [], atespace: 'ate-demo' });

  const later = (ms, fn) => setTimeout(() => { fn(); emit(); }, ms);
  const tick = () => {
    const active = actors.filter(a => a.state !== 'suspended');
    const idle = actors.filter(a => a.state === 'suspended');
    if (active.length < targetActive || (Math.random() < 0.5 && active.length <= targetActive)) {
      const a = pick(idle);
      a.state = 'resuming';
      a.workerPod = `worker-${(worker++ % 50) + 1}`;
      later(950, () => { a.state = 'running'; a.snapshots = Math.max(1, a.snapshots); });
    } else {
      const a = pick(actors.filter(x => x.state === 'running'));
      if (a) {
        a.state = 'suspending';
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
