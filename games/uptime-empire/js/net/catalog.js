// Hardware catalog access + per-OS naming conventions.
let CAT = null;
const byId = new Map();

export function setCatalog(json) {
  CAT = json;
  byId.clear();
  for (const m of json.models) byId.set(m.id, m);
}
export const catalog = () => CAT;
export const model = (id) => byId.get(id);
export const models = () => CAT.models;

// Latest firmware an OS had shipped by a given year (or the oldest if earlier).
export function versionFor(os, year, m) {
  const list = CAT.os[os]?.versions || [['1.0', 1990]];
  let v = list[0][0];
  for (const [ver, y] of list) if (y <= year) v = ver;
  if (os === 'aoss' && m?.swPrefix) return `${m.swPrefix}.${v}`;
  return v;
}
export function nextVersions(os, current, year, m) {
  const list = CAT.os[os]?.versions || [];
  const plain = os === 'aoss' ? String(current).replace(/^[A-Z]+\./, '') : current;
  const idx = list.findIndex(([v]) => v === plain);
  return list.filter(([, y], i) => i > idx && y <= year).map(([v]) => (os === 'aoss' && m?.swPrefix ? `${m.swPrefix}.${v}` : v));
}

// Expand a model's port groups into [{name, speed, media}]
export function expandPorts(m) {
  const out = [];
  for (const g of m.ports) {
    if (g.names) for (const n of g.names) out.push({ name: n, speed: g.speed, media: g.media });
    else for (let n = g.from; n <= g.to; n++) out.push({ name: g.fmt.replace('{n}', n), speed: g.speed, media: g.media });
  }
  return out;
}

// ---------- OS conventions ----------
const CISCO_SHORT = {
  Ethernet: 'Et', FastEthernet: 'Fa', GigabitEthernet: 'Gi', TenGigabitEthernet: 'Te', TwentyFiveGigE: 'Twe', FortyGigabitEthernet: 'Fo',
  HundredGigE: 'Hu', Serial: 'Se', Vlan: 'Vl', Loopback: 'Lo', 'Port-channel': 'Po', Tunnel: 'Tu', Null: 'Nu',
};
const XR_SHORT = { GigabitEthernet: 'Gi', TenGigE: 'Te', HundredGigE: 'Hu', FourHundredGigE: 'FH', 'Bundle-Ether': 'BE', Loopback: 'Lo', MgmtEth: 'Mg', BVI: 'BV', Null: 'Nu' };
const NX_SHORT = { Ethernet: 'Eth', 'port-channel': 'Po', Vlan: 'Vlan', loopback: 'Lo', mgmt: 'mgmt' };

export const OS = {
  ios: { family: 'cisco', vendor: 'Cisco', label: 'IOS', svi: (v) => `Vlan${v}`, lo: (n) => `Loopback${n}`, lag: (n) => `Port-channel${n}`, sub: (p, v) => `${p}.${v}`, fhrp: 'hsrp', mgmtVrf: null, types: Object.keys(CISCO_SHORT), short: CISCO_SHORT, prefixLogical: ['Vlan', 'Loopback', 'Port-channel', 'Tunnel', 'Null'] },
  iosxe: { family: 'cisco', vendor: 'Cisco', label: 'IOS XE', svi: (v) => `Vlan${v}`, lo: (n) => `Loopback${n}`, lag: (n) => `Port-channel${n}`, sub: (p, v) => `${p}.${v}`, fhrp: 'hsrp', mgmtVrf: 'Mgmt-vrf', types: [...Object.keys(CISCO_SHORT), 'AppGigabitEthernet'], short: CISCO_SHORT, prefixLogical: ['Vlan', 'Loopback', 'Port-channel', 'Tunnel', 'Null'] },
  nxos: { family: 'nxos', vendor: 'Cisco', label: 'NX-OS', svi: (v) => `Vlan${v}`, lo: (n) => `loopback${n}`, lag: (n) => `port-channel${n}`, sub: (p, v) => `${p}.${v}`, fhrp: 'hsrp', mgmtVrf: 'management', types: ['Ethernet', 'port-channel', 'Vlan', 'loopback', 'mgmt', 'Null'], short: NX_SHORT, prefixLogical: ['Vlan', 'loopback', 'port-channel'] },
  asa: { family: 'asa', vendor: 'Cisco', label: 'ASA', svi: (v) => `Vlan${v}`, lo: (n) => `Loopback${n}`, lag: (n) => `Port-channel${n}`, sub: (p, v) => `${p}.${v}`, fhrp: null, mgmtVrf: null, types: ['Ethernet', 'GigabitEthernet', 'TenGigabitEthernet', 'Management', 'Port-channel', 'Redundant'], short: { Ethernet: 'Et', GigabitEthernet: 'Gi', TenGigabitEthernet: 'Te', Management: 'Ma', 'Port-channel': 'Po' }, prefixLogical: ['Port-channel'] },
  iosxr: { family: 'iosxr', vendor: 'Cisco', label: 'IOS XR', svi: (v) => `BVI${v}`, lo: (n) => `Loopback${n}`, lag: (n) => `Bundle-Ether${n}`, sub: (p, v) => `${p}.${v}`, fhrp: 'vrrp', mgmtVrf: null, types: Object.keys(XR_SHORT), short: XR_SHORT, prefixLogical: ['Loopback', 'Bundle-Ether', 'BVI', 'Null'] },
  junos: { family: 'junos', vendor: 'Juniper', label: 'Junos', svi: (v) => `irb.${v}`, lo: () => 'lo0', lag: (n) => `ae${n}`, sub: (p, v) => `${p}.${v}`, fhrp: 'vrrp', mgmtVrf: null },
  evo: { family: 'junos', vendor: 'Juniper', label: 'Junos OS Evolved', svi: (v) => `irb.${v}`, lo: () => 'lo0', lag: (n) => `ae${n}`, sub: (p, v) => `${p}.${v}`, fhrp: 'vrrp', mgmtVrf: null },
  aoscx: { family: 'aoscx', vendor: 'HP / Aruba', label: 'AOS-CX', svi: (v) => `vlan${v}`, lo: (n) => `loopback${n}`, lag: (n) => `lag${n}`, sub: (p, v) => `${p}.${v}`, fhrp: 'vrrp', mgmtVrf: 'mgmt' },
  aoss: { family: 'aoss', vendor: 'HP / Aruba', label: 'AOS-Switch', svi: (v) => `VLAN${v}`, lo: (n) => `loopback${n}`, lag: (n) => `Trk${n}`, sub: (p, v) => `${p}.${v}`, fhrp: 'vrrp', mgmtVrf: 'oobm' },
  arubaos: { family: 'arubaos', vendor: 'HP / Aruba', label: 'ArubaOS', svi: (v) => `vlan${v}`, lo: (n) => `loopback${n}`, lag: (n) => `port-channel${n}`, sub: (p, v) => `${p}.${v}`, fhrp: 'vrrp', mgmtVrf: null },
  fortios: { family: 'fortios', vendor: 'Fortinet', label: 'FortiOS', svi: (v) => `vlan${v}`, lo: (n) => `loopback${n}`, lag: (n) => `agg${n}`, sub: (p, v) => `vlan${v}`, fhrp: 'vrrp', mgmtVrf: null },
  fortiswitch: { family: 'fortios', vendor: 'Fortinet', label: 'FortiSwitchOS', svi: (v) => `vlan${v}`, lo: (n) => `loopback${n}`, lag: (n) => `trunk${n}`, sub: (p, v) => `vlan${v}`, fhrp: null, mgmtVrf: null },
  fortiap: { family: 'fortiap', vendor: 'Fortinet', label: 'FortiAP' },
  apos: { family: 'apos', vendor: 'HP / Aruba', label: 'Aruba AP' },
};

export const osOf = (dev) => OS[dev.os] || OS.ios;

// Split "GigabitEthernet1/0/1" -> ["GigabitEthernet", "1/0/1"]
export function splitIf(name) {
  const m = String(name).match(/^([A-Za-z][A-Za-z-]*?)(\d.*)?$/);
  return m ? [m[1], m[2] || ''] : [name, ''];
}

// Short display name (Gi1/0/1, Eth1/1, Te0/0/0/0)
export function shortIf(dev, name) {
  const o = osOf(dev);
  if (!o.short) return name;
  const [t, n] = splitIf(name);
  const s = o.short[t];
  return s ? `${s}${n}` : name;
}

// Resolve a user-typed interface name for a device. Returns canonical name or null.
// allowCreate: logical interface types (Vlan/Loopback/Port-channel) that may not exist yet.
export function resolveIf(dev, input, { allowCreate = false } = {}) {
  if (!input) return null;
  const raw = String(input).trim();
  const ifs = dev.cfg.ifs;
  if (ifs[raw]) return raw;
  const lower = raw.toLowerCase();
  for (const n of Object.keys(ifs)) if (n.toLowerCase() === lower) return n;
  const o = osOf(dev);
  if (o.types) {
    const [t, num] = splitIf(raw);
    if (!num) return null;
    const tl = t.toLowerCase();
    const cands = o.types.filter((T) => T.toLowerCase().startsWith(tl));
    // Exact-short matches win (Te -> TenGigabitEthernet, Twe -> TwentyFiveGigE)
    const byShort = o.types.filter((T) => (o.short?.[T] || '').toLowerCase() === tl);
    const pool = byShort.length ? byShort : cands;
    const hits = [];
    for (const T of pool) {
      const full = `${T}${num}`;
      const found = Object.keys(ifs).find((n) => n.toLowerCase() === full.toLowerCase());
      if (found) hits.push(found);
      else if (allowCreate && (o.prefixLogical || []).includes(T)) hits.push(full);
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const existing = hits.filter((h) => ifs[h]);
      if (existing.length === 1) return existing[0];
    }
    return null;
  }
  // Non-Cisco: allow case-insensitive and Junos unit ".0"
  if (/\.0$/.test(raw) && ifs[raw.replace(/\.0$/, '')]) return raw.replace(/\.0$/, '');
  if (allowCreate) return raw;
  return null;
}

// Interface "type keywords" for completion (e.g. GigabitEthernet) present on a device
export function ifTypesPresent(dev) {
  const o = osOf(dev);
  const set = new Set();
  for (const n of Object.keys(dev.cfg.ifs)) set.add(splitIf(n)[0]);
  if (o.prefixLogical) o.prefixLogical.forEach((t) => set.add(t));
  return [...set];
}

export const VENDOR_COLORS = {
  Cisco: { face: '#2a5f8f', trim: '#1b3d5c', led: '#4fd1ff' },
  Juniper: { face: '#3b3f45', trim: '#22262b', led: '#7ddc4f' },
  'HP / Aruba': { face: '#8c8f94', trim: '#ff8300', led: '#ff9d2e' },
  Fortinet: { face: '#3a3a3a', trim: '#da291c', led: '#ff5a4a' },
};
