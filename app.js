'use strict';

const API = window.LADDER_API_URL;
const HOUR = 3600 * 1000;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, session) { try { return (session ? sessionStorage : localStorage).getItem(k) || ''; } catch { return ''; } },
  set(k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch { /* ignore */ } }
};

let state = null;
let skew = 0;          // server clock minus browser clock
let me = store.get('ladderMe');
let adminPin = store.get('ladderAdmin', true);
let reloading = false;

const now = () => Date.now() + skew;
const fmt = t => new Date(t).toLocaleString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London'
});
const fmtDate = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
const toLocalInput = t => { const d = new Date(t); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const pinField = (label = 'Your 4-digit PIN', name = 'pin') =>
  `<label>${label}<input name="${name}" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off"></label>`;
const score = c => `${Math.max(c.cFrames, c.dFrames)}–${Math.min(c.cFrames, c.dFrames)}`;

/* ---------- Server ---------- */

async function load() {
  const r = await fetch(API + '?action=state');
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  setState(j.state);
}

async function post(body) {
  let j;
  try {
    const r = await fetch(API, { method: 'POST', body: JSON.stringify(body) });
    j = await r.json();
  } catch {
    throw new Error('Could not reach the ladder. Check your connection and try again.');
  }
  if (j.state) setState(j.state);
  if (!j.ok) throw new Error(j.error);
  return j;
}

function setState(s) {
  state = s;
  skew = Date.parse(s.now) - Date.now();
  if (!location.hash.startsWith('#admin')) render();
}

/* ---------- Modal ---------- */

function modal({ title, body, ok = 'OK', cancel = 'Cancel', onOk }) {
  const d = $('#modal');
  d.innerHTML = `<form novalidate><h3>${esc(title)}</h3><div>${body}</div><p class="err"></p>
    <div class="actions">${cancel ? `<button type="button" class="secondary" data-close>${cancel}</button>` : ''}
    ${ok ? `<button class="primary">${ok}</button>` : ''}</div></form>`;
  const form = d.querySelector('form'), err = d.querySelector('.err');
  d.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => d.close(); });
  form.onsubmit = async e => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    if (!onOk) return d.close();
    const btn = form.querySelector('.primary');
    btn.disabled = true;
    err.textContent = '';
    try {
      const next = await onOk(new FormData(form));
      d.close();
      if (typeof next === 'function') next();
    } catch (x) {
      err.textContent = x.message;
    } finally {
      btn.disabled = false;
    }
  };
  d.showModal();
  const first = d.querySelector('input, select');
  if (first) first.focus();
}

const notice = (title, body) => modal({ title, body, ok: 'Close', cancel: '' });

/* ---------- Player view ---------- */

const player = id => state.players.find(p => p.id === id);
const activeFor = id => state.challenges.find(c => c.challengerId === id || c.defenderId === id);

function seasonOpen() {
  const s = state.settings;
  return now() >= Date.parse(s.seasonStart) && now() + s.challengeHours * HOUR <= Date.parse(s.seasonEnd);
}

function render() {
  const s = state.settings;
  $('#season').textContent = `Season ${fmtDate(s.seasonStart)} – ${fmtDate(s.seasonEnd)}`;

  const sel = $('#me');
  const sorted = [...state.players].sort((a, b) => a.name.localeCompare(b.name));
  if (me && !player(me)) me = '';
  sel.innerHTML = '<option value="">Choose your name…</option>' +
    sorted.map(p => `<option value="${p.id}" ${p.id === me ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  const mine = player(me);
  const canChallenge = mine && !activeFor(mine.id) && seasonOpen();
  const targets = state.players.filter(p => canChallenge && !activeFor(p.id) &&
    mine.position - p.position >= 1 && mine.position - p.position <= 2);

  $('#meHint').textContent = !mine ? 'Choose your name to see who you can challenge. Your PIN is only needed to make changes.'
    : activeFor(mine.id) ? 'You are in a challenge. Finish it before making another.'
    : !seasonOpen() ? 'New challenges are closed (there is not enough time left in the season).'
    : mine.position === 1 ? 'You are top of the ladder!'
    : targets.length ? 'Tap a green name to challenge them.'
    : 'Both players above you are already in challenges. Try again later.';

  $('#ladder').innerHTML = state.players.map(p => {
    const ch = activeFor(p.id), target = targets.includes(p);
    const tag = ch ? `<span class="tag">${ch.challengerId === p.id ? 'Challenging' : 'Challenged by'} ${esc(ch.challengerId === p.id ? ch.defenderName : ch.challengerName)}</span>` : '';
    return `<li class="row${ch ? ' is-busy' : ''}${target ? ' is-target' : ''}${p.id === me ? ' is-me' : ''}">
      <span class="pos">${p.position}</span>
      <span class="name">${target ? `<button class="link" data-challenge="${p.id}">${esc(p.name)}</button>` : esc(p.name)}</span>
      ${tag}${target ? `<button class="primary sm" data-challenge="${p.id}">Challenge</button>` : ''}</li>`;
  }).join('');

  $('#challenges').innerHTML = state.challenges.length
    ? [...state.challenges].sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline)).map(card).join('')
    : '<p class="muted">No challenges in progress.</p>';

  $('#history').innerHTML = state.history.length ? state.history.map(h => `<li><time>${fmtDate(h.resolvedAt)}</time>${historyText(h)}</li>`).join('')
    : '<li class="muted">No results yet this season.</li>';

  tick();
}

function card(c) {
  const involved = me === c.challengerId || me === c.defenderId;
  let info = '', actions = '';
  if (c.status === 'open') {
    info = `<div>Deadline: <b>${fmt(c.deadline)}</b> <span class="cd" data-until="${c.deadline}" data-suffix=" left"></span></div>
      <div>${c.booked ? `Match booked: <b>${fmt(c.booked)}</b>` : '<span class="warn">Date not booked yet</span>'}</div>`;
    if (involved) {
      actions = `<button class="secondary" data-act="book" data-id="${c.id}">${c.booked ? 'Change date' : 'Book date'}</button>
        <button class="primary" data-act="result" data-id="${c.id}">Enter result</button>
        <a class="btn whatsapp" target="_blank" rel="noopener" href="${waLink(opponentPhone(c), waChallengeText(c))}">WhatsApp opponent</a>`;
    }
  } else if (c.status === 'pending') {
    const winner = +c.cFrames > +c.dFrames ? c.challengerName : c.defenderName;
    const enteredBy = c.enteredBy === c.challengerId ? c.challengerName : c.defenderName;
    const confirmerId = c.enteredBy === c.challengerId ? c.defenderId : c.challengerId;
    const autoAt = new Date(Date.parse(c.enteredAt) + state.settings.confirmHours * HOUR).toISOString();
    info = `<div>${esc(enteredBy)} entered: <b>${esc(winner)} won ${score(c)}</b></div>
      <div>Waiting for ${esc(player(confirmerId)?.name || '')} to confirm. Auto-confirms in <span class="cd" data-until="${autoAt}"></span></div>`;
    if (me === confirmerId) {
      actions = `<button class="primary" data-act="confirm" data-id="${c.id}">Confirm result</button>
        <button class="danger" data-act="dispute" data-id="${c.id}">Dispute</button>`;
    }
  } else {
    info = '<div class="warn">Result disputed. The admin will decide.</div>';
  }
  return `<article class="card ${c.status}">
    <div class="vs">#${c.challengerPos} ${esc(c.challengerName)} <small>challenged</small> #${c.defenderPos} ${esc(c.defenderName)}</div>
    ${info}${actions ? `<div class="actions">${actions}</div>` : ''}</article>`;
}

function historyText(h) {
  const c = esc(h.challengerName), d = esc(h.defenderName);
  if (h.status === 'cancelled') return `${c} v ${d}: challenge cancelled`;
  if (h.outcome === 'expired') return `${c} takes #${h.defenderPos} from ${d} (match not played by the deadline)`;
  if (h.outcome === 'challenger') return `<b>${c}</b> beat ${d} ${score(h)} and moves up to #${h.defenderPos}`;
  return `<b>${d}</b> beat ${c} ${score(h)} and stays at #${h.defenderPos}`;
}

function left(t) {
  const ms = Date.parse(t) - now();
  if (ms <= 0) return 'time up';
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m % 60}m`;
}

function tick() {
  let due = false;
  document.querySelectorAll('[data-until]').forEach(el => {
    const ms = Date.parse(el.dataset.until) - now();
    if (ms <= 0) due = true;
    el.textContent = left(el.dataset.until) + (ms > 0 ? el.dataset.suffix || '' : '');
    el.className = 'cd ' + (ms < 24 * HOUR ? 'red' : ms < 72 * HOUR ? 'amber' : 'green');
  });
  if (due && !reloading) {
    reloading = true;
    setTimeout(() => load().catch(() => {}).finally(() => { reloading = false; }), 5000);
  }
}

/* ---------- WhatsApp ---------- */

const siteUrl = () => state.settings.siteUrl || location.href.split('#')[0];
const waLink = (phone, text) => `https://wa.me/${phone || ''}?text=${encodeURIComponent(text)}`;
const opponentPhone = c => player(me === c.challengerId ? c.defenderId : c.challengerId)?.phone;
const waChallengeText = c =>
  `🎱 Snooker ladder challenge\n${c.challengerName} (#${c.challengerPos}) has challenged ${c.defenderName} (#${c.defenderPos}).\n` +
  `The match must be played by ${fmt(c.deadline)}.\n${siteUrl()}`;

/* ---------- Player actions ---------- */

function challenge(targetId) {
  const t = player(targetId), mine = player(me);
  const deadline = now() + state.settings.challengeHours * HOUR;
  modal({
    title: `Challenge ${t.name}?`,
    body: `<p>You (#${mine.position}) are challenging <b>${esc(t.name)}</b> (#${t.position}).</p>
      <p>The clock starts now. The match must be played by <b>${fmt(deadline)}</b>, or it counts as a win for you.</p>${pinField()}`,
    ok: 'Send challenge',
    onOk: async f => {
      const { challenge: c } = await post({ action: 'challenge', playerId: me, pin: f.get('pin'), targetId });
      return () => {
        const text = waChallengeText(c);
        notice('Challenge made', `<p>Now let ${esc(c.defenderName)} know:</p><div class="stack">
          ${t.phone ? `<a class="btn whatsapp" target="_blank" rel="noopener" href="${waLink(t.phone, text)}">Message ${esc(c.defenderName)} on WhatsApp</a>` : ''}
          <a class="btn whatsapp" target="_blank" rel="noopener" href="${waLink('', text)}">Post in the WhatsApp group</a></div>`);
      };
    }
  });
}

function book(c) {
  modal({
    title: 'Book the match',
    body: `<p>Must be on or before <b>${fmt(c.deadline)}</b>.</p>
      <label>Date and time<input type="datetime-local" name="when" required min="${toLocalInput(now())}" max="${toLocalInput(c.deadline)}" value="${c.booked ? toLocalInput(c.booked) : ''}"></label>${pinField()}`,
    ok: 'Save',
    onOk: f => post({ action: 'book', playerId: me, pin: f.get('pin'), challengeId: c.id, when: new Date(f.get('when')).toISOString() })
  });
}

const resultFields = c => `<fieldset><legend>Who won?</legend>
    <label><input type="radio" name="winner" value="c" required> ${esc(c.challengerName)} (challenger)</label>
    <label><input type="radio" name="winner" value="d"> ${esc(c.defenderName)}</label></fieldset>
  <fieldset><legend>Frames</legend>
    <label><input type="radio" name="loserFrames" value="0" required> 2–0</label>
    <label><input type="radio" name="loserFrames" value="1"> 2–1</label></fieldset>`;
const framesFrom = f => {
  const l = Number(f.get('loserFrames'));
  return f.get('winner') === 'c' ? { cFrames: 2, dFrames: l } : { cFrames: l, dFrames: 2 };
};

function result(c) {
  modal({
    title: 'Enter result',
    body: resultFields(c) + pinField() + '<p class="muted">Your opponent will be asked to confirm.</p>',
    ok: 'Submit result',
    onOk: f => post({ action: 'result', playerId: me, pin: f.get('pin'), challengeId: c.id, ...framesFrom(f) })
  });
}

function confirmResult(c, dispute) {
  modal({
    title: dispute ? 'Dispute result' : 'Confirm result',
    body: (dispute ? '<p>The admin will be asked to decide the result.</p>' : '<p>The ladder will update straight away.</p>') + pinField(),
    ok: dispute ? 'Dispute' : 'Confirm',
    onOk: f => post({ action: dispute ? 'dispute' : 'confirm', playerId: me, pin: f.get('pin'), challengeId: c.id })
  });
}

function changePin() {
  if (!player(me)) return notice('Change PIN', '<p>Choose your name at the top first.</p>');
  modal({
    title: `Change PIN for ${player(me).name}`,
    body: pinField('Current PIN') + pinField('New 4-digit PIN', 'newPin') + pinField('Repeat new PIN', 'newPin2'),
    ok: 'Change PIN',
    onOk: async f => {
      if (f.get('newPin') !== f.get('newPin2')) throw new Error('The new PINs do not match.');
      await post({ action: 'changePin', playerId: me, pin: f.get('pin'), newPin: f.get('newPin') });
      return () => notice('PIN changed', '<p>Your new PIN is ready to use.</p>');
    }
  });
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-challenge], [data-act]');
  if (!t || !state || location.hash.startsWith('#admin')) return;
  if (t.dataset.challenge) return challenge(t.dataset.challenge);
  const c = state.challenges.find(x => x.id === t.dataset.id);
  if (!c) return;
  ({ book, result, confirm: x => confirmResult(x, false), dispute: x => confirmResult(x, true) })[t.dataset.act]?.(c);
});

$('#me').onchange = e => { me = e.target.value; store.set('ladderMe', me); render(); };
$('#changePin').onclick = changePin;

/* ---------- Admin view ---------- */

async function admin(action, data = {}) {
  return post({ action, adminPin, ...data });
}

async function renderAdmin() {
  const v = $('#adminView');
  if (!adminPin) {
    v.innerHTML = `<div class="top-bar"><h2>Admin</h2><a href="#">Back to ladder</a></div>
      <form class="panel" id="adminLogin"><label>Admin PIN <input type="password" inputmode="numeric" name="pin" required autocomplete="off"></label>
      <p class="err"></p><button class="primary">Log in</button></form>`;
    $('#adminLogin').onsubmit = async e => {
      e.preventDefault();
      adminPin = new FormData(e.target).get('pin');
      try {
        await admin('adminLogin');
        store.set('ladderAdmin', adminPin, true);
        renderAdmin();
      } catch (x) {
        adminPin = '';
        e.target.querySelector('.err').textContent = x.message;
      }
    };
    return;
  }

  let data;
  try {
    data = await admin('adminData');
  } catch (x) {
    adminPin = '';
    store.set('ladderAdmin', '', true);
    return renderAdmin();
  }
  const players = data.players;
  const opts = players.map(p => `<option value="${p.id}">#${p.position} ${esc(p.name)}</option>`).join('');

  v.innerHTML = `<div class="top-bar"><h2>Admin</h2><span><a href="#">Back to ladder</a> · <button class="secondary sm" id="logout">Log out</button></span></div>

    <section class="panel"><h3>Players</h3><div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Name</th><th>Mobile</th><th>PIN</th><th>Alert topic</th><th></th></tr></thead>
      <tbody>${players.map(p => `<tr><td>${p.position}</td><td>${esc(p.name)}</td><td>${esc(p.phone)}</td><td>${esc(p.pin)}</td>
        <td><code>${esc(p.ntfy)}</code></td><td><div class="actions">
        <button class="sm secondary" data-a="edit" data-id="${p.id}">Edit</button>
        <button class="sm secondary" data-a="move" data-id="${p.id}">Move</button>
        <button class="sm secondary" data-a="pin" data-id="${p.id}">New PIN</button>
        <button class="sm danger" data-a="remove" data-id="${p.id}">Remove</button></div></td></tr>`).join('')}</tbody>
    </table></div></section>

    <section class="panel"><h3>Add player</h3><form class="form-grid" id="addPlayer">
      <label>Name<input name="name" required></label>
      <label>Mobile<input name="phone" inputmode="tel" placeholder="07…"></label>
      <label>Position (blank = bottom)<input name="position" type="number" min="1" max="${players.length + 1}"></label>
      <button class="primary">Add</button></form></section>

    <section class="panel"><h3>Challenges in progress</h3>
      ${state.challenges.length ? state.challenges.map(c => `<div class="card ${c.status}">
        <div class="vs">#${c.challengerPos} ${esc(c.challengerName)} <small>challenged</small> #${c.defenderPos} ${esc(c.defenderName)}</div>
        <div>Status: <b>${c.status}</b>${c.status !== 'open' ? ` (entered ${c.cFrames}–${c.dFrames}, challenger first)` : ''} · Deadline ${fmt(c.deadline)}</div>
        <div>${c.booked ? `Match booked: <b>${fmt(c.booked)}</b>` : '<span class="warn">Date not booked yet</span>'}</div>
        <div class="actions">${c.status === 'open' ? `<button class="sm secondary" data-a="book" data-id="${c.id}">${c.booked ? 'Change date' : 'Book date'}</button>` : ''}
        <button class="sm primary" data-a="result" data-id="${c.id}">Set result</button>
        <button class="sm danger" data-a="cancel" data-id="${c.id}">Cancel challenge</button></div></div>`).join('')
        : '<p class="muted">None.</p>'}
      <h3>Add a challenge manually</h3>
      <p class="muted">Use this for challenges made before the site went live. The deadline is 240 hours from the start time.</p>
      <form class="form-grid" id="addChallenge">
        <label>Challenger<select name="challengerId" required>${opts}</select></label>
        <label>Challenged player<select name="defenderId" required>${opts}</select></label>
        <label>Challenge made at<input type="datetime-local" name="start" required value="${toLocalInput(now())}"></label>
        <button class="primary">Add challenge</button></form></section>

    <section class="panel"><h3>Settings</h3><form class="form-grid" id="settings">
      <label>Site address (for alerts and WhatsApp)<input name="siteUrl" value="${esc(data.settings.siteUrl || location.href.split('#')[0])}"></label>
      <label>New admin PIN (optional)<input name="newAdminPin" type="password" inputmode="numeric" autocomplete="off"></label>
      <button class="primary">Save settings</button></form></section>

    <section class="panel"><h3>New season</h3>
      <p class="muted">Cancels open challenges and places every player in a random order (names out of a hat).</p>
      <form class="form-grid" id="newSeason">
        <label>Start<input type="date" name="start" required></label>
        <label>End<input type="date" name="end" required></label>
        <label>Type DRAW to confirm<input name="confirm" required pattern="DRAW"></label>
        <button class="danger">Start new season</button></form></section>

    <section class="panel"><h3>Activity log</h3><div class="log">
      ${data.log.map(l => `<div><time class="muted">${fmt(l.time)}</time> ${esc(l.event)}</div>`).join('')}</div></section>`;

  const done = (msg) => { renderAdmin(); if (msg) notice('Done', msg); };
  const formAction = (id, fn) => {
    $(id).onsubmit = async e => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try { await fn(new FormData(e.target)); } catch (x) { notice('Problem', `<p>${esc(x.message)}</p>`); } finally { btn.disabled = false; }
    };
  };

  $('#logout').onclick = () => { adminPin = ''; store.set('ladderAdmin', '', true); renderAdmin(); };
  formAction('#addPlayer', async f => {
    const j = await admin('adminAddPlayer', Object.fromEntries(f));
    done(`<p>${esc(f.get('name'))} has been added. Their PIN is:</p><p class="big-pin">${j.pin}</p>`);
  });
  formAction('#addChallenge', async f => {
    await admin('adminChallenge', { challengerId: f.get('challengerId'), defenderId: f.get('defenderId'), start: new Date(f.get('start')).toISOString() });
    done('<p>Challenge added.</p>');
  });
  formAction('#settings', async f => { await admin('adminSettings', Object.fromEntries(f)); done('<p>Settings saved.</p>'); });
  formAction('#newSeason', async f => {
    await admin('adminNewSeason', { start: new Date(f.get('start') + 'T00:00:00').toISOString(), end: new Date(f.get('end') + 'T23:59:59').toISOString() });
    done('<p>New season started. The random ladder is shown above.</p>');
  });

  v.querySelectorAll('[data-a]').forEach(b => {
    b.onclick = () => {
      const p = players.find(x => x.id === b.dataset.id), c = state.challenges.find(x => x.id === b.dataset.id);
      const a = b.dataset.a;
      if (a === 'edit') modal({
        title: `Edit ${p.name}`,
        body: `<label>Name<input name="name" required value="${esc(p.name)}"></label>
          <label>Mobile<input name="phone" inputmode="tel" value="${esc(p.phone)}"></label>
          <label>Alert topic (ntfy)<input name="ntfy" value="${esc(p.ntfy)}"></label>`,
        ok: 'Save',
        onOk: async f => { await admin('adminUpdatePlayer', { id: p.id, ...Object.fromEntries(f) }); return done; }
      });
      if (a === 'move') modal({
        title: `Move ${p.name}`,
        body: `<label>New position<input name="position" type="number" min="1" max="${players.length}" required value="${p.position}"></label>`,
        ok: 'Move',
        onOk: async f => { await admin('adminMovePlayer', { id: p.id, position: f.get('position') }); return done; }
      });
      if (a === 'pin') modal({
        title: `New PIN for ${p.name}?`, body: '<p>Their old PIN will stop working.</p>', ok: 'Create new PIN',
        onOk: async () => { const j = await admin('adminResetPin', { id: p.id }); return () => done(`<p>New PIN for ${esc(p.name)}:</p><p class="big-pin">${j.pin}</p>`); }
      });
      if (a === 'remove') modal({
        title: `Remove ${p.name}?`,
        body: '<p>Everyone below them moves up one place. Any challenge they are in will be cancelled.</p>', ok: 'Remove',
        onOk: async () => { await admin('adminRemovePlayer', { id: p.id }); return done; }
      });
      if (a === 'book') modal({
        title: 'Book the match',
        body: `<p>${esc(c.challengerName)} v ${esc(c.defenderName)}. Must be on or before <b>${fmt(c.deadline)}</b>.</p>
          <label>Date and time<input type="datetime-local" name="when" required max="${toLocalInput(c.deadline)}" value="${c.booked ? toLocalInput(c.booked) : ''}"></label>`,
        ok: 'Save',
        onOk: async f => { await admin('adminBook', { challengeId: c.id, when: new Date(f.get('when')).toISOString() }); return done; }
      });
      if (a === 'result') modal({
        title: 'Set result', body: resultFields(c) + '<p class="muted">The ladder updates straight away.</p>', ok: 'Save result',
        onOk: async f => { await admin('adminResult', { challengeId: c.id, ...framesFrom(f) }); return done; }
      });
      if (a === 'cancel') modal({
        title: 'Cancel challenge?', body: '<p>Nobody moves. Both players become free to challenge again.</p>', ok: 'Cancel challenge', cancel: 'Keep',
        onOk: async () => { await admin('adminCancel', { challengeId: c.id }); return done; }
      });
    };
  });
}

/* ---------- Start ---------- */

function route() {
  const isAdmin = location.hash.startsWith('#admin');
  $('#playerView').hidden = isAdmin;
  $('#adminView').hidden = !isAdmin;
  if (isAdmin) renderAdmin();
  else if (state) render();
}

window.addEventListener('hashchange', route);
setInterval(tick, 30000);
setInterval(() => { if (!location.hash.startsWith('#admin') && !$('#modal').open) load().catch(() => {}); }, 120000);

if (!API || API.startsWith('PASTE')) {
  $('#ladder').innerHTML = '<li class="row">Set the web app address in config.js (see README).</li>';
} else {
  load().catch(e => { $('#ladder').innerHTML = `<li class="row">Could not load the ladder: ${esc(e.message)}</li>`; });
  route();
}
