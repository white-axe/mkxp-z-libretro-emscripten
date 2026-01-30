import { Button, Gamepad } from '@rbuljan/gamepad';
import { primaryInput } from 'detect-it';
import fetchProgress from 'fetch-progress';
import { Nostalgist } from 'nostalgist';
import ProgressBar from 'progressbar.js';
import { Spinner } from 'spin.js';

const CORE_NAME = 'mkxp-z';
const GAME_PATH: string | undefined = import.meta.env.VITE_GAME_PATH;
const XP_CONTROLS = import.meta.env.VITE_XP_CONTROLS !== undefined && import.meta.env.VITE_XP_CONTROLS !== 'false';

// These can be arbitrary
const SAVE_DIRECTORY = '/' + CORE_NAME + '/saves';
const STATE_DIRECTORY = '/' + CORE_NAME + '/states';

const spinner = new Spinner({
  color: '#fff',
});
const spinnerTarget = document.getElementById('spinner-target');
if (spinnerTarget !== null) {
  spinner.spin(spinnerTarget);
}

const progressbarTarget = document.getElementById('progressbar-target');
const bar = new ProgressBar.Circle(progressbarTarget, {
  color: '#fff',
  strokeWidth: 6.0,
  step: (_, bar) => {
    // @ts-ignore
    bar.setText(Math.round(bar.value() * 100) + '%');
  }
});
bar.text!.style.fontSize = '20px';

let currentBytes = 0;
let totalBytes = 0;

const updateBar = () => {
  if (currentBytes !== 0 && progressbarTarget !== null) {
    spinner.stop();
    progressbarTarget.style.display = 'initial';
  }
  bar.set(isNaN(totalBytes) || !isFinite(totalBytes) || totalBytes === 0 ? 0 : currentBytes / totalBytes);
};

// Disable bfcache because it causes the WebAssembly module to crash when this page is restored from bfcache
window.addEventListener('pageshow', (ev) => {
  if (ev.persisted) {
    location.reload();
  }
});

// Wait for coi-serviceworker.js to load
if (!window.crossOriginIsolated && navigator.serviceWorker.controller === null) {
  throw 'coi-serviceworker.js is not ready yet';
}
const sessionStorageKey = 'nostalgist status for ' + CORE_NAME + ' @ ' + location.href;
if (window.sessionStorage.getItem(sessionStorageKey) !== 'ready') {
  window.sessionStorage.setItem(sessionStorageKey, 'ready');
  location.reload();
}
if (!window.crossOriginIsolated) {
  console.error('Cross-origin isolation is not enabled; reloading to enable it');
  location.reload();
}

// Fetches a file and caches it in IndexedDB to improve subsequent load times
const fetchWithCache = async (path: string, size: number) => {
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
      if (result !== undefined && result.blob.size === size && result.etag === etag && result.lastModified == lastModified) {
        blob = result.blob;
      }
    } catch (err) {
      console.error(err);
    }
  }

  if (blob === undefined) {
    let fetchedBytes = 0;
    const response = await fetch(path)
      .then(fetchProgress({
        onProgress: (progress) => {
          if (fetchedBytes === 0 && progress.transferred !== 0) {
            totalBytes += size;
          }
          currentBytes += progress.transferred - fetchedBytes;
          fetchedBytes = progress.transferred;
          updateBar();
        },
      }));

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
    wasm: fetchWithCache('./' + CORE_NAME + '_libretro.wasm', parseInt(import.meta.env.VITE_CORE_SIZE)),
  },
  rom: fetchWithCache(GAME_PATH ?? '', parseInt(import.meta.env.VITE_GAME_SIZE)),
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

bar.destroy();
spinner.stop();

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

// Show an on-screen gamepad overlay if the user is using a touchscreen device
const gamepadTarget = document.getElementById('gamepad-target');
if (primaryInput === 'touch' && gamepadTarget !== null) {
  const getCode = (input: string) => {
    const config = nostalgist.getEmulatorOptions().retroarchConfig;
    const key: string | undefined = config[input];
    if (key === undefined) {
      switch (input) {
        case 'input_player1_a':
          return 'KeyZ';
        case 'input_player1_b':
          return 'KeyX';
        case 'input_player1_down':
          return 'ArrowDown';
        case 'input_player1_left':
          return 'ArrowLeft';
        case 'input_player1_right':
          return 'ArrowRight';
        case 'input_player1_up':
          return 'ArrowUp';
      }
      return;
    }
    if (key.length === 1) {
      return 'Key' + key.toUpperCase();
    }
    if (key.startsWith('f') && /^\d+$/.test(key.substring(1))) {
      return 'F' + key.substring(1);
    }
    if (key.startsWith('num') && /^\d+$/.test(key.substring(3))) {
      return 'Digit' + key.substring(3);
    }
    if (key.startsWith('keypad') && /^\d+$/.test(key.substring(6))) {
      return 'Numpad' + key.substring(6);
    }
    switch (key) {
      case 'down':
        return 'ArrowDown';
      case 'left':
        return 'ArrowLeft';
      case 'right':
        return 'ArrowRight';
      case 'up':
        return 'ArrowUp';
      case 'escape':
        return 'Escape';
      case 'backspace':
        return 'Backspace';
      case 'space':
        return 'Space';
      case 'tab':
        return 'Tab';
      case 'enter':
        return 'Enter';
      case 'kp_enter':
        return 'NumpadEnter';
      case 'ctrl':
        return 'ControlLeft';
      case 'rctrl':
        return 'ControlRight';
      case 'shift':
        return 'ShiftLeft';
      case 'rshift':
        return 'ShiftRight';
      case 'alt':
        return 'AltLeft';
      case 'ralt':
        return 'AltRight';
    }
  };
  new Gamepad([
    new Button({
      id: 'gamepad-x',
      text: 'X',
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: '75px',
        right: '125px',
      },
      onInput: (state) => {
        nostalgist.getCanvas().dispatchEvent(new KeyboardEvent(state.isActive ? 'keydown' : 'keyup', {code: getCode('input_player1_y')}));
      },
    }),
    new Button({
      id: 'gamepad-y',
      text: 'Y',
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: '75px',
        right: '75px',
      },
      onInput: (state) => {
        nostalgist.getCanvas().dispatchEvent(new KeyboardEvent(state.isActive ? 'keydown' : 'keyup', {code: getCode('input_player1_l3')}));
      },
    }),
    new Button({
      id: 'gamepad-z',
      text: 'Z',
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: '75px',
        right: '25px',
      },
      onInput: (state) => {
        nostalgist.getCanvas().dispatchEvent(new KeyboardEvent(state.isActive ? 'keydown' : 'keyup', {code: getCode('input_player1_r3')}));
      },
    }),
    new Button({
      id: 'gamepad-a',
      text: 'A',
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: '25px',
        right: '125px',
      },
      onInput: (state) => {
        nostalgist.getCanvas().dispatchEvent(new KeyboardEvent(state.isActive ? 'keydown' : 'keyup', {code: getCode('input_player1_x')}));
      },
    }),
    new Button({
      id: 'gamepad-b',
      text: 'B',
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: '25px',
        right: '75px',
      },
      onInput: (state) => {
        nostalgist.getCanvas().dispatchEvent(new KeyboardEvent(state.isActive ? 'keydown' : 'keyup', {code: getCode('input_player1_b')}));
      },
    }),
    new Button({
      id: 'gamepad-c',
      text: 'C',
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: '25px',
        right: '25px',
      },
      onInput: (state) => {
        nostalgist.getCanvas().dispatchEvent(new KeyboardEvent(state.isActive ? 'keydown' : 'keyup', {code: getCode('input_player1_a')}));
      },
    }),
    new Button({
      id: 'gamepad-down',
      text: '▼',
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: '25px',
        left: '62.5px',
      },
      onInput: (state) => {
        nostalgist.getCanvas().dispatchEvent(new KeyboardEvent(state.isActive ? 'keydown' : 'keyup', {code: getCode('input_player1_down')}));
      },
    }),
    new Button({
      id: 'gamepad-left',
      text: '◀',
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: '62.5px',
        left: '25px',
      },
      onInput: (state) => {
        nostalgist.getCanvas().dispatchEvent(new KeyboardEvent(state.isActive ? 'keydown' : 'keyup', {code: getCode('input_player1_left')}));
      },
    }),
    new Button({
      id: 'gamepad-right',
      text: '▶',
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: '62.5px',
        left: '100px',
      },
      onInput: (state) => {
        nostalgist.getCanvas().dispatchEvent(new KeyboardEvent(state.isActive ? 'keydown' : 'keyup', {code: getCode('input_player1_right')}));
      },
    }),
    new Button({
      id: 'gamepad-up',
      text: '▲',
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: '100px',
        left: '62.5px',
      },
      onInput: (state) => {
        nostalgist.getCanvas().dispatchEvent(new KeyboardEvent(state.isActive ? 'keydown' : 'keyup', {code: getCode('input_player1_up')}));
      },
    }),
  ]);
}

await nostalgist.start();
