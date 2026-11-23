// Registers every CLI dialect. Import this once (the game does) before opening terminals.
import { register } from './registry.js';
import { LINUX } from './linux.js';
import { makeIOS } from './ios.js';
import { makeNXOS } from './nxos.js';
import { makeASA } from './asa.js';
import { makeJunos } from './junos.js';
import { makeFortiOS, makeFortiAP } from './fortios.js';
import { makeAOSCX, makeAOSS, makeArubaOS, makeAPBoot } from './aruba.js';
import { makeIOSXR } from './iosxr.js';

register('linux', LINUX);
register('ios', makeIOS(false));
register('iosxe', makeIOS(true));
register('nxos', makeNXOS());
register('asa', makeASA());
register('junos', makeJunos(false));
register('evo', makeJunos(true));
register('fortios', makeFortiOS('fortigate'));
register('fortiswitch', makeFortiOS('fortiswitch'));
register('fortiap', makeFortiAP());
register('aoscx', makeAOSCX());
register('aoss', makeAOSS());
register('arubaos', makeArubaOS());
register('apos', makeAPBoot());
register('iosxr', makeIOSXR());

export { getDialect } from './registry.js';
