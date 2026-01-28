const CORE_NAME = 'mkxp-z';
const GAME_PATH: string | undefined = import.meta.env.VITE_GAME_PATH;
const XP_CONTROLS = import.meta.env.VITE_XP_CONTROLS !== undefined && import.meta.env.VITE_XP_CONTROLS !== 'false';

const SAVE_DIRECTORY = '/' + CORE_NAME + '/saves';
const STATE_DIRECTORY = '/' + CORE_NAME + '/states';

import { Nostalgist } from 'nostalgist';

// Force the user to interact with the browser once before starting the game;
// otherwise the audio will not work because audio is gated behind sticky activation
// (see https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/User_activation)
while (!navigator.userActivation.hasBeenActive) {
  const prompt = document.getElementById('user-activation-prompt');
  if (prompt !== null) {
    prompt.style['display'] = 'initial';
  }
  await new Promise<void>((resolve, reject) => {
    const events = ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend'];
    const listener = () => {
      try {
        for (const ev of events) {
          document.body.removeEventListener(ev, listener);
        }
      } catch (err) {
        reject(err);
        return;
      }
      resolve();
    };
    for (const ev of events) {
      document.body.addEventListener(ev, listener);
    }
  });
  if (prompt !== null) {
    prompt.style['display'] = 'none';
  }
}

const nostalgist = await Nostalgist.prepare({
  core: {
    name: CORE_NAME.replace(/-/g, '_'),
    js: './' + CORE_NAME + '_libretro.js',
    wasm: './' + CORE_NAME + '_libretro.wasm',
  },
  rom: GAME_PATH,
  element: '#nostalgist-canvas',
  retroarchConfig: {
    savefile_directory: SAVE_DIRECTORY,
    savestate_directory: STATE_DIRECTORY,
    input_toggle_fast_forward: 'space',
    input_hold_fast_forward: 'l',
    input_hold_slowmotion: 'e',
    input_menu_toggle: 'f1',
    input_save_state: 'f2',
    input_load_state: 'f4',
    input_state_slot_decrease: 'f6',
    input_state_slot_increase: 'f7',
    input_screenshot: 'f8',
    input_player1_a: XP_CONTROLS ? 'c' : 'z',
    input_player1_b: 'x',
    input_player1_x: XP_CONTROLS ? 'z' : 'shift',
    input_player1_y: 'a',
    input_player1_l3: 's',
    input_player1_r3: 'd',
    input_player1_l: 'q',
    input_player1_r: 'w',
    input_player1_l2: 'ctrl',
    input_player1_r2: 'rshift',
    input_player1_start: 'alt',
  },
});

// Persist saves and save states to IndexedDB so that the user doesn't lose all of their saves and save states whenever the page is reloaded or closed
const fs = nostalgist.getEmscriptenFS();
fs.mkdirTree(SAVE_DIRECTORY);
fs.mkdirTree(STATE_DIRECTORY);
fs.mount(fs.filesystems.IDBFS, {autoPersist: true}, SAVE_DIRECTORY);
fs.mount(fs.filesystems.IDBFS, {autoPersist: true}, STATE_DIRECTORY);
await new Promise<void>((resolve, reject) => {
  fs.syncfs(true, (err: Error | null) => {
    if (err === null) {
      resolve();
    } else {
      reject(err);
    }
  });
});

await nostalgist.start();
