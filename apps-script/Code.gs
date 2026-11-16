/**
 * Patteson Social Club Snooker Ladder – back end (Google Apps Script).
 *
 * 1. Create a Google Sheet, open Extensions > Apps Script and paste this file in.
 * 2. Run setup() once (it creates the tabs, players, PINs and hourly timer).
 * 3. Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * See README.md for full instructions.
 */

// Optional: put a PIN here before running setup(). Leave blank for a random 6-digit PIN.
const ADMIN_PIN = '';

const INITIAL_PLAYERS = [
  'Sean Curtis', 'Tej Thacker', 'Steve Curtis', 'John Walker', 'Adam Gibson',
  'Graham Scott', 'Roberto Facchini', 'Steve Cotten', 'Dylan Wilcox', 'John Butler',
  'Terry Lemmon', 'Colin Lacey', 'Jeff Smith', 'Kevin Knights', 'Daryl Nobbs',
  'Robert Curtis', 'Ryan Stanforth', 'Tim Brown', 'Asa Vassar', 'Stuart Curtis'
];

const SHEETS = {
  Players: ['id', 'name', 'position', 'active', 'pin', 'phone', 'ntfy'],
  Challenges: ['id', 'challengerId', 'defenderId', 'challengerPos', 'defenderPos', 'created', 'deadline',
    'status', 'booked', 'cFrames', 'dFrames', 'enteredBy', 'enteredAt', 'resolvedAt', 'outcome'],
  Settings: ['key', 'value'],
  Log: ['time', 'event'],
  Absences: ['id', 'playerId', 'type', 'start', 'end', 'status', 'createdAt', 'reminded']
};
// Holiday / working away: days at a time, days per season, days back between absences, days ahead it can be booked.
const AWAY = { maxDays: 14, seasonDays: 42, gapDays: 7, aheadDays: 60 };
const AWAY_TYPES = { holiday: 'Holiday', work: 'Working away' };
const ACTIVE = ['open', 'pending', 'disputed'];
const HOUR = 3600 * 1000;
const TZ = 'Europe/London';

/* ---------- Setup and entry points ---------- */

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange('A:Z').setNumberFormat('@');
  });
  if (readTable('Players').length) throw new Error('The ladder is already set up.');
  writeTable('Players', INITIAL_PLAYERS.map((name, i) => ({
    id: uid(), name, position: i + 1, active: 'TRUE', pin: randomPin(4), phone: '', ntfy: newTopic()
  })));
  writeTable('Challenges', []);
  writeTable('Absences', []);
  writeTable('Settings', [
    { key: 'clubName', value: 'Patteson Social Club Snooker Ladder' },
    { key: 'seasonStart', value: '2026-02-01T00:00:00.000Z' },
    { key: 'seasonEnd', value: '2027-01-31T23:59:59.000Z' },
    { key: 'challengeHours', value: '240' },
    { key: 'confirmHours', value: '24' },
    { key: 'siteUrl', value: '' },
    { key: 'adminPin', value: ADMIN_PIN || randomPin(6) }
  ]);
  writeTable('Log', [{ time: iso(Date.now()), event: 'Ladder set up with ' + INITIAL_PLAYERS.length + ' players' }]);
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('hourly').timeBased().everyHours(1).create();
  const sh = ss.getSheetByName('Sheet1');
  if (sh && ss.getSheets().length > 1) ss.deleteSheet(sh);
}

// Runs every hour so expired challenges are applied even if nobody opens the site.
function hourly() {
  withLock(() => {
    const db = load();
    if (processDue(db)) save(db);
  });
}

function doGet() {
  return respond(() => {
    const db = load();
    if (processDue(db)) save(db);
    return { state: publicState(db) };
  });
}

function doPost(e) {
  return respond(() => {
    const req = JSON.parse(e.postData.contents);
    const action = ACTIONS[req.action];
    if (!action) fail('Unknown action.');
    const db = load();
    if (processDue(db)) save(db); // keep automatic updates even if the action below fails
    db.logs = [];
    const result = action(db, req) || {};
    save(db);
    result.state = publicState(db);
    return result;
  });
}

function respond(fn) {
  let out;
  try {
    out = withLock(fn);
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: err.message || String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- Actions ---------- */

const ACTIONS = {
  challenge(db, r) {
    const me = auth(db, r.playerId, r.pin);
    return { challenge: publicChallenge(db, newChallenge(db, me.id, r.targetId, Date.now(), false)) };
  },

  book(db, r) {
    const { me, ch, other } = party(db, r, ['open']);
    const t = Date.parse(r.when);
    if (isNaN(t)) fail('Please choose a date and time.');
    if (t > Date.parse(ch.deadline)) fail('The match must be played by ' + fmt(ch.deadline) + '. Please choose an earlier date.');
    ch.booked = iso(t);
    log(db, `${me.name} booked ${nameOf(db, ch.challengerId)} v ${nameOf(db, ch.defenderId)} for ${fmt(t)}`);
    notify(db, other, 'Match booked', `${me.name} has booked your ladder match for ${fmt(t)}.`);
  },

  result(db, r) {
    const { me, ch, other } = party(db, r, ['open']);
    const [c, d] = frames(r);
    Object.assign(ch, { status: 'pending', cFrames: c, dFrames: d, enteredBy: me.id, enteredAt: iso(Date.now()) });
    const winner = c > d ? nameOf(db, ch.challengerId) : nameOf(db, ch.defenderId);
    log(db, `${me.name} entered result: ${winner} won ${Math.max(c, d)}-${Math.min(c, d)} (awaiting confirmation)`);
    notify(db, other, 'Please confirm the result',
      `${me.name} entered: ${winner} won ${Math.max(c, d)}-${Math.min(c, d)}. Confirm or dispute on the ladder site within ${db.settings.confirmHours} hours.`);
  },

  confirm(db, r) {
    const { me, ch } = party(db, r, ['pending']);
    if (ch.enteredBy === me.id) fail('Your opponent needs to confirm this result.');
    finish(db, ch, Number(ch.cFrames) > Number(ch.dFrames) ? 'challenger' : 'defender', Date.now());
  },

  dispute(db, r) {
    const { me, ch } = party(db, r, ['pending']);
    if (ch.enteredBy === me.id) fail('You entered this result.');
    ch.status = 'disputed';
    log(db, `${me.name} disputed the result of ${nameOf(db, ch.challengerId)} v ${nameOf(db, ch.defenderId)}`);
  },

  away(db, r) {
    const me = auth(db, r.playerId, r.pin);
    const a = addAbsence(db, me, r, false);
    log(db, `${me.name}: ${AWAY_TYPES[a.type]} ${fmtDay(a.start)} to ${fmtDay(a.end)}`);
  },

  endAway(db, r) {
    const me = auth(db, r.playerId, r.pin);
    const a = db.absences.find(x => x.id === r.absenceId && x.playerId === me.id && x.status === 'active');
    if (!a) fail('Absence not found. Please refresh the page.');
    endAbsence(db, a, me.name);
  },

  changePin(db, r) {
    const me = auth(db, r.playerId, r.pin);
    if (!/^\d{4}$/.test(String(r.newPin))) fail('The new PIN must be 4 digits.');
    me.pin = String(r.newPin);
    log(db, `${me.name} changed their PIN`);
  },

  adminLogin(db, r) { admin(db, r); },

  adminData(db, r) {
    admin(db, r);
    return {
      players: ladder(db).map(p => ({
        id: p.id, name: p.name, position: p.position, pin: p.pin, phone: p.phone, ntfy: p.ntfy,
        absences: absences(db, p.id).filter(x => x.end >= londonDay(Date.now())).map(publicAbsence), awayUsed: daysUsed(db, p.id)
      })),
      settings: { siteUrl: db.settings.siteUrl, seasonStart: db.settings.seasonStart, seasonEnd: db.settings.seasonEnd },
      log: readTable('Log').slice(-100).reverse()
    };
  },

  adminAddPlayer(db, r) {
    admin(db, r);
    const list = ladder(db);
    const p = { id: uid(), name: cleanName(r.name), position: 0, active: true, pin: randomPin(4), phone: cleanPhone(r.phone), ntfy: newTopic() };
    db.players.push(p);
    list.splice(clampPos(r.position, list.length + 1) - 1, 0, p);
    renumber(list);
    log(db, `Admin added ${p.name} at position ${p.position}`);
    return { pin: p.pin };
  },

  adminUpdatePlayer(db, r) {
    admin(db, r);
    const p = find(db, r.id);
    p.name = cleanName(r.name);
    p.phone = cleanPhone(r.phone);
    p.ntfy = String(r.ntfy || '').trim();
    log(db, `Admin updated ${p.name}`);
  },

  adminResetPin(db, r) {
    admin(db, r);
    const p = find(db, r.id);
    p.pin = randomPin(4);
    log(db, `Admin reset PIN for ${p.name}`);
    return { pin: p.pin };
  },

  adminRemovePlayer(db, r) {
    admin(db, r);
    const p = find(db, r.id);
    db.challenges.filter(c => ACTIVE.includes(c.status) && (c.challengerId === p.id || c.defenderId === p.id))
      .forEach(c => cancel(db, c));
    p.active = false;
    renumber(ladder(db));
    log(db, `Admin removed ${p.name} from position ${p.position}; players below moved up`);
  },

  adminMovePlayer(db, r) {
    admin(db, r);
    const p = find(db, r.id), list = ladder(db);
    list.splice(list.indexOf(p), 1);
    list.splice(clampPos(r.position, list.length + 1) - 1, 0, p);
    renumber(list);
    log(db, `Admin moved ${p.name} to position ${p.position}`);
  },

  adminChallenge(db, r) {
    admin(db, r);
    const start = Date.parse(r.start);
    if (isNaN(start)) fail('Please give the date and time the challenge was made.');
    newChallenge(db, r.challengerId, r.defenderId, start, true);
  },

  adminBook(db, r) {
    admin(db, r);
    const ch = findChallenge(db, r.challengeId, ['open']);
    const t = Date.parse(r.when);
    if (isNaN(t)) fail('Please choose a date and time.');
    if (t > Date.parse(ch.deadline)) fail('The match must be played by ' + fmt(ch.deadline) + '.');
    ch.booked = iso(t);
    log(db, `Admin booked ${nameOf(db, ch.challengerId)} v ${nameOf(db, ch.defenderId)} for ${fmt(t)}`);
    [ch.challengerId, ch.defenderId].forEach(id =>
      notify(db, byId(db, id), 'Match booked', `Your ladder match has been booked for ${fmt(t)}.`));
  },

  adminCancel(db, r) {
    admin(db, r);
    cancel(db, findChallenge(db, r.challengeId, ACTIVE));
  },

  adminResult(db, r) {
    admin(db, r);
    const ch = findChallenge(db, r.challengeId, ACTIVE);
    const [c, d] = frames(r);
    Object.assign(ch, { cFrames: c, dFrames: d });
    finish(db, ch, c > d ? 'challenger' : 'defender', Date.now());
  },

  adminAway(db, r) {
    admin(db, r);
    const p = find(db, r.id);
    const a = addAbsence(db, p, r, true);
    log(db, `Admin set ${p.name}: ${AWAY_TYPES[a.type]} ${fmtDay(a.start)} to ${fmtDay(a.end)}`);
  },

  adminEndAway(db, r) {
    admin(db, r);
    const a = db.absences.find(x => x.id === r.absenceId && x.status === 'active');
    if (!a) fail('Absence not found.');
    endAbsence(db, a, 'Admin');
  },

  adminSettings(db, r) {
    admin(db, r);
    db.settings.siteUrl = String(r.siteUrl || '').trim();
    if (r.newAdminPin) {
      if (!/^\d{4,8}$/.test(String(r.newAdminPin))) fail('The admin PIN must be 4–8 digits.');
      db.settings.adminPin = String(r.newAdminPin);
    }
    log(db, 'Admin updated settings');
  },

  adminNewSeason(db, r) {
    admin(db, r);
    const start = Date.parse(r.start), end = Date.parse(r.end);
    if (isNaN(start) || isNaN(end) || end <= start) fail('Please give valid start and end dates.');
    db.challenges.filter(c => ACTIVE.includes(c.status)).forEach(c => cancel(db, c));
    const list = ladder(db);
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    renumber(list);
    db.settings.seasonStart = iso(start);
    db.settings.seasonEnd = iso(end);
    log(db, `New season ${fmt(start)} to ${fmt(end)}. Random draw: ` + list.map(p => p.position + '. ' + p.name).join(', '));
  }
};

/* ---------- Ladder rules ---------- */

function newChallenge(db, challengerId, defenderId, start, byAdmin) {
  const c = find(db, challengerId), d = find(db, defenderId);
  const gap = c.position - d.position;
  if (gap < 1 || gap > 2) fail('A player can only challenge someone 1 or 2 places above them.');
  if (busy(db, c.id)) fail(c.name + ' is already in a challenge.');
  if (busy(db, d.id)) fail(d.name + ' is already in a challenge.');
  const startDay = londonDay(start);
  if (!byAdmin) {
    if (awayOn(db, c.id, startDay)) fail('You are marked as away, so you cannot make a challenge.');
    if (awayOn(db, d.id, startDay)) fail(d.name + ' is away and cannot be challenged until they are back.');
  }
  const hours = Number(db.settings.challengeHours);
  let deadline = start + hours * HOUR;
  // An absence booked to start before the deadline moves the deadline back by its length.
  const counted = {};
  let more = true;
  while (more) {
    more = false;
    db.absences.filter(a => a.status === 'active' && (a.playerId === c.id || a.playerId === d.id) && !counted[a.id] &&
      a.start > startDay && a.start <= londonDay(deadline)).forEach(a => {
      counted[a.id] = true;
      deadline += absDays(a.start, a.end) * 24 * HOUR;
      more = true;
    });
  }
  if (!byAdmin) {
    if (start < Date.parse(db.settings.seasonStart)) fail('The season has not started yet.');
    if (deadline > Date.parse(db.settings.seasonEnd)) fail(`No new challenges: there are fewer than ${hours} hours left in the season.`);
  }
  const ch = {
    id: uid(), challengerId: c.id, defenderId: d.id, challengerPos: c.position, defenderPos: d.position,
    created: iso(start), deadline: iso(deadline), status: 'open'
  };
  db.challenges.push(ch);
  log(db, `${c.name} (#${c.position}) challenged ${d.name} (#${d.position}). Deadline ${fmt(deadline)}` +
    (Object.keys(counted).length ? ' (extended for a planned absence)' : ''));
  notify(db, d, 'You have been challenged!',
    `${c.name} (#${c.position}) has challenged you. The match must be played by ${fmt(deadline)}.`);
  return ch;
}

// outcome: 'challenger' | 'defender' | 'expired' (deadline passed, counts as a challenger win)
function finish(db, ch, outcome, when) {
  const c = byId(db, ch.challengerId), d = byId(db, ch.defenderId);
  ch.status = 'complete';
  ch.outcome = outcome;
  ch.resolvedAt = iso(when);
  if (outcome !== 'defender') moveUp(db, c, d);
  const text = outcome === 'expired'
    ? `Deadline passed: ${c.name} takes the win over ${d.name}`
    : `${outcome === 'challenger' ? c.name : d.name} beat ${outcome === 'challenger' ? d.name : c.name} ` +
      `${Math.max(ch.cFrames, ch.dFrames)}-${Math.min(ch.cFrames, ch.dFrames)}`;
  log(db, text + (outcome === 'defender' ? '; no change' : `; ${c.name} now #${c.position}, ${d.name} now #${d.position}`));
  if (outcome === 'expired') [c, d].forEach(p => notify(db, p, 'Challenge deadline passed', text + '. The ladder has been updated.'));
}

// Challenger takes the defender's place; everyone from the defender down to the challenger's old place drops one.
// Works on current positions, so it stays correct if others have moved since the challenge was made.
function moveUp(db, c, d) {
  const list = ladder(db), ci = list.indexOf(c), di = list.indexOf(d);
  if (ci < 0 || di < 0 || ci < di) return;
  list.splice(ci, 1);
  list.splice(di, 0, c);
  renumber(list);
}

function cancel(db, ch) {
  ch.status = 'cancelled';
  ch.resolvedAt = iso(Date.now());
  log(db, `Challenge ${nameOf(db, ch.challengerId)} v ${nameOf(db, ch.defenderId)} cancelled`);
}

// Applies expired challenges and auto-confirms results, oldest first.
function processDue(db) {
  const now = Date.now(), confirmMs = Number(db.settings.confirmHours) * HOUR;
  const due = db.challenges
    .map(ch => ({
      ch,
      at: ch.status === 'open' ? Date.parse(ch.deadline)
        : ch.status === 'pending' ? Date.parse(ch.enteredAt) + confirmMs : Infinity
    }))
    .filter(x => x.at <= now)
    .sort((a, b) => a.at - b.at);
  due.forEach(({ ch, at }) => finish(db, ch,
    ch.status === 'open' ? 'expired' : Number(ch.cFrames) > Number(ch.dFrames) ? 'challenger' : 'defender', at));
  // Reminder on the last day of an absence, from 9am.
  const day = londonDay(now), hour = Number(Utilities.formatDate(new Date(now), TZ, 'H'));
  const remind = hour >= 9 ? db.absences.filter(a => a.status === 'active' && a.end === day && a.reminded !== 'TRUE') : [];
  remind.forEach(a => {
    a.reminded = 'TRUE';
    notify(db, byId(db, a.playerId), 'Welcome back tomorrow', `Your time away (${AWAY_TYPES[a.type].toLowerCase()}) on the ladder ends today. From tomorrow you can challenge and be challenged again.`);
  });
  return due.length > 0 || remind.length > 0;
}

function frames(r) {
  const c = Number(r.cFrames), d = Number(r.dFrames);
  if (!((c === 2 && d < 2 && d >= 0) || (d === 2 && c < 2 && c >= 0))) fail('Best of 3: the score must be 2-0 or 2-1.');
  return [c, d];
}

/* ---------- Holiday / working away ---------- */

function londonDay(t) { return Utilities.formatDate(new Date(t), TZ, 'yyyy-MM-dd'); }
function dayNo(d) { return Math.round(Date.parse(d + 'T12:00:00Z') / (24 * HOUR)); }
function plusDays(d, n) { return new Date(Date.parse(d + 'T12:00:00Z') + n * 24 * HOUR).toISOString().slice(0, 10); }
function absDays(a, b) { return dayNo(b) - dayNo(a) + 1; }
function absences(db, id) { return db.absences.filter(a => a.playerId === id && a.status === 'active'); }
function awayOn(db, id, day) { return absences(db, id).find(a => a.start <= day && day <= a.end); }

// Days of absence that fall inside the current season.
function daysUsed(db, id, ignoreId) {
  const s = londonDay(Date.parse(db.settings.seasonStart)), e = londonDay(Date.parse(db.settings.seasonEnd));
  return absences(db, id).filter(a => a.id !== ignoreId).reduce((n, a) => {
    const from = a.start > s ? a.start : s, to = a.end < e ? a.end : e;
    return n + Math.max(0, absDays(from, to));
  }, 0);
}

function addAbsence(db, p, r, byAdmin) {
  const type = r.type in AWAY_TYPES ? r.type : fail('Please choose Holiday or Working away.');
  const start = String(r.start || ''), end = String(r.end || ''), today = londonDay(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) fail('Please choose the dates.');
  if (end < start) fail('The last day must be on or after the first day.');
  const days = absDays(start, end), others = absences(db, p.id);
  if (end < today) fail('Those dates are in the past.');
  if (others.some(a => a.start <= end && start <= a.end)) fail('This overlaps an absence already booked.');
  if (!byAdmin) {
    if (start < today) fail('The first day cannot be in the past.');
    if (start > plusDays(today, AWAY.aheadDays)) fail(`You can book up to ${AWAY.aheadDays} days ahead.`);
    if (days > AWAY.maxDays) fail(`An absence can be up to ${AWAY.maxDays} days.`);
    others.forEach(a => {
      const gap = a.end < start ? dayNo(start) - dayNo(a.end) - 1 : dayNo(a.start) - dayNo(end) - 1;
      if (gap < AWAY.gapDays) fail(`You need at least ${AWAY.gapDays} days back between absences.`);
    });
    const used = daysUsed(db, p.id);
    if (used + days > AWAY.seasonDays) fail(`That would take you over ${AWAY.seasonDays} days this season. You have ${AWAY.seasonDays - used} days left.`);
    const ch = db.challenges.find(c => ACTIVE.includes(c.status) && (c.challengerId === p.id || c.defenderId === p.id));
    if (ch && londonDay(Date.parse(ch.deadline)) >= start) fail('You are in a challenge. Please finish it first, or ask Adam.');
  }
  const a = { id: uid(), playerId: p.id, type, start, end, status: 'active', createdAt: iso(Date.now()), reminded: '' };
  db.absences.push(a);
  return a;
}

// Ending early: an absence that has not started (or started today) is cancelled; otherwise it ends yesterday.
function endAbsence(db, a, who) {
  const today = londonDay(Date.now());
  if (a.start >= today) a.status = 'cancelled';
  else if (a.end >= today) a.end = plusDays(today, -1);
  log(db, `${who} ended ${nameOf(db, a.playerId)}'s ${AWAY_TYPES[a.type].toLowerCase()} (${a.status === 'cancelled' ? 'cancelled' : 'back from today'})`);
}

function publicAbsence(a) { return a ? { id: a.id, type: a.type, label: AWAY_TYPES[a.type], start: a.start, end: a.end } : null; }

/* ---------- Helpers ---------- */

function ladder(db) { return db.players.filter(p => p.active).sort((a, b) => a.position - b.position); }
function renumber(list) { list.forEach((p, i) => { p.position = i + 1; }); }
function byId(db, id) { return db.players.find(p => p.id === id); }
function nameOf(db, id) { return (byId(db, id) || { name: '?' }).name; }
function busy(db, id) { return db.challenges.some(c => ACTIVE.includes(c.status) && (c.challengerId === id || c.defenderId === id)); }

function find(db, id) {
  const p = db.players.find(x => x.id === id && x.active);
  if (!p) fail('Player not found.');
  return p;
}

function findChallenge(db, id, statuses) {
  const ch = db.challenges.find(c => c.id === id);
  if (!ch) fail('Challenge not found.');
  if (!statuses.includes(ch.status)) fail('This challenge has changed. Please refresh the page.');
  return ch;
}

function party(db, r, statuses) {
  const me = auth(db, r.playerId, r.pin);
  const ch = findChallenge(db, r.challengeId, statuses);
  if (ch.challengerId !== me.id && ch.defenderId !== me.id) fail('Only the two players in this challenge can do that.');
  return { me, ch, other: byId(db, me.id === ch.challengerId ? ch.defenderId : ch.challengerId) };
}

// Five wrong PINs locks that player (or the admin) out for 15 minutes.
function checkPin(key, correct) {
  const cache = CacheService.getScriptCache(), k = 'fail_' + key, n = Number(cache.get(k) || 0);
  if (n >= 5) fail('Too many wrong PINs. Please try again in 15 minutes.');
  if (!correct) {
    cache.put(k, String(n + 1), 900);
    fail('Incorrect PIN.');
  }
}

function auth(db, id, pin) {
  const p = find(db, id);
  checkPin(id, String(pin) === String(p.pin));
  return p;
}

function admin(db, r) { checkPin('admin', String(r.adminPin) === String(db.settings.adminPin)); }

function notify(db, p, title, message) {
  if (!p || !p.ntfy) return;
  try {
    const headers = { Title: title, Tags: '8ball' };
    if (db.settings.siteUrl) headers.Click = db.settings.siteUrl;
    UrlFetchApp.fetch('https://ntfy.sh/' + encodeURIComponent(p.ntfy), { method: 'post', payload: message, headers, muteHttpExceptions: true });
  } catch (e) { /* alerts are best effort */ }
}

function publicChallenge(db, c) {
  return Object.assign({}, c, { challengerName: nameOf(db, c.challengerId), defenderName: nameOf(db, c.defenderId) });
}

function publicState(db) {
  const s = db.settings, seasonStart = Date.parse(s.seasonStart);
  return {
    now: iso(Date.now()),
    settings: {
      clubName: s.clubName, seasonStart: s.seasonStart, seasonEnd: s.seasonEnd,
      challengeHours: Number(s.challengeHours), confirmHours: Number(s.confirmHours), siteUrl: s.siteUrl
    },
    away: AWAY,
    players: ladder(db).map(p => {
      const day = londonDay(Date.now()), mine = absences(db, p.id).filter(a => a.end >= day).sort((a, b) => a.start < b.start ? -1 : 1);
      return {
        id: p.id, name: p.name, position: p.position, phone: p.phone,
        away: publicAbsence(mine.find(a => a.start <= day)), absences: mine.map(publicAbsence), awayUsed: daysUsed(db, p.id)
      };
    }),
    challenges: db.challenges.filter(c => ACTIVE.includes(c.status)).map(c => publicChallenge(db, c)),
    history: db.challenges
      .filter(c => !ACTIVE.includes(c.status) && Date.parse(c.resolvedAt) >= seasonStart)
      .sort((a, b) => Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt))
      .slice(0, 40)
      .map(c => publicChallenge(db, c))
  };
}

function cleanName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) fail('Please enter a name.');
  return n;
}

// Stores numbers in international format for WhatsApp links, e.g. 07700 900123 -> 447700900123.
function cleanPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.startsWith('0') ? '44' + d.slice(1) : d;
}

function clampPos(pos, max) {
  const n = parseInt(pos, 10);
  return isNaN(n) ? max : Math.min(Math.max(n, 1), max);
}

function fail(msg) { throw new Error(msg); }
function uid() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function iso(t) { return new Date(t).toISOString(); }
function fmtDay(d) { return Utilities.formatDate(new Date(d + 'T12:00:00Z'), 'UTC', 'EEE d MMM'); }
function fmt(t) { return Utilities.formatDate(new Date(typeof t === 'string' ? Date.parse(t) : t), TZ, 'EEE d MMM HH:mm'); }
function randomPin(len) { let s = ''; while (s.length < len) s += Math.floor(Math.random() * 10); return s; }
function newTopic() { return 'psc-ladder-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function log(db, event) { db.logs.push({ time: iso(Date.now()), event }); }

/* ---------- Sheet storage ---------- */

function load() {
  const settings = {};
  readTable('Settings').forEach(r => { settings[r.key] = String(r.value); });
  return {
    settings,
    players: readTable('Players').map(p => Object.assign(p, {
      id: String(p.id), position: Number(p.position), active: String(p.active).toUpperCase() === 'TRUE', pin: String(p.pin)
    })),
    challenges: readTable('Challenges').map(c => Object.assign(c, {
      challengerPos: Number(c.challengerPos), defenderPos: Number(c.defenderPos)
    })),
    absences: readTable('Absences'),
    logs: []
  };
}

function save(db) {
  writeTable('Players', db.players.map(p => Object.assign({}, p, { active: p.active ? 'TRUE' : 'FALSE' })));
  writeTable('Challenges', db.challenges);
  writeTable('Absences', db.absences);
  writeTable('Settings', Object.keys(db.settings).map(key => ({ key, value: db.settings[key] })));
  if (db.logs.length) {
    const sh = SpreadsheetApp.getActive().getSheetByName('Log');
    const rows = db.logs.map(l => [l.time, l.event]);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 2).setNumberFormat('@').setValues(rows);
  }
}

// Creates a tab if it is missing (e.g. Absences on a ladder set up before that feature).
function sheet(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange('A:Z').setNumberFormat('@');
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]);
  }
  return sh;
}

function readTable(name) {
  const values = sheet(name).getDataRange().getValues();
  const head = values.shift() || [];
  return values.filter(r => r[0] !== '').map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i] instanceof Date ? r[i].toISOString() : String(r[i]); });
    return o;
  });
}

function writeTable(name, rows) {
  const sh = sheet(name), head = SHEETS[name];
  const data = [head].concat(rows.map(r => head.map(h => (r[h] === undefined || r[h] === null ? '' : String(r[h])))));
  sh.clearContents();
  sh.getRange(1, 1, data.length, head.length).setNumberFormat('@').setValues(data);
  sh.setFrozenRows(1);
}
