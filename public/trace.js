// Trace view: clicking an actor lists its create, suspend and resume calls
// (from the cluster's Jaeger, through /api/traces) on one timeline, oldest
// first, each with a bar for how long the call took. The router also calls
// ResumeActor before every request just to find the worker; those lookups
// fold into the row before them instead of getting rows of their own.

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// Durations arrive in microseconds.
function dur(us) {
  if (us < 1000) return `${Math.round(us)}µs`;
  if (us < 1e6) return `${(us / 1000).toFixed(us < 1e4 ? 1 : 0)}ms`;
  return `${(us / 1e6).toFixed(2)}s`;
}

function when(us) {
  const d = new Date(us / 1000);
  const time = d.toLocaleTimeString([], { hour12: false });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

// Gap since the previous call, so a burst of suspends reads as a burst.
function gap(us) {
  const s = us / 1e6;
  if (s < 60) return `+${s.toFixed(s < 10 ? 1 : 0)}s`;
  if (s < 3600) return `+${Math.round(s / 60)}m`;
  return `+${(s / 3600).toFixed(1)}h`;
}

async function getJSON(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (body.error) throw new Error(body.error);
  return body;
}

const KINDS = { CreateActor: 'create', ResumeActor: 'resume', SuspendActor: 'suspend' };

export class TraceView {
  constructor(dialog) {
    this.dialog = dialog;
    const $ = sel => dialog.querySelector(sel);
    this.titleEl = $('[data-trace-title]');
    this.subEl = $('[data-trace-sub]');
    this.timelineEl = $('[data-trace-timeline]');
    this.detailEl = $('[data-trace-detail]');
    $('[data-trace-close]').onclick = () => dialog.close();
    // A click on the backdrop lands on the dialog element itself.
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  }

  async open(actor) {
    const req = this.req = {};
    this.titleEl.textContent = `actor/${actor.name}`;
    this.subEl.textContent = [actor.atespace, actor.state, actor.workerPod, actor.template].filter(Boolean).join(' · ');
    this.timelineEl.replaceChildren(el('div', 'as-trace__note', 'loading calls…'));
    this.detailEl.replaceChildren();
    if (!this.dialog.open) this.dialog.showModal();
    try {
      const q = new URLSearchParams({ actor: actor.name, atespace: actor.atespace || '' });
      const { events } = await getJSON(`/api/traces?${q}`);
      if (this.req !== req) return;
      if (!events.length) {
        this.timelineEl.replaceChildren(el('div', 'as-trace__note', 'No create, suspend or resume calls for this actor in the last 6 hours.'));
        return;
      }
      this.render(events);
    } catch (e) {
      if (this.req === req) this.timelineEl.replaceChildren(el('div', 'as-trace__note as-trace__note--error', e.message));
    }
  }

  render(all) {
    const events = [];
    for (const e of all) {
      if (e.lookup && events.length) events[events.length - 1].lookups.push(e);
      else events.push({ ...e, lookups: [] });
    }
    // Bars share one duration scale so calls compare at a glance.
    const longest = Math.max(1, ...events.map(e => e.duration));
    const legend = el('div', 'as-trace__legend');
    for (const [name, kind] of Object.entries(KINDS)) {
      const of = events.filter(e => e.name === name && !e.lookup);
      const avg = of.reduce((t, e) => t + e.duration, 0) / of.length;
      const c = el('span', null, of.length ? `${kind} ${of.length} · avg ${dur(avg)}` : `${kind} 0`);
      c.dataset.kind = kind;
      c.prepend(el('i', 'as-trace__swatch'));
      legend.append(c);
    }
    const lookups = all.filter(e => e.lookup).length;
    if (lookups) {
      const c = el('span', null, `lookup ${lookups}`);
      c.dataset.kind = 'lookup';
      c.title = 'ResumeActor calls on a running actor: the router finding its worker';
      c.prepend(el('i', 'as-trace__swatch'));
      legend.append(c);
    }
    const head = el('div', 'as-trace__row as-trace__row--ruler');
    head.append(el('div', 'as-trace__label', 'time · call · triggered by'), legend);

    const rows = events.map((e, i) => {
      const row = el('div', 'as-trace__row');
      row.dataset.kind = e.lookup ? 'lookup' : KINDS[e.name];
      row.tabIndex = 0;
      const label = el('div', 'as-trace__label');
      label.append(
        el('span', 'as-trace__time', when(e.start)),
        el('span', 'as-trace__gap', i ? gap(e.start - events[i - 1].start) : ''),
        el('i', 'as-trace__swatch'),
        el('span', `as-trace__name${e.error ? ' is-error' : ''}`, e.name),
        el('span', 'as-trace__by', e.via || e.by),
      );
      label.title = `started by ${e.by}${e.via ? ` · ${e.via}` : ''}`;
      const lane = el('div', 'as-trace__lane');
      const bar = el('span', `as-trace__bar${e.error ? ' is-error' : ''}`);
      bar.style.width = `max(3px, ${(e.duration / longest) * 85}%)`;
      lane.append(bar, el('span', 'as-trace__dur', dur(e.duration)));
      if (e.lookups.length) {
        const more = el('span', 'as-trace__more', `+${e.lookups.length} lookup${e.lookups.length > 1 ? 's' : ''}`);
        more.title = e.lookups.map(l => `${when(l.start)}  ${l.via || l.by}  ${dur(l.duration)}`).join('\n');
        lane.append(more);
      }
      row.append(label, lane);
      row.onclick = () => this.select(row, e);
      row.onkeydown = ev => {
        const next = { ArrowUp: row.previousElementSibling, ArrowDown: row.nextElementSibling }[ev.key];
        if (next?.tabIndex === 0) { ev.preventDefault(); next.focus(); next.click(); }
      };
      return row;
    });
    this.timelineEl.replaceChildren(head, ...rows);
    const last = rows[rows.length - 1];
    this.select(last, events[events.length - 1]);
    last.scrollIntoView({ block: 'nearest' });
  }

  select(row, e) {
    for (const r of this.timelineEl.querySelectorAll('.is-selected')) r.classList.remove('is-selected');
    row.classList.add('is-selected');
    const head = el('div', 'as-trace__detail-head');
    head.dataset.kind = e.lookup ? 'lookup' : KINDS[e.name];
    head.append(el('i', 'as-trace__swatch'), el('span', `as-trace__name${e.error ? ' is-error' : ''}`, e.name),
      el('span', 'as-trace__by', [e.lookup && 'lookup', e.via, e.by].filter(Boolean).join(' · ')),
      el('span', 'as-trace__detail-time', `${when(e.start)} · ${dur(e.duration)}${e.error ? ' · error' : ''} · trace ${e.id}`));
    const parts = [head];
    if (e.lookups.length) {
      const list = el('div', 'as-trace__lookups');
      list.append(el('div', 'as-trace__lookups-head', `then ${e.lookups.length} ResumeActor lookup${e.lookups.length > 1 ? 's' : ''} (already running; the router finding its worker)`));
      for (const l of e.lookups) {
        const item = el('div', 'as-trace__lookup');
        item.append(el('span', 'as-trace__time', when(l.start)), el('span', 'as-trace__gap', `+${dur(l.start - e.start)}`),
          el('span', 'as-trace__name', l.via || l.by), el('span', 'as-trace__dur', dur(l.duration)));
        list.append(item);
      }
      parts.push(list);
    }
    const table = el('dl', 'as-trace__attrs');
    for (const [k, v] of Object.entries(e.attrs).sort(([a], [b]) => a.localeCompare(b))) {
      table.append(el('dt', null, k), el('dd', null, String(v)));
    }
    this.detailEl.replaceChildren(...parts, table);
  }
}
