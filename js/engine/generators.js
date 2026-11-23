// Procedural question generators: endless subnetting drills, binary conversion and port numbers.
// Each generator returns a ready-to-ask question instance with a worked explanation.

// ---------- IPv4 helpers (exported for tests) ----------
export function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
export function intToIp(n) {
  n >>>= 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
export function prefixToMaskInt(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}
export function prefixToMask(prefix) {
  return intToIp(prefixToMaskInt(prefix));
}
export function maskToPrefix(mask) {
  const n = ipToInt(mask);
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) bits++;
    else break;
  }
  return bits;
}
export function wildcardFor(prefix) {
  return intToIp(~prefixToMaskInt(prefix) >>> 0);
}
export function networkOf(ip, prefix) {
  return intToIp((ipToInt(ip) & prefixToMaskInt(prefix)) >>> 0);
}
export function broadcastOf(ip, prefix) {
  return intToIp((ipToInt(ip) | (~prefixToMaskInt(prefix) >>> 0)) >>> 0);
}
export function usableHosts(prefix) {
  if (prefix >= 31) return prefix === 31 ? 2 : 1;
  return 2 ** (32 - prefix) - 2;
}
export function firstHost(ip, prefix) {
  return intToIp(ipToInt(networkOf(ip, prefix)) + 1);
}
export function lastHost(ip, prefix) {
  return intToIp(ipToInt(broadcastOf(ip, prefix)) - 1);
}
export function smallestPrefixFor(hosts) {
  for (let p = 30; p >= 1; p--) if (usableHosts(p) >= hosts) return p;
  return 0;
}
export function ipClass(ip) {
  const o = Number(ip.split('.')[0]);
  if (o < 128) return 'A';
  if (o < 192) return 'B';
  if (o < 224) return 'C';
  if (o < 240) return 'D';
  return 'E';
}
export function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function toBin8(n) {
  return n.toString(2).padStart(8, '0');
}

// ---------- random address helpers ----------
function randomPrefix(rng, difficulty) {
  if (difficulty <= 1) return rng.int(25, 30);
  if (difficulty === 2) return rng.pick([17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 29]);
  return rng.pick([9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22]);
}

function randomHostIp(rng, prefix) {
  // Pick a private range that is large enough for the prefix so the question feels realistic.
  let base;
  if (prefix >= 24) base = rng.pick([[192, 168, rng.int(0, 255)], [10, rng.int(0, 255), rng.int(0, 255)], [172, rng.int(16, 31), rng.int(0, 255)]]);
  else if (prefix >= 16) base = rng.pick([[172, rng.int(16, 31)], [10, rng.int(0, 255)]]);
  else base = [10];
  const octets = [...base];
  while (octets.length < 4) octets.push(rng.int(0, 255));
  let ip = octets.join('.');
  // Never hand out the network or broadcast address as the "host" in the question.
  const net = networkOf(ip, prefix);
  const bc = broadcastOf(ip, prefix);
  if (ip === net) ip = intToIp(ipToInt(ip) + rng.int(1, Math.min(200, usableHosts(prefix))));
  if (ip === bc) ip = intToIp(ipToInt(ip) - rng.int(1, Math.min(200, usableHosts(prefix))));
  return ip;
}

function randomPublicIp(rng) {
  const firstOctets = [];
  for (let i = 1; i <= 223; i++) {
    if ([10, 100, 127, 169, 172, 192].includes(i)) continue;
    firstOctets.push(i);
  }
  return [rng.pick(firstOctets), rng.int(0, 255), rng.int(0, 255), rng.int(1, 254)].join('.');
}

// Explains the "magic number" (block size) method for a given address/prefix.
export function explainBlock(ip, prefix) {
  const mask = prefixToMask(prefix);
  const net = networkOf(ip, prefix);
  const bc = broadcastOf(ip, prefix);
  if (prefix % 8 === 0) {
    const keep = prefix / 8;
    return `/${prefix} = ${mask}. The mask ends exactly on an octet boundary, so keep the first ${keep} octet${keep === 1 ? '' : 's'}: network ${net}, broadcast ${bc}.`;
  }
  const k = Math.floor(prefix / 8);
  const maskOctet = Number(mask.split('.')[k]);
  const block = 256 - maskOctet;
  const v = Number(ip.split('.')[k]);
  const start = Math.floor(v / block) * block;
  const ord = ['1st', '2nd', '3rd', '4th'][k];
  return `/${prefix} = ${mask}. The interesting octet is the ${ord} (mask ${maskOctet}), so the block size is 256 − ${maskOctet} = ${block}. ${v} falls in the ${start}–${start + block - 1} block → network ${net}, broadcast ${bc}.`;
}

function prefixAnswers(p) {
  return [`/${p}`, `${p}`];
}

// ---------- generators ----------
export const GENERATORS = {
  'subnet-network': {
    topic: 'Subnetting',
    make(rng, d) {
      const p = randomPrefix(rng, d);
      const ip = randomHostIp(rng, p);
      return {
        type: 'input',
        q: `What is the NETWORK (subnet ID) address of ${ip}/${p}?`,
        answers: [networkOf(ip, p)],
        placeholder: 'e.g. 10.0.0.0',
        explain: explainBlock(ip, p),
        hint: 'Find the block size: 256 minus the mask value in the "interesting" octet.',
      };
    },
  },
  'subnet-broadcast': {
    topic: 'Subnetting',
    make(rng, d) {
      const p = randomPrefix(rng, d);
      const ip = randomHostIp(rng, p);
      return {
        type: 'input',
        q: `What is the BROADCAST address of ${ip}/${p}?`,
        answers: [broadcastOf(ip, p)],
        placeholder: 'e.g. 10.0.0.255',
        explain: explainBlock(ip, p) + ' The broadcast is the last address in the block (next network − 1).',
        hint: 'Broadcast = next subnet ID minus one.',
      };
    },
  },
  'subnet-first-last': {
    topic: 'Subnetting',
    make(rng, d) {
      const p = rng.pick(d <= 1 ? [25, 26, 27, 28, 29, 30] : [20, 21, 22, 23, 26, 27, 28]);
      const ip = randomHostIp(rng, p);
      const first = rng.chance(0.5);
      return {
        type: 'input',
        q: `What is the ${first ? 'FIRST' : 'LAST'} usable host address in the subnet containing ${ip}/${p}?`,
        answers: [first ? firstHost(ip, p) : lastHost(ip, p)],
        placeholder: 'e.g. 10.0.0.1',
        explain: `${explainBlock(ip, p)} First usable = network + 1 (${firstHost(ip, p)}), last usable = broadcast − 1 (${lastHost(ip, p)}).`,
        hint: 'Work out the network and broadcast first.',
      };
    },
  },
  'subnet-hosts': {
    topic: 'Subnetting',
    make(rng, d) {
      const p = d <= 1 ? rng.int(24, 30) : d === 2 ? rng.int(17, 23) : rng.int(9, 16);
      const n = usableHosts(p);
      return {
        type: 'input',
        q: `How many USABLE host addresses are in a /${p} subnet?`,
        answers: [String(n)],
        placeholder: 'number',
        explain: `A /${p} leaves ${32 - p} host bits. 2^${32 - p} = ${(2 ** (32 - p)).toLocaleString('en-US')} addresses, minus 2 (network + broadcast) = ${n.toLocaleString('en-US')} usable hosts.`,
        hint: 'Usable hosts = 2^(host bits) − 2.',
      };
    },
  },
  'subnet-mask': {
    topic: 'Subnetting',
    make(rng, d) {
      const p = d <= 1 ? rng.pick([8, 16, 24, 25, 26, 27, 28, 29, 30]) : rng.int(9, 30);
      return {
        type: 'input',
        q: `Write the /${p} prefix as a dotted-decimal subnet mask.`,
        answers: [prefixToMask(p)],
        placeholder: 'e.g. 255.255.255.0',
        explain: `/${p} = ${p} ones followed by ${32 - p} zeros = ${prefixToMask(p)}. Remember the octet values: 128, 192, 224, 240, 248, 252, 254, 255.`,
        hint: 'Mask octet values go 128, 192, 224, 240, 248, 252, 254, 255.',
      };
    },
  },
  'subnet-prefix': {
    topic: 'Subnetting',
    make(rng, d) {
      const p = d <= 1 ? rng.pick([8, 16, 24, 25, 26, 27, 28, 29, 30]) : rng.int(9, 30);
      return {
        type: 'input',
        q: `What CIDR prefix length is the mask ${prefixToMask(p)}?`,
        answers: prefixAnswers(p),
        placeholder: 'e.g. /24',
        explain: `Count the 1 bits: ${prefixToMask(p)
          .split('.')
          .map((o) => toBin8(Number(o)))
          .join('.')} → ${p} ones → /${p}.`,
        hint: '255 = 8 bits; 128=1, 192=2, 224=3, 240=4, 248=5, 252=6, 254=7.',
      };
    },
  },
  'subnet-fit': {
    topic: 'Subnetting',
    make(rng, d) {
      const hosts = d <= 1 ? rng.int(3, 120) : d === 2 ? rng.int(100, 2000) : rng.int(1500, 60000);
      const p = smallestPrefixFor(hosts);
      return {
        type: 'input',
        q: `A LAN needs ${hosts.toLocaleString('en-US')} hosts. What is the LONGEST prefix (smallest subnet) that fits?`,
        answers: prefixAnswers(p),
        placeholder: 'e.g. /26',
        explain: `You need 2^h − 2 ≥ ${hosts}. h = ${32 - p} host bits gives ${usableHosts(p).toLocaleString('en-US')} usable (h = ${31 - p} would give only ${usableHosts(p + 1).toLocaleString('en-US')}). 32 − ${32 - p} = /${p}.`,
        hint: 'Find the smallest power of two that is at least hosts + 2.',
      };
    },
  },
  'subnet-count': {
    topic: 'Subnetting',
    make(rng, d) {
      const from = d <= 1 ? 24 : rng.pick([16, 20, 22, 24]);
      const to = Math.min(30, from + rng.int(1, d <= 1 ? 6 : 8));
      const n = 2 ** (to - from);
      return {
        type: 'input',
        q: `How many /${to} subnets can you carve out of one /${from}?`,
        answers: [String(n)],
        placeholder: 'number',
        explain: `Borrowed bits = ${to} − ${from} = ${to - from}. 2^${to - from} = ${n} subnets.`,
        hint: 'Subnets = 2^(borrowed bits).',
      };
    },
  },
  'wildcard-mask': {
    topic: 'Wildcard masks',
    make(rng, d) {
      const p = d <= 1 ? rng.pick([24, 16, 30, 32, 8]) : rng.int(16, 30);
      return {
        type: 'input',
        q: `What WILDCARD mask matches a /${p} network (as used in ACLs and OSPF network statements)?`,
        answers: [wildcardFor(p)],
        placeholder: 'e.g. 0.0.0.255',
        explain: `Wildcard = 255.255.255.255 − subnet mask. 255.255.255.255 − ${prefixToMask(p)} = ${wildcardFor(p)}.`,
        hint: 'Subtract each mask octet from 255.',
      };
    },
  },
  'same-subnet': {
    topic: 'Subnetting',
    make(rng, d) {
      const p = d <= 1 ? rng.int(25, 29) : rng.pick([20, 21, 22, 26, 27, 28, 29]);
      const a = randomHostIp(rng, p);
      const same = rng.chance(0.5);
      const blockSize = 2 ** (32 - p);
      const net = ipToInt(networkOf(a, p));
      let b;
      if (same) {
        b = intToIp(net + rng.int(1, blockSize - 2));
      } else {
        const dir = rng.chance(0.5) ? 1 : -1;
        const other = net + dir * blockSize;
        const otherNet = other < 0 || other > 0xffffffff - blockSize ? net + blockSize : other;
        b = intToIp(otherNet + rng.int(1, blockSize - 2));
      }
      const correct = networkOf(a, p) === networkOf(b, p);
      return {
        type: 'mc',
        q: `Are ${a}/${p} and ${b}/${p} in the SAME subnet?`,
        choices: ['Yes, same subnet', 'No, different subnets'],
        answer: correct ? 0 : 1,
        noShuffle: true,
        explain: `${a} → network ${networkOf(a, p)}; ${b} → network ${networkOf(b, p)}. ${correct ? 'Same network, so they can talk without a router.' : 'Different networks, so traffic between them needs a router.'}`,
        hint: 'Compute the network address of each one.',
      };
    },
  },
  'ip-class': {
    topic: 'IP addressing',
    make(rng) {
      const cls = rng.pick(['A', 'B', 'C', 'D']);
      const first = { A: rng.int(1, 126), B: rng.int(128, 191), C: rng.int(192, 223), D: rng.int(224, 239) }[cls];
      const ip = [first, rng.int(0, 255), rng.int(0, 255), rng.int(1, 254)].join('.');
      return {
        type: 'mc',
        q: `Which classful address class does ${ip} belong to?`,
        choices: ['Class A', 'Class B', 'Class C', 'Class D (multicast)'],
        answer: ['A', 'B', 'C', 'D'].indexOf(cls),
        noShuffle: true,
        explain: `First octet ${first}. Class A = 1–126, B = 128–191, C = 192–223, D = 224–239 (multicast), E = 240–255. (127 is loopback.)`,
        hint: 'Look only at the first octet.',
      };
    },
  },
  'ip-private': {
    topic: 'IP addressing',
    make(rng) {
      const priv = rng.pick([
        `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
        `172.${rng.int(16, 31)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
        `192.168.${rng.int(0, 255)}.${rng.int(1, 254)}`,
      ]);
      const decoys = new Set();
      const tricky = [`172.${rng.pick([15, 32, 33, 40])}.${rng.int(0, 255)}.${rng.int(1, 254)}`, `192.169.${rng.int(0, 255)}.${rng.int(1, 254)}`, `11.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`];
      decoys.add(rng.pick(tricky));
      while (decoys.size < 3) decoys.add(randomPublicIp(rng));
      return {
        type: 'mc',
        q: 'Which of these is a PRIVATE (RFC 1918) address?',
        choices: [priv, ...decoys],
        answer: 0,
        explain: `${priv} is private. RFC 1918 ranges: 10.0.0.0/8, 172.16.0.0/12 (172.16.0.0–172.31.255.255) and 192.168.0.0/16. Watch for look-alikes such as 172.32.x.x or 192.169.x.x, which are public.`,
        hint: '10/8, 172.16/12, 192.168/16.',
      };
    },
  },
  'bin-to-dec': {
    topic: 'Binary',
    make(rng) {
      const n = rng.int(1, 255);
      const bits = toBin8(n);
      const parts = bits
        .split('')
        .map((b, i) => (b === '1' ? 2 ** (7 - i) : 0))
        .filter(Boolean);
      return {
        type: 'input',
        q: `Convert the binary octet ${bits} to decimal.`,
        answers: [String(n)],
        placeholder: '0-255',
        explain: `Bit values: 128 64 32 16 8 4 2 1. ${bits} = ${parts.join(' + ')} = ${n}.`,
        hint: 'Add up the place values of the 1 bits: 128 64 32 16 8 4 2 1.',
      };
    },
  },
  'dec-to-bin': {
    topic: 'Binary',
    make(rng) {
      const n = rng.int(1, 255);
      const bits = toBin8(n);
      return {
        type: 'input',
        q: `Convert ${n} to an 8-bit binary octet.`,
        answers: [bits, bits.replace(/^0+/, '') || '0', bits.slice(0, 4) + ' ' + bits.slice(4)],
        placeholder: 'e.g. 11000000',
        explain: `Subtract place values from the left: 128 64 32 16 8 4 2 1 → ${bits}.`,
        hint: 'Is it ≥128? Then put a 1 and subtract 128. Repeat with 64, 32 ...',
      };
    },
  },
  'port-number': {
    topic: 'Ports & protocols',
    make(rng, d) {
      const pool = d <= 1 ? PORTS.filter((p) => p.common) : PORTS;
      const p = rng.pick(pool);
      return {
        type: 'input',
        q: `What is the default port number for ${p.name}?`,
        answers: [String(p.port)],
        placeholder: 'port number',
        explain: `${p.name} uses ${p.proto} ${p.port}. ${p.note || ''}`.trim(),
        hint: `It runs over ${p.proto}.`,
      };
    },
  },
  'port-protocol': {
    topic: 'Ports & protocols',
    make(rng, d) {
      const pool = d <= 1 ? PORTS.filter((p) => p.common) : PORTS;
      const p = rng.pick(pool);
      const decoys = rng.shuffle(PORTS.filter((x) => x.port !== p.port && x.short !== p.short)).slice(0, 3);
      return {
        type: 'mc',
        q: `Which protocol uses ${p.proto} port ${p.port} by default?`,
        choices: [p.short, ...decoys.map((x) => x.short)],
        answer: 0,
        explain: `${p.proto} ${p.port} = ${p.name}. ${p.note || ''}`.trim(),
        hint: p.port < 100 ? 'It is one of the "well-known" ports below 100.' : 'Think about what service would sit on this port.',
      };
    },
  },
};

export const PORTS = [
  { port: 20, short: 'FTP (data)', name: 'FTP data transfer', proto: 'TCP', common: false, note: 'FTP uses 21 for control and 20 for active-mode data.' },
  { port: 21, short: 'FTP (control)', name: 'FTP control', proto: 'TCP', common: true, note: 'Port 20 carries active-mode data.' },
  { port: 22, short: 'SSH', name: 'SSH (Secure Shell, also SCP/SFTP)', proto: 'TCP', common: true, note: 'Always prefer SSH over Telnet: it is encrypted.' },
  { port: 23, short: 'Telnet', name: 'Telnet', proto: 'TCP', common: true, note: 'Telnet sends everything, including passwords, in clear text.' },
  { port: 25, short: 'SMTP', name: 'SMTP (sending email)', proto: 'TCP', common: true },
  { port: 53, short: 'DNS', name: 'DNS', proto: 'UDP/TCP', common: true, note: 'Queries normally use UDP; zone transfers and large responses use TCP.' },
  { port: 67, short: 'DHCP (server)', name: 'DHCP server', proto: 'UDP', common: true, note: 'Clients listen on UDP 68.' },
  { port: 68, short: 'DHCP (client)', name: 'DHCP client', proto: 'UDP', common: false, note: 'Servers listen on UDP 67.' },
  { port: 69, short: 'TFTP', name: 'TFTP', proto: 'UDP', common: false, note: 'Often used to copy IOS images and configs. No authentication.' },
  { port: 80, short: 'HTTP', name: 'HTTP', proto: 'TCP', common: true },
  { port: 110, short: 'POP3', name: 'POP3 (retrieving email)', proto: 'TCP', common: false },
  { port: 123, short: 'NTP', name: 'NTP (time sync)', proto: 'UDP', common: true },
  { port: 143, short: 'IMAP', name: 'IMAP (retrieving email)', proto: 'TCP', common: false },
  { port: 161, short: 'SNMP', name: 'SNMP (polling)', proto: 'UDP', common: true, note: 'Traps are sent to UDP 162.' },
  { port: 162, short: 'SNMP traps', name: 'SNMP traps', proto: 'UDP', common: false },
  { port: 389, short: 'LDAP', name: 'LDAP', proto: 'TCP', common: false },
  { port: 443, short: 'HTTPS', name: 'HTTPS (HTTP over TLS)', proto: 'TCP', common: true, note: 'REST APIs and RESTCONF usually run here too.' },
  { port: 445, short: 'SMB', name: 'SMB (Windows file sharing)', proto: 'TCP', common: false },
  { port: 514, short: 'Syslog', name: 'Syslog', proto: 'UDP', common: true },
  { port: 636, short: 'LDAPS', name: 'LDAP over TLS', proto: 'TCP', common: false },
  { port: 830, short: 'NETCONF', name: 'NETCONF over SSH', proto: 'TCP', common: false, note: 'NETCONF uses XML-encoded RPCs over SSH.' },
  { port: 3306, short: 'MySQL', name: 'MySQL', proto: 'TCP', common: false },
  { port: 3389, short: 'RDP', name: 'RDP (Remote Desktop)', proto: 'TCP', common: true },
  { port: 5060, short: 'SIP', name: 'SIP (VoIP signaling)', proto: 'UDP/TCP', common: false },
];
