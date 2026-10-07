/* Triage Lens engine: duplicate matching + urgency scoring. No DOM. */
/* ===================== ENGINE (pure, no DOM) ===================== */
const LAT0 = 47.62, LON0 = -122.33;
const MLAT = 110574, MLON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toXY = (lat, lon) => ({ x: (lon - LON0) * MLON, y: (lat - LAT0) * MLAT });
const toLL = (x, y) => [LAT0 + y / MLAT, LON0 + x / MLON];

const W = { space: .45, time: .15, type: .25, detail: .15 };
const AUTO = 0.70, REVIEW = 0.50, WINDOW = 3600, CELL = 1000;

const CAT = {
  crash:       { label: 'Vehicle crash',  R: 600,  base: 3 },
  fire:        { label: 'Fire',           R: 1200, base: 2 },
  medical:     { label: 'Medical',        R: 150,  base: 3 },
  violence:    { label: 'Weapon / violence', R: 400, base: 2 },
  hazmat:      { label: 'Hazardous material', R: 1000, base: 2 },
  disturbance: { label: 'Disturbance',    R: 300,  base: 4 },
  unknown:     { label: 'Unclassified',   R: 600,  base: 4 },
};
const CATS = [
  ['violence', /\b(gun|guns|gunshots?|shots? fired|shooting|stabbed|stabbing|knife|assault|disparos)\b/],
  ['crash', /\b(crash|crashed|collision|accident|wreck|pile ?up|pileup|rear-?ended|flipped|rolled over|went down|choque|accidente)\b/],
  ['fire', /\b(fire|smoke|flames|burning|fuego|humo|incendio)\b/],
  ['hazmat', /\b(gas leak|chemical|spill|fumes)\b/],
  ['medical', /\b(chest pain|breathing|breathe|unconscious|passed out|collapsed|seizure|overdose|bleeding|heart|stroke|won'?t wake|sweating|no respira|dolor de pecho)\b/],
  ['disturbance', /\b(noise|loud|party|music)\b/],
];
const COMPAT = { 'crash|fire': .6, 'crash|hazmat': .6, 'fire|hazmat': .7, 'crash|medical': .5, 'fire|medical': .3, 'medical|violence': .5 };
const compat = (a, b) => a === b ? 1 : (a === 'unknown' || b === 'unknown') ? .6 : (COMPAT[[a, b].sort().join('|')] || 0);

const FLAGS = [
  { re: /\b(not breathing|stopped breathing|no respira)\b/, sev: 3, label: 'Not breathing' },
  { re: /\b(unconscious|unresponsive|not responding|won'?t wake up|inconsciente)\b/, sev: 3, label: 'Unresponsive' },
  { re: /\b(trapped|pinned|stuck inside|can'?t get out|atrapad[oa])\b/, sev: 3, label: 'Trapped' },
  { re: /\b(still (be )?inside|people inside|someone inside|kids inside|still in there)\b/, sev: 3, label: 'People inside' },
  { re: /\b(chest pain|heart attack|can'?t breathe|struggling to breathe|dolor de pecho)\b/, sev: 3, label: 'Cardiac / breathing' },
  { re: /\b(gun|gunshots?|shots? fired|shooting|stabbed|stabbing|knife)\b/, sev: 3, label: 'Weapon' },
  { re: /\b(bleeding (a lot|badly|heavily)|lots of blood|losing blood)\b/, sev: 3, label: 'Severe bleeding' },
  { re: /\b(fire|flames|burning|fuego|incendio)\b/, sev: 2, label: 'Active fire' },
  { re: /\b(hurt|injur(ed|y|ies)|bleeding|herid[oa]s?|ambulances?)\b/, sev: 2, label: 'Injuries' },
  { re: /\b(fuel leak|leaking fuel|fuel leaking|gas leak|leaking gas|chemical)\b/, sev: 2, label: 'Hazard leak' },
  { re: /\b(isn'?t getting out|not getting out|crushed)\b/, sev: 2, label: 'Occupant may be hurt' },
  { re: /\b(smoke|humo)\b/, sev: 1, label: 'Smoke' },
];
const VULN = /\b(kid|kids|child|children|baby|infant|toddler|elderly|pregnant|niñ[oa]s?)\b|\b(he'?s|she'?s|aged?)\s(6[5-9]|[7-9]\d)\b/;
const INFO = /\b(how long|anyone reported|already reported|backed up|when will|is anyone coming)\b/;
const NEG = /\b(no|not|nobody|no one|none|isn'?t|aren'?t|without|never)\b[\w\s']{0,12}$/;
const SPANISH = /\b(hay|está|carro|choque|fuego|ayuda|autopista|cerca)\b/;

const SYN = { sb: 'southbound', nb: 'northbound', freeway: 'freeway', highway: 'freeway', autopista: 'freeway', interstate: 'freeway', hwy: 'freeway',
  plateado: 'silver', gray: 'grey', pickup: 'truck', 'third floor': '3rd floor', avenue: '', ave: '', '2nd': '2nd', second: '2nd' };
const DESC = new Set(['red','blue','white','black','silver','grey','green','truck','sedan','suv','van','semi','motorcycle','bus','overpass','bridge',
  'barrier','shoulder','exit','northbound','southbound','i5','mercer','freeway','2nd','bell','apartment','apartments','building','window','3rd floor',
  'park','bench','dexter','broadway','house','lake union','cal anderson']);

function analyze(r) {
  const t = r.text.toLowerCase().replace(/\b(i-5|i5|interstate 5)\b/g, 'i5 freeway');
  r.cat = (CATS.find(([, re]) => re.test(t)) || ['unknown'])[0];
  r.flags = [];
  for (const f of FLAGS) {
    const m = t.match(f.re); if (!m) continue;
    if (NEG.test(t.slice(Math.max(0, m.index - 24), m.index))) continue;
    if (!r.flags.some(x => x.label === f.label)) r.flags.push({ label: f.label, sev: f.sev });
  }
  if (VULN.test(t)) r.flags.push({ label: /\d/.test(t.match(VULN)[0]) ? 'Elderly patient' : 'Child / vulnerable', sev: 0, vuln: true });
  if (r.tone === 'panicked' && !r.flags.some(f => f.sev >= 2)) r.flags.push({ label: 'Caller panicked', sev: 2 });
  r.distress = r.tone ? { panicked: .92, distressed: .6, calm: .15 }[r.tone] : null; // voice-stress model output (0–1); null = no audio
  r.info = INFO.test(t) && !r.flags.some(f => f.sev >= 2);
  r.lang = SPANISH.test(t) ? 'ES' : 'EN';
  const words = t.replace(/[^a-z0-9ñáéíóú\s]/g, ' ').split(/\s+/).filter(Boolean);
  r.desc = new Set();
  const add = w => { const s = SYN[w] !== undefined ? SYN[w] : w; if (s && DESC.has(s)) r.desc.add(s); };
  words.forEach((w, i) => { add(w); if (i) add(words[i - 1] + ' ' + w); });
  return r;
}

function scoreMatch(r, inc) {
  const cats = [...inc.cats.keys()];
  const medical = r.cat === 'medical' || inc.cat === 'medical';
  const R = medical ? 150 : Math.max(CAT[r.cat].R, ...cats.map(c => CAT[c].R));
  const d = Math.hypot(r.x - inc.x, r.y - inc.y);
  const reach = R + r.acc;
  if (d > reach) return null;
  const dt = r.t - inc.lastT;
  if (dt > WINDOW) return null;
  const type = Math.max(...cats.map(c => compat(r.cat, c)));
  if (type === 0) return null; // different emergency types never merge
  let space = 1 - d / reach; if (r.acc > 500) space *= .8;
  const time = 1 - Math.max(0, dt) / WINDOW;
  const shared = [...r.desc].filter(x => inc.desc.has(x));
  const detail = r.desc.size && inc.desc.size ? Math.min(1, shared.length / Math.min(r.desc.size, inc.desc.size)) : 0;
  const dir = r.desc.has('northbound') ? 'northbound' : r.desc.has('southbound') ? 'southbound' : null;
  const opp = dir === 'northbound' ? 'southbound' : 'northbound';
  const conflict = !!dir && inc.desc.has(opp) && !inc.desc.has(dir);
  const score = W.space * space + W.time * time + W.type * type + W.detail * detail - (conflict ? .15 : 0);
  return { incId: inc.id, score: Math.max(0, score), d, dt, type, shared, conflict, acc: r.acc, rcat: r.cat, icat: inc.cat };
}

class Engine {
  constructor() { this.incidents = new Map(); this.reports = []; this.grid = new Map(); this.n = 0; this.events = []; }
  index(inc) {
    const k = Math.floor(inc.x / CELL) + ',' + Math.floor(inc.y / CELL);
    if (inc.cell === k) return;
    if (inc.cell) this.grid.get(inc.cell)?.delete(inc);
    inc.cell = k; if (!this.grid.has(k)) this.grid.set(k, new Set()); this.grid.get(k).add(inc);
  }
  unindex(inc) { if (inc.cell) this.grid.get(inc.cell)?.delete(inc); inc.cell = null; }
  *candidates(r) {
    const reach = Math.ceil((1200 + Math.min(r.acc, 1500)) / CELL);
    const cx = Math.floor(r.x / CELL), cy = Math.floor(r.y / CELL);
    for (let i = cx - reach; i <= cx + reach; i++) for (let j = cy - reach; j <= cy + reach; j++) {
      const set = this.grid.get(i + ',' + j); if (!set) continue;
      for (const inc of set) { if (r.t - inc.lastT > WINDOW) { set.delete(inc); inc.cell = null; continue; } yield inc; }
    }
  }
  process(r) {
    analyze(r); this.reports.push(r);
    let best = null;
    for (const inc of this.candidates(r)) { const s = scoreMatch(r, inc); if (s && (!best || s.score > best.score)) best = s; }
    if (best && best.score >= AUTO) {
      const inc = this.incidents.get(best.incId); r.match = best; inc.reports.push(r); r.incId = inc.id;
      this.recompute(inc, r);
      return { type: 'linked', inc, s: best };
    }
    const inc = this.create(r);
    if (best && best.score >= REVIEW) { inc.review = best; return { type: 'review', inc, s: best }; }
    return { type: 'new', inc, s: best };
  }
  create(r) {
    const inc = { id: 'INC-' + (++this.n), num: this.n, reports: [r], cell: null, review: null, esc: null };
    r.incId = inc.id; r.match = null;
    this.incidents.set(inc.id, inc); this.recompute(inc, null); return inc;
  }
  recompute(inc, trigger) {
    const prevP = inc.p, rs = inc.reports.sort((a, b) => a.t - b.t);
    const good = rs.filter(r => r.acc <= 500), use = good.length ? good : rs;
    let sw = 0, sx = 0, sy = 0;
    for (const r of use) { const w = 1 / Math.max(r.acc, 10); sw += w; sx += r.x * w; sy += r.y * w; }
    inc.x = sx / sw; inc.y = sy / sw; inc.acc = Math.min(...use.map(r => r.acc));
    inc.cats = new Map(); rs.forEach(r => inc.cats.set(r.cat, (inc.cats.get(r.cat) || 0) + 1));
    const known = [...inc.cats].filter(([c]) => c !== 'unknown').sort((a, b) => b[1] - a[1]);
    inc.cat = known.length ? known[0][0] : 'unknown';
    inc.desc = new Set(); rs.forEach(r => r.desc.forEach(d => inc.desc.add(d)));
    const flags = new Map();
    rs.forEach(r => r.flags.forEach(f => { if (!flags.has(f.label)) flags.set(f.label, { ...f, by: r }); }));
    inc.flags = [...flags.values()].sort((a, b) => b.sev - a.sev);
    inc.firstT = rs[0].t; inc.lastT = rs[rs.length - 1].t;
    inc.surge = rs.filter(r => r.t > inc.lastT - 300).length;
    // Urgency score 0–100: four explainable factors
    const sevMax = Math.max(0, ...inc.flags.map(f => f.sev));
    const nDanger = inc.flags.filter(f => f.sev >= 2).length;
    const danger = Math.min(100, [0, 25, 55, 85][sevMax] + 5 * Math.max(0, nDanger - 1));
    const ds = rs.map(r => r.distress).filter(v => v != null).sort((a, b) => b - a).slice(0, 3);
    const distress = ds.length ? Math.round(100 * ds.reduce((a, b) => a + b, 0) / ds.length) : 0;
    const vulnerable = inc.flags.some(f => f.vuln) ? 100 : 0;
    const surge = Math.min(100, Math.round(inc.surge / 8 * 100));
    inc.factors = { danger, distress, vulnerable, surge };
    inc.score = Math.round(.5 * danger + .2 * distress + .15 * vulnerable + .15 * surge);
    // Priority = the more urgent of (a) hard rules and (b) the score band
    let p = CAT[inc.cat].base; inc.rule = null;
    for (const f of inc.flags) if (f.sev && 4 - f.sev < p) { p = 4 - f.sev; inc.rule = f.label; }
    if (inc.flags.some(f => f.vuln) && p === 2) { p = 1; inc.rule = 'Vulnerable person + danger'; }
    if (inc.surge >= 5 && p > 2) { p = 2; inc.rule = inc.rule || 'Report surge'; }
    const sp = inc.score >= 70 ? 1 : inc.score >= 45 ? 2 : inc.score >= 25 ? 3 : 4;
    if (sp < p) { p = sp; inc.rule = null; }
    inc.p = p;
    if (trigger && prevP && p < prevP) {
      const f = trigger.flags.slice().sort((a, b) => b.sev - a.sev)[0];
      inc.esc = { from: prevP, to: p, by: trigger.id, why: f ? f.label : 'Surge of reports', t: trigger.t };
      this.events.push({ type: 'esc', inc: inc.id });
    }
    this.index(inc);
  }
  merge(fromId, intoId) {
    const a = this.incidents.get(fromId), b = this.incidents.get(intoId); if (!a || !b) return;
    a.reports.forEach(r => { r.incId = b.id; r.match = r.match || { incId: b.id, score: a.review?.score ?? 0, manual: true, d: Math.hypot(r.x - b.x, r.y - b.y), dt: r.t - b.lastT, type: 1, shared: [] }; b.reports.push(r); });
    this.unindex(a); this.incidents.delete(fromId);
    this.recompute(b, a.reports[a.reports.length - 1]);
    for (const inc of this.incidents.values()) if (inc.review?.incId === fromId) inc.review = null;
  }
  keep(id) { const a = this.incidents.get(id); if (a) { a.review = null; a.kept = true; } }
  split(rid) {
    const r = this.reports.find(x => x.id === rid); const inc = this.incidents.get(r.incId); if (!inc || inc.reports.length < 2) return;
    inc.reports = inc.reports.filter(x => x !== r); this.recompute(inc, null);
    const n = this.create(r); n.kept = true; return n;
  }
}

/* ===================== SCENARIO: Seattle, I-5 at Mercer St ===================== */
// Real coordinates from OpenStreetMap: I-5 southbound lanes at the Mercer St overpass, northbound lanes ~290 m north.
const SCEN_RAW = [
  [5,  47.62445,-122.32866, 15,'call','distressed',"There's a big crash on I-5 southbound right under the Mercer overpass, like four cars."],
  [20, 47.62418,-122.32869, 30,'call','distressed',"Car accident on the freeway by Mercer, a red pickup hit a silver sedan."],
  [32, 47.62460,-122.32866, 10,'text',null,"crash i5 sb at mercer st. multiple cars. traffic stopped"],
  [45, 47.62429,-122.32541, 25,'call','panicked',"My husband has chest pain and he's sweating, he's 68. We're on East Mercer Street, please hurry."],
  [58, 47.62400,-122.32868, 40,'call','distressed',"Wreck on I-5 near the Mercer overpass, I think someone is hurt, the driver of the sedan isn't getting out."],
  [70, 47.62520,-122.33010, 1400,'call','calm',"There's been an accident on the freeway, lots of cars stopped."],
  [85, 47.62438,-122.32866, 12,'app',null,"Pileup at the Mercer overpass southbound, silver car is crushed against the barrier."],
  [100,47.62470,-122.32862, 20,'call','calm',"Traffic is backed up on I-5, how long until it's cleared?"],
  [115,47.62436,-122.32867, 15,'call','panicked',"Hay un choque en la autopista cerca de Mercer. Un hombre está atrapado en el carro plateado."],
  [130,47.62431,-122.32866, 18,'call','panicked',"The silver car, the guy is pinned and he's not responding. There's fuel leaking."],
  [150,47.61430,-122.34560, 20,'call','distressed',"Apartment fire at 2nd and Bell, smoke pouring out of a third floor window."],
  [162,47.61410,-122.34590, 35,'call','calm',"There's smoke coming from the building on 2nd Avenue near Bell."],
  [175,47.62700,-122.32807, 20,'call','calm',"Northbound I-5 before the Mercer exit, a white van flipped on its side, driver is out and walking."],
  [190,47.62440,-122.32870, 25,'text',null,"car on fire at the I-5 crash by Mercer, people still near it"],
  [205,47.62550,-122.33650, 30,'call','calm',"I can see black smoke over the freeway near Mercer from my office."],
  [220,47.61425,-122.34575, 15,'call','panicked',"Fire at the apartments on 2nd and Bell, my neighbor's kids might still be inside, third floor!"],
  [240,47.62452,-122.32868, 20,'call','distressed',"Big accident on I-5 at Mercer, several cars, we need ambulances."],
  [255,47.62425,-122.32860, 15,'call','distressed',"Someone is bleeding a lot from the head, sitting on the shoulder next to the red truck."],
  [270,47.61704,-122.31917, 20,'call','distressed',"A man passed out on a bench in Cal Anderson Park. He's breathing but won't wake up."],
  [290,47.61440,-122.34550, 25,'text',null,"building on fire 2nd & bell, fire trucks not here yet"],
  [300,47.62420,-122.32850, 18,'call','calm',"Just calling to see if anyone reported the crash on I-5 at Mercer."],
  [320,47.62446,-122.32868, 10,'app',null,"Southbound I-5 pileup, 5 cars now, a motorcycle went down too."],
  [340,47.62846,-122.34197, 30,'call','calm',"Loud party on Dexter Ave North, it's been going for hours."],
  [360,47.62434,-122.32866, 15,'call','distressed',"Accident under the Mercer overpass, there's a kid in the back of the blue SUV crying."],
];
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const FILLER = ["Accident on I-5 at Mercer.", "Multi-car crash on the freeway by the Mercer overpass.", "There's a wreck on I-5 southbound.",
  "crash on i5 near mercer st, cars everywhere", "Car accident under the overpass on I-5.", "Big pileup on the freeway at Mercer, traffic is stopped.",
  "Accident on I-5, I think police need to come.", "Someone crashed on I-5 by Mercer, several cars.", "Calling about the crash on I-5 southbound at Mercer.",
  "Lots of cars smashed up on I-5 near Mercer."];
function buildScenario() {
  const R = rng(7), out = SCEN_RAW.map(a => ({ t: a[0], lat: a[1], lon: a[2], acc: a[3], ch: a[4], tone: a[5], text: a[6] }));
  let t = 375;
  FILLER.forEach(text => { t += 12 + R() * 14; out.push({ t: Math.round(t), lat: 47.6237 + R() * .0016, lon: -122.32868 + (R() - .5) * .00008,
    acc: [10, 15, 25, 40, 60][Math.floor(R() * 5)], ch: R() < .2 ? 'text' : 'call', tone: R() < .3 ? 'distressed' : 'calm', text }); });
  return out.sort((a, b) => a.t - b.t);
}

/* Place names a caller might say, matched against the transcript (stand-in for a geocoder). */
const GAZ = [
  { re: /\b(i-?5|interstate|freeway|highway|overpass)\b.*\bmercer\b|\bmercer\b.*\b(i-?5|freeway|overpass|highway)\b/, name: 'I-5 at Mercer St', lat: 47.62440, lon: -122.32866, acc: 80 },
  { re: /\b(2nd|second)\b.*\bbell\b|\bbell\b.*\b(2nd|second)\b/, name: '2nd Ave & Bell St', lat: 47.61430, lon: -122.34560, acc: 60 },
  { re: /cal anderson/, name: 'Cal Anderson Park', lat: 47.61704, lon: -122.31917, acc: 120 },
  { re: /space needle/, name: 'Space Needle', lat: 47.62051, lon: -122.34930, acc: 80 },
  { re: /lake union park/, name: 'Lake Union Park', lat: 47.62702, lon: -122.33716, acc: 150 },
  { re: /\bdexter\b/, name: 'Dexter Ave N', lat: 47.62846, lon: -122.34197, acc: 300 },
  { re: /\bbroadway\b/, name: 'Broadway, Capitol Hill', lat: 47.61900, lon: -122.32100, acc: 500 },
  { re: /\bmercer\b/, name: 'Mercer St', lat: 47.62428, lon: -122.33100, acc: 500 },
];
const LANDMARKS = [
  { name: 'I-5 at Mercer St overpass', lat: 47.62440, lon: -122.32866 },
  { name: 'E Mercer St, east of I-5', lat: 47.62429, lon: -122.32541 },
  { name: '2nd Ave & Bell St, Belltown', lat: 47.61430, lon: -122.34560 },
  { name: 'Cal Anderson Park', lat: 47.61704, lon: -122.31917 },
  { name: 'Dexter Ave N', lat: 47.62846, lon: -122.34197 },
  { name: 'Lake Union Park', lat: 47.62702, lon: -122.33716 },
  { name: 'Space Needle', lat: 47.62051, lon: -122.34930 },
  { name: 'South Lake Union', lat: 47.62550, lon: -122.33650 },
].map(l => ({ ...l, ...toXY(l.lat, l.lon) }));
function placeName(inc) {
  let best = null, bd = 1e9;
  for (const l of LANDMARKS) { const d = Math.hypot(l.x - inc.x, l.y - inc.y); if (d < bd) { bd = d; best = l; } }
  const dir = inc.desc.has('northbound') && !inc.desc.has('southbound') ? ' · northbound' : inc.desc.has('southbound') && !inc.desc.has('northbound') ? ' · southbound' : '';
  return (bd < 250 ? best.name : 'near ' + best.name) + (inc.cat === 'crash' ? dir : '');
}

/* ===================== STRESS TEST ===================== */
function stressTest(N = 10000) {
  const R = rng(42), gauss = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const pick = a => a[Math.floor(R() * a.length)];
  const colors = ['red', 'blue', 'white', 'black', 'silver', 'grey', 'green'], vehs = ['truck', 'sedan', 'suv', 'van', 'motorcycle', 'bus'];
  const T = {
    crash: [i => `Car crash, a ${i.c} ${i.v} hit another car`, i => `accident on the freeway, ${i.c} ${i.v} flipped`, i => `wreck here, someone is hurt, ${i.c} ${i.v}`,
      i => `collision, the driver of the ${i.c} ${i.v} is trapped`, i => `multi car accident, traffic stopped`, i => `crash near the exit, ${i.c} ${i.v}`],
    fire: [i => `${i.b} fire, smoke from the window`, i => `I can see smoke from here`, i => `flames coming out of the ${i.b}`, i => `fire, people still inside the ${i.b}`, i => `${i.b} on fire`],
    medical: [i => `my husband has chest pain`, i => `someone collapsed, not breathing`, i => `man passed out, won't wake up`, i => `woman fell and is bleeding`],
    violence: [i => `shots fired near the park`, i => `heard gunshots outside`, i => `someone has a knife, fight outside the bar`],
    hazmat: [i => `strong gas leak smell`, i => `chemical smell, people coughing`],
    disturbance: [i => `loud party next door`, i => `loud music for hours`],
  };
  const mix = [['crash', .32, 12, 60], ['fire', .14, 14, 300], ['medical', .3, 1.4, 15], ['violence', .1, 7, 150], ['hazmat', .06, 5, 300], ['disturbance', .08, 1.5, 50]];
  const reports = []; let truth = 0;
  while (reports.length < N) {
    let u = R(), m = mix[0]; for (const x of mix) { if ((u -= x[1]) < 0) { m = x; break; } }
    const [cat, , mean, sd] = m, id = ++truth;
    const cx = R() * 40000, cy = R() * 40000, t0 = R() * 6 * 3600;
    const info = { c: pick(colors), v: pick(vehs), b: pick(['apartment', 'building', 'house']) };
    const k = Math.max(1, Math.round(-mean * Math.log(1 - R() * .999) * .9) || 1);
    for (let i = 0; i < k && reports.length < N; i++) {
      const acc = R() < .04 ? 1500 : pick([8, 15, 30, 60, 150]);
      reports.push({ id: reports.length + 1, truth: id, t: t0 + Math.min(2700, -480 * Math.log(1 - R())),
        x: cx + gauss() * sd + gauss() * Math.min(acc, 300) * .4, y: cy + gauss() * sd + gauss() * Math.min(acc, 300) * .4, acc,
        text: pick(T[cat])(info), tone: 'calm' });
    }
  }
  reports.sort((a, b) => a.t - b.t);
  const e = new Engine(); let rev = 0;
  const t0 = performance.now();
  for (const r of reports) if (e.process(r).type === 'review') rev++;
  const ms = performance.now() - t0;
  const pairs = new Set(), byInc = new Map();
  for (const r of reports) { pairs.add(r.incId + '|' + r.truth); if (!byInc.has(r.incId)) byInc.set(r.incId, new Map()); const m = byInc.get(r.incId); m.set(r.truth, (m.get(r.truth) || 0) + 1); }
  let wrong = 0; for (const m of byInc.values()) { const v = [...m.values()]; wrong += v.reduce((a, b) => a + b, 0) - Math.max(...v); }
  const trueInc = new Set(reports.map(r => r.truth)).size;
  return { N: reports.length, ms, per: ms * 1000 / reports.length, found: e.incidents.size, trueInc,
    recall: (N - pairs.size) / (N - trueInc), wrong: wrong / N, review: rev };
}
if (typeof module !== 'undefined') module.exports = { Engine, analyze, buildScenario, toXY, stressTest };
