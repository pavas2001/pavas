// Shared bits for the Signal counter display and the staff app.
import { esc } from '/assets/lib.js';

export const TYPES = ['waiter', 'bill', 'water', 'order', 'togo'];
export const COLORS = { waiter: '#ff4f5e', bill: '#3f7dff', water: '#11b5e4', order: '#2fc46f', togo: '#a35dff', other: '#8495a1' };

export const T = {
  en: {
    waiter: 'Service', bill: 'Bill', water: 'Water', order: 'Ready to order', togo: 'To go', other: 'Help',
    live: 'Live', floor: 'Floor', cubes: 'Cubes', today: 'Today', open: 'Open', longest: 'Longest', avg: 'Avg reply',
    onway: 'On my way', done: 'Done', on_the_way: 'on the way', late: 'Late · whole floor alerted', clear: 'All clear. Nothing is waiting.',
    requests: 'Requests', waiting: 'Waiting', on_floor: 'On the floor', zone: 'Zone', no_zone: 'No zone', free: 'Free', min: 'min',
    chime_on: 'Chime on', chime_off: 'Chime off', evening: 'Evening mode', battery: 'Battery', offline: 'Offline', off_coaster: 'Off coaster',
    low_battery: 'Low battery', ok: 'OK', no_cubes: 'No cubes paired yet. Pair them from the staff app (Cubes tab).', total: 'Requests today', late_n: 'Late',
    fastest: 'Fastest', by_type: 'By request', by_staff: 'Answered by', nobody: 'Nobody has signed in on duty yet.', not_assigned: 'No table',
    via_qr: 'QR', via_cube: 'Cube', via_staff: 'Staff', back_office: 'Back office', staff_app: 'Staff app', sound_hint: 'Tap anywhere to turn on sound',
  },
  ml: {
    waiter: 'സർവീസ്', bill: 'ബിൽ', water: 'വെള്ളം', order: 'ഓർഡർ ചെയ്യാൻ', togo: 'പാഴ്സൽ', other: 'സഹായം',
    live: 'ലൈവ്', floor: 'ഫ്ലോർ', cubes: 'ക്യൂബുകൾ', today: 'ഇന്ന്', open: 'തുറന്നവ', longest: 'ഏറ്റവും നീണ്ടത്', avg: 'ശരാശരി മറുപടി',
    onway: 'വരുന്നു', done: 'കഴിഞ്ഞു', on_the_way: 'വരുന്നു', late: 'വൈകി · എല്ലാവരെയും അറിയിച്ചു', clear: 'ഒന്നും കാത്തിരിക്കുന്നില്ല.',
    requests: 'അഭ്യർത്ഥനകൾ', waiting: 'കാത്തിരിപ്പ്', on_floor: 'ഫ്ലോറിൽ', zone: 'സോൺ', no_zone: 'സോൺ ഇല്ല', free: 'ഒഴിവ്', min: 'മിനിറ്റ്',
    chime_on: 'ശബ്ദം ഓൺ', chime_off: 'ശബ്ദം ഓഫ്', evening: 'സന്ധ്യ മോഡ്', battery: 'ബാറ്ററി', offline: 'ഓഫ്‌ലൈൻ', off_coaster: 'കോസ്റ്ററിൽ ഇല്ല',
    low_battery: 'ബാറ്ററി കുറവ്', ok: 'ശരി', no_cubes: 'ഇതുവരെ ക്യൂബുകൾ ജോടിയാക്കിയിട്ടില്ല.', total: 'ഇന്നത്തെ അഭ്യർത്ഥനകൾ', late_n: 'വൈകിയവ',
    fastest: 'ഏറ്റവും വേഗം', by_type: 'തരം അനുസരിച്ച്', by_staff: 'മറുപടി നൽകിയവർ', nobody: 'ആരും ഡ്യൂട്ടിയിൽ കയറിയിട്ടില്ല.', not_assigned: 'ടേബിൾ ഇല്ല',
    via_qr: 'QR', via_cube: 'ക്യൂബ്', via_staff: 'സ്റ്റാഫ്', back_office: 'ബാക്ക് ഓഫീസ്', staff_app: 'സ്റ്റാഫ് ആപ്പ്', sound_hint: 'ശബ്ദം ഓണാക്കാൻ എവിടെയെങ്കിലും തൊടുക',
  },
};

const PATHS = {
  waiter: '<path d="M4 16h16M6 16a6 6 0 0 1 12 0M12 8v2M3 19h18"/>',
  bill: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>',
  water: '<path d="M12 3c-4 5.5-6 8.5-6 11.5a6 6 0 0 0 12 0C18 11.5 16 8.5 12 3z"/>',
  order: '<path d="M5 4h14v16H5zM8.5 9h7M8.5 13h7M8.5 17h4"/>',
  togo: '<path d="M4 9h16l-1.5 11h-13zM8 9V7a4 4 0 0 1 8 0v2"/>',
  other: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16v.5"/>',
};
export const icon = type => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[type] || PATHS.other}</svg>`;
export const tile = (type, extra = '') => `<span class="tile" style="background:${COLORS[type] || COLORS.other}">${icon(type)}${extra}</span>`;

/** Seconds since an ISO time, corrected by the server clock offset. */
let skew = 0;
export function syncClock(serverIso) { skew = Date.parse(serverIso) - Date.now(); }
export const ageS = iso => Math.max(0, Math.round((Date.now() + skew - Date.parse(iso)) / 1000));
export const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
export const shortLabel = l => esc(String(l || '').replace(/^Table\s*/i, ''));

// A short, different chime for each request type, so staff can tell them apart without looking.
const TONES = { waiter: [660, 880], bill: [988, 784, 988], water: [740], order: [523, 659, 784], togo: [784, 523], other: [600, 600], late: [880, 880] };
let ctx;
export function unlockAudio() { try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch { /* no audio */ } }
export function chimeFor(type) {
  try {
    unlockAudio();
    if (!ctx || ctx.state !== 'running') return false;
    const t0 = ctx.currentTime;
    (TONES[type] || TONES.other).forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = t0 + i * 0.17;
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.start(t); o.stop(t + 0.37);
    });
    return true;
  } catch { return false; }
}
