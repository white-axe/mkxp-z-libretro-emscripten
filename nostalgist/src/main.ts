const CORE_NAME = 'mkxp-z';
const GAME_PATH: string | undefined = import.meta.env.VITE_GAME_PATH;
const XP_CONTROLS = import.meta.env.VITE_XP_CONTROLS !== undefined && import.meta.env.VITE_XP_CONTROLS !== 'false';

const SAVE_DIRECTORY = '/' + CORE_NAME + '/saves';
const STATE_DIRECTORY = '/' + CORE_NAME + '/states';

import { Nostalgist } from 'nostalgist';
import { Spinner } from 'spin.js';

let spinner: Spinner | null = null;
const spinnerTarget = document.getElementById('spinner-target');
if (spinnerTarget !== null) {
  spinner = new Spinner().spin(spinnerTarget);
}

// Disable bfcache because it causes the WebAssembly module to crash when this page is restored from bfcache
window.addEventListener('pageshow', (ev) => {
  if (ev.persisted) {
    location.reload();
  }
});

// Fetches a file and caches it in IndexedDB to improve subsequent load times
const fetchWithCache = (path: string) => async () => {
  path = new URL(path, location.href).toString();

  let blob: Blob | undefined = undefined;

  const getCacheStore = () => {
    const openRequest = indexedDB.open(CORE_NAME, 1);
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      db.createObjectStore('cache', {keyPath: 'path'});
    };
    return openRequest;
  };

  const headers = (await fetch(path, {method: 'HEAD'})).headers;
  const etag = headers.get('ETag');
  const lastModified = headers.get('Last-Modified');

  if (etag !== null || lastModified !== null) {
    try {
      const result = await new Promise<{blob: Blob, etag: string | null, lastModified: string | null} | undefined>((resolve, reject) => {
        try {
          const openRequest = getCacheStore();
          openRequest.onsuccess = () => {
            try {
              const db = openRequest.result;
              const tx = db.transaction('cache', 'readonly');
              const store = tx.objectStore('cache');
              const getRequest = store.get(path);
              getRequest.onsuccess = () => {
                resolve(getRequest.result);
              };
              getRequest.onerror = () => {
                reject(getRequest.error);
              };
            } catch (err) {
              reject(err);
            }
          };
          openRequest.onerror = () => {
            reject(openRequest.error);
          };
        } catch (err) {
          reject(err);
        }
      });
      if (result !== undefined && result.etag === etag && result.lastModified == lastModified) {
        blob = result.blob;
      }
    } catch (err) {
      console.error(err);
    }
  }

  if (blob === undefined) {
    const response = await fetch(path);
    blob = await response.blob();

    try {
      await new Promise<void>((resolve, reject) => {
        try {
          const openRequest = getCacheStore();
          openRequest.onsuccess = () => {
            try {
              const db = openRequest.result;
              const tx = db.transaction('cache', 'readwrite');
              const store = tx.objectStore('cache');
              const putRequest = store.put({path, blob, etag: response.headers.get('ETag'), lastModified: response.headers.get('Last-Modified')});
              putRequest.onsuccess = () => {
                resolve();
              };
              putRequest.onerror = () => {
                reject(putRequest.error);
              };
            } catch (err) {
              reject(err);
            }
          };
          openRequest.onerror = () => {
            reject(openRequest.error);
          };
        } catch (err) {
          reject(err);
        }
      });
    } catch (err) {
      console.error(err);
    }
  }

  return blob;
};

const nostalgist = await Nostalgist.prepare({
  core: {
    name: CORE_NAME.replace(/-/g, '_'),
    js: './' + CORE_NAME + '_libretro.js',
    wasm: fetchWithCache('./' + CORE_NAME + '_libretro.wasm'),
  },
  rom: fetchWithCache(GAME_PATH ?? ''),
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

spinner?.stop();

// Force the user to interact with the browser once before starting the game;
// otherwise the audio will not work because audio is gated behind sticky activation
// (see https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/User_activation)
while (!navigator.userActivation.hasBeenActive) {
  const prompt = document.getElementById('user-activation-prompt');
  if (prompt !== null) {
    prompt.style.display = 'initial';
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
    prompt.style.display = 'none';
  }
}

await nostalgist.start();
