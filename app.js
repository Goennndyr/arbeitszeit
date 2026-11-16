'use strict';

const APP_VERSION = '1.0.0';
const KEY = 'arbeitszeit.v1';
const DEFAULT_NAMES = ['Unterrichtszeit', 'Korrekturen', 'Unterrichtsvorbereitung', 'Unterrichtsnachbereitung',
  'Schulportal', 'Konferenz', 'Fortbildung', 'Gesundheitsteam', 'ISB-Projekt', 'Fachkonferenz'];
const DEFAULT_THRESHOLD_MIN = 330; // 5,5 Stunden
const BACKUP_REMINDER_DAYS = 30;
const MIN = 60000;
const DAY = 86400000;
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/* ---------- Zustand ---------- */

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }

function freshState() {
  return {
    format: 1,
    activities: DEFAULT_NAMES.map((name) => ({ id: uid(), name, threshold: DEFAULT_THRESHOLD_MIN, deleted: false })),
    entries: [],
    settings: { lastBackup: null, createdAt: Date.now() }
  };
}

function validState(s) {
  return s && typeof s === 'object' && Array.isArray(s.activities) && Array.isArray(s.entries) &&
    s.activities.every((a) => a && typeof a.id === 'string' && typeof a.name === 'string') &&
    s.entries.every((e) => e && typeof e.id === 'string' && typeof e.start === 'number' && (e.end === null || typeof e.end === 'number'));
}

function normalize(s) {
  s.settings = Object.assign({ lastBackup: null, createdAt: Date.now() }, s.settings || {});
  s.activities.forEach((a) => {
    if (typeof a.threshold !== 'number' || !(a.threshold > 0)) a.threshold = DEFAULT_THRESHOLD_MIN;
    a.deleted = !!a.deleted;
  });
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (validState(s)) return normalize(s);
      localStorage.setItem(KEY + '.defekt.' + Date.now(), raw); // nichts wegwerfen
    }
  } catch (e) { console.error(e); }
  return freshState();
}

let state = loadState();
let persistAsked = false;

function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
  if (!persistAsked && navigator.storage && navigator.storage.persist) {
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }
}

/* ---------- Hilfsfunktionen ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const pad2 = (n) => String(n).padStart(2, '0');
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const floorMin = (ms) => Math.floor(ms / MIN) * MIN;
const ceilMin = (ms) => Math.ceil(ms / MIN) * MIN;
function fmtHM(ms) { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function fmtDate(ms) { const d = new Date(ms); return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear(); }
function fmtDateLong(ms) { return WD[new Date(ms).getDay()] + ', ' + fmtDate(ms); }
function fmtDur(min) { min = Math.max(0, Math.round(min)); return Math.floor(min / 60) + ':' + pad2(min % 60); }
function fmtDurSec(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 3600) + ':' + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60); }
function fmtHours(min) { return (min / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 }); }
function dateVal(ms) { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function timeVal(ms) { return fmtHM(ms); }
function parseLocal(dateStr, timeStr, addDays = 0) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  const tm = /^(\d{1,2}):(\d{2})/.exec(timeStr || '');
  if (!dm || !tm) return NaN;
  return new Date(+dm[1], +dm[2] - 1, +dm[3] + addDays, +tm[1], +tm[2], 0, 0).getTime();
}
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfWeek(ms) { const d = new Date(startOfDay(ms)); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return d.getTime(); }
function schoolYearOf(ms) { const d = new Date(ms); return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1; }
function syLabel(y) { return y + '/' + pad2((y + 1) % 100); }
function entryMin(e, now = Date.now()) { return Math.max(0, Math.floor(((e.end != null ? e.end : now) - e.start) / MIN)); }

const running = () => state.entries.find((e) => e.end == null) || null;
const actById = (id) => state.activities.find((a) => a.id === id) || null;
const actName = (id) => { const a = actById(id); return a ? a.name : '(unbekannt)'; };
const activeActs = () => state.activities.filter((a) => !a.deleted);
const fmtThreshold = (min) => (min / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' h';

/* ---------- Rückgängig / Snackbar ---------- */

let undoSnap = null;
let snackTimer = null;
const snapshot = () => JSON.stringify(state);

function snack(text, snap = null) {
  const el = $('#snack');
  $('#snack-text').textContent = text;
  undoSnap = snap;
  $('#snack-undo').hidden = !snap;
  el.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { el.hidden = true; undoSnap = null; }, 10000);
}

function doUndo() {
  if (!undoSnap) return;
  state = normalize(JSON.parse(undoSnap));
  undoSnap = null;
  save();
  $('#snack').hidden = true;
  render();
}

/* ---------- Dialoge ---------- */

function openModal({ title, body = '', buttons, onOpen, dismissable = true }) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'modal-backdrop';
    root.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3><div class="modal-body">${body}</div>
      <div class="modal-error" hidden></div>
      <div class="modal-buttons">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
    </div>`;
    document.body.appendChild(root);
    let closed = false;
    const close = (val) => { if (closed) return; closed = true; root.remove(); resolve(val); };
    const errEl = $('.modal-error', root);
    root.addEventListener('click', async (ev) => {
      if (ev.target === root) { if (dismissable) close(null); return; }
      const btn = ev.target.closest('.modal-buttons button[data-i]');
      if (!btn) return;
      const b = buttons[+btn.dataset.i];
      if (b.handler) {
        const res = await b.handler(root, close);
        if (typeof res === 'string') { errEl.textContent = res; errEl.hidden = false; return; }
        if (res === false) return;
      }
      close(b.value);
    });
    if (onOpen) onOpen(root, close);
  });
}

function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return openModal({
    title,
    body: `<p>${text}</p>`,
    buttons: [{ label: 'Abbrechen', value: false }, { label: okLabel, value: true, cls: danger ? 'danger' : 'primary' }]
  }).then((v) => v === true);
}

function overlaps(start, end, excludeId) {
  const now = Date.now();
  return state.entries.filter((o) => o.id !== excludeId && start < (o.end != null ? o.end : now) && end > o.start);
}

async function confirmOverlaps(start, end, excludeId) {
  const ov = overlaps(start, end, excludeId);
  if (!ov.length) return true;
  const list = ov.slice(0, 4).map((o) => `<br>• ${esc(actName(o.activityId))}, ${fmtDate(o.start)} ${fmtHM(o.start)}–${o.end != null ? fmtHM(o.end) : 'läuft'}`).join('');
  return confirmDialog('Überschneidung', `Dieser Zeitraum überschneidet sich mit:${list}${ov.length > 4 ? '<br>…' : ''}<br><br>Trotzdem speichern?`, 'Trotzdem speichern');
}

/* ---------- Aktionen: Erfassen ---------- */

function startActivity(actId) {
  const snap = snapshot();
  const now = floorMin(Date.now());
  const r = running();
  let switched = false;
  if (r) {
    r.end = Math.max(now, r.start);
    if (r.end <= r.start) state.entries = state.entries.filter((e) => e !== r);
    switched = true;
  }
  state.entries.push({ id: uid(), activityId: actId, start: now, end: null });
  save();
  render();
  snack(`${actName(actId)} ${switched ? '– gewechselt' : 'gestartet'}`, snap);
}

function stopRunning() {
  const r = running();
  if (!r) return;
  const snap = snapshot();
  r.end = Math.max(ceilMin(Date.now()), r.start);
  let msg = `Gestoppt: ${actName(r.activityId)} (${fmtDur(entryMin(r))} h)`;
  if (r.end <= r.start) { state.entries = state.entries.filter((e) => e !== r); msg = 'Erfassung verworfen (unter 1 Minute)'; }
  save();
  render();
  snack(msg, snap);
}

function tilesHtml(acts, action) {
  if (!acts.length) return '<div class="empty">Keine Tätigkeiten vorhanden. Lege unter „Einstellungen“ eine an.</div>';
  return `<div class="tiles">${acts.map((a) => `<button class="tile" data-action="${action}" data-id="${a.id}">${esc(a.name)}</button>`).join('')}</div>`;
}

function openSwitch() {
  const r = running();
  if (!r) return;
  const acts = activeActs().filter((a) => a.id !== r.activityId);
  openModal({
    title: 'Wechseln zu …',
    body: `<p class="muted small">„${esc(actName(r.activityId))}“ wird beendet, die neue Tätigkeit beginnt ohne Lücke.</p>${tilesHtml(acts, 'pick')}`,
    buttons: [{ label: 'Abbrechen', value: null }],
    onOpen(root, close) {
      root.addEventListener('click', (ev) => {
        const t = ev.target.closest('[data-action="pick"]');
        if (t) { close(null); startActivity(t.dataset.id); }
      });
    }
  });
}

function editRunningStart() {
  const r = running();
  if (!r) return;
  openModal({
    title: 'Beginn ändern',
    body: `<p class="muted small">${esc(actName(r.activityId))}</p>
      <div class="row2"><label>Datum<input type="date" id="rs-date" value="${dateVal(r.start)}"></label>
      <label>Beginn<input type="time" id="rs-time" value="${timeVal(r.start)}"></label></div>`,
    buttons: [{ label: 'Abbrechen', value: null }, {
      label: 'Speichern', cls: 'primary',
      handler: async (root) => {
        const s = parseLocal($('#rs-date', root).value, $('#rs-time', root).value);
        if (isNaN(s)) return 'Bitte Datum und Uhrzeit angeben.';
        if (s > Date.now()) return 'Der Beginn darf nicht in der Zukunft liegen.';
        if (!(await confirmOverlaps(s, Date.now(), r.id))) return false;
        const snap = snapshot();
        r.start = s;
        r.longAck = false;
        save();
        render();
        snack('Beginn geändert auf ' + fmtHM(s), snap);
        return true;
      }
    }]
  });
}

/* ---------- Vergessen zu stoppen ---------- */

let longCheckOpen = false;
function checkLongRunning() {
  const r = running();
  if (!r || r.longAck || longCheckOpen) return;
  const a = actById(r.activityId);
  const threshold = (a ? a.threshold : DEFAULT_THRESHOLD_MIN) * MIN;
  const elapsed = Date.now() - r.start;
  if (elapsed < threshold) return;
  longCheckOpen = true;
  openModal({
    title: 'Noch bei der Arbeit?',
    dismissable: false,
    body: `<p><strong>${esc(actName(r.activityId))}</strong> läuft seit <strong>${fmtDur(elapsed / MIN)} h</strong>
      (Beginn ${fmtDateLong(r.start)}, ${fmtHM(r.start)} Uhr).</p>
      <p>Hast du vergessen zu stoppen? Dann trage ein, wann du aufgehört hast.</p>
      <div class="row2"><label>Datum Ende<input type="date" id="lr-date" value="${dateVal(r.start)}"></label>
      <label>Uhrzeit Ende<input type="time" id="lr-time" value=""></label></div>`,
    buttons: [
      { label: 'Läuft noch', value: 'keep', handler: () => { r.longAck = true; save(); return true; } },
      {
        label: 'Ende speichern', cls: 'primary', value: 'end',
        handler: async (root) => {
          const e = parseLocal($('#lr-date', root).value, $('#lr-time', root).value);
          if (isNaN(e)) return 'Bitte die Uhrzeit des Endes angeben.';
          if (e <= r.start) return 'Das Ende muss nach dem Beginn liegen.';
          if (e > Date.now()) return 'Das Ende darf nicht in der Zukunft liegen.';
          if (!(await confirmOverlaps(r.start, e, r.id))) return false;
          const snap = snapshot();
          r.end = e;
          save();
          render();
          snack(`Ende gespeichert: ${fmtHM(e)} (${fmtDur(entryMin(r))} h)`, snap);
          return true;
        }
      }
    ]
  }).then(() => { longCheckOpen = false; });
}

/* ---------- Einträge bearbeiten ---------- */

function openEntryEditor(id) {
  const e = id ? state.entries.find((x) => x.id === id) : null;
  if (id && !e) return;
  const isRunning = !!e && e.end == null;
  const now = Date.now();
  const acts = activeActs().slice();
  if (e && !acts.some((a) => a.id === e.activityId)) {
    acts.push({ id: e.activityId, name: actName(e.activityId) + ' (gelöscht)' });
  }
  const start = e ? e.start : floorMin(now - 60 * MIN);
  const end = e ? e.end : floorMin(now);
  const selId = e ? e.activityId : (acts[0] && acts[0].id);
  const buttons = [];
  if (e) {
    buttons.push({
      label: 'Löschen', cls: 'danger-text',
      handler: async () => {
        if (!(await confirmDialog('Eintrag löschen?', `${esc(actName(e.activityId))}, ${fmtDateLong(e.start)}, ${fmtHM(e.start)}–${e.end != null ? fmtHM(e.end) : 'läuft'}`, 'Löschen', true))) return false;
        const snap = snapshot();
        state.entries = state.entries.filter((x) => x.id !== e.id);
        save();
        render();
        snack('Eintrag gelöscht', snap);
        return true;
      }
    });
  }
  buttons.push({ label: 'Abbrechen', value: null });
  buttons.push({
    label: 'Speichern', cls: 'primary',
    handler: async (root) => {
      const actId = $('#ed-act', root).value;
      const d = $('#ed-date', root).value;
      const st = $('#ed-start', root).value;
      const en = $('#ed-end', root).value;
      if (!actId) return 'Bitte eine Tätigkeit wählen.';
      const s = parseLocal(d, st);
      if (isNaN(s)) return 'Bitte Datum und Beginn angeben.';
      let endMs = null;
      if (en) {
        endMs = parseLocal(d, en);
        if (endMs <= s) endMs = parseLocal(d, en, 1);
      } else if (!isRunning) {
        return 'Bitte ein Ende angeben.';
      }
      if (s > Date.now()) return 'Der Beginn darf nicht in der Zukunft liegen.';
      if (!(await confirmOverlaps(s, endMs != null ? endMs : Date.now(), e && e.id))) return false;
      const snap = snapshot();
      if (e) {
        if (e.start !== s) e.longAck = false;
        e.activityId = actId; e.start = s; e.end = endMs;
      } else {
        state.entries.push({ id: uid(), activityId: actId, start: s, end: endMs });
      }
      save();
      render();
      snack(e ? 'Eintrag gespeichert' : 'Eintrag nachgetragen', snap);
      return true;
    }
  });
  openModal({
    title: e ? 'Eintrag bearbeiten' : 'Eintrag nachtragen',
    body: `<label>Tätigkeit<select id="ed-act">${acts.map((a) => `<option value="${a.id}"${a.id === selId ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label>Datum (Beginn)<input type="date" id="ed-date" value="${dateVal(start)}"></label>
      <div class="row2"><label>Beginn<input type="time" id="ed-start" value="${timeVal(start)}"></label>
      <label>Ende<input type="time" id="ed-end" value="${end != null ? timeVal(end) : ''}"></label></div>
      <div class="hint" id="ed-hint"></div>
      ${isRunning ? '<p class="muted small">Diese Erfassung läuft noch. Ende leer lassen, damit sie weiterläuft – oder Ende eintragen, um sie zu beenden.</p>' : ''}`,
    buttons,
    onOpen(root) {
      const upd = () => {
        const d = $('#ed-date', root).value;
        const s = parseLocal(d, $('#ed-start', root).value);
        const enStr = $('#ed-end', root).value;
        let txt = '';
        if (!isNaN(s) && enStr) {
          let en = parseLocal(d, enStr);
          let next = false;
          if (en <= s) { en = parseLocal(d, enStr, 1); next = true; }
          txt = `Dauer: ${fmtDur((en - s) / MIN)} h${next ? ' · Ende am Folgetag' : ''}`;
        } else if (isRunning && !enStr) {
          txt = 'läuft weiter';
        }
        $('#ed-hint', root).textContent = txt;
      };
      root.addEventListener('input', upd);
      root.addEventListener('change', upd);
      upd();
    }
  });
}

/* ---------- Tätigkeiten verwalten ---------- */

function moveActivity(id, dir) {
  const act = activeActs();
  const i = act.findIndex((a) => a.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= act.length) return;
  [act[i], act[j]] = [act[j], act[i]];
  state.activities = [...act, ...state.activities.filter((a) => a.deleted)];
  save();
  render();
}

function openActivityEditor(id) {
  const a = id ? actById(id) : null;
  openModal({
    title: a ? 'Tätigkeit bearbeiten' : 'Tätigkeit hinzufügen',
    body: `<label>Name<input type="text" id="ac-name" maxlength="60" value="${a ? esc(a.name) : ''}" autocomplete="off"></label>
      <label>Nachfragen, ob vergessen wurde zu stoppen, nach … Stunden<input type="text" inputmode="decimal" id="ac-thr" value="${((a ? a.threshold : DEFAULT_THRESHOLD_MIN) / 60).toLocaleString('de-DE')}"></label>
      ${a ? '<p class="muted small">Eine Umbenennung gilt auch für alle bisherigen Einträge dieser Tätigkeit.</p>' : ''}`,
    buttons: [{ label: 'Abbrechen', value: null }, {
      label: 'Speichern', cls: 'primary',
      handler: (root) => {
        const name = $('#ac-name', root).value.trim().replace(/\s+/g, ' ');
        const thr = parseFloat($('#ac-thr', root).value.replace(',', '.'));
        if (!name) return 'Bitte einen Namen eingeben.';
        if (!(thr > 0 && thr <= 24)) return 'Bitte eine Stundenzahl zwischen 0 und 24 eingeben (z. B. 5,5).';
        const dup = activeActs().find((x) => x.id !== (a && a.id) && x.name.toLowerCase() === name.toLowerCase());
        if (dup) return `„${name}“ gibt es schon.`;
        const snap = snapshot();
        const thrMin = Math.round(thr * 60);
        if (a) {
          a.name = name; a.threshold = thrMin;
          snack('Tätigkeit gespeichert', snap);
        } else {
          const old = state.activities.find((x) => x.deleted && x.name.toLowerCase() === name.toLowerCase());
          if (old) {
            // Früher gelöschte Tätigkeit gleichen Namens wieder aktivieren (alte Einträge hängen wieder dran)
            old.deleted = false; old.name = name; old.threshold = thrMin;
            state.activities = [...activeActs().filter((x) => x !== old), old, ...state.activities.filter((x) => x.deleted)];
          } else {
            state.activities = [...activeActs(), { id: uid(), name, threshold: thrMin, deleted: false }, ...state.activities.filter((x) => x.deleted)];
          }
          snack(`„${name}“ hinzugefügt`, snap);
        }
        save();
        render();
        return true;
      }
    }],
    onOpen(root) { if (!a) setTimeout(() => $('#ac-name', root).focus(), 50); }
  });
}

async function deleteActivity(id) {
  const a = actById(id);
  if (!a) return;
  const n = state.entries.filter((e) => e.activityId === id).length;
  const ok = await confirmDialog(`„${a.name}“ löschen?`,
    `Die Tätigkeit verschwindet aus der Auswahl.${n ? ` Die ${n} vorhandenen Einträge bleiben erhalten und erscheinen weiterhin im Export.` : ''}`, 'Löschen', true);
  if (!ok) return;
  const snap = snapshot();
  a.deleted = true;
  state.activities = [...activeActs(), ...state.activities.filter((x) => x.deleted)];
  save();
  render();
  snack(`„${a.name}“ gelöscht`, snap);
}

/* ---------- Dateien teilen / herunterladen ---------- */

function canShareFile(name, mime) {
  try {
    if (!navigator.canShare) return false;
    return navigator.canShare({ files: [new File(['x'], name, { type: mime })] });
  } catch (e) { return false; }
}

async function deliverFile(blob, name, mode) {
  const file = new File([blob], name, { type: blob.type });
  if (mode === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
      console.warn('Teilen fehlgeschlagen, lade herunter', e);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
  window.__lastDownload = { name, blob }; // für Tests
  return true;
}

/* ---------- Sicherung ---------- */

async function exportBackup(mode) {
  const payload = { app: 'arbeitszeit', format: 1, exportedAt: new Date().toISOString(), appVersion: APP_VERSION, state };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const name = `Arbeitszeit_Sicherung_${dateVal(Date.now())}.json`;
  const ok = await deliverFile(blob, name, mode);
  if (ok) {
    state.settings.lastBackup = Date.now();
    save();
    render();
    snack('Sicherung erstellt');
  }
}

async function importBackupText(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  const s = data && data.state ? data.state : data;
  if (!validState(s)) {
    await openModal({ title: 'Import nicht möglich', body: '<p>Die Datei ist keine gültige Sicherung dieser App.</p>', buttons: [{ label: 'OK', cls: 'primary' }] });
    return;
  }
  const when = data.exportedAt ? ` vom ${fmtDate(Date.parse(data.exportedAt))}, ${fmtHM(Date.parse(data.exportedAt))} Uhr` : '';
  const ok = await confirmDialog('Sicherung importieren?',
    `Die Sicherung${when} enthält <strong>${s.entries.length} Einträge</strong> und ${s.activities.filter((a) => !a.deleted).length} Tätigkeiten.<br><br>
     Alle aktuellen Daten auf diesem Gerät (<strong>${state.entries.length} Einträge</strong>) werden dadurch <strong>ersetzt</strong>.`, 'Ersetzen', true);
  if (!ok) return;
  const snap = snapshot();
  state = normalize(s);
  save();
  render();
  snack('Sicherung importiert', snap);
}

function backupDue() {
  if (!state.entries.length) return false;
  const ref = state.settings.lastBackup || Math.min(...state.entries.map((e) => e.start));
  return Date.now() - ref > BACKUP_REMINDER_DAYS * DAY;
}

/* ---------- Excel-Export ---------- */

function excelDate(ms) { const d = new Date(ms); return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / DAY; }
function excelTime(ms) { const d = new Date(ms); return (d.getHours() * 60 + d.getMinutes()) / 1440; }

function schoolYearsWithData() {
  const ys = new Set(state.entries.filter((e) => e.end != null).map((e) => schoolYearOf(e.start)));
  ys.add(schoolYearOf(Date.now()));
  return [...ys].sort((a, b) => b - a);
}

function buildExport(sy) {
  const S = XLSX.S;
  const done = state.entries
    .filter((e) => e.end != null && (sy === 'all' || schoolYearOf(e.start) === sy))
    .sort((a, b) => a.start - b.start);

  const head = ['Datum', 'Wochentag', 'Tätigkeit', 'Beginn', 'Ende', 'Dauer (h:mm)', 'Dauer (h, dezimal)', 'Schuljahr'];
  const rows1 = [head.map((h) => ({ v: h, t: 's', s: S.HEAD }))];
  for (const e of done) {
    const m = entryMin(e);
    rows1.push([
      { v: excelDate(e.start), t: 'n', s: S.DATE },
      { v: WD[new Date(e.start).getDay()], t: 's' },
      { v: actName(e.activityId), t: 's' },
      { v: excelTime(e.start), t: 'n', s: S.TIME },
      { v: excelTime(e.end), t: 'n', s: S.TIME },
      { v: m / 1440, t: 'n', s: S.DUR },
      { v: m / 60, t: 'n', s: S.DEC },
      { v: syLabel(schoolYearOf(e.start)), t: 's' }
    ]);
  }

  const now = Date.now();
  const rows2 = [
    [{ v: 'Arbeitszeit – Zusammenfassung', t: 's', s: S.TITLE }],
    [{ v: `Erstellt am ${fmtDate(now)} um ${fmtHM(now)} Uhr · Schuljahr jeweils 01.08. bis 31.07. (Hessen)` + (running() ? ' · laufende Erfassung nicht enthalten' : ''), t: 's', s: S.MUTED }],
    []
  ];
  const years = sy === 'all' ? [...new Set(done.map((e) => schoolYearOf(e.start)))].sort((a, b) => a - b) : [sy];
  if (!years.length) rows2.push([{ v: 'Noch keine abgeschlossenen Einträge vorhanden.', t: 's' }]);
  for (const y of years) {
    const inYear = done.filter((e) => schoolYearOf(e.start) === y);
    const ids = activeActs().map((a) => a.id);
    // gelöschte Tätigkeiten mit Einträgen in diesem Schuljahr ergänzen (in Listenreihenfolge)
    state.activities.forEach((a) => { if (a.deleted && inYear.some((e) => e.activityId === a.id)) ids.push(a.id); });
    inYear.forEach((e) => { if (!ids.includes(e.activityId)) ids.push(e.activityId); });
    rows2.push([{ v: `Schuljahr ${syLabel(y)}  (01.08.${y} – 31.07.${y + 1})`, t: 's', s: S.BOLD }]);
    rows2.push(['Tätigkeit', 'Stunden (h:mm)', 'Stunden (dezimal)', 'Anzahl Einträge'].map((h) => ({ v: h, t: 's', s: S.HEAD })));
    let tot = 0, cnt = 0;
    for (const id of ids) {
      const es = inYear.filter((e) => e.activityId === id);
      const m = es.reduce((acc, e) => acc + entryMin(e), 0);
      tot += m; cnt += es.length;
      rows2.push([{ v: actName(id), t: 's' }, { v: m / 1440, t: 'n', s: S.DUR }, { v: m / 60, t: 'n', s: S.DEC }, { v: es.length, t: 'n' }]);
    }
    rows2.push([{ v: 'Gesamt', t: 's', s: S.BOLD }, { v: tot / 1440, t: 'n', s: S.BOLD_DUR }, { v: tot / 60, t: 'n', s: S.BOLD_DEC }, { v: cnt, t: 'n', s: S.BOLD }]);
    rows2.push([]);
  }

  return XLSX.build([
    { name: 'Einträge', cols: [12, 11, 28, 9, 9, 13, 17, 11], rows: rows1, freezeRow: true, landscape: true, autoFilter: `A1:H${rows1.length}` },
    { name: 'Zusammenfassung', cols: [34, 16, 18, 16], rows: rows2 }
  ]);
}

async function exportExcel(mode) {
  const val = $('#exp-sy').value;
  const sy = val === 'all' ? 'all' : +val;
  const bytes = buildExport(sy);
  const name = sy === 'all' ? `Arbeitszeit_alle_${dateVal(Date.now())}.xlsx` : `Arbeitszeit_${sy}-${pad2((sy + 1) % 100)}.xlsx`;
  const ok = await deliverFile(new Blob([bytes], { type: XLSX.MIME }), name, mode);
  if (ok) snack(mode === 'share' ? 'Excel-Datei erstellt' : 'Excel-Datei heruntergeladen: ' + name);
}

/* ---------- Ansichten ---------- */

let tab = 'home';
let daysShown = 30;

function sumsNow() {
  const now = Date.now();
  const d0 = startOfDay(now), w0 = startOfWeek(now);
  let today = 0, week = 0;
  for (const e of state.entries) {
    if (e.start >= w0 && e.start <= now) {
      const m = entryMin(e, now);
      week += m;
      if (e.start >= d0) today += m;
    }
  }
  return { today, week };
}

function viewHome() {
  const r = running();
  const s = sumsNow();
  let h = `<div class="sums"><div><span>Heute</span><strong id="sum-today">${fmtDur(s.today)} h</strong></div>
    <div><span>Diese Woche</span><strong id="sum-week">${fmtDur(s.week)} h</strong></div></div>`;
  if (backupDue()) {
    const days = state.settings.lastBackup ? Math.floor((Date.now() - state.settings.lastBackup) / DAY) : null;
    h += `<div class="banner"><span>${days != null ? `Letzte Sicherung vor ${days} Tagen.` : 'Noch keine Sicherung erstellt.'}</span>
      <button class="btn" data-action="goto-backup">Sichern</button></div>`;
  }
  if (r) {
    const sameDay = startOfDay(r.start) === startOfDay(Date.now());
    h += `<section class="run-card">
      <div class="run-label">Läuft</div>
      <div class="run-act">${esc(actName(r.activityId))}</div>
      <div class="run-timer" id="run-timer">${fmtDurSec(Date.now() - r.start)}</div>
      <div class="run-since">seit ${sameDay ? '' : fmtDateLong(r.start) + ', '}${fmtHM(r.start)} Uhr · <button class="link" data-action="edit-start">Beginn ändern</button></div>
      <div class="run-buttons"><button class="btn" data-action="switch">Wechseln</button><button class="btn danger" data-action="stop">Stopp</button></div>
    </section>`;
  } else {
    h += `<h2 class="section-title">Tätigkeit starten</h2>${tilesHtml(activeActs(), 'start')}`;
  }
  return h;
}

function viewEntries() {
  const groups = new Map();
  [...state.entries].sort((a, b) => b.start - a.start).forEach((e) => {
    const k = startOfDay(e.start);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  });
  let h = '';
  if (!groups.size) h = '<div class="empty">Noch keine Einträge.<br>Tippe auf <strong>+</strong>, um einen Eintrag nachzutragen.</div>';
  let i = 0;
  for (const [day, es] of groups) {
    if (i++ >= daysShown) break;
    const sum = es.reduce((acc, e) => acc + entryMin(e), 0);
    h += `<div class="day"><div class="day-head"><span>${fmtDateLong(day)}</span><span class="muted">${fmtDur(sum)} h</span></div><div class="day-list">`;
    for (const e of es.slice().sort((a, b) => a.start - b.start)) {
      const nextDay = e.end != null && startOfDay(e.end) !== startOfDay(e.start);
      h += `<button class="entry${e.end == null ? ' running' : ''}" data-action="entry-edit" data-id="${e.id}">
        <span class="entry-act">${esc(actName(e.activityId))}</span>
        <span class="entry-dur">${e.end == null ? 'läuft' : fmtDur(entryMin(e)) + ' h'}</span>
        <span class="entry-time">${fmtHM(e.start)} – ${e.end != null ? fmtHM(e.end) + (nextDay ? ' (+1 Tag)' : '') : '…'}</span>
      </button>`;
    }
    h += '</div></div>';
  }
  if (groups.size > daysShown) h += '<button class="btn block" data-action="more-entries">Ältere Einträge anzeigen</button>';
  h += '<button class="fab" data-action="entry-new" aria-label="Eintrag nachtragen">+</button>';
  return h;
}

function viewExport() {
  const ys = schoolYearsWithData();
  const share = canShareFile('a.xlsx', XLSX.MIME);
  const r = running();
  return `<div class="card">
    <h2 style="margin-top:0">Excel-Export</h2>
    <p class="muted small">Die Datei enthält das Blatt „Einträge“ (jeder einzelne Eintrag) und das Blatt „Zusammenfassung“ (Stunden pro Tätigkeit und gesamt je Schuljahr, 01.08.–31.07.).</p>
    <label>Zeitraum<select id="exp-sy">
      <option value="all">Alle Schuljahre</option>
      ${ys.map((y) => `<option value="${y}">Schuljahr ${syLabel(y)}</option>`).join('')}
    </select></label>
    <div class="stack">
      ${share ? '<button class="btn primary block" data-action="export-share">Excel-Datei teilen …</button>' : ''}
      <button class="btn ${share ? '' : 'primary'} block" data-action="export-download">Excel-Datei herunterladen</button>
    </div>
    ${r ? '<p class="muted small">Hinweis: Die gerade laufende Erfassung wird erst nach dem Stoppen exportiert.</p>' : ''}
  </div>`;
}

function viewSettings() {
  const acts = activeActs();
  const share = canShareFile('a.json', 'application/json');
  const lb = state.settings.lastBackup;
  return `<h2 class="section-title">Tätigkeiten</h2>
    <div class="day-list" id="act-list">
      ${acts.map((a, i) => `<div class="act-row">
        <button class="act-main" data-action="act-edit" data-id="${a.id}"><div class="act-name">${esc(a.name)}</div><div class="act-sub">Nachfrage nach ${fmtThreshold(a.threshold)}</div></button>
        <button class="icon-btn" data-action="act-up" data-id="${a.id}" aria-label="nach oben" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="icon-btn" data-action="act-down" data-id="${a.id}" aria-label="nach unten" ${i === acts.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="icon-btn del" data-action="act-del" data-id="${a.id}" aria-label="löschen">✕</button>
      </div>`).join('') || '<div class="empty">Keine Tätigkeiten.</div>'}
    </div>
    <div style="margin-top:10px"><button class="btn block" data-action="act-add">+ Tätigkeit hinzufügen</button></div>
    <p class="muted small">Tippe auf eine Tätigkeit, um sie umzubenennen oder die Nachfrage-Zeit zu ändern.</p>

    <h2 class="section-title" id="backup">Sicherung</h2>
    <div class="card">
      <p class="small" style="margin-top:0">Letzte Sicherung: <strong>${lb ? fmtDate(lb) + ', ' + fmtHM(lb) + ' Uhr' : 'noch keine'}</strong></p>
      <p class="muted small">Die Sicherung enthält alle Einträge und Tätigkeiten. Speichere sie z. B. in Google Drive. Auf einem neuen Handy installierst du die App und importierst die Sicherung.</p>
      <div class="stack">
        ${share ? '<button class="btn primary block" data-action="backup-share">Sicherung teilen / speichern …</button>' : ''}
        <button class="btn ${share ? '' : 'primary'} block" data-action="backup-download">Sicherung herunterladen</button>
        <button class="btn block" data-action="backup-import">Sicherung importieren …</button>
      </div>
    </div>
    <p class="muted small" style="text-align:center">Arbeitszeit · Version ${APP_VERSION} · ${state.entries.length} Einträge gespeichert</p>`;
}

const VIEWS = { home: viewHome, entries: viewEntries, export: viewExport, settings: viewSettings };

function render() {
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const v = $('#view');
  const keepScroll = window.scrollY;
  const sel = $('#exp-sy') && $('#exp-sy').value;
  v.innerHTML = VIEWS[tab]();
  if (sel && $('#exp-sy')) $('#exp-sy').value = sel;
  window.scrollTo(0, keepScroll);
}

function tick() {
  if (tab !== 'home') return;
  const r = running();
  const t = $('#run-timer');
  if (r && t) t.textContent = fmtDurSec(Date.now() - r.start);
  const s = sumsNow();
  const a = $('#sum-today'), b = $('#sum-week');
  if (a) a.textContent = fmtDur(s.today) + ' h';
  if (b) b.textContent = fmtDur(s.week) + ' h';
}

/* ---------- Ereignisse ---------- */

function onViewClick(ev) {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case 'start': startActivity(id); break;
    case 'stop': stopRunning(); break;
    case 'switch': openSwitch(); break;
    case 'edit-start': editRunningStart(); break;
    case 'goto-backup': tab = 'settings'; render(); $('#backup').scrollIntoView(); break;
    case 'entry-edit': openEntryEditor(id); break;
    case 'entry-new': openEntryEditor(null); break;
    case 'more-entries': daysShown += 30; render(); break;
    case 'act-up': moveActivity(id, -1); break;
    case 'act-down': moveActivity(id, 1); break;
    case 'act-edit': openActivityEditor(id); break;
    case 'act-add': openActivityEditor(null); break;
    case 'act-del': deleteActivity(id); break;
    case 'backup-share': exportBackup('share'); break;
    case 'backup-download': exportBackup('download'); break;
    case 'backup-import': $('#import-file').value = ''; $('#import-file').click(); break;
    case 'export-share': exportExcel('share'); break;
    case 'export-download': exportExcel('download'); break;
  }
}

function init() {
  $('#view').addEventListener('click', onViewClick);
  document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    if (tab === 'entries') daysShown = 30;
    render();
    window.scrollTo(0, 0);
  }));
  $('#snack-undo').addEventListener('click', doUndo);
  $('#import-file').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) importBackupText(await f.text());
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const fresh = loadState(); // falls in anderem Tab geändert
      state = fresh;
      render();
      checkLongRunning();
    }
  });
  window.addEventListener('storage', (ev) => { if (ev.key === KEY) { state = loadState(); render(); } });
  if (!localStorage.getItem(KEY)) save();
  render();
  checkLongRunning();
  setInterval(tick, 1000);
  setInterval(checkLongRunning, 60000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
  }
}

init();
