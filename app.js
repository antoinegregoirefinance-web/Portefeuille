'use strict';
/* =====================================================================
   Mon Portefeuille — suivi de placements en bourse (V1.0)
   App 100 % locale : les données restent dans ce navigateur (localStorage).
   Seuls les symboles boursiers sont envoyés au fournisseur de cours choisi.
   ===================================================================== */

const APP_VERSION = 'V1.2';
const LS_KEY = 'mon_portefeuille_bourse_v1';
const CG_EXEMPTION = 10000; // exonération annuelle taxe plus-values (2026)

const TYPES = { action: 'Action', etf: 'ETF / tracker', obligation: 'Obligation', fonds: 'Fonds / SICAV', etc: 'ETC / ETN (or, matières premières)', crypto: 'Crypto', autre: 'Autre' };
const CLASSES = { actions: 'Actions', obligations: 'Obligations', or: 'Or & métaux précieux', immobilier: 'Immobilier', matieres: 'Matières premières', crypto: 'Crypto', monetaire: 'Monétaire / liquidités', autre: 'Autre' };
const DIMS = { classe: 'Classe d\'actif', type: 'Type d\'instrument', region: 'Région', secteur: 'Secteur', devise: 'Devise', ligne: 'Ligne' };
const KINDS = { achat: 'Achat', vente: 'Vente', dividende: 'Dividende (net)', frais: 'Frais / droits', depot: 'Dépôt d\'argent', retrait: 'Retrait d\'argent' };
const REGIONS = ['', 'Monde', 'Europe', 'Belgique', 'Zone euro', 'Royaume-Uni', 'Suisse', 'États-Unis', 'Amérique (hors USA)', 'Japon', 'Asie-Pacifique', 'Asie', 'Émergents', 'Autre'];
const CCYS = ['EUR', 'USD', 'GBP', 'GBX', 'CHF', 'SEK', 'DKK', 'NOK', 'CAD', 'JPY'];
const ALERT_KINDS = {
  prix_sup: 'Cours ≥', prix_inf: 'Cours ≤',
  gain_pct: 'Gain vs PRU ≥ (%)', perte_pct: 'Perte vs PRU ≥ (%)',
  var_jour: 'Variation du jour ≥ (%)', rsi_haut: 'RSI ≥', rsi_bas: 'RSI ≤'
};
const TOB_RATES = [
  ['', 'TOB : saisie libre'],
  ['0.0012', '0,12 % — ETF/tracker EEE, obligations'],
  ['0.0035', '0,35 % — actions, trackers hors EEE'],
  ['0.0132', '1,32 % — ETF capitalisant enregistré en BE']
];
const PALETTE = ['#1d4e89', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#475569', '#0d9488', '#a16207'];

/* ---------------------------- État ---------------------------- */
function defaultState() {
  return {
    version: 1, created: new Date().toISOString(),
    settings: {
      provider: 'alphavantage', avKey: '', tdKey: '',
      fx: { USD: 0.86, GBP: 1.14, CHF: 1.07 }, fxDate: null,
      autoRefresh: true, autoTonio: true, lastTonio: null, lastRefresh: null,
      allocBy: 'ligne', showClosed: false,
      gsUrl: '', gsToken: '', gsEvery: 5, lastPoll: null
    },
    assets: [], tx: [], alerts: []
  };
}
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw), d = defaultState();
      return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}), fx: { ...d.settings.fx, ...((s.settings || {}).fx || {}) } } };
    }
  } catch (e) { console.error(e); }
  return defaultState();
}
let S = load();
let currentTab = 'overview';
let busy = false;
let lastCreatedAssetId = null;
let importCtx = null;

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); }
  catch (e) { toast('⚠️ Enregistrement local impossible : ' + e.message, 'err'); }
}
function save() { persist(); dirty = true; scheduleSave(); }

/* ---------------------------- Outils ---------------------------- */
const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5); }
function fmtDate(iso) { if (!iso) return '–'; const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}`; }
function localISO(d) {
  const o = -d.getTimezoneOffset(), sg = o >= 0 ? '+' : '-', p2 = n => pad(Math.floor(Math.abs(n)));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sg}${p2(o / 60)}:${p2(o % 60)}`;
}
const nfEur = new Intl.NumberFormat('fr-BE', { style: 'currency', currency: 'EUR' });
function eur(v) { return v == null || isNaN(v) ? '–' : nfEur.format(v); }
function sEur(v) { return v == null || isNaN(v) ? '–' : (v > 0 ? '+' : '') + nfEur.format(v); }
function num(v, d) {
  if (v == null || isNaN(v)) return '–';
  const dec = d != null ? d : (Math.abs(v) < 10 ? 4 : 2);
  return new Intl.NumberFormat('fr-BE', { minimumFractionDigits: Math.min(2, dec), maximumFractionDigits: dec }).format(v);
}
function money(v, c) {
  if (v == null || isNaN(v)) return '–';
  if (c === 'GBX') return num(v) + ' p';
  try { return new Intl.NumberFormat('fr-BE', { style: 'currency', currency: c || 'EUR', minimumFractionDigits: 2, maximumFractionDigits: Math.abs(v) < 10 ? 4 : 2 }).format(v); }
  catch { return num(v) + ' ' + c; }
}
function pct(v) { return v == null || isNaN(v) ? '–' : (v > 0 ? '+' : '') + (v * 100).toFixed(2).replace('.', ',') + ' %'; }
function pctAbs(v) { return v == null || isNaN(v) ? '–' : (v * 100).toFixed(1).replace('.', ',') + ' %'; }
function cls(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function parseNum(s) {
  if (typeof s === 'number') return s;
  if (s == null) return NaN;
  let t = String(s).trim().replace(/[\s  ]/g, '').replace(/[^\d.,\-+]/g, '');
  if (!t) return NaN;
  const c = t.lastIndexOf(','), p = t.lastIndexOf('.');
  if (c > -1 && p > -1) t = c > p ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (c > -1) t = t.replace(/\./g, '').replace(',', '.');
  return parseFloat(t);
}
const r2 = v => v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
const r4 = v => v == null || isNaN(v) ? null : Math.round(v * 10000) / 10000;
function toast(msg, type) {
  const t = document.createElement('div'); t.className = 'toast ' + (type || ''); t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), type === 'err' ? 9000 : 5000);
}
function fx(ccy) {
  if (!ccy || ccy === 'EUR') return 1;
  if (ccy === 'GBX') return (S.settings.fx.GBP || 1) / 100;
  return S.settings.fx[ccy] || 1;
}
const assetById = id => S.assets.find(a => a.id === id);
const nm = a => a ? (a.name || a.symbol || '?') : '?';
function sortedTx() { return [...S.tx].sort((a, b) => a.date === b.date ? (a.created || 0) - (b.created || 0) : (a.date < b.date ? -1 : 1)); }

/* ---------------------------- Calculs ---------------------------- */
function compute() {
  const by = {};
  S.assets.forEach(a => by[a.id] = { asset: a, qty: 0, cost: 0, costEur: 0, realized: 0, divs: 0, fees: 0, boughtEur: 0, txCount: 0 });
  let cash = 0, hasCash = false, feesOther = 0;
  const realizedYear = {};
  for (const t of sortedTx()) {
    const p = by[t.assetId], yr = t.date.slice(0, 4), amt = +t.amount || 0;
    switch (t.kind) {
      case 'depot': cash += amt; hasCash = true; break;
      case 'retrait': cash -= amt; hasCash = true; break;
      case 'frais': cash -= amt; if (p) { p.fees += amt; p.realized -= amt; } else feesOther += amt; break;
      case 'dividende': cash += amt; if (p) p.divs += amt; break;
      case 'achat': {
        if (!p) break;
        const r = +t.fx || 1, q = +t.qty || 0, pr = +t.price || 0, f = (+t.fees || 0) + (+t.tax || 0);
        const tot = q * pr * r + f;
        p.qty += q; p.costEur += tot; p.cost += q * pr + f / r; p.boughtEur += tot; p.fees += f; cash -= tot; p.txCount++;
        break;
      }
      case 'vente': {
        if (!p || p.qty <= 0) break;
        const r = +t.fx || 1, q = Math.min(+t.qty || 0, p.qty), pr = +t.price || 0, f = (+t.fees || 0) + (+t.tax || 0);
        const share = q / p.qty, baseEur = p.costEur * share, proceeds = q * pr * r - f, g = proceeds - baseEur;
        p.realized += g; realizedYear[yr] = (realizedYear[yr] || 0) + g;
        p.costEur -= baseEur; p.cost -= p.cost * share; p.qty -= q; p.fees += f; cash += proceeds; p.txCount++;
        if (p.qty < 1e-9) { p.qty = 0; p.cost = 0; p.costEur = 0; }
        break;
      }
    }
  }
  const list = Object.values(by);
  const T = { value: 0, cost: 0, latent: 0, realized: 0, divs: 0, day: 0, bought: 0, fees: feesOther };
  for (const p of list) {
    const a = p.asset, r = fx(a.ccy);
    p.pru = p.qty > 0 ? p.cost / p.qty : null;
    p.price = a.price ?? null;
    p.priced = p.price != null;
    p.value = p.qty > 0 ? (p.priced ? p.qty * p.price * r : p.costEur) : 0;
    p.latent = p.qty > 0 ? p.value - p.costEur : 0;
    p.pctLatent = p.costEur > 0 ? p.latent / p.costEur : 0;
    p.dayPct = a.prevClose && p.priced ? p.price / a.prevClose - 1 : null;
    p.day = p.qty > 0 && p.dayPct != null ? p.qty * (p.price - a.prevClose) * r : 0;
    T.value += p.value; T.cost += p.costEur; T.latent += p.latent; T.realized += p.realized;
    T.divs += p.divs; T.day += p.day; T.bought += p.boughtEur; T.fees += p.fees;
  }
  list.forEach(p => p.weight = T.value > 0 && p.qty > 0 ? p.value / T.value : 0);
  T.total = T.latent + T.realized + T.divs - feesOther;
  T.pctLatent = T.cost > 0 ? T.latent / T.cost : 0;
  T.dayPct = T.value - T.day > 0 ? T.day / (T.value - T.day) : 0;
  return { list, by, T, cash, hasCash, realizedYear, open: list.filter(p => p.qty > 0) };
}

function closes(a) { return (a.hist || []).map(x => x[1]); }
function sma(arr, k) { if (arr.length < k) return null; let s = 0; for (let i = arr.length - k; i < arr.length; i++) s += arr[i]; return s / k; }
function rollingSma(arr, k) { const out = []; let s = 0; for (let i = 0; i < arr.length; i++) { s += arr[i]; if (i >= k) s -= arr[i - k]; out.push(i >= k - 1 ? s / k : null); } return out; }
function rsi(arr, k = 14) {
  if (arr.length < k + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= k; i++) { const d = arr[i] - arr[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= k; l /= k;
  for (let i = k + 1; i < arr.length; i++) { const d = arr[i] - arr[i - 1]; g = (g * (k - 1) + Math.max(d, 0)) / k; l = (l * (k - 1) + Math.max(-d, 0)) / k; }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function indicators(a) {
  const c = closes(a), n = c.length, last = a.price ?? (n ? c[n - 1] : null);
  const I = { n, last, sma20: sma(c, 20), sma50: sma(c, 50), sma200: sma(c, 200), rsi: rsi(c.slice(-120)), perf1m: null, perf3m: null, perf1y: null, hi: null, lo: null, rangeLabel: '', vol: null, longMA: null, longLabel: null };
  if (last == null) return I;
  const perf = k => n > k && c[n - 1 - k] > 0 ? last / c[n - 1 - k] - 1 : null;
  I.perf1m = perf(21); I.perf3m = perf(63);
  const w = (a.weekly || []).map(x => x[1]);
  if (n > 252) I.perf1y = perf(252); else if (w.length > 52) I.perf1y = last / w[w.length - 53] - 1;
  let yr = null;
  if (n >= 250) { yr = c.slice(-252); I.rangeLabel = '52 sem.'; }
  else if (w.length >= 52) { yr = w.slice(-52); I.rangeLabel = '52 sem.'; }
  else if (n >= 20) { yr = c; I.rangeLabel = n + ' j'; }
  if (yr) { I.hi = Math.max(...yr, last); I.lo = Math.min(...yr, last); }
  if (I.rangeLabel !== '52 sem.' && a.hi52 > 0 && a.lo52 > 0) { I.hi = Math.max(a.hi52, last); I.lo = Math.min(a.lo52, last); I.rangeLabel = '52 sem.'; }
  if (I.sma200 != null) { I.longMA = I.sma200; I.longLabel = 'moyenne 200 jours'; }
  else if (w.length >= 40) { I.longMA = sma(w, 40); I.longLabel = 'moyenne 40 semaines (≈ 200 jours)'; }
  if (n >= 30) {
    const rets = []; for (let i = Math.max(1, n - 60); i < n; i++) if (c[i - 1] > 0) rets.push(Math.log(c[i] / c[i - 1]));
    const m = rets.reduce((s, x) => s + x, 0) / rets.length;
    const v = rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1);
    I.vol = Math.sqrt(v) * Math.sqrt(252);
  }
  return I;
}
/* Lecture pédagogique : t = p (positif), m (négatif), z (info), x (attention) */
function lecture(a, p) {
  const I = indicators(a), pts = []; let sc = 0;
  if (I.last == null) return { I, pts: [{ t: 'z', m: 'Pas encore de cours : actualise les cours ou saisis-le à la main.' }], score: 0, label: 'Pas de données', cls: 'neutral' };
  if (I.sma50 != null) {
    if (I.last > I.sma50) { sc++; pts.push({ t: 'p', m: `Cours au-dessus de sa moyenne 50 jours (${num(I.sma50)}) : tendance de court terme positive.` }); }
    else { sc--; pts.push({ t: 'm', m: `Cours sous sa moyenne 50 jours (${num(I.sma50)}) : tendance de court terme négative.` }); }
  } else pts.push({ t: 'z', m: 'Historique trop court pour calculer la moyenne 50 jours.' });
  if (I.longMA != null) {
    if (I.last > I.longMA) { sc++; pts.push({ t: 'p', m: `Au-dessus de sa ${I.longLabel} : tendance de fond haussière.` }); }
    else { sc--; pts.push({ t: 'm', m: `Sous sa ${I.longLabel} : tendance de fond baissière, prudence avant de renforcer.` }); }
  } else if (a.source !== 'manuel') pts.push({ t: 'z', m: 'Tendance de fond inconnue : ouvre le titre et clique « Charger le long terme ».' });
  if (I.rsi != null) {
    if (I.rsi >= 70) pts.push({ t: 'x', m: `RSI ${I.rsi.toFixed(0)} : suracheté, forte hausse récente. Acheter maintenant, c'est acheter dans l'euphorie ; un étalement des achats limite ce risque.` });
    else if (I.rsi <= 30) pts.push({ t: 'x', m: `RSI ${I.rsi.toFixed(0)} : survendu, forte baisse récente. Possible opportunité si le titre reste solide, mais une baisse peut continuer.` });
    else pts.push({ t: 'z', m: `RSI ${I.rsi.toFixed(0)} : zone neutre.` });
  }
  if (I.hi) {
    const dd = I.last / I.hi - 1;
    if (dd > -0.03) pts.push({ t: 'z', m: `Proche de son plus haut sur ${I.rangeLabel}.` });
    else if (dd < -0.3) { sc--; pts.push({ t: 'm', m: `À ${pct(dd)} de son plus haut sur ${I.rangeLabel} : fort recul, comprends pourquoi avant de renforcer.` }); }
  }
  if (I.vol != null && I.vol > 0.4) pts.push({ t: 'x', m: `Volatilité élevée (${pctAbs(I.vol)} par an) : grosses variations, limite la taille de la position.` });
  if (p && p.qty > 0) {
    if (p.weight > 0.2 && !['etf', 'fonds'].includes(a.type)) pts.push({ t: 'x', m: `Pèse ${pctAbs(p.weight)} de ton portefeuille : concentration élevée sur une seule société.` });
    if (p.pctLatent >= 0.5) pts.push({ t: 'x', m: `Gain latent de ${pct(p.pctLatent)} : envisage de sécuriser une partie ou de rééquilibrer.` });
    if (p.pctLatent <= -0.2) pts.push({ t: 'x', m: `Perte latente de ${pct(p.pctLatent)} : relis ta raison d'achat. Si elle ne tient plus, la perte n'est pas une raison de garder.` });
  }
  let label = 'Neutre / mitigé', c = 'neutral';
  if (sc >= 2) { label = 'Tendance favorable'; c = 'pos'; }
  else if (sc <= -2) { label = 'Tendance défavorable'; c = 'neg'; }
  return { I, pts, score: sc, label, cls: c };
}

function valueHistory() {
  const txs = sortedTx().filter(t => (t.kind === 'achat' || t.kind === 'vente') && assetById(t.assetId));
  if (!txs.length) return [];
  const start = txs[0].date, ids = [...new Set(txs.map(t => t.assetId))], dates = new Set([today()]);
  const H = {};
  ids.forEach(id => { H[id] = assetById(id).hist || []; H[id].forEach(([d]) => { if (d >= start) dates.add(d); }); });
  txs.forEach(t => dates.add(t.date));
  const ds = [...dates].filter(d => d >= start).sort();
  const qty = {}, cost = {}, ptr = {};
  ids.forEach(id => { qty[id] = 0; cost[id] = 0; ptr[id] = -1; });
  let ti = 0; const out = [];
  for (const d of ds) {
    while (ti < txs.length && txs[ti].date <= d) {
      const t = txs[ti++], id = t.assetId, r = +t.fx || 1, q = +t.qty || 0, f = (+t.fees || 0) + (+t.tax || 0);
      if (t.kind === 'achat') { qty[id] += q; cost[id] += q * t.price * r + f; }
      else if (qty[id] > 0) { const qq = Math.min(q, qty[id]); cost[id] -= cost[id] * qq / qty[id]; qty[id] -= qq; }
    }
    let v = 0, inv = 0;
    for (const id of ids) {
      if (qty[id] <= 1e-9) continue;
      const h = H[id];
      while (ptr[id] + 1 < h.length && h[ptr[id] + 1][0] <= d) ptr[id]++;
      const px = ptr[id] >= 0 ? h[ptr[id]][1] : null;
      v += px != null ? qty[id] * px * fx(assetById(id).ccy) : cost[id];
      inv += cost[id];
    }
    out.push({ date: d, value: v, invested: inv });
  }
  return out;
}

/* ------------------------- Fournisseurs de cours ------------------------- */
async function av(fn, params) {
  if (!S.settings.avKey) throw new Error('NOKEY');
  const u = new URL('https://www.alphavantage.co/query');
  u.searchParams.set('function', fn);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  u.searchParams.set('apikey', S.settings.avKey);
  const r = await fetch(u);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j['Error Message']) throw new Error('symbole inconnu chez Alpha Vantage (utilise 🔎 Chercher)');
  const info = j.Note || j.Information;
  if (info) throw new Error((/premium/i.test(info) ? 'PREMIUM:' : 'LIMIT:') + info);
  return j;
}
async function td(path, params) {
  if (!S.settings.tdKey) throw new Error('NOKEY');
  const u = new URL('https://api.twelvedata.com/' + path);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  u.searchParams.set('apikey', S.settings.tdKey);
  const r = await fetch(u);
  const j = await r.json();
  if (j.status === 'error' || (j.code && j.code >= 400)) {
    const m = j.message || 'erreur';
    if (/credits|limit|minute/i.test(m)) throw new Error('LIMIT:' + m);
    if (/plan|upgrade|grow|pro/i.test(m)) throw new Error('PREMIUM:' + m);
    throw new Error(m);
  }
  return j;
}
function providerOf(a) { return S.settings.provider; }
async function fetchDaily(a) {
  if (providerOf(a) === 'twelvedata') {
    const j = await td('time_series', { symbol: a.symbol, interval: '1day', outputsize: 300 });
    return (j.values || []).map(v => [v.datetime.slice(0, 10), +v.close, +v.open, +v.high, +v.low]).reverse();
  }
  const j = await av('TIME_SERIES_DAILY', { symbol: a.symbol, outputsize: 'compact' });
  const ts = j['Time Series (Daily)'];
  if (!ts) throw new Error('réponse vide');
  return Object.entries(ts).map(([d, v]) => [d, +v['4. close'], +v['1. open'], +v['2. high'], +v['3. low']]).sort((x, y) => x[0] < y[0] ? -1 : 1);
}
async function fetchWeekly(a) {
  if (providerOf(a) === 'twelvedata') {
    const j = await td('time_series', { symbol: a.symbol, interval: '1week', outputsize: 260 });
    return (j.values || []).map(v => [v.datetime.slice(0, 10), +v.close, +v.open, +v.high, +v.low]).reverse();
  }
  const j = await av('TIME_SERIES_WEEKLY', { symbol: a.symbol });
  const ts = j['Weekly Time Series'];
  if (!ts) throw new Error('réponse vide');
  return Object.entries(ts).map(([d, v]) => [d, +v['4. close'], +v['1. open'], +v['2. high'], +v['3. low']]).sort((x, y) => x[0] < y[0] ? -1 : 1).slice(-260);
}
async function searchSymbol(q) {
  if (S.settings.provider === 'twelvedata') {
    const u = new URL('https://api.twelvedata.com/symbol_search');
    u.searchParams.set('symbol', q); u.searchParams.set('outputsize', 20);
    if (S.settings.tdKey) u.searchParams.set('apikey', S.settings.tdKey);
    const j = await (await fetch(u)).json();
    return (j.data || []).map(x => ({ symbol: x.symbol, name: x.instrument_name, exch: x.exchange + (x.country ? ' · ' + x.country : ''), ccy: x.currency, type: x.instrument_type }));
  }
  const j = await av('SYMBOL_SEARCH', { keywords: q });
  return (j.bestMatches || []).map(x => ({ symbol: x['1. symbol'], name: x['2. name'], type: x['3. type'], exch: x['4. region'], ccy: x['8. currency'] }));
}
/* Historique : [date, clôture] ou [date, clôture, ouverture, plus haut, plus bas] */
function mergeHist(a, rows, keep = 400) {
  const m = new Map((a.hist || []).map(x => [x[0], x]));
  rows.forEach(([d, c, o, h, l]) => {
    if (!d || !(c > 0)) return;
    const old = m.get(d);
    if (o > 0 && h > 0 && l > 0) m.set(d, [d, c, o, Math.max(h, c, o), Math.min(l, c, o)]);
    else if (old && old.length >= 5) m.set(d, [d, c, old[2], Math.max(old[3], c), Math.min(old[4], c)]);
    else m.set(d, [d, c]);
  });
  a.hist = [...m.values()].sort((x, y) => x[0] < y[0] ? -1 : 1).slice(-keep);
  const n = a.hist.length;
  if (n) { a.price = a.hist[n - 1][1]; a.priceDate = a.hist[n - 1][0]; a.prevClose = n > 1 ? a.hist[n - 2][1] : null; }
}
function explainErr(e) {
  const m = e.message || String(e);
  if (m === 'NOKEY') return 'aucune clé API (⚙️ Paramètres)';
  if (m.startsWith('LIMIT:')) return 'limite gratuite atteinte';
  if (m.startsWith('PREMIUM:')) return 'non couvert par le plan gratuit';
  if (m === 'Failed to fetch') return 'connexion impossible';
  return m;
}
function needsPrice(a, c) { return a.symbol && a.source !== 'manuel' && (a.watch || c.by[a.id].qty > 0 || S.alerts.some(x => x.assetId === a.id && x.active)); }

async function refreshPrices(force) {
  if (busy) return;
  const key = S.settings.provider === 'twelvedata' ? S.settings.tdKey : S.settings.avKey;
  if (!key) { if (force && !S.settings.gsUrl) { toast('Ajoute d\'abord une clé de cours gratuite dans ⚙️ Paramètres (ou saisis les cours à la main).'); showTab('parametres'); } return; }
  const c = compute();
  const list = S.assets.filter(a => needsPrice(a, c) && (force || !a.fetchedAt || Date.now() - a.fetchedAt > 6 * 3600e3));
  if (!list.length) { if (force) toast('Cours déjà à jour (moins de 6 h).'); return; }
  busy = true;
  if (!S.settings.fxDate || S.settings.fxDate < addDays(today(), -1)) await refreshFx(true);
  let ok = 0; const errs = []; let stop = '';
  const delay = S.settings.provider === 'twelvedata' ? 8000 : 1500;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    setStatus(`Cours ${i + 1}/${list.length} : ${a.symbol}…`);
    try { mergeHist(a, await fetchDaily(a)); a.fetchedAt = Date.now(); ok++; }
    catch (e) {
      if ((e.message || '').startsWith('LIMIT:')) { stop = e.message.slice(6); break; }
      errs.push(`${a.symbol} : ${explainErr(e)}`);
    }
    if (i < list.length - 1) await sleep(delay);
  }
  busy = false;
  S.settings.lastRefresh = new Date().toISOString(); dirty = true;
  checkAlerts();
  save(); renderAll();
  let msg = `✅ ${ok}/${list.length} cours mis à jour.`;
  if (stop) msg += ' Limite gratuite atteinte : les autres seront actualisés plus tard (ou saisis-les à la main).';
  toast(msg, stop ? 'err' : '');
  if (errs.length) toast('Problèmes : ' + errs.join(' · '), 'err');
}
async function refreshOne(id, long) {
  const a = assetById(id); if (!a || !a.symbol) return toast('Indique d\'abord le symbole du titre.', 'err');
  try {
    setStatus('Chargement de ' + a.symbol + '…');
    if (long) { a.weekly = await fetchWeekly(a); a.weeklyAt = Date.now(); }
    else { mergeHist(a, await fetchDaily(a)); a.fetchedAt = Date.now(); }
    checkAlerts(); save(); renderAll(); openAsset(id);
    toast(long ? '✅ Historique long terme chargé.' : '✅ Cours mis à jour.');
  } catch (e) { toast(a.symbol + ' : ' + explainErr(e), 'err'); setStatus(''); }
}
async function refreshFx(silent) {
  const want = [...new Set([...S.assets.map(a => a.ccy === 'GBX' ? 'GBP' : a.ccy).filter(c => c && c !== 'EUR'), 'USD', 'GBP', 'CHF'])];
  try {
    let j;
    try { const r = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=' + want.join(',')); if (!r.ok) throw 0; j = await r.json(); }
    catch { const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=' + want.join(',')); j = await r.json(); }
    Object.entries(j.rates || {}).forEach(([k, v]) => { if (v > 0) S.settings.fx[k] = 1 / v; });
    S.settings.fxDate = j.date || today();
    save();
    if (!silent) { toast('Taux de change BCE du ' + fmtDate(S.settings.fxDate) + ' chargés.'); renderAll(); }
  } catch (e) { if (!silent) toast('Taux de change indisponibles : ' + e.message, 'err'); }
}

/* ------------- Cours en continu via un relais Google Sheets (GOOGLEFINANCE) ------------- */
const GS_SUFFIX = { BRU: 'EBR', BR: 'EBR', AMS: 'AMS', AS: 'AMS', PAR: 'EPA', PA: 'EPA', DEX: 'ETR', DE: 'ETR', XETRA: 'ETR', FRK: 'FRA', F: 'FRA', LON: 'LON', L: 'LON', MIL: 'BIT', MI: 'BIT', SWX: 'SWX', SW: 'SWX', MAD: 'BME', MC: 'BME', STO: 'STO', ST: 'STO', CPH: 'CPH', CO: 'CPH', HEL: 'HEL', HE: 'HEL', OSL: 'OSL', OL: 'OSL', LIS: 'ELI', LS: 'ELI', VIE: 'VIE', VI: 'VIE', TRT: 'TSE', TO: 'TSE' };
function googleSym(a) {
  if (!a) return '';
  if (a.gsym) return a.gsym;
  const s = (a.symbol || '').toUpperCase(); if (!s) return '';
  const m = s.match(/^(.+)\.([A-Z]+)$/);
  if (!m) return s;
  return GS_SUFFIX[m[2]] ? GS_SUFFIX[m[2]] + ':' + m[1] : '';
}
let pollTimer = null, polling = false;
async function gsCall(params) {
  const u = new URL(S.settings.gsUrl);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  u.searchParams.set('token', S.settings.gsToken || '');
  const r = await fetch(u);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error === 'token' ? 'code d\'accès incorrect' : j.error);
  return j;
}
async function pollQuotes(manual) {
  if (!S.settings.gsUrl || polling) return;
  const c = compute();
  const list = S.assets.filter(a => (a.watch || c.by[a.id].qty > 0 || S.alerts.some(x => x.assetId === a.id && x.active)) && googleSym(a));
  polling = true;
  try {
    const j = await gsCall({ action: 'quotes', sync: '1', symbols: [...new Set(list.map(googleSym))].join(',') });
    if (manual && !list.length) toast('Aucun titre suivi : la feuille Google a été vidée.');
    let n = 0; const miss = [];
    list.forEach(a => {
      const q = (j.quotes || {})[googleSym(a)];
      if (!q || !(q.price > 0)) { miss.push(googleSym(a)); return; }
      const d = (q.time || '').slice(0, 10) || today();
      mergeHist(a, [[d, q.price, q.open, q.high, q.low]]);
      const stamp = q.time || localISO(new Date()).slice(0, 16);
      a.intraday = (a.intraday || []).filter(x => x[0].slice(0, 10) === stamp.slice(0, 10));
      if (!a.intraday.length || a.intraday[a.intraday.length - 1][0] !== stamp) a.intraday.push([stamp, q.price]);
      if (a.intraday.length > 150) a.intraday = a.intraday.slice(-150);
      if (q.prev > 0 && d === a.priceDate) a.prevClose = q.prev;
      a.priceTime = q.time || null;
      if (q.high52 > 0) a.hi52 = q.high52;
      if (q.low52 > 0) a.lo52 = q.low52;
      n++;
    });
    S.settings.lastPoll = Date.now();
    const fired = checkAlerts();
    dirty = true;
    if (fired) save(); else persist();
    renderHeader();
    if ($('#modal').classList.contains('hidden') && ['overview', 'positions', 'analyse', 'alertes'].includes(currentTab)) renderView(currentTab);
    if (manual) toast(`✅ ${n} cours Google Finance mis à jour` + (miss.length ? ` · introuvables : ${miss.join(', ')} (corrige le « Symbole Google Finance » du titre)` : '.'), miss.length ? 'err' : '');
  } catch (e) {
    if (manual) toast('Relais Google : ' + explainErr(e), 'err'); else setStatus('⚠️ relais Google indisponible');
  }
  polling = false;
}
function setupPolling() {
  clearInterval(pollTimer);
  const s = S.settings;
  if (!s.gsUrl || !(+s.gsEvery > 0)) return;
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pollQuotes(false); }, s.gsEvery * 60000);
}
document.addEventListener('visibilitychange', () => {
  const s = S.settings;
  if (document.visibilityState === 'visible' && s.gsUrl && +s.gsEvery > 0 && Date.now() - (s.lastPoll || 0) > s.gsEvery * 60000) pollQuotes(false);
});
const GS_SCRIPT = [
  "/**",
  " * @OnlyCurrentDoc",
  " * Mon Portefeuille - relais de cours Google Finance (V2)",
  " * Le script n'a accès qu'à CETTE feuille Google Sheets, rien d'autre dans ton Drive.",
  " * L'app ajoute et retire elle-même les titres : inutile de modifier la feuille à la main.",
  " */",
  "const TOKEN = 'CHANGE-MOI'; // ton code, à recopier dans l'app (Paramètres)",
  "const COLS = ['price', 'closeyest', 'tradetime', 'currency', 'high52', 'low52', 'priceopen', 'high', 'low'];",
  "const HEAD = ['Symbole', 'Cours', 'Clôture veille', 'Heure', 'Devise', 'Haut 52s', 'Bas 52s', 'Ouverture', 'Haut jour', 'Bas jour'];",
  "",
  "function doGet(e) {",
  "  const p = (e && e.parameter) || {};",
  "  if (p.token !== TOKEN) return out_({ error: 'token' });",
  "  try {",
  "    const list = String(p.symbols || '').split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(String);",
  "    if (p.action === 'quotes') return out_(quotes_(list, p.sync === '1'));",
  "    if (p.action === 'list') return out_({ symbols: known_() });",
  "    return out_({ ok: true, version: 2 });",
  "  } catch (err) { return out_({ error: String(err) }); }",
  "}",
  "",
  "function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }",
  "",
  "function sheet_() {",
  "  const ss = SpreadsheetApp.getActive();",
  "  const sh = ss.getSheetByName('Cours') || ss.insertSheet('Cours');",
  "  if (sh.getLastRow() < 1) sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]);",
  "  return sh;",
  "}",
  "",
  "function known_() {",
  "  const sh = sheet_(), last = sh.getLastRow();",
  "  return last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];",
  "}",
  "",
  "function quotes_(symbols, sync) {",
  "  const lock = LockService.getScriptLock(); lock.waitLock(20000);",
  "  try {",
  "    const ss = SpreadsheetApp.getActive(), sh = sheet_();",
  "    let known = known_();",
  "    // 1. Retirer les titres que l'app ne suit plus",
  "    if (sync) {",
  "      for (let i = known.length - 1; i >= 0; i--) if (symbols.indexOf(known[i]) < 0) sh.deleteRow(i + 2);",
  "      known = known_();",
  "    }",
  "    // 2. Ajouter les nouveaux titres demandés par l'app",
  "    let last = sh.getLastRow();",
  "    const add = symbols.filter(function (s) { return known.indexOf(s) < 0; });",
  "    add.forEach(function (s) {",
  "      last++;",
  "      sh.getRange(last, 1).setValue(s);",
  "      sh.getRange(last, 2, 1, COLS.length).setFormulas([COLS.map(function (c) { return '=IFERROR(GOOGLEFINANCE($A' + last + ',\"' + c + '\"),\"\")'; })]);",
  "    });",
  "    if (add.length) {",
  "      SpreadsheetApp.flush();",
  "      for (let i = 0; i < 10; i++) {",
  "        const d = sh.getDataRange().getDisplayValues();",
  "        if (!d.some(function (r) { const t = r.join(''); return t.indexOf('Loading') > -1 || t.indexOf('Chargement') > -1; })) break;",
  "        Utilities.sleep(800);",
  "      }",
  "    }",
  "    // 3. Lire les cours",
  "    const v = sh.getDataRange().getValues(), tz = ss.getSpreadsheetTimeZone(), res = {};",
  "    const n = function (x) { return typeof x === 'number' ? x : null; };",
  "    v.slice(1).forEach(function (r) {",
  "      if (symbols.indexOf(String(r[0])) < 0 || typeof r[1] !== 'number') return;",
  "      res[r[0]] = {",
  "        price: r[1], prev: n(r[2]),",
  "        time: r[3] instanceof Date ? Utilities.formatDate(r[3], tz, \"yyyy-MM-dd'T'HH:mm\") : null,",
  "        ccy: r[4] || null, high52: n(r[5]), low52: n(r[6]), open: n(r[7]), high: n(r[8]), low: n(r[9])",
  "      };",
  "    });",
  "    return { quotes: res, added: add, at: new Date().toISOString() };",
  "  } finally { lock.releaseLock(); }",
  "}"
].join('\n');
function showGsScript() {
  openModal(`<h2>⏱️ Relais de cours Google Sheets</h2>
    <p class="small">Une Google Sheet calcule les cours avec la fonction GOOGLEFINANCE ; un petit script les transmet à l'app. Gratuit, sans Python, sans serveur. Installation unique d'environ 5 minutes :</p>
    <ol class="steps small">
      <li>Dans Google Drive (en dehors des dossiers Tonio et Coffre), crée une Google Sheet vide, par exemple « Mon Portefeuille – cours ». Le script y crée lui-même l'onglet « Cours ».</li>
      <li>Menu <b>Extensions → Apps Script</b>. Efface le contenu, colle le script ci-dessous et remplace <code>CHANGE-MOI</code> par un code de ton choix. Enregistre.</li>
      <li><b>Déployer → Nouveau déploiement</b> → type <b>Application Web</b>. « Exécuter en tant que » : <b>Moi</b> ; « Qui a accès » : <b>Tout le monde</b>. Autorise l'accès (écran « application non validée » : Paramètres avancés → Accéder). Grâce à <code>@OnlyCurrentDoc</code>, le script ne peut lire que cette feuille.</li>
      <li>Copie l'URL qui se termine par <code>/exec</code> et colle-la dans ⚙️ Paramètres avec ton code, puis « Tester le relais ».</li>
    </ol>
    <textarea id="gsScriptTxt" readonly style="width:100%;min-height:300px;font-family:monospace;font-size:12px">${esc(GS_SCRIPT)}</textarea>
    <div class="modal-actions"><button class="btn primary" data-act="gscopy">📋 Copier le script</button><button class="btn" data-act="closemodal">Fermer</button></div>
    <p class="hint">Si tu modifies le script plus tard : Déployer → Gérer les déploiements → ✏️ → Version : nouvelle version (l'URL reste la même).</p>`);
}

/* ---------------------------- Alertes ---------------------------- */
function alertText(al) { const a = assetById(al.assetId); return `${nm(a)} — ${ALERT_KINDS[al.kind]} ${num(al.value)}`; }
function alertCurrent(al, c, a) {
  const p = c.by[a.id];
  switch (al.kind) {
    case 'prix_sup': case 'prix_inf': return a.price ?? null;
    case 'gain_pct': case 'perte_pct': return p && p.qty > 0 && a.price != null ? p.pctLatent * 100 : null;
    case 'var_jour': return a.prevClose && a.price != null ? (a.price / a.prevClose - 1) * 100 : null;
    case 'rsi_haut': case 'rsi_bas': return indicators(a).rsi;
  }
  return null;
}
function checkAlerts() {
  const c = compute(); const fired = [];
  for (const al of S.alerts) {
    const a = assetById(al.assetId); if (!a || !al.active) continue;
    const v = alertCurrent(al, c, a); al.lastValue = v;
    if (v == null || al.triggeredAt) continue;
    const x = +al.value;
    const hit = { prix_sup: v >= x, prix_inf: v <= x, gain_pct: v >= x, perte_pct: v <= -Math.abs(x), var_jour: Math.abs(v) >= x, rsi_haut: v >= x, rsi_bas: v <= x }[al.kind];
    if (hit) { al.triggeredAt = new Date().toISOString(); fired.push(al); }
  }
  fired.forEach(al => {
    const body = alertText(al) + ' (valeur actuelle : ' + num(al.lastValue) + ')';
    toast('🔔 ' + body);
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Alerte — Mon Portefeuille', { body }); } catch { }
  });
  return fired.length;
}

/* ---------------------------- Rendu ---------------------------- */
const charts = {};
function mkChart(id, cfg) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  const el = document.getElementById(id);
  if (!el || !window.Chart) return;
  charts[id] = new Chart(el, cfg);
}
function setStatus(t) { $('#hdrStatus').textContent = t; }

function renderHeader() {
  const c = compute();
  const sub = c.open.length ? `${eur(c.T.value)} · <span class="${cls(c.T.day)}">${sEur(c.T.day)} (${pct(c.T.dayPct)}) aujourd'hui</span>` : 'Suivi de placements — données 100 % locales';
  $('#hdrSub').innerHTML = sub;
  const lr = S.settings.lastRefresh;
  setStatus(lr ? 'Cours actualisés le ' + fmtDate(lr.slice(0, 10)) + ' à ' + lr.slice(11, 16).replace(':', 'h') : '');
  if (lr) { const d = new Date(lr); setStatus('Cours actualisés le ' + d.toLocaleDateString('fr-BE') + ' à ' + d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' })); }
  if (S.settings.gsUrl && S.settings.lastPoll) setStatus('⏱️ Cours relevés à ' + new Date(S.settings.lastPoll).toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' }) + (+S.settings.gsEvery > 0 ? ' · auto toutes les ' + S.settings.gsEvery + ' min' : '') + ' (différé ~15-20 min)');
  const n = S.alerts.filter(a => a.active && a.triggeredAt).length;
  const b = $('#alertBadge'); b.textContent = n; b.classList.toggle('hidden', !n);
}
function renderAll() { renderHeader(); renderView(currentTab); }
function renderView(t) {
  ({ overview: renderOverview, positions: renderPositions, repartition: renderRepartition, graphiques: renderCharts, transactions: renderTx, analyse: renderAnalyse, alertes: renderAlerts, parametres: renderSettings }[t] || (() => { }))();
}
function showTab(t) {
  currentTab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + t));
  history.replaceState(null, '', '#' + t);
  renderAll();
  window.scrollTo(0, 0);
}
function kpi(l, v, s, sign) { return `<div class="kpi"><div class="l">${l}</div><div class="v ${sign != null ? cls(sign) : ''}">${v}</div><div class="s ${sign != null ? cls(sign) : ''}">${s || '&nbsp;'}</div></div>`; }

function welcomeHTML() {
  return `<div class="card empty">
    <h2>Bienvenue dans ton suivi de portefeuille 👋</h2>
    <p>Tout reste dans ce navigateur : aucune donnée n'est envoyée, sauf les symboles des titres au fournisseur de cours.</p>
    <div class="toolbar" style="justify-content:center;margin-top:18px">
      <button class="btn primary" data-act="tab" data-tab="parametres">1. Configurer une clé de cours gratuite</button>
      <button class="btn" data-act="tab" data-tab="transactions">2. Saisir mon premier achat</button>
      <button class="btn" data-act="import">ou importer un CSV Keytrade</button>
      <button class="btn" data-act="tab" data-tab="bases">📘 Les bases</button>
    </div>
    <p class="muted small" style="margin-top:18px">Astuce : sauvegarde régulièrement (⚙️ Paramètres → Sauvegarde) ; les données sont propres à chaque appareil et navigateur.</p>
  </div>`;
}
/* ---------- Répartitions (classe, instrument, région, secteur, devise, ligne) ---------- */
function defaultClass(type) { return { action: 'actions', etf: 'actions', fonds: 'actions', obligation: 'obligations', etc: 'or', crypto: 'crypto' }[type] || 'autre'; }
function assetClass(a) { return a.cls || defaultClass(a.type); }
/* « États-Unis 70; Europe 15; Japon 6 » → [[nom, part 0-1]], normalisé à 100 % */
function parseSplit(txt) {
  if (!txt) return null;
  const out = [];
  String(txt).split(/[;\n]+/).forEach(part => { const m = part.trim().match(/^(.+?)[\s:=]+(\d+(?:[.,]\d+)?)\s*%?$/); if (m) { const v = parseNum(m[2]); if (v > 0) out.push([m[1].trim(), v]); } });
  const tot = out.reduce((t, x) => t + x[1], 0);
  return tot > 0 ? out.map(([k, v]) => [k, v / tot]) : null;
}
function groupKey(p, by) {
  const a = p.asset;
  switch (by) {
    case 'classe': return CLASSES[assetClass(a)];
    case 'type': return TYPES[a.type] || 'Autre';
    case 'secteur': return a.sector || 'Non renseigné';
    case 'region': return a.region || 'Non renseignée';
    case 'devise': return a.ccy || 'EUR';
    default: return nm(a);
  }
}
function contributions(p, dim) {
  const a = p.asset;
  const sp = dim === 'region' ? parseSplit(a.regionSplit) : dim === 'secteur' ? parseSplit(a.sectorSplit) : null;
  return sp ? sp.map(([k, w]) => [k, p.value * w]) : [[groupKey(p, dim), p.value]];
}
function breakdown(c, dim, withCash) {
  const m = new Map();
  c.open.forEach(p => contributions(p, dim).forEach(([k, v]) => {
    const e = m.get(k) || { key: k, value: 0, cost: 0, latent: 0, lines: new Set() };
    const share = p.value ? v / p.value : 0;
    e.value += v; e.cost += p.costEur * share; e.latent += p.latent * share; e.lines.add(p.asset.id);
    m.set(k, e);
  }));
  if (withCash && c.hasCash && c.cash > 0) {
    const k = dim === 'classe' ? CLASSES.monetaire : dim === 'devise' ? 'EUR' : 'Liquidités';
    const e = m.get(k) || { key: k, value: 0, cost: 0, latent: 0, lines: new Set() };
    e.value += c.cash; e.cash = true; m.set(k, e);
  }
  const arr = [...m.values()].sort((x, y) => y.value - x.value);
  const tot = arr.reduce((t, x) => t + x.value, 0);
  arr.forEach(x => x.pct = tot ? x.value / tot : 0);
  return { arr, tot };
}
function attention(c) {
  const out = [];
  if (!c.open.length) { out.push(['i', 'Aucune position ouverte : ajoute une transaction d\'achat pour démarrer.']); return out; }
  c.open.filter(p => p.weight > 0.2 && !['etf', 'fonds'].includes(p.asset.type)).forEach(p => out.push(['w', `${esc(nm(p.asset))} pèse ${pctAbs(p.weight)} du portefeuille : une seule société ne devrait idéalement pas dépasser 10 à 20 %.`]));
  const broad = c.open.some(p => ['etf', 'fonds'].includes(p.asset.type));
  if (c.open.length < 5 && !broad) out.push(['w', 'Moins de 5 lignes et aucun ETF : portefeuille peu diversifié. Un ETF « monde » couvre des centaines de sociétés en une seule ligne.']);
  breakdown(c, 'region').arr.forEach(x => { if (x.pct > 0.7 && !/monde|non renseign/i.test(x.key)) out.push(['w', `${pctAbs(x.pct)} du portefeuille est exposé à une seule région (${esc(x.key)}). <button class="btn sm" data-act="tab" data-tab="repartition">Voir</button>`]); });
  breakdown(c, 'secteur').arr.forEach(x => { if (x.pct > 0.4 && !/diversifi|non renseign/i.test(x.key)) out.push(['w', `${pctAbs(x.pct)} du portefeuille dans un seul secteur (${esc(x.key)}). <button class="btn sm" data-act="tab" data-tab="repartition">Voir</button>`]); });
  c.open.filter(p => p.pctLatent <= -0.2).forEach(p => out.push(['w', `${esc(nm(p.asset))} : ${pct(p.pctLatent)} depuis ton achat. La raison de l'achat tient-elle toujours ?`]));
  c.open.filter(p => p.pctLatent >= 0.5).forEach(p => out.push(['i', `${esc(nm(p.asset))} : ${pct(p.pctLatent)}. Vérifie que son poids n'est pas devenu trop important.`]));
  S.assets.filter(a => c.by[a.id].qty > 0 || a.watch).forEach(a => { const mv = bigMoves(a, 3)[0]; if (mv) out.push(['w', `⚡ ${esc(nm(a))} : <b class="${cls(mv.pct)}">${pct(mv.pct)}</b> le ${fmtDate(mv.date)}, mouvement inhabituel. <button class="btn sm" data-act="ask" data-id="${a.id}" data-date="${mv.date}">🤖 Pourquoi ?</button>`]); });
  const stale = c.open.filter(p => p.asset.priceDate && daysBetween(p.asset.priceDate, today()) > 5);
  if (stale.length) out.push(['i', `${stale.length} cours datent de plus de 5 jours : clique « 🔄 Cours » ou saisis-les.`]);
  const unpriced = c.open.filter(p => !p.priced);
  if (unpriced.length) out.push(['i', `${unpriced.length} ligne(s) sans cours, valorisée(s) au prix d'achat : ${unpriced.map(p => esc(nm(p.asset))).join(', ')}.`]);
  const noInfo = c.open.filter(p => !p.asset.sector || !p.asset.region).length;
  if (noInfo) out.push(['i', `${noInfo} ligne(s) sans secteur ou région : complète-les pour une répartition fiable.`]);
  if (!S.settings.avKey && !S.settings.tdKey) out.push(['i', 'Pas de clé de cours : les cours se saisissent à la main. Une clé gratuite se configure dans ⚙️ Paramètres.']);
  if (!out.length) out.push(['ok', 'Rien de particulier à signaler.']);
  return out;
}
function taxBox(ry, yr) {
  const used = Math.max(0, ry), w = Math.min(100, used / CG_EXEMPTION * 100);
  return `<div class="small">Plus-values nettes réalisées en ${yr} : <b class="${cls(ry)}">${sEur(ry)}</b></div>
    <div class="bar"><i class="${used > CG_EXEMPTION ? 'over' : ''}" style="width:${w}%"></i></div>
    <div class="small muted">Exonération annuelle : ${eur(CG_EXEMPTION)} · reste ${eur(Math.max(0, CG_EXEMPTION - used))}. Calcul indicatif (méthode PRU de l'app ; la loi a ses propres règles, ex. valeur de référence au 31/12/2025).</div>`;
}
function renderOverview() {
  const el = $('#v-overview');
  if (!S.assets.length && !S.tx.length) { el.innerHTML = welcomeHTML(); return; }
  const c = compute(), T = c.T, yr = String(new Date().getFullYear());
  const trig = S.alerts.filter(a => a.active && a.triggeredAt);
  const sorted = [...c.open].filter(p => p.priced).sort((a, b) => b.pctLatent - a.pctLatent);
  const tf = arr => arr.map(p => `<tr class="click" data-act="asset" data-id="${p.asset.id}"><td>${esc(nm(p.asset))}</td><td class="r ${cls(p.pctLatent)}">${pct(p.pctLatent)}</td><td class="r ${cls(p.latent)}">${sEur(p.latent)}</td></tr>`).join('');
  const by = S.settings.allocBy;
  el.innerHTML = `
    ${trig.length ? `<div class="banner warn">🔔 <b>${trig.length} alerte(s) déclenchée(s)</b> : ${trig.map(al => esc(alertText(al))).join(' · ')} <button class="btn sm" data-act="tab" data-tab="alertes">Voir</button></div>` : ''}
    <div class="kpis">
      ${kpi('Valeur du portefeuille', eur(T.value), c.hasCash ? 'liquidités : ' + eur(c.cash) : `${c.open.length} ligne(s) ouverte(s)`)}
      ${kpi('Montant investi', eur(T.cost), 'coût des lignes ouvertes, frais inclus')}
      ${kpi('Plus-value latente', sEur(T.latent), pct(T.pctLatent), T.latent)}
      ${kpi('Variation du jour', sEur(T.day), pct(T.dayPct), T.day)}
      ${kpi('Plus-values réalisées', sEur(T.realized), 'depuis le début', T.realized)}
      ${kpi('Dividendes nets', eur(T.divs), 'résultat total : ' + sEur(T.total))}
    </div>
    <div class="grid2">
      <div class="card"><div class="card-h"><h3>Répartition</h3>
        <select id="allocBy">${Object.entries(DIMS).map(([v, l]) => `<option value="${v}" ${by === v ? 'selected' : ''}>par ${l.toLowerCase()}</option>`).join('')}</select></div>
        <div class="chartbox"><canvas id="chAlloc"></canvas></div></div>
      <div class="card"><div class="card-h"><h3>Évolution</h3><span class="muted small">valeur et montant investi (€)</span></div>
        <div class="chartbox"><canvas id="chEvo"></canvas></div></div>
    </div>
    <div class="grid2">
      <div class="card"><h3>Points d'attention</h3><ul class="pts">${attention(c).map(([k, m]) => `<li class="${k}">${m}</li>`).join('')}</ul></div>
      <div class="card"><h3>Meilleures lignes</h3>
        <table>${tf(sorted.slice(0, 3)) || '<tr><td class="muted">–</td></tr>'}</table>
        <h3 style="margin-top:14px">Moins bonnes lignes</h3>
        <table>${tf(sorted.length > 3 ? sorted.slice(-Math.min(3, sorted.length - 3)).reverse() : []) ||'<tr><td class="muted">–</td></tr>'}</table>
        <h3 style="margin-top:14px">Taxe sur les plus-values ${yr}</h3>${taxBox(c.realizedYear[yr] || 0, yr)}
      </div>
    </div>
    <p class="muted small">Taux de change : ${S.settings.fxDate ? 'BCE du ' + fmtDate(S.settings.fxDate) : 'par défaut, à actualiser'} · Outil personnel d'aide à la décision, pas un conseil en investissement.</p>`;
  // Répartition
  const ent = breakdown(c, by).arr.map(x => [x.key, x.value]);
  mkChart('chAlloc', {
    type: 'doughnut',
    data: { labels: ent.map(e => e[0]), datasets: [{ data: ent.map(e => r2(e[1])), backgroundColor: ent.map((_, i) => PALETTE[i % PALETTE.length]), borderWidth: 1 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: ctx => `${ctx.label} : ${eur(ctx.raw)} (${pctAbs(ctx.raw / T.value)})` } } } }
  });
  const hist = valueHistory();
  mkChart('chEvo', {
    type: 'line',
    data: {
      labels: hist.map(h => fmtDate(h.date)),
      datasets: [
        { label: 'Valeur', data: hist.map(h => r2(h.value)), borderColor: '#1d4e89', backgroundColor: 'rgba(29,78,137,.08)', fill: true, pointRadius: 0, tension: .2 },
        { label: 'Investi', data: hist.map(h => r2(h.invested)), borderColor: '#94a3b8', borderDash: [5, 4], pointRadius: 0, stepped: true }
      ]
    },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { ticks: { callback: v => num(v, 0) + ' €' } } }, plugins: { tooltip: { callbacks: { label: ctx => ctx.dataset.label + ' : ' + eur(ctx.raw) } } } }
  });
}

function renderPositions() {
  const c = compute();
  const gb = S.settings.posGroup || '';
  let rows = (S.settings.showClosed ? c.list.filter(p => p.txCount > 0 || p.qty > 0) : c.open).sort((a, b) => b.value - a.value || nm(a.asset).localeCompare(nm(b.asset)));
  const groups = [];
  if (gb) {
    const m = new Map();
    rows.forEach(p => { const k = groupKey(p, gb); if (!m.has(k)) m.set(k, []); m.get(k).push(p); });
    [...m.entries()].map(([k, ps]) => ({ k, ps, value: ps.reduce((t, p) => t + p.value, 0), cost: ps.reduce((t, p) => t + p.costEur, 0), latent: ps.reduce((t, p) => t + p.latent, 0) })).sort((x, y) => y.value - x.value).forEach(g => groups.push(g));
  } else groups.push({ k: null, ps: rows });
  $('#v-positions').innerHTML = `<div class="card">
    <div class="toolbar"><h3 class="grow" style="margin:0">Positions (${c.open.length} ouvertes)</h3>
      <label class="small">Regrouper par <select id="posGroup"><option value="">—</option>${Object.entries(DIMS).filter(([k]) => k !== 'ligne').map(([v, l]) => `<option value="${v}" ${gb === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="small"><input type="checkbox" id="showClosed" ${S.settings.showClosed ? 'checked' : ''}> afficher les lignes vendues</label>
      <button class="btn" data-act="newasset">+ Ajouter un titre</button>
      <button class="btn primary" data-act="tab" data-tab="transactions">+ Transaction</button></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Titre</th><th class="r">Quantité</th><th class="r">PRU</th><th class="r">Cours</th><th class="r">Jour</th><th class="r">Valeur</th><th class="r">+/- latente</th><th class="r">Poids</th><th>Lecture</th></tr></thead>
      <tbody>${groups.map(g => (g.k != null ? `<tr class="grp"><td colspan="5">${esc(g.k)} <span class="muted small">(${g.ps.length} ligne${g.ps.length > 1 ? 's' : ''})</span></td><td class="r">${eur(g.value)}</td><td class="r ${cls(g.latent)}">${g.cost ? sEur(g.latent) + '<div class="small">' + pct(g.latent / g.cost) + '</div>' : ''}</td><td class="r">${c.T.value ? pctAbs(g.value / c.T.value) : ''}</td><td></td></tr>` : '') + g.ps.map(p => {
    const a = p.asset, L = lecture(a, p);
    return `<tr class="click ${p.qty > 0 ? '' : 'closed'}" data-act="asset" data-id="${a.id}">
          <td><b>${esc(nm(a))}</b><div class="muted small">${esc(a.symbol || '')} · ${CLASSES[assetClass(a)]}${a.type !== 'action' ? ' · ' + (TYPES[a.type] || '') : ''}</div></td>
          <td class="r">${num(p.qty, 4)}</td>
          <td class="r">${p.pru != null ? money(p.pru, a.ccy) : '–'}</td>
          <td class="r">${p.priced ? money(p.price, a.ccy) : '<span class="muted">à saisir</span>'}<div class="muted small">${a.priceDate ? fmtDate(a.priceDate) : ''}</div></td>
          <td class="r ${cls(p.dayPct)}">${pct(p.dayPct)}</td>
          <td class="r"><b>${eur(p.value)}</b></td>
          <td class="r ${cls(p.qty > 0 ? p.latent : p.realized)}">${p.qty > 0 ? sEur(p.latent) + '<div class="small">' + pct(p.pctLatent) + '</div>' : 'réalisé ' + sEur(p.realized)}</td>
          <td class="r">${p.qty > 0 ? pctAbs(p.weight) : ''}</td>
          <td><span class="tag ${L.cls}">${L.label}</span></td></tr>`;
  }).join('')).join('') || '<tr><td colspan="9" class="muted">Aucune position. Ajoute une transaction d\'achat.</td></tr>'}</tbody>
      ${c.open.length ? `<tfoot><tr><th colspan="5">Total</th><th class="r">${eur(c.T.value)}</th><th class="r ${cls(c.T.latent)}">${sEur(c.T.latent)}<div class="small">${pct(c.T.pctLatent)}</div></th><th class="r">100 %</th><th></th></tr></tfoot>` : ''}
    </table></div>
    <p class="hint">Clique sur une ligne pour voir son graphique, ses indicateurs, saisir un cours ou créer une alerte.</p></div>`;
}

/* ---------- Onglet Graphiques : historique de n'importe quel titre ---------- */
const CHART_RANGES = { '1J': '1 jour', '1S': '1 semaine', '1M': '1 mois', '1A': '1 an', '10A': '10 ans' };
const PRESETS = [
  ['SPY', 'S&P 500 — via l\'ETF SPY', 'USD'], ['QQQ', 'Nasdaq 100 — via l\'ETF QQQ', 'USD'], ['DIA', 'Dow Jones — via l\'ETF DIA', 'USD'],
  ['VGK', 'Actions européennes — via l\'ETF VGK', 'USD'], ['EFA', 'Pays développés hors USA — via l\'ETF EFA', 'USD'],
  ['EEM', 'Marchés émergents — via l\'ETF EEM', 'USD'], ['GLD', 'Or — via l\'ETF GLD', 'USD'], ['SLV', 'Argent — via l\'ETF SLV', 'USD'],
  ['IEF', 'Obligations d\'État US 7-10 ans — via l\'ETF IEF', 'USD'], ['TLT', 'Obligations d\'État US 20 ans+ — via l\'ETF TLT', 'USD']
];
let seriesCache = {};
try { seriesCache = JSON.parse(localStorage.getItem('mp_series') || '{}'); } catch { seriesCache = {}; }
function cacheGet(k, maxAge) { const e = seriesCache[k]; return e && Date.now() - e.t < maxAge ? e.rows : null; }
function cacheSet(k, rows) {
  seriesCache[k] = { t: Date.now(), rows };
  try { localStorage.setItem('mp_series', JSON.stringify(seriesCache)); }
  catch { seriesCache = { [k]: seriesCache[k] }; try { localStorage.setItem('mp_series', JSON.stringify(seriesCache)); } catch { } }
}
async function fetchSeriesAny(sym, interval) {
  if (S.settings.provider === 'twelvedata') {
    const iv = { '5min': '5min', daily: '1day', weekly: '1week', monthly: '1month' }[interval];
    const j = await td('time_series', { symbol: sym, interval: iv, outputsize: { '5min': 120, daily: 300, weekly: 530, monthly: 130 }[interval] });
    return (j.values || []).map(v => [v.datetime, +v.close, +v.open, +v.high, +v.low]).reverse();
  }
  const fn = { '5min': 'TIME_SERIES_INTRADAY', daily: 'TIME_SERIES_DAILY', weekly: 'TIME_SERIES_WEEKLY', monthly: 'TIME_SERIES_MONTHLY' }[interval];
  const params = { symbol: sym };
  if (interval === '5min') { params.interval = '5min'; params.outputsize = 'compact'; }
  if (interval === 'daily') params.outputsize = 'compact';
  const j = await av(fn, params);
  const key = Object.keys(j).find(k => k !== 'Meta Data' && typeof j[k] === 'object');
  if (!key) throw new Error('réponse vide');
  return Object.entries(j[key]).map(([d, v]) => [d, +v['4. close'], +v['1. open'], +v['2. high'], +v['3. low']]).sort((x, y) => x[0] < y[0] ? -1 : 1);
}
function chartTarget() {
  const c = S.settings.chartSel || {};
  if (c.assetId) { const a = assetById(c.assetId); if (a) return { asset: a, sym: a.symbol, name: nm(a), ccy: a.ccy }; }
  if (c.sym) return { asset: null, sym: c.sym, name: c.name || c.sym, ccy: c.ccy || '' };
  const first = S.assets.find(a => compute().by[a.id].qty > 0) || S.assets[0];
  if (first) return { asset: first, sym: first.symbol, name: nm(first), ccy: first.ccy };
  return { asset: null, sym: 'SPY', name: PRESETS[0][1], ccy: 'USD' };
}
async function loadChartRows(t, range) {
  const key = S.settings.provider === 'twelvedata' ? S.settings.tdKey : S.settings.avKey;
  const local = t.asset ? (t.asset.hist || []) : [];
  const canFetch = !!(t.sym && key && (!t.asset || t.asset.source !== 'manuel'));
  const get = async (interval, maxAge) => {
    const k = (S.settings.provider || 'av') + '|' + t.sym + '|' + interval, c = cacheGet(k, maxAge);
    if (c) return c;
    const rows = await fetchSeriesAny(t.sym, interval); cacheSet(k, rows); return rows;
  };
  if (range === '1J') {
    if (canFetch) {
      try {
        const rows = await get('5min', 15 * 60000);
        const lastDay = rows.length ? rows[rows.length - 1][0].slice(0, 10) : null;
        return { rows: rows.filter(r => r[0].slice(0, 10) === lastDay), unit: 'heure', note: 'Cours toutes les 5 minutes (dernière séance disponible).' };
      } catch (e) { if (!t.asset) throw e; }
    }
    const intr = (t.asset && t.asset.intraday) || [];
    if (intr.length >= 2) return { rows: intr.map(p => [p[0], p[1]]), unit: 'heure', note: 'Points relevés par le relais Google pendant que l\'app était ouverte aujourd\'hui.' };
    throw new Error(t.asset && t.asset.source === 'manuel' ? 'Pas de cours intrajournaliers pour un titre saisi à la main ou de simulation.' : 'Pas encore de cours de la journée : laisse l\'app ouverte avec le relais Google, ou utilise une clé couvrant ce titre en intrajournalier (souvent seulement les titres américains en gratuit).');
  }
  const need = { '1S': 6, '1M': 23, '1A': 253 }[range];
  if (range !== '10A') {
    if (local.length >= need || (!canFetch && local.length)) return { rows: local.slice(-need), unit: 'jour', note: local.length < need ? `Historique disponible : ${local.length} jours.` : '' };
    if (!canFetch) throw new Error(key ? 'Ce titre n\'a pas de symbole pour les cours automatiques.' : 'Ajoute une clé Alpha Vantage (⚙️ Paramètres) pour charger l\'historique.');
    if (range === '1A' && S.settings.provider !== 'twelvedata') return { rows: (await get('weekly', 864e5)).slice(-53), unit: 'semaine', note: 'Une bougie par semaine (l\'historique quotidien gratuit couvre 100 jours).' };
    return { rows: (await get('daily', 6 * 3600e3)).slice(-need), unit: 'jour', note: '' };
  }
  if (canFetch) return { rows: (await get('monthly', 7 * 864e5)).slice(-121), unit: 'mois', note: 'Une bougie par mois.' };
  if (local.length) return { rows: local, unit: 'jour', note: `Historique disponible : ${local.length} jours seulement (titre sans cours automatiques).` };
  throw new Error('Ajoute une clé Alpha Vantage (⚙️ Paramètres) pour charger 10 ans d\'historique.');
}
function fmtX(d, unit) {
  if (unit === 'heure') return d.slice(11, 16);
  if (unit === 'mois') return d.slice(5, 7) + '/' + d.slice(0, 4);
  return d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(2, 4);
}
function drawOHLC(id, rows, mode, unit) {
  const candles = mode === 'bougies' && rows.some(r => r.length >= 5 && r[2] > 0);
  const up = r => r.length < 5 || !(r[2] > 0) || r[1] >= r[2], col = r => up(r) ? '#16a34a' : '#dc2626';
  const cl = rows.map(r => r[1]);
  const ds = candles ? [
    { type: 'bar', label: 'Mèches', data: rows.map(r => r.length >= 5 && r[3] > 0 ? [r[4], r[3]] : null), backgroundColor: rows.map(col), barThickness: 1, grouped: false, order: 3 },
    { type: 'bar', label: 'Cours', data: rows.map(r => { const o = r.length >= 5 && r[2] > 0 ? r[2] : r[1], c = r[1], lo = Math.min(o, c), hi = Math.max(o, c); return [lo, hi === lo ? hi * 1.0005 : hi]; }), backgroundColor: rows.map(col), barPercentage: .8, categoryPercentage: 1, grouped: false, order: 2 }
  ] : [{ type: 'line', label: 'Cours', data: cl, borderColor: '#1d4e89', backgroundColor: 'rgba(29,78,137,.08)', fill: true, pointRadius: rows.length < 40 ? 2 : 0, tension: .1, order: 2 }];
  if (rows.length >= 40 && unit !== 'heure') ds.push({ type: 'line', label: 'Moyenne 20 périodes', data: rollingSma(cl, 20), borderColor: '#f59e0b', pointRadius: 0, borderWidth: 1, order: 1 });
  mkChart(id, {
    type: candles ? 'bar' : 'line', data: { labels: rows.map(r => fmtX(r[0], unit)), datasets: ds },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      scales: { x: { ticks: { maxTicksLimit: 8 }, grid: { display: false } }, y: { beginAtZero: false } },
      plugins: {
        legend: { labels: { boxWidth: 12, filter: it => it.text !== 'Mèches' } },
        tooltip: {
          filter: it => it.dataset.label !== 'Mèches',
          callbacks: {
            title: items => { const r = rows[items[0].dataIndex]; return unit === 'heure' ? r[0].slice(0, 16).replace('T', ' ') : fmtDate(r[0].slice(0, 10)); },
            label: ctx => { const r = rows[ctx.dataIndex]; if (ctx.dataset.label === 'Cours') return r.length >= 5 && r[2] > 0 ? `Ouv. ${num(r[2])} · Haut ${num(r[3])} · Bas ${num(r[4])} · Clôt. ${num(r[1])}` : 'Cours ' + num(r[1]); return ctx.dataset.label + ' : ' + num(ctx.raw); }
          }
        }
      }
    }
  });
}
async function renderCharts() {
  const el = $('#v-graphiques'); if (!el) return;
  const c = compute(), t = chartTarget(), cs = S.settings.chartSel || {};
  const range = S.settings.chartTabRange || '1M', mode = S.settings.chartTabMode || 'bougies';
  const own = S.assets.filter(a => c.by[a.id].qty > 0), watch = S.assets.filter(a => !(c.by[a.id].qty > 0));
  const optA = a => `<option value="a:${a.id}" ${t.asset && t.asset.id === a.id ? 'selected' : ''}>${esc(nm(a))}${a.symbol ? ' (' + esc(a.symbol) + ')' : ''}</option>`;
  el.innerHTML = `<div class="card">
    <div class="toolbar">
      <select id="chSel" style="min-width:280px">
        ${own.length ? `<optgroup label="Mon portefeuille">${own.map(optA).join('')}</optgroup>` : ''}
        ${watch.length ? `<optgroup label="Surveillance et autres titres">${watch.map(optA).join('')}</optgroup>` : ''}
        <optgroup label="Indices et références (via un ETF)">${PRESETS.map(([sy, l]) => `<option value="p:${sy}" ${!t.asset && t.sym === sy ? 'selected' : ''}>${esc(l)}</option>`).join('')}</optgroup>
        ${!t.asset && !PRESETS.some(p => p[0] === t.sym) ? `<option value="s:${esc(t.sym)}" selected>${esc(t.name)} (${esc(t.sym)})</option>` : ''}
      </select>
      <input id="chSym" placeholder="Autre : nom ou symbole (ex. Tesla, BEL 20, AIR.PAR)" style="min-width:260px"><button class="btn" data-act="chsearch">🔎 Chercher</button>
    </div>
    <div id="chResults" class="symres"></div>
    <div class="toolbar">
      <div class="seg">${Object.keys(CHART_RANGES).map(r => `<button class="${r === range ? 'on' : ''}" data-act="chtr" data-v="${r}" title="${CHART_RANGES[r]}">${r}</button>`).join('')}</div>
      <div class="seg">${[['ligne', '📈 Lignes'], ['bougies', '🕯️ Bougies']].map(([v, l]) => `<button class="${v === mode ? 'on' : ''}" data-act="chtm" data-v="${v}">${l}</button>`).join('')}</div>
      <span class="grow"></span>
      ${!t.asset && t.sym ? `<button class="btn sm" data-act="chwatch">+ Suivre ce titre</button>` : ''}
      ${t.asset ? `<button class="btn sm" data-act="asset" data-id="${t.asset.id}">Fiche du titre</button>` : ''}
    </div>
    <h3 style="margin:6px 0 2px">${esc(t.name)} <span class="muted small">${esc(t.sym || '')} · ${CHART_RANGES[range]}</span></h3>
    <div class="mgrid" id="chStats"></div>
    <div class="chartbox" style="height:430px"><canvas id="chMain"></canvas><div id="chMsg" class="muted" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px">Chargement…</div></div>
    <p class="hint" id="chNote"></p>
    <p class="small muted">Les indices (S&P 500, Nasdaq…) sont suivis via un ETF qui les réplique, en dollars : les cours gratuits ne couvrent pas les indices eux-mêmes. Cours différés. Chaque chargement consomme une requête Alpha Vantage (25 par jour) ; les historiques sont gardés en mémoire (15 min à 7 jours selon la période).</p>
  </div>`;
  try {
    const { rows, unit, note } = await loadChartRows(t, range);
    if (!rows || rows.length < 2) throw new Error('Pas assez de données pour cette période.');
    $('#chMsg').style.display = 'none';
    drawOHLC('chMain', rows, mode, unit);
    const first = rows[0][2] > 0 && rows[0].length >= 5 ? rows[0][2] : rows[0][1], last = rows[rows.length - 1][1];
    const hi = Math.max(...rows.map(r => r.length >= 5 && r[3] > 0 ? r[3] : r[1])), lo = Math.min(...rows.map(r => r.length >= 5 && r[4] > 0 ? r[4] : r[1]));
    const v = last / first - 1, ccy = t.ccy || '';
    $('#chStats').innerHTML = `
      <div class="m"><div class="l">Dernier cours</div><div class="v">${ccy ? money(last, ccy) : num(last)}</div></div>
      <div class="m"><div class="l">Variation ${range}</div><div class="v ${cls(v)}">${pct(v)}</div></div>
      <div class="m"><div class="l">Plus haut</div><div class="v">${num(hi)}</div></div>
      <div class="m"><div class="l">Plus bas</div><div class="v">${num(lo)}</div></div>
      <div class="m"><div class="l">Du</div><div class="v">${unit === 'heure' ? rows[0][0].slice(11, 16) : fmtDate(rows[0][0].slice(0, 10))}</div></div>
      <div class="m"><div class="l">Au</div><div class="v">${unit === 'heure' ? rows[rows.length - 1][0].slice(11, 16) : fmtDate(rows[rows.length - 1][0].slice(0, 10))}</div></div>`;
    $('#chNote').textContent = note || '';
  } catch (e) {
    if (charts.chMain) { charts.chMain.destroy(); delete charts.chMain; }
    $('#chMsg').textContent = '⚠️ ' + (e.message === 'NOKEY' || /NOKEY/.test(e.message) ? 'Ajoute une clé Alpha Vantage dans ⚙️ Paramètres pour charger cet historique.' : explainErr(e) + (/LIMIT|PREMIUM/.test(e.message) ? ' — ' + (e.message.split(':').slice(1).join(':').slice(0, 160)) : ''));
  }
}

/* ---------- Onglet Répartition ---------- */
function renderRepartition() {
  const el = $('#v-repartition'), c = compute();
  if (!c.open.length) { el.innerHTML = '<div class="card muted">Aucune position ouverte : les répartitions apparaîtront après ton premier achat.</div>'; return; }
  const dim = S.settings.splitDim || 'classe', wc = !!S.settings.splitCash;
  const color = i => PALETTE[i % PALETTE.length];
  const bars = Object.entries(DIMS).filter(([k]) => k !== 'ligne').map(([k, l]) => {
    const b = breakdown(c, k, wc);
    return `<div class="split-row ${k === dim ? 'on' : ''}" data-act="splitdim" data-v="${k}">
      <div class="split-l">${l}</div>
      <div class="stack">${b.arr.map((x, i) => `<i style="width:${(x.pct * 100).toFixed(2)}%;background:${color(i)}" title="${esc(x.key)} : ${pctAbs(x.pct)}"></i>`).join('')}</div>
      <div class="split-leg">${b.arr.slice(0, 5).map((x, i) => `<span><b class="dot" style="background:${color(i)}"></b>${esc(x.key)} ${pctAbs(x.pct)}</span>`).join('')}${b.arr.length > 5 ? `<span class="muted">+ ${b.arr.length - 5} autres</span>` : ''}</div>
    </div>`;
  }).join('');
  const b = breakdown(c, dim, wc);
  const missing = c.open.filter(p => (!p.asset.region && !p.asset.regionSplit) || (!p.asset.sector && !p.asset.sectorSplit));
  const etfNoSplit = c.open.filter(p => ['etf', 'fonds'].includes(p.asset.type) && !p.asset.regionSplit);
  el.innerHTML = `
    <div class="card"><div class="card-h"><h3>Toutes les répartitions</h3>
      <label class="small"><input type="checkbox" id="splitCash" ${wc ? 'checked' : ''} ${c.hasCash ? '' : 'disabled title="Saisis tes dépôts pour suivre les liquidités"'}> inclure les liquidités${c.hasCash ? ' (' + eur(c.cash) + ')' : ''}</label></div>
      ${bars}
      <p class="hint">Clique une ligne pour afficher son détail ci-dessous.</p></div>
    <div class="grid2">
      <div class="card"><div class="card-h"><h3>Par ${DIMS[dim].toLowerCase()}</h3><select id="splitSel">${opts(DIMS, dim)}</select></div>
        <div class="chartbox"><canvas id="chSplit"></canvas></div></div>
      <div class="card"><h3>Détail</h3><div class="tbl-wrap"><table>
        <thead><tr><th>${DIMS[dim]}</th><th class="r">Valeur</th><th class="r">Poids</th><th class="r">+/- latente</th></tr></thead>
        <tbody>${b.arr.map((x, i) => `<tr><td class="wrap"><b class="dot" style="background:${color(i)}"></b><b>${esc(x.key)}</b><div class="muted small">${x.cash ? 'liquidités' : ''}${[...x.lines].map(id => `<a href="#" data-act="asset" data-id="${id}">${esc(nm(assetById(id)))}</a>`).join(', ')}</div></td>
          <td class="r">${eur(x.value)}</td><td class="r"><b>${pctAbs(x.pct)}</b></td>
          <td class="r ${cls(x.latent)}">${x.cost ? sEur(x.latent) + '<div class="small">' + pct(x.latent / x.cost) + '</div>' : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th>Total</th><th class="r">${eur(b.tot)}</th><th class="r">100 %</th><th></th></tr></tfoot></table></div></div>
    </div>
    ${missing.length || etfNoSplit.length ? `<div class="card"><h3>Pour des répartitions plus justes</h3><ul class="pts">
      ${missing.map(p => `<li class="i">${esc(nm(p.asset))} : région ou secteur manquant. <button class="btn sm" data-act="asset" data-id="${p.asset.id}">Compléter</button></li>`).join('')}
      ${etfNoSplit.map(p => `<li class="i">${esc(nm(p.asset))} : un ETF couvre plusieurs pays et secteurs. Recopie sa répartition (fiche de l'émetteur ou justETF) dans « Répartition détaillée ». <button class="btn sm" data-act="asset" data-id="${p.asset.id}">Ventiler</button></li>`).join('')}
    </ul></div>` : ''}`;
  mkChart('chSplit', {
    type: 'doughnut',
    data: { labels: b.arr.map(x => x.key), datasets: [{ data: b.arr.map(x => r2(x.value)), backgroundColor: b.arr.map((_, i) => color(i)), borderWidth: 1 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: ctx => `${ctx.label} : ${eur(ctx.raw)} (${pctAbs(ctx.raw / b.tot)})` } } } }
  });
}

/* ---------- Fiche titre (modale) ---------- */
function openModal(html, onMount) { $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); if (onMount) setTimeout(onMount, 0); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; if (charts.chAsset) { charts.chAsset.destroy(); delete charts.chAsset; } }
function opts(obj, sel) { return Object.entries(obj).map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join(''); }
function assetOptions(sel, filter) {
  return S.assets.filter(filter || (() => true)).sort((a, b) => nm(a).localeCompare(nm(b))).map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(nm(a))}${a.symbol ? ' (' + esc(a.symbol) + ')' : ''}</option>`).join('');
}
function openAsset(id, preset) {
  const a = id ? assetById(id) : { id: '', symbol: '', name: '', isin: '', type: 'action', ccy: 'EUR', sector: '', region: '', source: 'auto', watch: false, note: '', ...(preset || {}) };
  if (!a) return;
  const c = compute(), p = id ? c.by[id] : null;
  let detail = '';
  if (id) {
    const L = lecture(a, p), I = L.I;
    const txs = sortedTx().filter(t => t.assetId === id).reverse();
    const rng = I.hi && I.hi > I.lo ? Math.max(0, Math.min(100, (I.last - I.lo) / (I.hi - I.lo) * 100)) : null;
    detail = `<hr>
      <div class="toolbar">
        <button class="btn" data-act="fetchone" data-id="${id}">📈 Actualiser ce cours</button>
        <button class="btn" data-act="fetchlong" data-id="${id}">📊 Charger le long terme</button>
        <button class="btn" data-act="newalert" data-id="${id}">🔔 Ajouter une alerte</button>
        <button class="btn" data-act="newtx" data-id="${id}">💶 Nouvelle transaction</button>
        <button class="btn primary" data-act="ask" data-id="${id}">🤖 Analyser avec Claude</button>
      </div>
      <div class="card" style="background:#f8fafc">
        <b>Saisir un cours à la main</b>
        <div class="toolbar" style="margin:8px 0 0"><input type="date" id="mpDate" value="${today()}"> <input id="mpPrice" placeholder="cours en ${a.ccy}" inputmode="decimal" style="width:140px"> <button class="btn" data-act="manualprice" data-id="${id}">Enregistrer le cours</button></div>
      </div>
      <div class="grid2">
        <div>
          ${p && p.qty > 0 ? `<div class="kv"><b>Quantité</b><span>${num(p.qty, 4)}</span><b>PRU</b><span>${money(p.pru, a.ccy)}</span><b>Investi</b><span>${eur(p.costEur)}</span><b>Valeur</b><span>${eur(p.value)}</span><b>+/- latente</b><span class="${cls(p.latent)}">${sEur(p.latent)} (${pct(p.pctLatent)})</span><b>Dividendes</b><span>${eur(p.divs)}</span><b>Poids</b><span>${pctAbs(p.weight)}</span></div>` : (p && p.txCount ? `<div class="kv"><b>Position</b><span>vendue</span><b>Plus-value réalisée</b><span class="${cls(p.realized)}">${sEur(p.realized)}</span></div>` : '<p class="muted">Pas de position (titre suivi).</p>')}
          <div class="mgrid">
            <div class="m"><div class="l">Cours</div><div class="v">${money(I.last, a.ccy)}</div></div>
            <div class="m"><div class="l">1 mois</div><div class="v ${cls(I.perf1m)}">${pct(I.perf1m)}</div></div>
            <div class="m"><div class="l">3 mois</div><div class="v ${cls(I.perf3m)}">${pct(I.perf3m)}</div></div>
            <div class="m"><div class="l">1 an</div><div class="v ${cls(I.perf1y)}">${pct(I.perf1y)}</div></div>
            <div class="m"><div class="l">MM 50 j</div><div class="v">${num(I.sma50)}</div></div>
            <div class="m"><div class="l">Moy. long terme</div><div class="v">${num(I.longMA)}</div></div>
            <div class="m"><div class="l">RSI 14</div><div class="v">${I.rsi != null ? I.rsi.toFixed(0) : '–'}</div></div>
            <div class="m"><div class="l">Volatilité</div><div class="v">${pctAbs(I.vol)}</div></div>
          </div>
          ${rng != null ? `<div class="small muted">Plus bas / plus haut sur ${I.rangeLabel}</div><div class="range"><i style="left:calc(${rng}% - 2px)"></i></div><div class="range-l"><span>${num(I.lo)}</span><span>${num(I.hi)}</span></div>` : ''}
          <div style="margin-top:10px"><span class="tag ${L.cls}">${L.label}</span>
          <ul class="lect">${L.pts.map(x => `<li class="${x.t}">${x.m}</li>`).join('')}</ul></div>
        </div>
        <div>
          <div class="toolbar" style="margin-bottom:6px">
            <div class="seg">${[['ligne', '📈 Lignes'], ['bougies', '🕯️ Bougies']].map(([v, l]) => `<button class="${(S.settings.chartMode || 'ligne') === v ? 'on' : ''}" data-act="chmode" data-v="${v}" data-id="${id}">${l}</button>`).join('')}</div>
            <div class="seg">${['1M', '3M', '6M', '1A', 'Tout'].map(v => `<button class="${(S.settings.chartRange || '6M') === v ? 'on' : ''}" data-act="chrange" data-v="${v}" data-id="${id}">${v}</button>`).join('')}</div>
          </div>
          <div class="chartbox tall"><canvas id="chAsset"></canvas></div>
          <div class="small muted">${(a.hist || []).length} cours en mémoire (${(a.hist || []).filter(x => x.length >= 5).length} avec ouverture/haut/bas) · dernier : ${fmtDate(a.priceDate)}${a.priceTime ? ' ' + a.priceTime.slice(11) : ''}</div>
        </div>
      </div>
      ${(() => { const mv = bigMoves(a, 30); return mv.length ? `<h3>⚡ Mouvements inhabituels (30 derniers jours)</h3><div class="tbl-wrap"><table><thead><tr><th>Date</th><th class="r">Variation</th><th class="r">Clôture</th><th class="r">Habituel</th><th></th></tr></thead><tbody>${mv.map(m => `<tr><td>${fmtDate(m.date)}</td><td class="r ${cls(m.pct)}"><b>${pct(m.pct)}</b></td><td class="r">${num(m.price)}</td><td class="r muted">±${pctAbs(m.usual)}</td><td class="r"><button class="btn sm" data-act="ask" data-id="${id}" data-date="${m.date}">🤖 Pourquoi ?</button></td></tr>`).join('')}</tbody></table></div>` : ''; })()}
      <h3>Transactions</h3>
      <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Type</th><th class="r">Qté</th><th class="r">Cours</th><th class="r">Frais + taxes</th><th class="r">Montant</th></tr></thead>
      <tbody>${txs.map(t => `<tr><td>${fmtDate(t.date)}</td><td>${KINDS[t.kind]}</td><td class="r">${t.qty ? num(t.qty, 4) : ''}</td><td class="r">${t.price ? money(t.price, a.ccy) : ''}</td><td class="r">${(t.fees || t.tax) ? eur((+t.fees || 0) + (+t.tax || 0)) : ''}</td><td class="r">${eur(txTotal(t))}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucune</td></tr>'}</tbody></table></div>
      <p class="disclaimer">Lecture technique simplifiée, à but pédagogique : ce n'est pas un conseil d'achat ou de vente.</p>`;
  }
  openModal(`<h2>${id ? esc(nm(a)) : 'Nouveau titre'}</h2>
    <div class="form-grid">
      <label class="full">Symbole pour les cours <div class="row"><input id="aSymbol" value="${esc(a.symbol)}" placeholder="ex. IWDA.AMS, ABI.BRU, AAPL"><button class="btn" type="button" data-act="symsearch">🔎 Chercher</button></div>
        <span class="small muted" style="font-weight:400">Tape un nom (ex. « iShares MSCI World ») puis 🔎 : choisis la bonne bourse et la bonne devise.</span></label>
      <div id="symResults" class="symres"></div>
      <label>Nom<input id="aName" value="${esc(a.name)}"></label>
      <label>ISIN<input id="aIsin" value="${esc(a.isin || '')}" placeholder="ex. IE00B4L5Y983"></label>
      <label>Type d'instrument<select id="aType">${opts(TYPES, a.type)}</select></label>
      <label>Classe d'actif<select id="aCls" ${a.cls ? 'data-touched="1"' : ''}>${opts(CLASSES, assetClass(a))}</select></label>
      <label>Devise de cotation<select id="aCcy">${CCYS.map(x => `<option ${x === a.ccy ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Secteur<input id="aSector" list="sectors" value="${esc(a.sector || '')}"></label>
      <label>Région<select id="aRegion">${REGIONS.map(x => `<option value="${x}" ${x === (a.region || '') ? 'selected' : ''}>${x || '—'}</option>`).join('')}</select></label>
      <label>Cours<select id="aSource"><option value="auto" ${a.source !== 'manuel' ? 'selected' : ''}>Automatiques (clé API)</option><option value="manuel" ${a.source === 'manuel' ? 'selected' : ''}>Saisis à la main</option></select></label>
      <label>Symbole Google Finance (cours en direct)<input id="aGsym" value="${esc(a.gsym || '')}" placeholder="auto : ${esc(googleSym(a) || 'ex. EBR:ABI')}"></label>
      <label class="chk"><input type="checkbox" id="aWatch" ${a.watch ? 'checked' : ''}> Liste de surveillance (suivre sans posséder)</label>
      <label class="full">Répartition géographique détaillée (facultatif, utile pour un ETF)<input id="aRegionSplit" value="${esc(a.regionSplit || '')}" placeholder="ex. États-Unis 70; Europe 15; Japon 6; Autres 9 — voir la fiche de l'ETF"></label>
      <label class="full">Répartition sectorielle détaillée (facultatif)<input id="aSectorSplit" value="${esc(a.sectorSplit || '')}" placeholder="ex. Technologie 26; Finance 16; Santé 11; Industrie 11; Autres 36"></label>
      <label class="full">Pourquoi ce titre ? (ta « thèse », à relire avant de vendre)<textarea id="aNote">${esc(a.note || '')}</textarea></label>
    </div>
    <div class="modal-actions"><button class="btn primary" data-act="assetsave" data-id="${id}">Enregistrer</button>${id ? `<button class="btn danger" data-act="assetdel" data-id="${id}">Supprimer le titre</button>` : ''}</div>
    ${detail}`, () => { if (id) drawAssetChart(a, p); });
}
const RANGE_DAYS = { '1M': 22, '3M': 66, '6M': 130, '1A': 260, 'Tout': 100000 };
function drawAssetChart(a, p) {
  const all = a.hist || []; if (!all.length) return;
  const k = Math.min(all.length, RANGE_DAYS[S.settings.chartRange || '6M'] || 130);
  const h = all.slice(-k), cl = closes(a);
  const s20 = rollingSma(cl, 20).slice(-k), s50 = rollingSma(cl, 50).slice(-k);
  const moves = new Set(bigMoves(a, k).map(m => m.date));
  const candles = (S.settings.chartMode || 'ligne') === 'bougies';
  const lines = [
    { type: 'line', label: 'MM 20', data: s20, borderColor: '#f59e0b', pointRadius: 0, borderWidth: 1, order: 1 },
    { type: 'line', label: 'MM 50', data: s50, borderColor: '#16a34a', pointRadius: 0, borderWidth: 1, order: 1 }
  ];
  if (p && p.qty > 0 && p.pru) lines.push({ type: 'line', label: 'Ton PRU', data: h.map(() => r4(p.pru)), borderColor: '#dc2626', borderDash: [6, 4], pointRadius: 0, borderWidth: 1, order: 1 });
  let ds;
  if (candles) {
    const up = x => x.length < 5 || x[1] >= x[2];
    const col = x => up(x) ? '#16a34a' : '#dc2626';
    ds = [
      { type: 'bar', label: 'Mèches', data: h.map(x => x.length >= 5 ? [x[4], x[3]] : null), backgroundColor: h.map(col), barThickness: 1, grouped: false, order: 3 },
      { type: 'bar', label: 'Cours', data: h.map(x => { const o = x.length >= 5 ? x[2] : x[1], c = x[1], lo = Math.min(o, c), hi = Math.max(o, c); return [lo, hi === lo ? hi * 1.0005 : hi]; }), backgroundColor: h.map(col), borderColor: h.map(x => moves.has(x[0]) ? '#0f2a4a' : col(x)), borderWidth: h.map(x => moves.has(x[0]) ? 2 : 0), barPercentage: .8, categoryPercentage: 1, grouped: false, order: 2 },
      ...lines
    ];
  } else {
    ds = [{ type: 'line', label: 'Cours', data: h.map(x => x[1]), borderColor: '#1d4e89', tension: .1, order: 2, pointRadius: h.map(x => moves.has(x[0]) ? 5 : (h.length < 30 ? 2 : 0)), pointBackgroundColor: h.map((x, i) => moves.has(x[0]) ? (i && x[1] < h[i - 1][1] ? '#dc2626' : '#16a34a') : '#1d4e89') }, ...lines];
  }
  mkChart('chAsset', {
    type: candles ? 'bar' : 'line',
    data: { labels: h.map(x => fmtDate(x[0])), datasets: ds },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      scales: { x: { ticks: { maxTicksLimit: 6 }, grid: { display: false } }, y: { beginAtZero: false } },
      plugins: {
        legend: { labels: { boxWidth: 12, filter: it => it.text !== 'Mèches' } },
        tooltip: {
          filter: it => it.dataset.label !== 'Mèches',
          callbacks: {
            label: ctx => {
              const x = h[ctx.dataIndex];
              if (ctx.dataset.label === 'Cours') return x.length >= 5 ? `Ouv. ${num(x[2])} · Haut ${num(x[3])} · Bas ${num(x[4])} · Clôt. ${num(x[1])}` : 'Cours ' + num(x[1]);
              return ctx.dataset.label + ' : ' + num(ctx.raw);
            },
            afterBody: items => { const x = h[items[0].dataIndex]; return moves.has(x[0]) ? ['⚡ Mouvement inhabituel ce jour-là'] : []; }
          }
        }
      }
    }
  });
}
/* Mouvements inhabituels : variation du jour ≥ max(3 %, 2,5 × variation journalière habituelle) */
function bigMoves(a, days = 30) {
  const h = a.hist || [], n = h.length; if (n < 3) return [];
  const I = indicators(a), dv = I.vol ? I.vol / Math.sqrt(252) : 0.015, thr = Math.max(0.03, 2.5 * dv), out = [];
  for (let i = Math.max(1, n - days); i < n; i++) {
    if (daysBetween(h[i - 1][0], h[i][0]) > 5) continue;
    const r = h[i][1] / h[i - 1][1] - 1;
    if (Math.abs(r) >= thr) out.push({ date: h[i][0], pct: r, price: h[i][1], usual: dv });
  }
  return out.reverse();
}
function askPrompt(a, mv) {
  const c = compute(), p = c.by[a.id], I = indicators(a);
  const id = `${nm(a)}${a.symbol ? ' (symbole ' + a.symbol + ')' : ''}${a.isin ? ', ISIN ' + a.isin : ''}, ${TYPES[a.type] || ''} coté en ${a.ccy}`;
  const pos = p && p.qty > 0 ? `Ma position : ${num(p.qty, 4)} titres, PRU ${num(p.pru)} ${a.ccy}, ${sEur(p.latent)} (${pct(p.pctLatent)}), ${pctAbs(p.weight)} de mon portefeuille.` : 'Je ne possède pas ce titre, je le surveille.';
  const ctx = `Contexte technique : 1 mois ${pct(I.perf1m)}, 3 mois ${pct(I.perf3m)}, RSI ${I.rsi != null ? I.rsi.toFixed(0) : 'n.d.'}.`;
  const why = a.note ? `Ma raison d'achat / de suivi : « ${a.note} ».` : '';
  const ask = '1) ce qui explique probablement le mouvement, avec les sources et leur date ; 2) si c\'est propre à la société, à son secteur ou au marché dans son ensemble ; 3) si l\'information change quelque chose de fondamental ou si cela ressemble à du bruit ; 4) les questions que je devrais me poser avant d\'acheter, de vendre ou de ne rien faire (sans me dire quoi faire). Sépare clairement les faits sourcés et tes hypothèses.';
  if (mv) return `Tonio, explique-moi ce mouvement de bourse.\nTitre : ${id}.\nMouvement : ${pct(mv.pct)} le ${fmtDate(mv.date)} (clôture ${num(mv.price)} ${a.ccy}), alors que sa variation journalière habituelle est d'environ ±${pctAbs(mv.usual)}.\n${ctx}\n${pos}\n${why}\nCherche sur le web les informations publiées autour du ${fmtDate(mv.date)} (de la veille au lendemain) : résultats ou prévisions, annonces de la société, notes d'analystes, actualité du secteur, mouvement général du marché ce jour-là. Dis-moi : ${ask}`;
  return `Tonio, fais le point sur ce titre.\nTitre : ${id}.\nCours actuel : ${num(I.last)} ${a.ccy} (${fmtDate(a.priceDate)}).\n${ctx}\n${pos}\n${why}\nCherche sur le web les informations importantes des 30 derniers jours (résultats, prévisions, annonces, analystes, secteur) et les prochaines échéances (date des résultats, dividende). Dis-moi : ${ask.replace('le mouvement', 'l\'évolution récente du cours')}`;
}
function openAsk(id, date) {
  const a = assetById(id); if (!a) return;
  const mv = date ? bigMoves(a, 400).find(m => m.date === date) : null;
  const txt = askPrompt(a, mv);
  openModal(`<h2>🤖 Analyser avec Claude</h2>
    <p class="small">Le texte ci-dessous est prêt pour ton projet Claude (Tonio), qui cherchera les informations sur le web. Clique « Copier et ouvrir Claude », puis colle-le (Ctrl+V). Aucun appel payant : c'est ton abonnement Claude qui sert.</p>
    <textarea id="askTxt" style="width:100%;min-height:260px;font-size:13px">${esc(txt)}</textarea>
    <div class="modal-actions"><button class="btn primary" data-act="askgo">📋 Copier et ouvrir Claude</button><button class="btn" data-act="asset" data-id="${id}">← Retour au titre</button></div>
    <p class="hint">Lien utilisé : ${esc(S.settings.claudeUrl || 'https://claude.ai/new')} (modifiable dans ⚙️ Paramètres → Export pour Tonio).</p>`);
}
function gsSoon() { if (S.settings.gsUrl) setTimeout(() => pollQuotes(false), 800); }
function guessRegion(sym) {
  const s = (sym || '').toUpperCase();
  if (/\.BR(U)?$/.test(s)) return 'Belgique';
  if (/\.(PAR|AMS|DEX|FRK|XETRA|LON|MIL|MAD|SWX|STO|CPH|HEL|OSL|LIS|VIE|DUB)$/.test(s)) return 'Europe';
  if (!s.includes('.')) return 'États-Unis';
  return '';
}
function saveAsset(id) {
  const g = k => $('#' + k).value.trim();
  const data = { symbol: g('aSymbol').toUpperCase(), name: g('aName'), isin: g('aIsin').toUpperCase(), type: g('aType'), ccy: g('aCcy'), sector: g('aSector'), region: g('aRegion'), source: g('aSource'), watch: $('#aWatch').checked, note: $('#aNote').value, gsym: g('aGsym').toUpperCase(), cls: g('aCls'), regionSplit: g('aRegionSplit'), sectorSplit: g('aSectorSplit') };
  if (!data.name && !data.symbol) return toast('Indique au moins un nom ou un symbole.', 'err');
  if (!data.name) data.name = data.symbol;
  if (!data.region) data.region = guessRegion(data.symbol);
  if (id) {
    const a = assetById(id);
    if (a.symbol !== data.symbol) { a.hist = []; a.weekly = []; a.price = null; a.priceDate = null; a.prevClose = null; a.fetchedAt = null; }
    Object.assign(a, data);
  } else {
    const a = { id: uid(), created: Date.now(), hist: [], ...data };
    S.assets.push(a); lastCreatedAssetId = a.id;
  }
  save(); closeModal(); renderAll(); gsSoon(); toast('Titre enregistré.');
}

/* ---------------------------- Transactions ---------------------------- */
function txTotal(t) {
  const f = (+t.fees || 0) + (+t.tax || 0), r = +t.fx || 1;
  if (t.kind === 'achat') return (+t.qty || 0) * (+t.price || 0) * r + f;
  if (t.kind === 'vente') return (+t.qty || 0) * (+t.price || 0) * r - f;
  return +t.amount || 0;
}
function renderTx(editId) {
  const t = editId ? S.tx.find(x => x.id === editId) : null;
  const preAsset = t ? t.assetId : (lastCreatedAssetId || '');
  lastCreatedAssetId = null;
  const filter = $('#txFilter') ? $('#txFilter').value : '';
  const list = sortedTx().reverse().filter(x => !filter || x.assetId === filter);
  $('#v-transactions').innerHTML = `
  <div class="card"><h3>${t ? 'Modifier l\'opération' : 'Nouvelle opération'}</h3>
    <div class="form-grid" id="txForm">
      <label>Type<select id="tKind">${opts(KINDS, t ? t.kind : 'achat')}</select></label>
      <label class="g-asset">Titre<select id="tAsset"><option value="">— choisir —</option>${assetOptions(preAsset)}<option value="__new">+ Nouveau titre…</option></select></label>
      <label>Date<input type="date" id="tDate" value="${t ? t.date : today()}"></label>
      <label class="g-trade">Quantité<input id="tQty" inputmode="decimal" value="${t && t.qty ? t.qty : ''}"></label>
      <label class="g-trade">Cours unitaire <span id="tCcyL"></span><input id="tPrice" inputmode="decimal" value="${t && t.price ? t.price : ''}"></label>
      <label class="g-trade">Courtage / frais (€)<input id="tFees" inputmode="decimal" value="${t && t.fees ? t.fees : ''}"></label>
      <label class="g-trade">Taxes : TOB… (€)<div class="row"><input id="tTax" inputmode="decimal" value="${t && t.tax ? t.tax : ''}"></div><select id="tTob">${TOB_RATES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label class="g-fx">Taux de change (€ pour 1 <span id="tFxL"></span>)<input id="tFx" inputmode="decimal" value="${t && t.fx && t.fx !== 1 ? t.fx : ''}"></label>
      <label class="g-amount">Montant net (€)<input id="tAmount" inputmode="decimal" value="${t && t.amount ? t.amount : ''}"></label>
      <label class="full">Note<input id="tNote" value="${esc(t ? t.note || '' : '')}" placeholder="facultatif"></label>
    </div>
    <div class="toolbar" style="margin-top:12px"><b id="tTotal" class="grow"></b>
      ${t ? `<button class="btn" data-act="txcancel">Annuler</button>` : ''}
      <button class="btn primary" data-act="txsave" data-id="${t ? t.id : ''}">${t ? 'Enregistrer les modifications' : 'Ajouter l\'opération'}</button></div>
    <p class="hint">Reprends les chiffres de l'avis d'exécution Keytrade. Le PRU inclut le courtage et la TOB.</p>
  </div>
  <div class="card"><div class="card-h"><h3>Historique (${S.tx.length})</h3>
    <div class="toolbar" style="margin:0"><select id="txFilter"><option value="">Tous les titres</option>${assetOptions(filter, a => S.tx.some(x => x.assetId === a.id))}</select>
    <button class="btn" data-act="import">📥 Importer un CSV (Keytrade)</button></div></div>
    <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Titre</th><th class="r">Qté</th><th class="r">Cours</th><th class="r">Frais + taxes</th><th class="r">Montant €</th><th></th></tr></thead>
    <tbody>${list.map(x => { const a = assetById(x.assetId); return `<tr><td>${fmtDate(x.date)}</td><td>${KINDS[x.kind]}</td><td>${a ? esc(nm(a)) : '<span class="muted">—</span>'}</td><td class="r">${x.qty ? num(x.qty, 4) : ''}</td><td class="r">${x.price ? money(x.price, a ? a.ccy : 'EUR') : ''}</td><td class="r">${(x.fees || x.tax) ? eur((+x.fees || 0) + (+x.tax || 0)) : ''}</td><td class="r">${eur(txTotal(x))}</td>
      <td class="r"><button class="btn sm" data-act="txedit" data-id="${x.id}">✏️</button> <button class="btn sm danger" data-act="txdel" data-id="${x.id}">🗑</button></td></tr>`; }).join('') || '<tr><td colspan="8" class="muted">Aucune opération.</td></tr>'}</tbody></table></div>
  </div>`;
  updateTxForm();
  if (t) $('#v-transactions').scrollIntoView();
}
function updateTxForm() {
  const k = $('#tKind'); if (!k) return;
  const kind = k.value, a = assetById($('#tAsset').value);
  const trade = kind === 'achat' || kind === 'vente';
  document.querySelectorAll('#txForm .g-trade').forEach(e => e.classList.toggle('hidden', !trade));
  document.querySelectorAll('#txForm .g-amount').forEach(e => e.classList.toggle('hidden', trade));
  document.querySelectorAll('#txForm .g-asset').forEach(e => e.classList.toggle('hidden', kind === 'depot' || kind === 'retrait'));
  const foreign = trade && a && a.ccy !== 'EUR';
  document.querySelectorAll('#txForm .g-fx').forEach(e => e.classList.toggle('hidden', !foreign));
  $('#tCcyL').textContent = a ? '(' + a.ccy + ')' : '';
  $('#tFxL').textContent = a ? a.ccy : '';
  if (foreign && !$('#tFx').value) $('#tFx').placeholder = num(fx(a.ccy), 4) + ' (actuel)';
  const rate = parseFloat($('#tTob').value);
  const q = parseNum($('#tQty').value), pr = parseNum($('#tPrice').value), r = foreign ? (parseNum($('#tFx').value) || fx(a.ccy)) : 1;
  if (trade && rate && q > 0 && pr > 0) $('#tTax').value = String(r2(q * pr * r * rate)).replace('.', ',');
  const f = (parseNum($('#tFees').value) || 0) + (parseNum($('#tTax').value) || 0);
  let total = null;
  if (trade && q > 0 && pr > 0) total = kind === 'achat' ? q * pr * r + f : q * pr * r - f;
  else if (!trade) total = parseNum($('#tAmount').value);
  $('#tTotal').textContent = total != null && !isNaN(total) ? (kind === 'achat' ? 'Total débité : ' : kind === 'vente' ? 'Total crédité : ' : 'Montant : ') + eur(total) : '';
}
function saveTx(id) {
  const kind = $('#tKind').value, assetId = $('#tAsset').value, date = $('#tDate').value;
  const trade = kind === 'achat' || kind === 'vente';
  if (!date) return toast('Indique la date.', 'err');
  if ((trade || kind === 'dividende') && (!assetId || assetId === '__new')) return toast('Choisis le titre concerné.', 'err');
  const a = assetById(assetId);
  const t = { kind, date, assetId: kind === 'depot' || kind === 'retrait' ? null : (assetId || null), note: $('#tNote').value.trim() };
  if (trade) {
    t.qty = parseNum($('#tQty').value); t.price = parseNum($('#tPrice').value);
    t.fees = parseNum($('#tFees').value) || 0; t.tax = parseNum($('#tTax').value) || 0;
    t.fx = a && a.ccy !== 'EUR' ? (parseNum($('#tFx').value) || fx(a.ccy)) : 1;
    if (!(t.qty > 0) || !(t.price > 0)) return toast('Quantité et cours doivent être positifs.', 'err');
    if (kind === 'vente') {
      const held = compute().by[assetId].qty + (id ? (S.tx.find(x => x.id === id).kind === 'vente' ? +S.tx.find(x => x.id === id).qty : 0) : 0);
      if (t.qty > held + 1e-9 && !confirm(`Tu vends ${num(t.qty, 4)} titres mais n'en détiens que ${num(held, 4)} d'après l'app. Continuer ?`)) return;
    }
  } else {
    t.amount = Math.abs(parseNum($('#tAmount').value));
    if (!(t.amount > 0)) return toast('Indique un montant positif.', 'err');
  }
  if (id) Object.assign(S.tx.find(x => x.id === id), t);
  else S.tx.push({ id: uid(), created: Date.now(), ...t });
  if (trade && a && !a.price) { mergeHist(a, [[date, t.price]]); }
  checkAlerts(); save(); renderAll(); gsSoon(); toast(id ? 'Opération modifiée.' : 'Opération ajoutée.');
}

/* ---------------------------- Analyse ---------------------------- */
function renderAnalyse() {
  const c = compute();
  const items = S.assets.filter(a => c.by[a.id].qty > 0 || a.watch).sort((a, b) => (c.by[b.id].value || 0) - (c.by[a.id].value || 0));
  $('#v-analyse').innerHTML = `
    <div class="toolbar"><h3 class="grow" style="margin:0">Analyse des positions et de la liste de surveillance</h3>
      <button class="btn" data-act="newwatch">+ Suivre un titre</button></div>
    <p class="disclaimer">Ces lectures combinent des repères techniques simples (tendance, RSI, recul depuis le sommet) et l'état de ta position. Elles aident à se poser les bonnes questions ; elles ne disent pas quoi faire. Pour un débutant, l'élément le plus important reste la qualité et la diversification de ce que tu achètes, et la durée pendant laquelle tu restes investi.</p>
    <div class="grid3">${items.map(a => {
    const p = c.by[a.id], L = lecture(a, p), I = L.I;
    const rng = I.hi && I.hi > I.lo ? Math.max(0, Math.min(100, (I.last - I.lo) / (I.hi - I.lo) * 100)) : null;
    return `<div class="card acard">
        <h3><span>${esc(nm(a))} <span class="muted small">${esc(a.symbol || '')}</span></span><span class="tag ${p.qty > 0 ? '' : 'warn'}">${p.qty > 0 ? 'En portefeuille' : 'Surveillé'}</span></h3>
        <div><span class="price-big">${money(I.last, a.ccy)}</span> <span class="${cls(p.dayPct)}">${pct(p.dayPct)}</span> <span class="muted small">${a.priceDate ? fmtDate(a.priceDate) : ''}</span></div>
        ${p.qty > 0 ? `<div class="small">PRU ${money(p.pru, a.ccy)} · <span class="${cls(p.latent)}">${sEur(p.latent)} (${pct(p.pctLatent)})</span> · poids ${pctAbs(p.weight)}</div>` : ''}
        <div class="mgrid">
          <div class="m"><div class="l">1 mois</div><div class="v ${cls(I.perf1m)}">${pct(I.perf1m)}</div></div>
          <div class="m"><div class="l">3 mois</div><div class="v ${cls(I.perf3m)}">${pct(I.perf3m)}</div></div>
          <div class="m"><div class="l">1 an</div><div class="v ${cls(I.perf1y)}">${pct(I.perf1y)}</div></div>
          <div class="m"><div class="l">RSI</div><div class="v">${I.rsi != null ? I.rsi.toFixed(0) : '–'}</div></div>
        </div>
        ${rng != null ? `<div class="range"><i style="left:calc(${rng}% - 2px)"></i></div><div class="range-l"><span>bas ${num(I.lo)}</span><span>${I.rangeLabel}</span><span>haut ${num(I.hi)}</span></div>` : ''}
        ${(() => { const mv = bigMoves(a, 5)[0]; return mv ? `<div class="banner ${mv.pct < 0 ? 'warn' : 'info'}" style="margin:8px 0 0;padding:6px 10px">⚡ <b class="${cls(mv.pct)}">${pct(mv.pct)}</b> le ${fmtDate(mv.date)} : mouvement inhabituel <button class="btn sm" data-act="ask" data-id="${a.id}" data-date="${mv.date}">🤖 Pourquoi ?</button></div>` : ''; })()}
        <div style="margin-top:8px"><span class="tag ${L.cls}">${L.label}</span></div>
        <ul class="lect">${L.pts.map(x => `<li class="${x.t}">${x.m}</li>`).join('')}</ul>
        ${a.note ? `<div class="small muted" style="margin-top:6px">📝 ${esc(a.note)}</div>` : ''}
        <div class="toolbar" style="margin:10px 0 0"><button class="btn sm" data-act="asset" data-id="${a.id}">Détail</button><button class="btn sm" data-act="fetchlong" data-id="${a.id}">Long terme</button><button class="btn sm" data-act="newalert" data-id="${a.id}">🔔 Alerte</button><button class="btn sm" data-act="ask" data-id="${a.id}">🤖 Claude</button></div>
      </div>`;
  }).join('') || '<div class="card muted">Aucun titre en portefeuille ni en surveillance.</div>'}</div>`;
}

/* ---------------------------- Alertes (vue) ---------------------------- */
function renderAlerts(pre) {
  const c = compute();
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  $('#v-alertes').innerHTML = `
  <div class="card"><h3>Nouvelle alerte</h3>
    <div class="form-grid">
      <label>Titre<select id="alAsset"><option value="">— choisir —</option>${assetOptions(pre || '')}</select></label>
      <label>Condition<select id="alKind">${opts(ALERT_KINDS, 'prix_inf')}</select></label>
      <label>Seuil<input id="alValue" inputmode="decimal" placeholder="ex. 85 ou 15"></label>
      <label>Note<input id="alNote" placeholder="ex. renforcer si ≤ 85"></label>
    </div>
    <div class="toolbar" style="margin-top:12px"><span class="grow small muted">Les alertes sont vérifiées à chaque actualisation des cours (à l'ouverture de l'app ou via 🔄).</span>
      ${notif === 'default' ? '<button class="btn" data-act="notif">Activer les notifications du navigateur</button>' : notif === 'granted' ? '<span class="tag pos">Notifications actives</span>' : ''}
      <button class="btn primary" data-act="alsave">Créer l'alerte</button></div>
    <p class="hint">Idées pour débuter : « Perte vs PRU ≥ 15 % » (ta perte maximale acceptée), « Gain vs PRU ≥ 30 % » (penser à sécuriser), « Cours ≤ X » pour un prix d'achat visé, « Variation du jour ≥ 5 % » pour être prévenu d'un mouvement brutal.</p>
  </div>
  <div class="card"><h3>Mes alertes (${S.alerts.length})</h3>
    <div class="tbl-wrap"><table><thead><tr><th>Statut</th><th>Titre</th><th>Condition</th><th class="r">Valeur actuelle</th><th>Note</th><th></th></tr></thead>
    <tbody>${S.alerts.map(al => {
    const a = assetById(al.assetId), v = a ? alertCurrent(al, c, a) : null;
    const st = !al.active ? '<span class="tag">En pause</span>' : al.triggeredAt ? `<span class="tag neg">Déclenchée ${fmtDate(al.triggeredAt.slice(0, 10))}</span>` : '<span class="tag pos">Active</span>';
    return `<tr><td>${st}</td><td>${esc(nm(a))}</td><td>${ALERT_KINDS[al.kind]} ${num(al.value)}</td><td class="r">${v != null ? num(v, 2) : '–'}</td><td>${esc(al.note || '')}</td>
        <td class="r">${al.triggeredAt ? `<button class="btn sm" data-act="alrearm" data-id="${al.id}">Réarmer</button>` : ''} <button class="btn sm" data-act="altoggle" data-id="${al.id}">${al.active ? 'Pause' : 'Activer'}</button> <button class="btn sm danger" data-act="aldel" data-id="${al.id}">🗑</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">Aucune alerte.</td></tr>'}</tbody></table></div></div>`;
}
function saveAlert() {
  const assetId = $('#alAsset').value, kind = $('#alKind').value, value = parseNum($('#alValue').value);
  if (!assetId) return toast('Choisis un titre.', 'err');
  if (isNaN(value)) return toast('Indique un seuil.', 'err');
  S.alerts.push({ id: uid(), assetId, kind, value, note: $('#alNote').value.trim(), active: true, created: new Date().toISOString(), triggeredAt: null });
  checkAlerts(); save(); renderAll(); toast('Alerte créée.');
}

/* ---------------------------- Paramètres ---------------------------- */
function renderSettings() {
  const s = S.settings;
  const ccys = [...new Set(['USD', 'GBP', 'CHF', ...S.assets.map(a => a.ccy === 'GBX' ? 'GBP' : a.ccy).filter(x => x && x !== 'EUR')])];
  $('#v-parametres').innerHTML = `
  <div class="card"><h3>Source des cours</h3>
    <div class="form-grid">
      <label>Fournisseur<select id="sProvider">
        <option value="alphavantage" ${s.provider === 'alphavantage' ? 'selected' : ''}>Alpha Vantage — gratuit, Europe + USA, 25 requêtes/jour</option>
        <option value="twelvedata" ${s.provider === 'twelvedata' ? 'selected' : ''}>Twelve Data — gratuit 800/jour, USA uniquement</option></select></label>
      <label>Clé Alpha Vantage<input id="sAv" value="${esc(s.avKey)}" placeholder="colle ta clé ici" autocomplete="off"></label>
      <label>Clé Twelve Data<input id="sTd" value="${esc(s.tdKey)}" placeholder="facultatif" autocomplete="off"></label>
      <label class="chk"><input type="checkbox" id="sAuto" ${s.autoRefresh ? 'checked' : ''}> Actualiser les cours à l'ouverture (si plus de 6 h)</label>
    </div>
    <div class="toolbar" style="margin-top:12px"><button class="btn primary" data-act="ssave">Enregistrer</button><button class="btn" data-act="stest">Tester la clé</button>
      <a class="btn" href="https://www.alphavantage.co/support/#api-key" target="_blank" rel="noopener">Obtenir une clé Alpha Vantage gratuite ↗</a></div>
    <p class="hint">La clé reste dans ce navigateur, jamais dans les fichiers publiés sur GitHub. Avec 25 requêtes par jour, l'app actualise environ 20 titres par jour ; les titres non couverts peuvent passer en « saisie manuelle ».</p>
  </div>
  <div class="card"><h3>⏱️ Cours en continu (relais Google Sheets, gratuit)</h3>
    <p class="small">Met à jour les cours toutes les X minutes tant que l'app est ouverte, sans limite de requêtes. Les cours Google Finance sont en général <b>différés de 15 à 20 minutes</b>. Alpha Vantage reste utile pour l'historique (moyennes, RSI), une fois par jour.</p>
    <div class="form-grid">
      <label class="full">URL du relais (se termine par /exec)<input id="sGsUrl" value="${esc(s.gsUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
      <label>Code d'accès du relais<input id="sGsToken" value="${esc(s.gsToken)}" autocomplete="off"></label>
      <label>Fréquence<select id="sGsEvery">${[[0, 'désactivé'], [5, 'toutes les 5 min'], [10, 'toutes les 10 min'], [15, 'toutes les 15 min'], [30, 'toutes les 30 min']].map(([v, l]) => `<option value="${v}" ${+s.gsEvery === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="toolbar" style="margin-top:12px"><button class="btn primary" data-act="ssave">Enregistrer</button><button class="btn" data-act="gstest">Tester le relais</button><button class="btn" data-act="gsscript">📄 Installer le relais (script à copier)</button>
      <span class="small muted">${s.lastPoll ? 'Dernier relevé : ' + new Date(s.lastPoll).toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
  </div>
  <div class="card"><h3>Taux de change (€ pour 1 unité)</h3>
    <div class="form-grid">${ccys.map(k => `<label>${k}<input data-fx="${k}" value="${num(s.fx[k] || 1, 4)}" inputmode="decimal"></label>`).join('')}</div>
    <div class="toolbar" style="margin-top:12px"><button class="btn" data-act="fxsave">Enregistrer</button><button class="btn" data-act="fxrefresh">Charger les taux BCE du jour</button>
      <span class="small muted">${s.fxDate ? 'Taux BCE du ' + fmtDate(s.fxDate) : 'Taux par défaut'}</span></div>
  </div>
  <div class="card"><h3>🤖 Double sauvegarde — Coffre + Tonio</h3>
    <p class="small">Comme dans tes autres apps : deux sauvegardes dans deux dossiers différents du Drive (sur le PC, dans Chrome ou Edge), réécrites 30 secondes après chaque modification et toutes les 5 minutes si quelque chose a changé (cours compris), avec des copies datées sur 30 jours.</p>
    <div class="grid2">
      <div class="m" style="padding:12px"><b>🤖 Tonio</b> — dossier <code>Tonio</code>, lisible par Tonio
        <div class="small" style="margin:6px 0">Chiffres globaux (valeur, plus-value, répartitions), <b>noms</b> des actions et ETF détenus et surveillés avec leurs % (poids, variation, lecture), alertes et mouvements inhabituels. <b>Jamais</b> : quantités, prix d'achat, montants par ligne, opérations, notes, clés.</div>
        <button class="btn sm" data-act="tonioDir">📁 Choisir le dossier Tonio</button> <button class="btn sm" data-act="tonioDl">⬇️ Voir le JSON</button>
        <div class="small muted" id="tonioStatus" style="margin-top:6px"></div></div>
      <div class="m" style="padding:12px"><b>🔒 Coffre</b> — dossier <code>Coffre</code>, jamais partagé
        <div class="small" style="margin:6px 0">Toutes les données de l'app (titres, opérations, alertes, historique des cours, réglages et clés), <b>chiffrées AES-256</b> avec ton code. Le code n'est jamais enregistré : à saisir une fois à chaque ouverture de l'app.</div>
        <button class="btn sm" data-act="coffreDir">📁 Choisir le dossier Coffre</button>
        ${!s.coffre ? '<button class="btn sm" data-act="coffreCode">🔑 Créer le code</button>' : coffreKey ? '' : '<button class="btn sm" data-act="coffreUnlock">🔓 Déverrouiller</button>'}
        <label class="btn sm">⬆️ Restaurer depuis le Coffre<input type="file" id="coffreFile" accept=".mpcoffre" hidden></label>
        <div class="small muted" id="coffreStatus" style="margin-top:6px"></div></div>
    </div>
    <div class="toolbar" style="margin-top:12px"><button class="btn primary" data-act="saveall">💾 Sauvegarder maintenant (Coffre + Tonio)</button>
      <label class="small"><input type="checkbox" id="sAutoTonio" ${s.autoTonio ? 'checked' : ''}> sauvegarde automatique (après chaque modification et toutes les 5 min)</label></div>
    <div class="form-grid" style="margin-top:10px"><label class="full">Lien vers ton projet Claude (boutons « 🤖 Analyser avec Claude »)<input id="sClaudeUrl" value="${esc(s.claudeUrl || '')}" placeholder="https://claude.ai/project/… (sinon : nouvelle conversation)"></label></div>
  </div>
  <div class="card"><h3>Sauvegarde complète</h3>
    <p class="small">Les données sont stockées dans ce navigateur, sur cet appareil. Pour les retrouver sur un autre appareil ou après un nettoyage du navigateur, télécharge une sauvegarde et réimporte-la.</p>
    <div class="toolbar"><button class="btn primary" data-act="backup">⬇️ Télécharger la sauvegarde</button>
      <label class="btn">⬆️ Restaurer une sauvegarde<input type="file" id="restoreFile" accept=".json,application/json" hidden></label>
      <button class="btn" data-act="demo">Charger un exemple</button>
      <button class="btn danger" data-act="reset">Tout effacer</button></div>
    <p class="small muted">${S.assets.length} titre(s) · ${S.tx.length} opération(s) · ${S.alerts.length} alerte(s) · ${APP_VERSION}</p>
  </div>`;
  renderTonioStatus();
}
function saveSettings() {
  S.settings.provider = $('#sProvider').value;
  S.settings.avKey = $('#sAv').value.trim();
  S.settings.tdKey = $('#sTd').value.trim();
  S.settings.autoRefresh = $('#sAuto').checked;
  S.settings.autoTonio = $('#sAutoTonio').checked;
  S.settings.claudeUrl = $('#sClaudeUrl').value.trim();
  S.settings.gsUrl = $('#sGsUrl').value.trim();
  S.settings.gsToken = $('#sGsToken').value.trim();
  S.settings.gsEvery = +$('#sGsEvery').value;
  save(); setupPolling(); toast('Paramètres enregistrés.');
}
async function testKey() {
  saveSettings();
  try {
    if (S.settings.provider === 'twelvedata') { const j = await td('price', { symbol: 'AAPL' }); toast('✅ Clé Twelve Data valide (AAPL : ' + j.price + ' USD).'); }
    else { const j = await av('GLOBAL_QUOTE', { symbol: 'IBM' }); const q = j['Global Quote'] || {}; toast('✅ Clé Alpha Vantage valide (IBM : ' + (q['05. price'] || '?') + ' USD).'); }
  } catch (e) { toast('Test échoué : ' + explainErr(e) + (e.message.includes(':') ? ' — ' + e.message.split(':').slice(1).join(':').slice(0, 160) : ''), 'err'); }
}

/* ---------------------------- Export Tonio ---------------------------- */
function buildTonio() {
  const c = compute(), now = new Date(), from = addDays(today(), -90), yr = String(now.getFullYear());
  const records = [];
  c.open.forEach(p => {
    const a = p.asset, L = lecture(a, p);
    records.push({
      id: 'pos-' + a.id, type: 'position', title: nm(a), date: a.priceDate || null, status: p.latent >= 0 ? 'gain' : 'perte',
      amount: null, currency: a.ccy, category: CLASSES[assetClass(a)], tags: [a.sector, a.region].filter(Boolean),
      data: {
        symbole: a.symbol || null, isin: a.isin || null, classe_actif: CLASSES[assetClass(a)], instrument: TYPES[a.type] || null,
        region: a.region || null, secteur: a.sector || null, devise: a.ccy, poids: r4(p.weight),
        plus_value_latente_pct: r4(p.pctLatent), variation_jour_pct: p.dayPct != null ? r4(p.dayPct) : null,
        perf_1m: r4(L.I.perf1m), perf_3m: r4(L.I.perf3m), rsi: L.I.rsi != null ? r2(L.I.rsi) : null,
        lecture: L.label, points: L.pts.map(x => x.m.replace(/<[^>]+>/g, ''))
      }
    });
  });
  S.assets.filter(a => a.watch && !(c.by[a.id].qty > 0)).forEach(a => {
    const L = lecture(a, null);
    records.push({ id: 'watch-' + a.id, type: 'surveillance', title: nm(a), date: a.priceDate || null, status: 'surveille', amount: null, currency: a.ccy, category: TYPES[a.type] || 'Autre', tags: [], data: { symbole: a.symbol, cours: a.price ?? null, lecture: L.label, points: L.pts.map(x => x.m) } });
  });
  S.alerts.forEach(al => {
    const a = assetById(al.assetId);
    records.push({ id: 'alert-' + al.id, type: 'alerte', title: alertText(al), date: al.triggeredAt ? al.triggeredAt.slice(0, 10) : null, status: !al.active ? 'inactive' : al.triggeredAt ? 'declenchee' : 'active', amount: null, currency: 'EUR', category: 'Alerte', tags: [], data: { symbole: a ? a.symbol : null, condition: al.kind, seuil: al.value, valeur_actuelle: a ? r2(alertCurrent(al, c, a)) : null } });
  });
  S.assets.filter(a => c.by[a.id].qty > 0 || a.watch).forEach(a => bigMoves(a, 30).forEach(m => records.push({ id: 'move-' + a.id + '-' + m.date, type: 'mouvement', title: `${nm(a)} ${pct(m.pct)}`, date: m.date, status: m.pct < 0 ? 'baisse' : 'hausse', amount: null, currency: a.ccy, category: 'Mouvement inhabituel', tags: [], data: { symbole: a.symbol || null, isin: a.isin || null, variation_pct: r4(m.pct), cloture: m.price, variation_habituelle_pct: r4(m.usual), en_portefeuille: c.by[a.id].qty > 0 } })));
  const trig = S.alerts.filter(a => a.active && a.triggeredAt).length;
  const ry = c.realizedYear[yr] || 0;
  const oldest = c.open.map(p => p.asset.priceDate).filter(Boolean).sort()[0] || null;
  return {
    tonio_format: '1.0', app: 'bourse', app_version: APP_VERSION, exported_at: localISO(now),
    period: { from, to: today() },
    summary: `Portefeuille de ${eur(c.T.value)} sur ${c.open.length} ligne(s), plus-value latente ${sEur(c.T.latent)} (${pct(c.T.pctLatent)}), ${trig} alerte(s) déclenchée(s).`,
    metrics: {
      repartition: Object.fromEntries(['classe', 'type', 'region', 'secteur', 'devise'].map(d => [d, Object.fromEntries(breakdown(c, d).arr.map(x => [x.key, r4(x.pct)]))])),
      valeur_totale: r2(c.T.value), investi: r2(c.T.cost), plus_value_latente: r2(c.T.latent), plus_value_latente_pct: r4(c.T.pctLatent),
      variation_jour: r2(c.T.day), plus_value_realisee: r2(c.T.realized), plus_value_realisee_annee: r2(ry),
      exoneration_plus_values_restante: r2(Math.max(0, CG_EXEMPTION - Math.max(0, ry))), dividendes: r2(c.T.divs),
      liquidites: c.hasCash ? r2(c.cash) : null, nb_positions: c.open.length, alertes_declenchees: trig, cours_le_plus_ancien: oldest
    },
    records, excluded: { private_items: S.tx.length }
  };
}
const IDB = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('mon_portefeuille_fs', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('h').objectStore('h').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('h', 'readwrite').objectStore('h').put(v, k); q.onsuccess = () => res(); q.onerror = () => rej(q.error); }); }
};
/* ---------- Double sauvegarde : Tonio (lisible, données globales) + Coffre (complète, chiffrée) ---------- */
let tonioDir = null, coffreDir = null, coffreKey = null, saveTimer = null, dirty = false, savePaused = '';
const CF_IT = 300000, CF_TEMOIN = 'mon-portefeuille-ok';
const b64e = buf => { let x = ''; new Uint8Array(buf).forEach(c => x += String.fromCharCode(c)); return btoa(x); };
const b64d = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
async function cfDerive(code, salt, it) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64d(salt), iterations: it || CF_IT, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function cfEncrypt(key, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)); return { iv: b64e(iv), ct: b64e(ct) }; }
async function cfDecrypt(key, iv, ct) { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(iv) }, key, b64d(ct))); }

function renderTonioStatus() {
  const s = S.settings, t = $('#tonioStatus'), c = $('#coffreStatus');
  if (t) t.textContent = (tonioDir ? '📁 ' + tonioDir.name + '/bourse' : '📁 aucun dossier choisi') + (s.lastTonio ? ' · dernière sauvegarde : ' + new Date(s.lastTonio).toLocaleString('fr-BE') : '');
  if (c) c.textContent = (coffreDir ? '📁 ' + coffreDir.name + '/bourse' : '📁 aucun dossier choisi') + ' · ' + (!s.coffre ? '🔑 code non défini' : coffreKey ? '🔓 déverrouillé pour cette session' : '🔒 verrouillé') + (s.lastCoffre ? ' · dernière sauvegarde : ' + new Date(s.lastCoffre).toLocaleString('fr-BE') : '');
  const bn = $('#saveBanner');
  if (bn) { bn.classList.toggle('hidden', !savePaused); bn.querySelector('span').textContent = savePaused; }
}
function scheduleSave() {
  if (!S.settings.autoTonio) return;
  clearTimeout(saveTimer); saveTimer = setTimeout(() => saveAll(false), 30000);
}
setInterval(() => { if (dirty && S.settings.autoTonio) saveAll(false); }, 5 * 60000);
function download(name, text) {
  const b = new Blob([text], { type: 'application/json' }), u = URL.createObjectURL(b), l = document.createElement('a');
  l.href = u; l.download = name; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000);
}
async function pickDir(kind) {
  if (!window.showDirectoryPicker) { toast('Ce navigateur ne permet pas d\'écrire dans un dossier : utilise Chrome ou Edge sur le PC.', 'err'); return null; }
  try {
    const h = await window.showDirectoryPicker({ id: kind, mode: 'readwrite' });
    const other = kind === 'tonio' ? coffreDir : tonioDir;
    if (other && await h.isSameEntry(other)) { toast('Le Coffre et Tonio doivent être deux dossiers différents.', 'err'); return null; }
    if (kind === 'tonio' && /coffre/i.test(h.name)) { toast('Ce dossier s\'appelle « ' + h.name + ' » : l\'export Tonio ne doit jamais aller dans le Coffre. Choisis le dossier Tonio.', 'err'); return null; }
    if (kind === 'coffre' && /tonio/i.test(h.name)) { toast('Ce dossier s\'appelle « ' + h.name + ' » : Tonio pourrait lire le Coffre. Choisis le dossier Coffre.', 'err'); return null; }
    if (kind === 'coffre' && !/coffre/i.test(h.name) && !confirm('Ce dossier s\'appelle « ' + h.name + ' ». Est-ce bien ton Coffre (non partagé avec Tonio) ?')) return null;
    await IDB.set(kind + 'Dir', h);
    return h;
  } catch (e) { if (e.name !== 'AbortError') toast('Erreur : ' + e.message, 'err'); return null; }
}
async function chooseTonioDir() { const h = await pickDir('tonio'); if (h) { tonioDir = h; await saveTonio(true); renderTonioStatus(); } }
async function chooseCoffreDir() { const h = await pickDir('coffre'); if (h) { coffreDir = h; renderTonioStatus(); await saveCoffre(true); } }
async function writeFile(dir, name, text) { const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(text); await w.close(); }
async function subDir(dir, manual) {
  let perm = await dir.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') { if (!manual) return null; perm = await dir.requestPermission({ mode: 'readwrite' }); if (perm !== 'granted') { toast('Accès au dossier refusé.', 'err'); return null; } }
  return dir.name.toLowerCase() === 'bourse' ? dir : dir.getDirectoryHandle('bourse', { create: true });
}
async function writeWithHistory(sub, prefix, ext, text) {
  await writeFile(sub, `${prefix}_latest.${ext}`, text);
  await writeFile(sub, `${prefix}_${today()}.${ext}`, text);
  const limit = addDays(today(), -30), re = new RegExp('^' + prefix + '_(\\d{4}-\\d{2}-\\d{2})\\.' + ext + '$');
  for await (const [name] of sub.entries()) { const m = name.match(re); if (m && m[1] < limit) await sub.removeEntry(name); }
}
/* Tonio : chiffres globaux + noms des titres, sans quantités ni montants par ligne ni opérations */
async function saveTonio(manual) {
  if (!tonioDir) { if (manual) await chooseTonioDir(); return 'Tonio : dossier non choisi'; }
  try {
    const sub = await subDir(tonioDir, manual); if (!sub) return 'Tonio : autorisation du dossier à renouveler';
    await writeWithHistory(sub, 'bourse', 'json', JSON.stringify(buildTonio(), null, 2));
    S.settings.lastTonio = new Date().toISOString(); persist(); renderTonioStatus();
    if (manual) toast('✅ Sauvegarde Tonio écrite dans ' + tonioDir.name + '/bourse.');
    return '';
  } catch (e) { toast('Sauvegarde Tonio impossible : ' + e.message, 'err'); return 'Tonio : erreur'; }
}
/* Coffre : toutes les données de l'app (clés comprises), chiffrées AES-256 avec ton code */
async function saveCoffre(manual) {
  if (!coffreDir) { if (manual) await chooseCoffreDir(); return 'Coffre : dossier non choisi'; }
  if (!S.settings.coffre) { if (manual) coffreModal('create'); return 'Coffre : code à définir'; }
  if (!coffreKey) { if (manual) coffreModal('unlock'); return 'Coffre verrouillé : saisis ton code'; }
  try {
    const sub = await subDir(coffreDir, manual); if (!sub) return 'Coffre : autorisation du dossier à renouveler';
    const { iv, ct } = await cfEncrypt(coffreKey, JSON.stringify(S));
    const file = JSON.stringify({ format: 'mon-portefeuille-coffre', version: 1, app_version: APP_VERSION, saved_at: localISO(new Date()), salt: S.settings.coffre.salt, it: S.settings.coffre.it || CF_IT, iv, ct });
    await writeWithHistory(sub, 'portefeuille_coffre', 'mpcoffre', file);
    S.settings.lastCoffre = new Date().toISOString(); persist(); renderTonioStatus();
    if (manual) toast('✅ Sauvegarde chiffrée écrite dans ' + coffreDir.name + '/bourse.');
    return '';
  } catch (e) { toast('Sauvegarde Coffre impossible : ' + e.message, 'err'); return 'Coffre : erreur'; }
}
async function saveAll(manual) {
  const r = [await saveTonio(manual), await saveCoffre(manual)].filter(Boolean);
  savePaused = r.length ? '💾 Sauvegarde automatique en pause — ' + r.join(' · ') : '';
  if (!r.length) dirty = false;
  renderTonioStatus();
}
function coffreModal(mode) {
  const create = mode === 'create';
  openModal(`<h2>🔒 ${create ? 'Créer le code du Coffre' : mode === 'restore' ? 'Code de cette sauvegarde' : 'Déverrouiller le Coffre'}</h2>
    <p class="small">${create ? 'Ce code chiffre la sauvegarde complète. Il n\'est jamais enregistré : seul un témoin chiffré permet de vérifier qu\'il est juste. <b>Sans lui, la sauvegarde du Coffre est illisible</b> : note-le dans ton gestionnaire de mots de passe.' : 'Le code reste en mémoire jusqu\'à la fermeture de l\'app, pour les sauvegardes automatiques.'}</p>
    <div class="form-grid"><label>Code<input type="password" id="cf1" autocomplete="off"></label>${create ? '<label>Confirme le code<input type="password" id="cf2" autocomplete="off"></label>' : ''}</div>
    <div class="modal-actions"><button class="btn primary" data-act="coffreok" data-mode="${mode}">Valider</button><button class="btn" data-act="closemodal">Annuler</button></div>
    <p class="hint" id="cfMsg"></p>`, () => $('#cf1').focus());
}
let pendingRestore = null;
async function coffreOk(mode) {
  const code = $('#cf1').value, msg = t => $('#cfMsg').textContent = t;
  if (!window.crypto || !crypto.subtle) return msg('Chiffrement indisponible dans ce navigateur.');
  try {
    if (mode === 'create') {
      if (code.length < 8) return msg('Au moins 8 caractères.');
      if (code !== $('#cf2').value) return msg('Les deux codes sont différents.');
      const salt = b64e(crypto.getRandomValues(new Uint8Array(16)));
      msg('Création…'); const key = await cfDerive(code, salt, CF_IT);
      S.settings.coffre = { salt, it: CF_IT, ...(await cfEncrypt(key, CF_TEMOIN)) }; coffreKey = key; persist();
      closeModal(); renderAll(); await saveAll(true); return;
    }
    if (mode === 'unlock') {
      const c = S.settings.coffre; msg('Vérification…');
      const key = await cfDerive(code, c.salt, c.it);
      if (await cfDecrypt(key, c.iv, c.ct).catch(() => null) !== CF_TEMOIN) return msg('Code incorrect.');
      coffreKey = key; closeModal(); renderAll(); await saveAll(true); return;
    }
    if (mode === 'restore') {
      const f = pendingRestore; msg('Déchiffrement…');
      const key = await cfDerive(code, f.salt, f.it);
      const txt = await cfDecrypt(key, f.iv, f.ct).catch(() => null);
      if (!txt) return msg('Code incorrect pour cette sauvegarde.');
      const d = JSON.parse(txt);
      if (!confirm(`Restaurer la sauvegarde du ${f.saved_at ? new Date(f.saved_at).toLocaleString('fr-BE') : '?'} : ${d.assets.length} titre(s), ${d.tx.length} opération(s) ? Les données actuelles seront remplacées.`)) return;
      const def = defaultState();
      S = { ...def, ...d, settings: { ...def.settings, ...(d.settings || {}) } };
      if (S.settings.coffre && S.settings.coffre.salt === f.salt) coffreKey = key;
      pendingRestore = null; checkAlerts(); save(); closeModal(); showTab('overview'); toast('✅ Sauvegarde du Coffre restaurée.');
    }
  } catch (e) { msg('Erreur : ' + e.message); }
}
async function restoreCoffre(file) {
  try {
    const f = JSON.parse(await file.text());
    if (f.format !== 'mon-portefeuille-coffre') throw new Error('ce n\'est pas une sauvegarde du Coffre de Mon Portefeuille');
    pendingRestore = f; coffreModal('restore');
  } catch (e) { toast('Fichier invalide : ' + e.message, 'err'); }
}

/* ---------------------------- Import CSV ---------------------------- */
const MAP_FIELDS = [
  ['date', 'Date', /date|datum|jour|ex[ée]cution|transactiedatum/i],
  ['kind', 'Type d\'opération', /^type|op[ée]ration|sens|transaction|verrichting|soort|nature|mouvement/i],
  ['symbol', 'Symbole / code', /symbo|ticker|mn[ée]mo|^code/i],
  ['isin', 'ISIN', /isin/i],
  ['name', 'Nom du titre', /^nom|naam|name|libell|descri|omschrijving|produit|product|titre|instrument|valeur|fonds|security/i],
  ['qty', 'Quantité', /quantit|qt[ée]|aantal|quantity|nombre|stuks|nominal/i],
  ['price', 'Cours / prix unitaire', /cours|prix|koers|price|unit/i],
  ['ccy', 'Devise', /devise|munt|currency|valuta|ccy/i],
  ['fees', 'Frais / courtage', /frais|courtage|kosten|commission|fee|makel/i],
  ['tax', 'Taxes (TOB, précompte)', /tax|tob|beurs|bours|pr[ée]compte|roerende|withholding/i],
  ['amount', 'Montant net (€)', /montant|bedrag|amount|net|total/i]
];
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 15);
  let sep = ';', best = -1;
  [';', ',', '\t', '|'].forEach(c => { const n = firstLines.reduce((s, l) => s + l.split(c).length, 0); if (n > best) { best = n; sep = c; } });
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x !== ''));
}
function parseDate(s) {
  s = String(s || '').trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))) { let y = m[3]; if (y.length === 2) y = '20' + y; return `${y}-${pad(m[2])}-${pad(m[1])}`; }
  return null;
}
function guessKind(s, qty, amount) {
  s = (s || '').toLowerCase();
  if (/achat|buy|aankoop|koop|souscri|purchase/.test(s)) return 'achat';
  if (/vente|sell|verkoop|sale|rembours/.test(s)) return 'vente';
  if (/divid|coupon/.test(s)) return 'dividende';
  if (/d[ée]p[oô]t|versement|storting|deposit/.test(s)) return 'depot';
  if (/retrait|opname|withdraw/.test(s)) return 'retrait';
  if (/frais|droit|kosten|fee|garde/.test(s)) return 'frais';
  if (!isNaN(qty) && qty !== 0) return qty > 0 ? 'achat' : 'vente';
  return null;
}
function guessType(name) { return /\b(gold|or physique|silver|argent|etc|etn)\b/i.test(name || '') ? 'etc' : /etf|ucits|tracker|ishares|vanguard|xtrackers|amundi|spdr|lyxor|invesco/i.test(name || '') ? 'etf' : 'action'; }
function headerRow(rows) {
  let bi = 0, bs = -1;
  rows.slice(0, 12).forEach((r, i) => { const s = r.filter(x => x && isNaN(parseNum(x))).length * 2 + MAP_FIELDS.filter(([, , re]) => r.some(h => re.test(h))).length * 3; if (s > bs) { bs = s; bi = i; } });
  return bi;
}
async function startImport(file) {
  const buf = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
  const rows = parseCSV(text);
  if (rows.length < 2) return toast('Fichier vide ou illisible.', 'err');
  const h = headerRow(rows);
  importCtx = { rows, h, map: {} };
  autoMap();
  renderImport();
}
function autoMap() {
  const hdr = importCtx.rows[importCtx.h] || [], used = new Set(); importCtx.map = {};
  MAP_FIELDS.forEach(([k, , re]) => { const i = hdr.findIndex((x, j) => !used.has(j) && re.test(x)); if (i > -1) { importCtx.map[k] = i; used.add(i); } });
}
function importRows() {
  const { rows, h, map } = importCtx, out = [];
  const g = (r, k) => map[k] != null ? r[map[k]] : '';
  rows.slice(h + 1).forEach((r, idx) => {
    const qtyRaw = parseNum(g(r, 'qty')), amountRaw = parseNum(g(r, 'amount'));
    const it = {
      line: h + 2 + idx, date: parseDate(g(r, 'date')), kind: guessKind(g(r, 'kind'), qtyRaw, amountRaw),
      symbol: g(r, 'symbol').toUpperCase(), isin: g(r, 'isin').toUpperCase(), name: g(r, 'name'), ccy: (g(r, 'ccy') || 'EUR').toUpperCase().slice(0, 3),
      qty: Math.abs(qtyRaw), price: Math.abs(parseNum(g(r, 'price'))), fees: Math.abs(parseNum(g(r, 'fees'))) || 0, tax: Math.abs(parseNum(g(r, 'tax'))) || 0, amount: Math.abs(amountRaw)
    };
    if (!CCYS.includes(it.ccy)) it.ccy = 'EUR';
    const trade = it.kind === 'achat' || it.kind === 'vente';
    if (trade && !(it.price > 0) && it.amount > 0 && it.qty > 0) it.price = (it.kind === 'achat' ? it.amount - it.fees - it.tax : it.amount + it.fees + it.tax) / it.qty;
    it.err = !it.date ? 'date illisible' : !it.kind ? 'type inconnu' : trade && !(it.qty > 0 && it.price > 0) ? 'quantité ou cours manquant' : !trade && !(it.amount > 0) ? 'montant manquant' : (trade || it.kind === 'dividende') && !(it.symbol || it.isin || it.name) ? 'titre manquant' : '';
    out.push(it);
  });
  return out;
}
function renderImport() {
  const { rows, h, map } = importCtx, hdr = rows[h] || [];
  const items = importRows(), ok = items.filter(x => !x.err);
  openModal(`<h2>📥 Importer un CSV</h2>
    <p class="small">Dans Keytrade, exporte l'historique de tes opérations (ou de ton portefeuille) au format CSV/Excel, puis vérifie ci-dessous à quelle colonne correspond chaque information.</p>
    <div class="form-grid">
      <label>Ligne d'en-tête<select id="imH">${rows.slice(0, 12).map((r, i) => `<option value="${i}" ${i === h ? 'selected' : ''}>Ligne ${i + 1} : ${esc(r.slice(0, 4).join(' | ').slice(0, 60))}</option>`).join('')}</select></label>
      ${MAP_FIELDS.map(([k, l]) => `<label>${l}<select data-map="${k}"><option value="">—</option>${hdr.map((x, i) => `<option value="${i}" ${map[k] === i ? 'selected' : ''}>${esc(x || 'colonne ' + (i + 1))}</option>`).join('')}</select></label>`).join('')}
    </div>
    <p class="small"><b>${ok.length}</b> opération(s) reconnue(s) sur ${items.length} ligne(s). Les lignes en rouge seront ignorées.</p>
    <div class="preview"><table><thead><tr><th>L.</th><th>Date</th><th>Type</th><th>Titre</th><th class="r">Qté</th><th class="r">Cours</th><th class="r">Frais+taxes</th><th class="r">Montant</th><th>Problème</th></tr></thead>
    <tbody>${items.slice(0, 200).map(x => `<tr class="${x.err ? 'err-row' : ''}"><td>${x.line}</td><td>${fmtDate(x.date)}</td><td>${KINDS[x.kind] || '?'}</td><td>${esc(x.name || x.symbol || x.isin)}</td><td class="r">${x.qty ? num(x.qty, 4) : ''}</td><td class="r">${x.price ? num(x.price) : ''}</td><td class="r">${num(x.fees + x.tax, 2)}</td><td class="r">${x.amount ? num(x.amount, 2) : ''}</td><td>${x.err}</td></tr>`).join('')}</tbody></table></div>
    <div class="modal-actions"><button class="btn primary" data-act="importgo" ${ok.length ? '' : 'disabled'}>Importer ${ok.length} opération(s)</button><button class="btn" data-act="closemodal">Annuler</button></div>
    <p class="hint">Les titres inconnus sont créés automatiquement en « cours saisis à la main » : ouvre-les ensuite pour indiquer le symbole (🔎) et activer les cours automatiques. Les doublons (même date, titre, type, quantité et cours) sont ignorés.</p>`);
}
function doImport() {
  const items = importRows().filter(x => !x.err);
  let added = 0, dup = 0, newAssets = 0;
  const findAsset = it => S.assets.find(a => (it.isin && a.isin === it.isin) || (it.symbol && a.symbol === it.symbol)) || (it.name ? S.assets.find(a => a.name && a.name.toLowerCase() === it.name.toLowerCase()) : null);
  for (const it of items) {
    let a = null;
    if (it.kind !== 'depot' && it.kind !== 'retrait') {
      a = findAsset(it);
      if (!a && (it.symbol || it.isin || it.name)) {
        a = { id: uid(), created: Date.now(), symbol: it.symbol, name: it.name || it.symbol || it.isin, isin: it.isin, type: guessType(it.name), ccy: it.ccy, sector: guessType(it.name) === 'etf' ? 'Diversifié (ETF)' : '', region: '', source: 'manuel', watch: false, note: '', hist: [] };
        S.assets.push(a); newAssets++;
      }
    }
    const t = { kind: it.kind, date: it.date, assetId: a ? a.id : null, note: 'import CSV' };
    if (it.kind === 'achat' || it.kind === 'vente') Object.assign(t, { qty: it.qty, price: it.price, fees: it.fees, tax: it.tax, fx: a && a.ccy !== 'EUR' ? fx(a.ccy) : 1 });
    else t.amount = it.amount;
    const key = x => [x.date, x.assetId, x.kind, r4(x.qty || 0), r4(x.price || 0), r2(x.amount || 0)].join('|');
    if (S.tx.some(x => key(x) === key(t))) { dup++; continue; }
    S.tx.push({ id: uid(), created: Date.now() + added, ...t }); added++;
    if (a && (t.kind === 'achat' || t.kind === 'vente') && (!a.priceDate || a.priceDate <= t.date) && a.source === 'manuel') mergeHist(a, [[t.date, t.price]]);
  }
  save(); closeModal(); importCtx = null; renderAll();
  toast(`✅ ${added} opération(s) importée(s)` + (dup ? `, ${dup} doublon(s) ignoré(s)` : '') + (newAssets ? `, ${newAssets} titre(s) créé(s) : ajoute leur symbole pour les cours automatiques.` : '.'));
}

/* ---------------------------- Démo & sauvegardes ---------------------------- */
function loadDemo() {
  if ((S.assets.length || S.tx.length) && !confirm('Charger l\'exemple remplacera tes données actuelles. Continuer ?')) return;
  const d = defaultState(); d.settings = { ...S.settings };
  const mk = (sym, name, type, ccy, sector, region, start, drift, vol, seed) => {
    const a = { id: uid() + seed, created: Date.now(), symbol: sym, name, isin: '', type, ccy, sector, region, source: 'manuel', watch: false, note: '', hist: [] };
    let p = start, x = seed * 9301 + 49297; const rnd = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
    for (let i = 300; i >= 0; i--) { const dt = addDays(today(), -i); const wd = new Date(dt + 'T12:00:00').getDay(); if (wd === 0 || wd === 6) continue; const o = p; p *= 1 + drift + (rnd() - 0.5) * vol + (rnd() < 0.015 ? (rnd() - 0.5) * 0.16 : 0); a.hist.push([dt, r2(p), r2(o), r2(Math.max(o, p) * (1 + rnd() * vol / 3)), r2(Math.min(o, p) * (1 - rnd() * vol / 3))]); }
    const n = a.hist.length; a.price = a.hist[n - 1][1]; a.priceDate = a.hist[n - 1][0]; a.prevClose = a.hist[n - 2][1];
    return a;
  };
  const w = mk('IWDA.AMS', 'iShares Core MSCI World (exemple)', 'etf', 'EUR', 'Diversifié (ETF)', 'Monde', 88, 0.0005, 0.02, 1);
  const s = mk('ABI.BRU', 'AB InBev (exemple)', 'action', 'EUR', 'Consommation', 'Belgique', 58, -0.0004, 0.035, 2);
  const m = mk('MSFT', 'Microsoft (exemple)', 'action', 'USD', 'Technologie', 'États-Unis', 410, 0.0006, 0.03, 3);
  w.note = 'Socle diversifié, achat mensuel'; s.note = 'Rendement + marque forte'; m.note = 'Cloud et IA';
  const v = mk('SOLB.BRU', 'Solvay (exemple, surveillé)', 'action', 'EUR', 'Matériaux', 'Belgique', 30, 0.0002, 0.04, 4); v.watch = true;
  const g = mk('4GLD.DEX', 'Xetra-Gold (exemple)', 'etc', 'EUR', 'Or & métaux', 'Monde', 95, 0.0007, 0.02, 5); g.note = 'Protection, 5 à 10 % du portefeuille';
  w.regionSplit = 'États-Unis 71; Europe 13; Japon 5; Royaume-Uni 3; Canada 3; Autres 5';
  w.sectorSplit = 'Technologie 26; Finance 16; Santé 10; Industrie 11; Consommation 15; Énergie 4; Autres 18';
  d.assets = [w, s, m, v, g];
  const px = (a, i) => a.hist[i][1];
  d.tx = [
    { id: uid() + 'a', created: 1, kind: 'depot', date: w.hist[5][0], amount: 10000, assetId: null },
    { id: uid() + 'b', created: 2, kind: 'achat', date: w.hist[10][0], assetId: w.id, qty: 40, price: px(w, 10), fees: 7.5, tax: r2(40 * px(w, 10) * 0.0012), fx: 1 },
    { id: uid() + 'c', created: 3, kind: 'achat', date: s.hist[40][0], assetId: s.id, qty: 30, price: px(s, 40), fees: 7.5, tax: r2(30 * px(s, 40) * 0.0035), fx: 1 },
    { id: uid() + 'd', created: 4, kind: 'achat', date: m.hist[60][0], assetId: m.id, qty: 5, price: px(m, 60), fees: 14.95, tax: r2(5 * px(m, 60) * 0.92 * 0.0035), fx: 0.92 },
    { id: uid() + 'e', created: 5, kind: 'achat', date: w.hist[120][0], assetId: w.id, qty: 15, price: px(w, 120), fees: 7.5, tax: r2(15 * px(w, 120) * 0.0012), fx: 1 },
    { id: uid() + 'h', created: 8, kind: 'achat', date: g.hist[90][0], assetId: g.id, qty: 6, price: g.hist[90][1], fees: 7.5, tax: 0, fx: 1 },
    { id: uid() + 'f', created: 6, kind: 'dividende', date: s.hist[150][0], assetId: s.id, amount: 21 },
    { id: uid() + 'g', created: 7, kind: 'vente', date: m.hist[180][0], assetId: m.id, qty: 2, price: px(m, 180), fees: 14.95, tax: r2(2 * px(m, 180) * 0.92 * 0.0035), fx: 0.92 }
  ];
  d.alerts = [
    { id: uid() + 'x', assetId: s.id, kind: 'perte_pct', value: 15, note: 'perte max acceptée', active: true, created: new Date().toISOString(), triggeredAt: null },
    { id: uid() + 'y', assetId: v.id, kind: 'prix_inf', value: 25, note: 'prix d\'achat visé', active: true, created: new Date().toISOString(), triggeredAt: null }
  ];
  S = d; checkAlerts(); save(); showTab('overview'); toast('Exemple chargé (données fictives). « Tout effacer » dans ⚙️ Paramètres pour repartir de zéro.');
}

/* ---------------------------- Événements ---------------------------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) { if (e.target.id === 'modal') closeModal(); return; }
  if (b.tagName === 'A' && b.getAttribute('href') === '#') e.preventDefault();
  const act = b.dataset.act, id = b.dataset.id;
  switch (act) {
    case 'tab': closeModal(); showTab(b.dataset.tab); break;
    case 'refresh': if (S.settings.gsUrl) pollQuotes(true); refreshPrices(!!(S.settings.avKey || S.settings.tdKey) || !S.settings.gsUrl); break;
    case 'gsscript': showGsScript(); break;
    case 'chtr': S.settings.chartTabRange = b.dataset.v; persist(); renderCharts(); break;
    case 'chtm': S.settings.chartTabMode = b.dataset.v; persist(); renderCharts(); break;
    case 'chsearch': {
      const q = $('#chSym').value.trim(); if (!q) return toast('Tape un nom ou un symbole.', 'err');
      $('#chResults').innerHTML = '<span class="small muted">Recherche…</span>';
      try {
        const res = await searchSymbol(q);
        $('#chResults').innerHTML = res.length ? res.slice(0, 12).map(r => `<button type="button" data-act="chpick" data-sym="${esc(r.symbol)}" data-name="${esc(r.name)}" data-ccy="${esc(r.ccy)}"><b>${esc(r.symbol)}</b> — ${esc(r.name)} <span class="muted">· ${esc(r.exch)} · ${esc(r.ccy)} · ${esc(r.type)}</span></button>`).join('') : '<span class="small muted">Aucun résultat. Essaie le nom anglais, ou directement le symbole.</span>';
      } catch (err) { $('#chResults').innerHTML = `<span class="small neg">Recherche impossible : ${esc(explainErr(err))}</span>`; }
      break;
    }
    case 'chpick': S.settings.chartSel = { sym: b.dataset.sym, name: b.dataset.name, ccy: (b.dataset.ccy || '').toUpperCase() }; persist(); renderCharts(); break;
    case 'chwatch': {
      const t = chartTarget(); if (!t.sym) break;
      const a = { id: uid(), created: Date.now(), symbol: t.sym, name: t.name, isin: '', type: 'action', ccy: CCYS.includes(t.ccy) ? t.ccy : 'USD', sector: '', region: guessRegion(t.sym), source: 'auto', watch: true, note: '', hist: [] };
      S.assets.push(a); S.settings.chartSel = { assetId: a.id }; save(); gsSoon(); renderCharts(); toast('Ajouté à la surveillance : complète sa fiche (type, classe, secteur).'); break;
    }
    case 'splitdim': S.settings.splitDim = b.dataset.v; persist(); renderRepartition(); break;
    case 'chmode': S.settings.chartMode = b.dataset.v; persist(); openAsset(id); break;
    case 'chrange': S.settings.chartRange = b.dataset.v; persist(); openAsset(id); break;
    case 'ask': openAsk(id, b.dataset.date); break;
    case 'askgo': { const t = $('#askTxt').value; try { await navigator.clipboard.writeText(t); } catch { $('#askTxt').select(); document.execCommand('copy'); } window.open(S.settings.claudeUrl || 'https://claude.ai/new', '_blank', 'noopener'); toast('Texte copié : colle-le dans Claude (Ctrl+V).'); break; }
    case 'gscopy': { const ta = $('#gsScriptTxt'); ta.select(); try { await navigator.clipboard.writeText(GS_SCRIPT); } catch { document.execCommand('copy'); } toast('Script copié.'); break; }
    case 'gstest': {
      saveSettings();
      if (!S.settings.gsUrl) return toast('Colle d\'abord l\'URL du relais.', 'err');
      try { await gsCall({ action: 'ping' }); toast('✅ Relais Google joignable. Récupération des cours…'); pollQuotes(true); }
      catch (err) { toast('Relais injoignable : ' + explainErr(err) + '. Vérifie l\'URL /exec, le code et l\'accès « Tout le monde ».', 'err'); }
      break;
    }
    case 'asset': openAsset(id); break;
    case 'newasset': openAsset(null); break;
    case 'newwatch': openAsset(null, { watch: true }); break;
    case 'closemodal': closeModal(); break;
    case 'assetsave': saveAsset(id); break;
    case 'assetdel': {
      if (S.tx.some(t => t.assetId === id)) return toast('Ce titre a des opérations : supprime-les d\'abord (ou décoche-le de la surveillance).', 'err');
      if (!confirm('Supprimer ce titre et ses alertes ?')) return;
      S.assets = S.assets.filter(a => a.id !== id); S.alerts = S.alerts.filter(a => a.assetId !== id);
      save(); closeModal(); renderAll(); gsSoon(); break;
    }
    case 'symsearch': {
      const q = $('#aSymbol').value.trim() || $('#aName').value.trim();
      if (!q) return toast('Tape un nom ou un symbole.', 'err');
      $('#symResults').innerHTML = '<span class="small muted">Recherche…</span>';
      try {
        const res = await searchSymbol(q);
        $('#symResults').innerHTML = res.length ? res.map(r => `<button type="button" data-act="sympick" data-sym="${esc(r.symbol)}" data-name="${esc(r.name)}" data-ccy="${esc(r.ccy)}" data-type="${esc(r.type)}"><b>${esc(r.symbol)}</b> — ${esc(r.name)} <span class="muted">· ${esc(r.exch)} · ${esc(r.ccy)} · ${esc(r.type)}</span></button>`).join('') : '<span class="small muted">Aucun résultat. Essaie le nom anglais ou le code ISIN.</span>';
      } catch (err) { $('#symResults').innerHTML = `<span class="small neg">Recherche impossible : ${esc(explainErr(err))}</span>`; }
      break;
    }
    case 'sympick': {
      $('#aSymbol').value = b.dataset.sym;
      if (!$('#aName').value) $('#aName').value = b.dataset.name;
      const c = (b.dataset.ccy || '').toUpperCase(); if (CCYS.includes(c)) $('#aCcy').value = c; else if (c === 'GBP' || /GBX|GBp/.test(b.dataset.ccy)) $('#aCcy').value = 'GBX';
      const t = (b.dataset.type || '').toLowerCase(); $('#aType').value = /etf/.test(t) ? 'etf' : /fund/.test(t) ? 'fonds' : /equity|stock/.test(t) ? 'action' : $('#aType').value;
      if (!$('#aRegion').value) $('#aRegion').value = guessRegion(b.dataset.sym);
      $('#symResults').innerHTML = '';
      break;
    }
    case 'fetchone': refreshOne(id, false); break;
    case 'fetchlong': refreshOne(id, true); break;
    case 'manualprice': {
      const p = parseNum($('#mpPrice').value), d = $('#mpDate').value;
      if (!(p > 0) || !d) return toast('Indique une date et un cours.', 'err');
      const a = assetById(id); mergeHist(a, [[d, p]]); checkAlerts(); save(); renderAll(); openAsset(id); toast('Cours enregistré.'); break;
    }
    case 'newalert': closeModal(); currentTab = 'alertes'; showTab('alertes'); renderAlerts(id); break;
    case 'newtx': closeModal(); lastCreatedAssetId = id; showTab('transactions'); break;
    case 'txsave': saveTx(id); break;
    case 'txedit': renderTx(id); break;
    case 'txcancel': renderTx(); break;
    case 'txdel': if (confirm('Supprimer cette opération ?')) { S.tx = S.tx.filter(t => t.id !== id); save(); renderAll(); } break;
    case 'import': { const i = document.createElement('input'); i.type = 'file'; i.accept = '.csv,.txt,text/csv'; i.onchange = () => i.files[0] && startImport(i.files[0]); i.click(); break; }
    case 'importgo': doImport(); break;
    case 'alsave': saveAlert(); break;
    case 'alrearm': { const al = S.alerts.find(x => x.id === id); al.triggeredAt = null; checkAlerts(); save(); renderAll(); break; }
    case 'altoggle': { const al = S.alerts.find(x => x.id === id); al.active = !al.active; save(); renderAll(); break; }
    case 'aldel': if (confirm('Supprimer cette alerte ?')) { S.alerts = S.alerts.filter(x => x.id !== id); save(); renderAll(); } break;
    case 'notif': if ('Notification' in window) { await Notification.requestPermission(); renderAll(); } break;
    case 'ssave': saveSettings(); break;
    case 'stest': testKey(); break;
    case 'fxsave': document.querySelectorAll('[data-fx]').forEach(i => { const v = parseNum(i.value); if (v > 0) S.settings.fx[i.dataset.fx] = v; }); save(); toast('Taux enregistrés.'); renderAll(); break;
    case 'fxrefresh': refreshFx(false); break;
    case 'tonioDir': chooseTonioDir(); break;
    case 'tonioSave': case 'saveall': saveAll(true); break;
    case 'coffreDir': chooseCoffreDir(); break;
    case 'coffreCode': coffreModal('create'); break;
    case 'coffreUnlock': coffreModal('unlock'); break;
    case 'coffreok': coffreOk(b.dataset.mode); break;
    case 'tonioDl': download('bourse_latest.json', JSON.stringify(buildTonio(), null, 2)); break;
    case 'backup': download(`mon_portefeuille_sauvegarde_${today()}.json`, JSON.stringify({ ...S, settings: { ...S.settings, avKey: '', tdKey: '' } }, null, 2)); toast('Sauvegarde téléchargée (sans tes clés API).'); break;
    case 'demo': loadDemo(); break;
    case 'reset': if (confirm('Effacer toutes les données de l\'app sur ce navigateur ?') && confirm('Vraiment ? Pense à télécharger une sauvegarde avant.')) { const keep = { avKey: S.settings.avKey, tdKey: S.settings.tdKey, provider: S.settings.provider }; S = defaultState(); Object.assign(S.settings, keep); save(); showTab('overview'); } break;
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'allocBy') { S.settings.allocBy = t.value; persist(); renderOverview(); }
  else if (t.id === 'showClosed') { S.settings.showClosed = t.checked; persist(); renderPositions(); }
  else if (t.id === 'posGroup') { S.settings.posGroup = t.value; persist(); renderPositions(); }
  else if (t.id === 'chSel') {
    const [k, v] = t.value.split(':');
    S.settings.chartSel = k === 'a' ? { assetId: v } : k === 'p' ? { sym: v, name: (PRESETS.find(p => p[0] === v) || [])[1], ccy: 'USD' } : (S.settings.chartSel || {});
    persist(); renderCharts();
  }
  else if (t.id === 'splitSel') { S.settings.splitDim = t.value; persist(); renderRepartition(); }
  else if (t.id === 'splitCash') { S.settings.splitCash = t.checked; persist(); renderRepartition(); }
  else if (t.id === 'aType' && !$('#aCls').dataset.touched) { $('#aCls').value = defaultClass(t.value); }
  else if (t.id === 'aCls') { t.dataset.touched = '1'; }
  else if (t.id === 'txFilter') renderTx();
  else if (t.id === 'tAsset' && t.value === '__new') { t.value = ''; openAsset(null); }
  else if (t.id === 'sAutoTonio') { S.settings.autoTonio = t.checked; persist(); }
  else if (t.id === 'imH') { importCtx.h = +t.value; autoMap(); renderImport(); }
  else if (t.dataset && t.dataset.map) { importCtx.map[t.dataset.map] = t.value === '' ? null : +t.value; renderImport(); }
  else if (t.id === 'coffreFile' && t.files[0]) { restoreCoffre(t.files[0]); t.value = ''; }
  else if (t.id === 'restoreFile' && t.files[0]) {
    t.files[0].text().then(txt => {
      try {
        const d = JSON.parse(txt);
        if (!d || !Array.isArray(d.assets) || !Array.isArray(d.tx)) throw new Error('format inattendu');
        if (!confirm(`Restaurer ${d.assets.length} titre(s) et ${d.tx.length} opération(s) ? Les données actuelles seront remplacées.`)) return;
        const keep = { avKey: S.settings.avKey, tdKey: S.settings.tdKey };
        const def = defaultState();
        S = { ...def, ...d, settings: { ...def.settings, ...(d.settings || {}), ...keep } };
        checkAlerts(); save(); showTab('overview'); toast('Sauvegarde restaurée.');
      } catch (err) { toast('Fichier invalide : ' + err.message, 'err'); }
    });
  }
  if (t.closest && t.closest('#txForm')) updateTxForm();
});
document.addEventListener('input', e => { if (e.target.closest && e.target.closest('#txForm') && e.target.id !== 'tTax') updateTxForm(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal();
  if (e.key === 'Enter' && (e.target.id === 'cf1' || e.target.id === 'cf2')) { const b = document.querySelector('[data-act=coffreok]'); if (b) b.click(); }
});

/* ---------------------------- Démarrage ---------------------------- */
(async function init() {
  const t = (location.hash || '').slice(1);
  if (['overview', 'positions', 'repartition', 'graphiques', 'transactions', 'analyse', 'alertes', 'parametres', 'bases'].includes(t)) currentTab = t;
  showTab(currentTab);
  try { tonioDir = (await IDB.get('tonioDir')) || null; coffreDir = (await IDB.get('coffreDir')) || null; } catch { tonioDir = null; coffreDir = null; }
  if (S.settings.autoTonio && (tonioDir || coffreDir)) saveAll(false);
  renderTonioStatus();
  if (!S.settings.fxDate || S.settings.fxDate < addDays(today(), -1)) refreshFx(true).then(renderAll);
  if (checkAlerts()) { persist(); renderAll(); }
  if (S.settings.autoRefresh) refreshPrices(false);
  setupPolling();
  if (S.settings.gsUrl && +S.settings.gsEvery > 0) pollQuotes(false);
})();
