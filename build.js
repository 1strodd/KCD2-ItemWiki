// Собирает kcd2-items/index.html из Lua-модулей вики KCD (Module:ItemData*).
// Запуск: node build.js   (нужен Node 18+, интернет)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://kingdomcomedeliverance.fandom.com/api.php';
const WIKI_PAGE = 'https://kingdomcomedeliverance.fandom.com/wiki/';
const IMG_BASE = 'https://static.wikia.nocookie.net/kingdom-come-deliverance/images/';
const MODULES = ['ItemData', 'ItemData/alchemy', 'ItemData/dlc', 'ItemData/rewards', 'ItemData/horse', 'ItemData/unique'];
const GROUPED = 'ItemData/grouped';

async function fetchModule(name) {
  const q = new URLSearchParams({
    action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
    titles: 'Module:' + name, format: 'json',
  });
  const r = await fetch(API + '?' + q, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
  const d = await r.json();
  const p = Object.values(d.query.pages)[0];
  if (!p.revisions) throw new Error(name + ': модуль не найден');
  return p.revisions[0].slots.main['*'];
}

const str = (body, key) => {
  const m = body.match(new RegExp('\\b' + key + '\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"'));
  return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
};

// Разбор data-модулей: UID = { EnName = "...", Id = "...", ... }
function parseData(lua) {
  const out = [];
  const re = /^\s*(?:\["([^"]+)"\]|([\w]+))\s*=\s*\{\s*$/gm;
  let m;
  while ((m = re.exec(lua))) {
    const uid = m[1] || m[2];
    if (uid === 'data') continue;
    const end = lua.indexOf('\n\t\t}', re.lastIndex);
    const body = lua.slice(re.lastIndex, end === -1 ? undefined : end);
    const id = str(body, 'Id');
    if (!id) continue;
    out.push({ uid, name: str(body, 'EnName') || uid, uuid: id, icon: str(body, 'IconId'), tag: str(body, 'Tag') });
  }
  return out;
}

// Разбор grouped: ["Name"] = { ["1"] = { UID=, UUID=, IconId= }, ... }
function parseGrouped(lua) {
  const out = [];
  const gre = /^\s*\["((?:[^"\\]|\\.)*)"\]\s*=\s*\{\s*$/gm;
  let g;
  while ((g = gre.exec(lua))) {
    const name = g[1].replace(/\\"/g, '"');
    const end = lua.indexOf('\n    },', gre.lastIndex);
    const body = lua.slice(gre.lastIndex, end === -1 ? undefined : end);
    const vre = /UID\s*=\s*"([^"]*)"\s*,\s*UUID\s*=\s*"([^"]*)"\s*,\s*IconId\s*=\s*"([^"]*)"/g;
    let v;
    while ((v = vre.exec(body))) out.push({ uid: v[1], name, uuid: v[2], icon: v[3], tag: '' });
  }
  return out;
}

function iconUrl(icon) {
  if (!icon) return '';
  const file = icon.replace(/ /g, '_') + '_icon.png';
  const h = crypto.createHash('md5').update(file).digest('hex');
  return `${IMG_BASE}${h[0]}/${h.slice(0, 2)}/${encodeURIComponent(file)}/revision/latest/scale-to-width-down/96`;
}

// Какие файлы иконок реально есть на вики (имена вида Name_icon.png)
async function existingIcons(icons) {
  const files = icons.map((i) => i.replace(/ /g, '_') + '_icon.png');
  const ok = new Set();
  for (let k = 0; k < files.length; k += 50) {
    const q = new URLSearchParams({
      action: 'query', prop: 'imageinfo', format: 'json',
      titles: files.slice(k, k + 50).map((f) => 'File:' + f).join('|'),
    });
    const d = await (await fetch(API + '?' + q, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
    const back = {};
    for (const n of d.query.normalized || []) back[n.to] = n.from;
    for (const p of Object.values(d.query.pages))
      if (p.imageinfo) ok.add((back[p.title] || p.title).slice(5).replace(/ /g, '_'));
  }
  return ok;
}

(async () => {
  if (process.argv.includes('--cached')) {
    const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'items.json'), 'utf8'));
    const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
    const html = tpl.replace('/*__ITEMS__*/[]', () => JSON.stringify(items).replace(/</g, '\\u003c')).replace('__BUILT__', new Date().toISOString().slice(0, 10));
    fs.writeFileSync(path.join(__dirname, 'index.html'), html);
    return console.log('Из кэша items.json:', items.length);
  }
  const byUuid = new Map();
  for (const m of MODULES) {
    const items = parseData(await fetchModule(m));
    console.log(m.padEnd(20), items.length);
    for (const it of items) if (!byUuid.has(it.uuid)) byUuid.set(it.uuid, it);
  }
  const grouped = parseGrouped(await fetchModule(GROUPED));
  console.log(GROUPED.padEnd(20), grouped.length);
  const groupNames = new Map(); // uuid -> "реальное" имя группы
  for (const it of grouped) {
    groupNames.set(it.uuid, it.name);
    const ex = byUuid.get(it.uuid);
    if (!ex) byUuid.set(it.uuid, it);
    else if (!ex.icon) ex.icon = it.icon;
  }

  // Только одежда/броня/оружие. Пустой тег — оружие, найденное только в grouped.
  const KEEP_TAGS = new Set(['Armor', 'Helmet', 'Hood', 'MeleeWeapon', 'MissileWeapon', 'Ammo', '']);
  // Вики общая для KCD1 и KCD2: данные первой игры лежат в Module:ItemData/KCD*.
  // Любой хэш оттуда исключаем, чтобы остался только KCD2.
  const kcd1 = new Set();
  for (const m of ['ItemData/KCD', 'ItemData/KCD/grouped'])
    for (const u of (await fetchModule(m)).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g) || []) kcd1.add(u);
  console.log('Хэшей KCD1 (исключаем):', kcd1.size);

  const wanted = [...byUuid.values()]
    .filter((i) => i.name && !/suspicious bag/i.test(i.name) && i.icon && KEEP_TAGS.has(i.tag) && !kcd1.has(i.uuid));
  const exists = await existingIcons([...new Set(wanted.map((i) => i.icon))]);
  console.log('Иконок на вики:', exists.size);

  const items = wanted
    .filter((i) => exists.has(i.icon.replace(/ /g, '_') + '_icon.png'))
    .map((i) => ({
      n: i.name, u: i.uid, h: i.uuid, i: iconUrl(i.icon), t: i.tag,
    }))
    .sort((a, b) => a.n.localeCompare(b.n) || a.u.localeCompare(b.u));

  const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const html = tpl
    .replace('/*__ITEMS__*/[]', () => JSON.stringify(items).replace(/</g, '\\u003c'))
    .replace('__BUILT__', new Date().toISOString().slice(0, 10));
  fs.writeFileSync(path.join(__dirname, 'items.json'), JSON.stringify(items, null, 1));
  fs.writeFileSync(path.join(__dirname, 'index.html'), html);
  console.log('Предметов:', items.length, '→ index.html, items.json');
})().catch((e) => { console.error(e); process.exit(1); });
