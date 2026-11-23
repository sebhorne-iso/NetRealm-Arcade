# Uptime Empire

A datacentre tycoon where every switch, router and firewall has a realistic command line.

Start in 1995 with a Cisco 2514 and a Catalyst 1924 in a leased cage. Sign customers, rack equipment from each era (Cisco, Juniper, HP/Aruba, Fortinet), keep every service inside its SLA, and grow into a modern data centre with redundant cores, BGP to two ISPs and an office Wi-Fi network. Things break - by themselves, because of old firmware, because of facilities, and sometimes because of you.

## What makes it a study tool

- **Real CLIs.** IOS, IOS XE, NX-OS, ASA, IOS XR, Junos, Junos Evolved, AOS-CX, AOS-Switch (ProCurve), ArubaOS, FortiOS, FortiSwitch, FortiAP, the Aruba AP boot loader and Linux. Abbreviations, `?` help, Tab completion, output pipes, `--More--`, vendor-accurate errors, enable/config modes, `write memory`, Junos and IOS XR candidate configuration with `commit`, `commit confirmed`, `rollback` and `show | compare`, NX-OS and AOS-CX checkpoints, FortiOS `config/edit/set/next/end`.
- **Real troubleshooting.** About 40 fault types: cabling, err-disabled ports and BPDU guard, VLANs and trunks, native VLAN mismatches, duplex, optics, LACP, SVIs, static routes, OSPF (timers, areas, MTU, passive, router-ID), BGP (shutdown, remote-AS, maximum-prefix, IOS XR route-policy), NAT, firewall policies and VIPs, ACLs, MTU black holes, broadcast storms, DHCP relay, server problems, power and cooling, and firmware bugs from a patch calendar.
- **Real tools.** A jump host with ssh/telnet/console, ping, traceroute, `nc`, `curl`, server consoles with `ip`, `ethtool`, `systemctl`, `journalctl`, `tcpdump`; ASA `packet-tracer` and `capture`, FortiGate `diagnose debug flow` and `diagnose sniffer`, Junos `monitor traffic`; monitoring, central syslog, IPAM, a cable patching schedule, a topology diagram, a password vault, nightly config backups with diffs, runbooks and a cross-vendor command reference.
- **Real process.** Vague customer tickets, SLA timers, service credits, maintenance windows, change management, and a scored root-cause analysis for every incident.

## Difficulty

| Level | What changes |
|---|---|
| Entry level | Tickets point at the problem, accurate docs, step-by-step hints with exact commands, the SLA clock pauses while you type, loans when you run out of cash. Layer 1-2 faults. |
| Associate | Symptoms instead of causes, hints cost reputation, 20-minute SLA, switching, routing basics, servers, optics, power. |
| Professional | Vague tickets, stale documentation, two hints at most, 12-minute SLA, change windows enforced, occasional double faults, bankruptcy. Adds OSPF, NAT, firewalls, LACP. |
| Expert | "It's broken." No hints, documentation drift, red-herring logs, 8-minute SLA, compound faults across BGP, OSPF, NAT and MTU. |

## Campaign

Nine chapters from 1995 to 2024, each with goals and some with historical set pieces: the 2003 SQL Slammer worm, the 2012 leap second, Heartbleed in 2014 and an upstream route leak. Sandbox mode lets you start in any year with any budget.

## Playing

Serve the repository root over HTTP (`npm start`) and open `games/uptime-empire/`. The game autosaves to `localStorage` under the `arcade.uptime-empire.v1` key.

Quick start: in the terminal at the bottom, `cat /etc/hosts`, then `telnet edge1` (1995 IOS has no SSH yet) or `ssh admin@<device>` later on. Passwords live in Docs > Vault. `console <name>` reaches any device or customer server even when the network is down.

## Development

- Architecture: [DESIGN.md](DESIGN.md).
- Tests: `npm test` from the repository root runs `games/uptime-empire/tests/*.test.js`. The fault tests inject every fault into nine vendor mixes and fix it by typing the hinted commands into the simulated CLIs; the game tests play months headlessly on every difficulty.
- Data checks: `npm run validate` runs `tools/validate.mjs`.

Vendor and product names describe the simulated platforms only. This project is not affiliated with or endorsed by any vendor, and device behaviour is a simplified simulation. Advisories in the patch calendar are invented (IDs start with `UE-`), apart from well-known historical events summarised in general terms.
