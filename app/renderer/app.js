/* SysMon renderer. All remote values are written via textContent / SVG
   attributes only — never through innerHTML. */
'use strict';
(function () {
  const F = window.SysmonFmt;
  const board = document.getElementById('board');
  const LAYOUTS = ['radial', 'bars', 'numerals'];
  const LAYOUT_NAMES = { radial: '1a', bars: '1b', numerals: '1c' };
  const LAYOUT_TITLES = { radial: '1a · radial rows', bars: '1b · bar columns', numerals: '1c · big numerals' };

  let settings = { layout: 'radial', displayId: null };
  let state = null;
  let layout = 'radial';
  let ciSignature = '';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function mark(e, name) { e.dataset.f = name; return e; }
  function svgEl(tag, attrs) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function f(parent, name) { return parent.querySelector(`[data-f="${name}"]`); }
  function setText(parent, name, value) { const e = f(parent, name); if (e) e.textContent = value; }
  function setColor(parent, name, value) { const e = f(parent, name); if (e) e.style.color = value; }

  /* ---------- skeleton builders ---------- */

  function header() {
    const h = el('header', 'hdr');
    const left = el('div', 'left');
    left.append(el('span', 'title', 'OPS · STAT BOARD'));
    left.append(mark(el('span'), 'hostsCount'));
    left.append(mark(el('span'), 'accountsCount'));
    const right = el('div', 'right');
    const live = el('span', null, null);
    live.style.display = 'flex'; live.style.gap = '8px'; live.style.alignItems = 'center';
    live.append(mark(el('span', 'dot offline'), 'dot'));
    live.append(mark(el('span', null, 'offline'), 'dotLabel'));
    right.append(live, switcher());
    right.append(mark(el('span'), 'date'));
    right.append(mark(el('span', 'clock', '--:--:--'), 'clock'));
    h.append(left, right);
    return h;
  }

  function switcher() {
    const sw = el('nav', 'switch');
    sw.dataset.f = 'switch';
    for (const name of LAYOUTS) {
      const b = el('button', name === layout ? 'active' : '', LAYOUT_NAMES[name]);
      b.dataset.layout = name;
      b.dataset.testid = `layout-${name}`;
      b.title = LAYOUT_TITLES[name];
      b.setAttribute('aria-label', `Layout ${LAYOUT_TITLES[name]}`);
      b.addEventListener('click', async () => {
        if (name === layout) return;
        settings = await window.sysmon.layout(name);
        applyLayout(settings.layout);
      });
      sw.append(b);
    }
    return sw;
  }

  function gauge(r, size, center = true) {
    const g = el('div', 'gauge');
    const svg = svgEl('svg', { width: size, height: size, viewBox: '0 0 100 100' });
    svg.append(svgEl('circle', { cx: 50, cy: 50, r, fill: 'none', stroke: 'var(--line)', 'stroke-width': r === 40 ? 7 : 10 }));
    const arc = svgEl('circle', { cx: 50, cy: 50, r, fill: 'none', stroke: 'var(--mute)', 'stroke-width': r === 40 ? 7 : 10, 'stroke-dasharray': `0 ${2 * Math.PI * r}` });
    arc.dataset.f = 'arc';
    arc.style.transition = 'stroke-dasharray .8s';
    svg.append(arc);
    if (!center) { g.append(svg); return g; }
    const gv = el('div', 'gv');
    gv.append(mark(el('div', 'n v', '—'), 'gaugeN'));
    gv.append(el('div', 'u', 'CPU'));
    g.append(svg, gv);
    return g;
  }

  function mstat(labelText) {
    const d = el('div', 'mstat');
    d.append(el('div', 'lbl', labelText));
    const n = el('div', 'n v', '—'); n.dataset.f = labelText.toLowerCase() + 'N';
    const unit = el('span', 'unit', '%');
    n.append(unit);
    d.append(n);
    const sub = el('div', 'sub', ''); sub.dataset.f = labelText.toLowerCase() + 'Sub';
    d.append(sub);
    return d;
  }

  function machineIdentity(m) {
    const id = el('div', 'm-id');
    const osRow = el('div', 'os', m.os); osRow.dataset.f = 'os';
    id.append(osRow);
    id.append(mark(el('div', 'host', ''), 'host'));
    id.append(mark(el('div', 'up', ''), 'up'));
    const badge = el('div', null, null); badge.dataset.f = 'badge'; badge.style.marginTop = '4px';
    id.append(badge);
    return id;
  }

  function machineRowRadial(m) {
    const row = el('div', 'mrow');
    row.dataset.m = m.id; row.dataset.testid = `machine-${m.id}`;
    row.append(machineIdentity(m));
    const gw = el('div', 'gauge-wrap');
    gw.append(gauge(40, 132));
    const meta = el('div', 'gauge-meta', '');
    meta.dataset.f = 'cores';
    gw.append(meta);
    row.append(gw, mstat('mem'), mstat('disk'));
    return row;
  }

  function machineColBars(m) {
    const col = el('div', 'bcol');
    col.dataset.m = m.id; col.dataset.testid = `machine-${m.id}`;
    const head = el('div', 'head');
    head.append(el('span', 'os', m.os));
    head.append(mark(el('span', 'host', ''), 'host'));
    col.append(head);
    const badge = el('div'); badge.dataset.f = 'badge'; col.append(badge);
    const cpu = el('div');
    const lbl = el('div', 'cpu-lbl');
    lbl.append(mark(el('span', 't', ''), 'cores'));
    lbl.append(mark(el('span', 'n v', '—'), 'cpuN'));
    cpu.append(lbl);
    const bar = el('div', 'bar');
    const fill = el('div'); fill.dataset.f = 'cpuBar'; bar.append(fill);
    cpu.append(bar);
    col.append(cpu);
    const md = el('div', 'md');
    md.append(mstat('mem'), mstat('disk'));
    col.append(md);
    const up = el('div', 'top-proc');
    up.append(mark(el('span', null, ''), 'topProc'));
    up.append(mark(el('span', null, ''), 'up'));
    col.append(up);
    return col;
  }

  function machineRowNumerals(m) {
    const row = el('div', 'nrow');
    row.dataset.m = m.id; row.dataset.testid = `machine-${m.id}`;
    row.append(machineIdentity(m));
    const cpu = el('div');
    const cpuTop = el('div'); cpuTop.style.display = 'flex'; cpuTop.style.justifyContent = 'space-between'; cpuTop.style.alignItems = 'baseline';
    cpuTop.append(el('span', 'lbl', 'CPU'));
    const n = el('span', 'cpu-n v', '—'); n.dataset.f = 'cpuN';
    n.append(el('span', 'unit', '%'));
    cpuTop.append(n);
    cpu.append(cpuTop);
    const spark = svgEl('svg', { viewBox: '0 0 240 56', preserveAspectRatio: 'none', class: 'spark' });
    spark.setAttribute('class', 'spark');
    spark.append(svgEl('line', { x1: 0, y1: 55, x2: 240, y2: 55, stroke: 'var(--line)' }));
    const pl = svgEl('polyline', { fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke', points: '' });
    pl.dataset.f = 'spark';
    spark.append(pl);
    cpu.append(spark);
    row.append(cpu, mstat('mem'), mstat('disk'));
    return row;
  }

  /* ---------- accounts ---------- */

  function accountBadgeRow(card) {
    const badge = el('div'); badge.dataset.f = 'badge';
    card.append(badge);
    return badge;
  }

  function accountCardRadial(a) {
    const card = el('div', 'acard');
    card.dataset.a = a.id; card.dataset.testid = `account-${a.id}`;
    const top = el('div', 'top');
    top.append(el('span', 'vendor', a.vendor));
    top.append(el('span', 'who', a.host));
    card.append(top);
    const mid = el('div', 'mid');
    const g = gauge(42, 96, false);
    mid.append(g);
    const info = el('div');
    const used = el('div', 'used v', '—'); used.dataset.f = 'usedN';
    used.append(el('span', 'unit', '%'));
    info.append(used);
    info.append(mark(el('div', 'of', ''), 'win'));
    info.append(mark(el('div', 'extras', ''), 'extras'));
    mid.append(info);
    card.append(mid);
    const bot = el('div', 'bot');
    bot.append(el('span', 'lbl', 'RESET IN'));
    bot.append(mark(el('span', 'reset', '—'), 'reset'));
    card.append(bot);
    card.append(mark(el('div', 'msg', ''), 'msg'));
    accountBadgeRow(card);
    return card;
  }

  function accountCardBars(a) {
    const card = el('div', 'bacct');
    card.dataset.a = a.id; card.dataset.testid = `account-${a.id}`;
    const top = el('div', 'top');
    top.append(el('span', 'vendor', `${a.vendor} · ${a.host}`));
    top.append(mark(el('span', 'win', ''), 'win'));
    card.append(top);
    const used = el('div', 'used v', '—'); used.dataset.f = 'usedN';
    used.append(el('span', 'unit', '%'));
    card.append(used);
    const bar = el('div', 'bar'); const fill = el('div'); fill.dataset.f = 'usedBar'; bar.append(fill); card.append(bar);
    card.append(mark(el('div', 'extras', ''), 'extras'));
    const rr = el('div', 'reset-row');
    rr.append(el('span', 'lbl', 'RESET'));
    rr.append(mark(el('span', 'reset', '—'), 'reset'));
    card.append(rr);
    card.append(mark(el('div', 'msg', ''), 'msg'));
    const badge = el('div'); badge.dataset.f = 'badge'; card.append(badge);
    return card;
  }

  function accountRowNumerals(a) {
    const card = el('div', 'nacct');
    card.dataset.a = a.id; card.dataset.testid = `account-${a.id}`;
    const left = el('div'); left.style.minWidth = '0';
    left.append(el('div', 'vendor', `${a.vendor} · ${a.host}`));
    left.append(mark(el('div', 'reset-big', '—'), 'reset'));
    left.append(mark(el('div', 'until', ''), 'win'));
    left.append(mark(el('div', 'msg', ''), 'msg'));
    const badge = el('div'); badge.dataset.f = 'badge'; left.append(badge);
    card.append(left);
    const right = el('div', 'right');
    const used = el('div', 'used v', '—'); used.dataset.f = 'usedN';
    used.append(el('span', 'unit', '%'));
    right.append(used);
    const bar = el('div', 'mini-bar'); const fill = el('div'); fill.dataset.f = 'usedBar'; bar.append(fill); right.append(bar);
    right.append(mark(el('div', 'extras', ''), 'extras'));
    card.append(right);
    return card;
  }

  /* ---------- CI panel ---------- */

  function ciPanel(withHeader) {
    const ci = el('aside', 'ci'); ci.dataset.testid = 'ci-panel';
    if (withHeader) {
      const h = el('div', 'ci-hdr');
      h.append(mark(el('span', 'date', ''), 'date'));
      h.append(switcher());
      h.append(mark(el('span', 'clock', '--:--:--'), 'clock'));
      ci.append(h);
    }
    const body = el('div', 'ci-body');
    const title = el('div', 'ci-title');
    title.append(el('span', 't', 'FAILING CI'));
    title.append(mark(el('span', 'n ok', '—'), 'ciCount'));
    body.append(title);
    const badge = el('div'); badge.dataset.f = 'ciBadge'; body.append(badge);
    body.append(mark(el('div', null, ''), 'ciList'));
    const foot = el('div', 'ci-foot');
    foot.append(mark(el('span', null, ''), 'ciScope'));
    foot.append(mark(el('span', null, ''), 'ciAge'));
    body.append(foot);
    ci.append(body);
    return ci;
  }

  /* ---------- layout assembly ---------- */

  function buildRadial() {
    board.className = 'lay-radial';
    board.append(header());
    const main = el('main', 'radial-main');
    const machines = el('section', 'radial-machines');
    for (const m of state.machines) machines.append(machineRowRadial(m));
    const accounts = el('section', 'radial-accounts');
    for (const a of state.accounts) accounts.append(accountCardRadial(a));
    main.append(machines, accounts, ciPanel(false));
    board.append(main);
  }

  function buildBars() {
    board.className = 'lay-bars';
    const left = el('div', 'bars-left');
    const machines = el('section', 'bars-machines');
    for (const m of state.machines) machines.append(machineColBars(m));
    const accounts = el('section', 'bars-accounts');
    // Two vendor-paired rows under the machine columns: row 1 Codex/Codex/Kimi,
    // row 2 Claude/Claude/Grok, each card beneath its owning machine column.
    const rank = { 'minis-Codex': 0, 'dictator-Codex': 1, 'dictator-Kimi': 2, 'minis-Claude': 3, 'dictator-Claude': 4, grok: 5 };
    const ordered = [...state.accounts].sort((x, y) => (rank[x.id] ?? 99) - (rank[y.id] ?? 99));
    for (const a of ordered) accounts.append(accountCardBars(a));
    left.append(machines, accounts);
    board.append(left, ciPanel(true));
  }

  function buildNumerals() {
    board.className = 'lay-numerals';
    const machines = el('section', 'num-machines');
    for (const m of state.machines) machines.append(machineRowNumerals(m));
    const accounts = el('section', 'num-accounts');
    for (const a of state.accounts) accounts.append(accountRowNumerals(a));
    board.append(machines, accounts, ciPanel(true));
  }

  function applyLayout(next) {
    layout = LAYOUTS.includes(next) ? next : 'radial';
    board.dataset.layout = layout;
    board.textContent = '';
    ciSignature = '';
    ({ radial: buildRadial, bars: buildBars, numerals: buildNumerals })[layout]();
    patch();
    tick();
  }

  /* ---------- patching ---------- */

  const STATUS_BADGE = {
    stale: ['stale', (x) => `stale ${F.fmtAgo(Date.now() - (x.lastSuccessAt || x.sampledAt)) || ''}`.trim()],
    offline: ['offline', () => 'offline'],
    connecting: ['connecting', () => 'connecting'],
    auth: ['auth', () => 'sign in'],
    unavailable: ['unavailable', () => 'unavailable'],
  };

  function patchBadge(parent, status, entity) {
    const b = f(parent, 'badge');
    if (!b) return;
    b.textContent = '';
    b.className = '';
    if (status === 'live') return;
    const def = STATUS_BADGE[status] || STATUS_BADGE.unavailable;
    b.className = `badge ${def[0]}`;
    b.textContent = def[1](entity);
  }

  function patchMachine(m) {
    const row = board.querySelector(`[data-m="${m.id}"]`);
    if (!row) return;
    const has = m.sampledAt != null && m.status !== 'connecting' && m.status !== 'offline';
    row.classList.toggle('dimmed', m.status === 'stale' || (m.status === 'offline' && m.sampledAt != null));
    setText(row, 'host', `${m.name} · ${m.address}`);
    const upNow = m.uptime != null && m.status === 'live' ? m.uptime + (Date.now() - m.sampledAt) / 1000 : m.uptime;
    setText(row, 'up', m.uptime != null ? `up ${F.fmtUptime(upNow)}` : 'up —');
    patchBadge(row, m.status, m);
    const cpu = F.pct(m.cpu);
    const gaugeN = f(row, 'gaugeN');
    if (gaugeN) gaugeN.textContent = cpu == null ? '—' : String(cpu);
    setText(row, 'cpuN', cpu == null ? '—' : `${cpu}%`);
    setColor(row, 'cpuN', F.colorFor(cpu));
    const arc = f(row, 'arc');
    if (arc) { arc.setAttribute('stroke-dasharray', F.dashFor(cpu, 40)); arc.setAttribute('stroke', F.colorFor(cpu)); }
    setText(row, 'cores', m.cores ? `${m.cores} cores${m.load != null ? ` · load ${Number(m.load).toFixed(1)}` : ''}` : '');
    const bar = f(row, 'cpuBar');
    if (bar) { bar.style.width = `${F.clamp(cpu ?? 0)}%`; bar.style.background = F.colorFor(cpu); }
    const mem = F.pct(m.mem), disk = F.pct(m.disk);
    setText(row, 'memN', mem == null ? '—' : `${mem}`); // unit span preserved below
    const memN = f(row, 'memN'); if (memN) { memN.textContent = mem == null ? '—' : `${mem}`; memN.append(el('span', 'unit', '%')); memN.style.color = F.colorFor(mem); }
    const diskN = f(row, 'diskN'); if (diskN) { diskN.textContent = disk == null ? '—' : `${disk}`; diskN.append(el('span', 'unit', '%')); diskN.style.color = F.colorFor(disk); }
    setText(row, 'memSub', m.memUsed != null ? `${F.fmtGB(m.memUsed)} / ${F.fmtGB(m.memTotal)} GB` : '');
    setText(row, 'diskSub', m.diskFree != null ? `${F.fmtGB(m.diskFree)} GB free` : '');
    setText(row, 'topProc', m.topProc ? `${m.topProc}${m.topPct != null ? ` · ${Math.round(m.topPct)}% cpu` : ''}` : '');
    const spark = f(row, 'spark');
    if (spark) { spark.setAttribute('points', F.sparkPoints(m.history)); spark.setAttribute('stroke', F.colorFor(cpu)); }
  }

  function windowShort(label) {
    const parts = String(label || '').split('·');
    return (parts[1] || parts[0]).trim();
  }

  function claudeSigninButton(a, msg) {
    const b = el('button', 'link', a.status === 'auth' ? 'Sign in' : 'Renew sign-in');
    b.dataset.testid = `connect-claude-${a.host}`;
    b.addEventListener('click', async () => {
      b.disabled = true;
      const show = (text, retry) => {
        msg.textContent = text;
        if (retry) { msg.append(b); b.disabled = false; }
      };
      try {
        const r = await window.sysmon.connectClaude(a.host);
        if (r && r.ok === false) { show(r.message || 'Sign-in could not be started', true); return; }
        show((r && r.message) || 'Sign-in opened — finish it in the terminal window', false);
      } catch {
        show('Sign-in could not be started', true);
      }
    });
    return b;
  }

  function patchAccount(a) {
    const card = board.querySelector(`[data-a="${a.id}"]`);
    if (!card) return;
    card.classList.toggle('dimmed', a.status === 'stale');
    patchBadge(card, a.status, a);
    const { primary, extras } = F.primaryWindow(a.windows);
    const canShow = primary && (a.status === 'live' || a.status === 'stale');
    const usedN = f(card, 'usedN');
    if (usedN) {
      usedN.textContent = canShow ? `${Math.round(primary.used)}` : '—';
      usedN.append(el('span', 'unit', '%'));
      usedN.style.color = canShow ? F.colorFor(primary.used) : 'var(--mute)';
    }
    setText(card, 'win', canShow ? (layout === 'radial' ? `of ${windowShort(primary.label)} window` : windowShort(primary.label)) : '');
    const arc = f(card, 'arc');
    if (arc) { arc.setAttribute('stroke-dasharray', F.dashFor(canShow ? primary.used : null, 42)); arc.setAttribute('stroke', canShow ? F.colorFor(primary.used) : 'var(--mute)'); }
    const bar = f(card, 'usedBar');
    if (bar) { bar.style.width = `${canShow ? F.clamp(primary.used) : 0}%`; bar.style.background = canShow ? F.colorFor(primary.used) : 'var(--mute)'; }
    const extrasText = canShow && extras.length ? extras.map((w) => `${w.label} ${Math.round(w.used)}%`).join(' · ') : '';
    setText(card, 'extras', extrasText);
    const extrasEl = f(card, 'extras');
    if (extrasEl) extrasEl.title = extrasText; // full quota list stays viewable when clamped
    const msg = f(card, 'msg');
    if (msg) {
      msg.textContent = '';
      if (a.status === 'auth' || a.status === 'unavailable' || a.status === 'stale') msg.textContent = a.message || '';
      if (a.id === 'grok' && a.status !== 'live') {
        const b = el('button', 'link', a.status === 'auth' ? 'Connect' : 'Reconnect');
        b.dataset.testid = 'connect-grok';
        b.addEventListener('click', () => window.sysmon.connectGrok());
        msg.append(b);
      }
      if (a.vendor === 'Claude' && (a.status === 'auth' || a.status === 'stale')) {
        msg.append(claudeSigninButton(a, msg));
      }
    }
    // reset countdown patched by tick()
    card._resetAt = canShow ? primary.resetAt : null;
    card._hasData = !!canShow;
  }

  function patchCi() {
    const ci = state.ci || {};
    const sig = JSON.stringify([ci.status, ci.jobs?.map((j) => j.url), ci.sampledAt]);
    const count = f(board, 'ciCount');
    if (count) {
      const n = ci.status === 'live' || ci.status === 'stale' ? String(ci.jobs?.length ?? 0) : '—';
      count.textContent = n;
      count.classList.toggle('ok', ci.jobs?.length === 0 && ci.status === 'live');
    }
    const badge = f(board, 'ciBadge');
    if (badge) {
      badge.textContent = ''; badge.className = '';
      if (ci.status === 'stale') { badge.className = 'badge stale'; badge.textContent = `stale ${F.fmtAgo(Date.now() - ci.sampledAt) || ''}`; }
      else if (ci.status === 'unavailable') { badge.className = 'badge unavailable'; badge.textContent = 'unavailable'; }
    }
    if (sig !== ciSignature) {
      ciSignature = sig;
      const list = f(board, 'ciList');
      if (list) {
        list.textContent = '';
        if ((ci.status === 'live' || ci.status === 'stale') && ci.jobs?.length) {
          for (const j of ci.jobs) {
            const row = el('div', 'job');
            row.append(el('span', 'sq'));
            row.append(el('span', 'repo', j.repo));
            row.append(el('span', 'num', `#${j.number}`));
            row.addEventListener('click', () => window.sysmon.openCi(j.url));
            list.append(row);
          }
        } else if (ci.status === 'live') {
          list.append(el('div', 'empty', 'No failing PR checks'));
        } else if (ci.status === 'unavailable' || ci.status === 'connecting') {
          list.append(el('div', 'empty', ci.message || 'Checking…'));
        }
      }
    }
    setText(board, 'ciScope', ci.scope || 'GitHub Actions');
  }

  function patch() {
    if (!state) return;
    setText(board, 'hostsCount', `${state.machines.length} hosts`);
    setText(board, 'accountsCount', `${state.accounts.length} accounts`);
    const bs = F.boardStatus(state.machines);
    const dot = f(board, 'dot');
    if (dot) dot.className = `dot ${bs}`;
    setText(board, 'dotLabel', bs);
    for (const m of state.machines) patchMachine(m);
    for (const a of state.accounts) patchAccount(a);
    patchCi();
  }

  function tick() {
    const d = new Date();
    setText(board, 'clock', d.toLocaleTimeString('en-GB', { hour12: false }));
    setText(board, 'date', d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase());
    if (state) {
      for (const a of state.accounts) {
        const card = board.querySelector(`[data-a="${a.id}"]`);
        if (!card) continue;
        const reset = f(card, 'reset');
        if (!reset) continue;
        if (!card._hasData) { reset.textContent = '—'; continue; }
        const cd = F.fmtCountdown(card._resetAt == null ? null : card._resetAt - Date.now());
        reset.textContent = cd == null ? 'unknown' : cd;
      }
      // refresh uptime + stale ages once a second without a full patch
      for (const m of state.machines) {
        const row = board.querySelector(`[data-m="${m.id}"]`);
        if (!row || m.uptime == null) continue;
        const upNow = m.status === 'live' ? m.uptime + (Date.now() - m.sampledAt) / 1000 : m.uptime;
        setText(row, 'up', `up ${F.fmtUptime(upNow)}`);
        if (m.status === 'stale') patchBadge(row, 'stale', m);
      }
      const ci = state.ci;
      if (ci?.sampledAt) setText(board, 'ciAge', `polled ${F.fmtAgo(Date.now() - ci.sampledAt)}`);
      if (ci?.status === 'stale') {
        const badge = f(board, 'ciBadge');
        if (badge) badge.textContent = `stale ${F.fmtAgo(Date.now() - ci.sampledAt) || ''}`;
      }
    }
  }

  /* ---------- boot ---------- */

  async function boot() {
    [settings, state] = await Promise.all([window.sysmon.settings(), window.sysmon.snapshot()]);
    window.sysmon.onUpdate((s) => { state = s; patch(); });
    applyLayout(settings.layout);
    setInterval(tick, 1000);
  }
  boot();
})();
