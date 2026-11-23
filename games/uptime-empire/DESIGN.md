# Uptime Empire: architecture

A datacentre tycoon where every network device has a realistic, stateful CLI. This document is the map for contributors (and for future maintenance).

## Big idea: one network model, many CLIs

Every device stores its configuration in a **vendor-neutral model** (`device.cfg`). The **simulator** (`js/net/sim.js`) computes the live network from those models: links, VLANs/STP, routing, FHRP, firewall policy, NAT, packet paths. Every **CLI dialect** (`js/cli/*.js`) is a view/controller on the same model: `show` commands render model + sim state in that vendor's exact format, and config commands mutate the model through helpers in `js/net/model.js`.

Consequences:
- A fault such as "wrong access VLAN" is written once (`js/game/faults.js`) and works on every switch OS.
- Replacing a Cisco core with a Juniper core keeps the logical network; the builder re-renders it.
- `js/game/recipes.js` turns each fault's abstract fix ("enable this interface", "add VLAN 103 to this trunk") into the exact commands for the device's OS. These power the in-game hints *and* the automated tests (inject fault → type the recipe into the real CLI → assert the service recovers), so every OS is proven able to fix every fault it can have.

## Modules

| Path | Role |
|---|---|
| `data/devices.json` | Hardware catalog: models, years, End-of-Sale/End-of-Life, ports, OS family, features. OS version timelines. |
| `data/facilities.json` | Racks, PDUs, UPS, cooling, generators, patch panels, spares. |
| `data/advisories.json` | Simulated vendor bug/security advisories for the patch calendar. |
| `data/campaign.json` | Chapters, goals and scripted set-piece events. |
| `js/core/util.js` | IP maths, VLAN lists, formatting, RNG. |
| `js/net/catalog.js` | Loads the catalog; port naming; OS metadata (prompts, naming conventions). |
| `js/net/model.js` | Creates devices; canonical config mutations (`setAdmin`, `setAccessVlan`, `addStatic`, ...). |
| `js/net/builder.js` | Source of truth → network. Wires devices by role, renders configs, onboards customers, generates docs (IPAM, cable patching schedule, topology). |
| `js/net/sim.js` | Computes link/L2/L3 state, routes, adjacencies; `walk()` traces packets; `checks()` evaluates monitoring; utilisation; event/log generation. |
| `js/cli/engine.js` | Grammar compiler (keywords, args, optional, alternatives, repeats), abbreviation, `?` help, tab completion, pipes, errors. |
| `js/cli/*.js` | Dialects: `ios.js` (IOS/IOS XE), `nxos.js`, `asa.js`, `iosxr.js`, `junos.js` (+EVO), `aruba.js` (AOS-CX, AOS-Switch, ArubaOS, AP boot), `fortios.js` (FortiOS, FortiSwitch, FortiAP), `linux.js` (jump host and servers). `common.js` holds shared ping/trace/counters helpers; `registry.js`/`index.js` register dialects. |
| `js/net/events.js`, `js/net/devops.js` | State diffs → syslog events; reload/boot/power and Junos commit-confirmed rollback. |
| `js/game/faults.js` | Fault catalog: targets, inject, fixed?, ticket text per difficulty, RCA truth, hints, fix ops. |
| `js/game/recipes.js` | Fix ops → exact per-OS commands (hints and tests). |
| `js/game/facility.js` | Racks, A/B feeds, UPS, generator, cooling, temperatures, physical actions. |
| `js/game/game.js` | Clock, difficulty, economy, leads, tickets/SLA/RCA, changes, advisories, campaign and set pieces, saves. |
| `js/ui/dom.js`, `js/ui/terminal.js` | DOM helpers; terminal widget and dock. |
| `js/views/*.js` | Screens: `infra.js` (data hall, racks, device panel, topology), `ops.js` (tickets, NOC), `docs.js`, `biz.js` (shop, customers, changes, finance, goals). |

## World model (save file)

```
world
  time.t            game minutes since 1995-01-01 00:00 (calendar)
  devices[id]       Device
  hosts[id]         Host: servers, service VMs, jump host, ISP routers, probes, Wi-Fi clients
  links[]           Link: physical cables (optionally via a patch panel)
  design            source of truth: roles, ISPs, customers, addressing
  tickets, faults, changes, advisories, backups, kb, campaign ...

Device
  id, model, os, version, hostname, role, rack, u, state ('up'|'booting'|'off')
  cfg               running config (canonical)
  startup           saved config (loaded on reboot; unsaved changes are lost)
  hw                PSUs, fans, optics (DOM), temperature
  run               counters, logs, err-disabled ports, FHRP state, uptime

cfg
  hostname, ifs{name: If}, vlans{id: name}, stp, static[], ospf, bgp,
  acls{}, fw{policies, vips, snat, zones}, nat{...}, svc{ntp, dns, snmp, syslog, users, ssh}, wlc, ap

If
  kind ('phys'|'svi'|'lo'|'lag'|'mgmt'|'sub'|'serial'), on, desc,
  sw {mode, vlan, native, allowed}  -- switchport (null when routed)
  ip 'a.b.c.d/len', vrf, fhrp {proto, grp, vip, prio, preempt},
  ospf {area, cost, hello, dead, passive}, mtu, speed, duplex,
  lag {id, mode}, stp {edge, bpduguard}, helper[], acl {in, out}, zone, seclvl, allow[]
```

## Conventions

- Interface names are stored in each OS's **full canonical form** (`GigabitEthernet1/0/1`, `ge-0/0/1`, `1/1/1`, `port1`). Dialects resolve abbreviations.
- Addressing plan (source of truth): OOB management `10.250.0.0/24` (jump host `.10`), loopbacks `10.255.0.0/24`, transit `/30`s from `10.0.0.0/24`, services VLAN 20 `10.20.0.0/24`, office VLANs 30-32, customer *k* = VLAN `100+k`, subnet `10.100.k.0/24`, public `192.0.2.0/24`, ISP links `203.0.113.0/30` and `203.0.113.4/30`, internet probe `198.51.100.77`.
- Game data is plain JSON; `tools/validate.mjs` checks it (run via `npm run validate`).
- Dates and model years in the catalog are approximate.
