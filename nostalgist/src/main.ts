import { Button, Gamepad } from "@rbuljan/gamepad";
import { primaryInput } from "detect-it";
import { Dexie, type EntityTable } from "dexie";
import fetchProgress from "fetch-progress";
import { toBase64 } from "js-base64";
import { Nostalgist } from "nostalgist";
import ProgressBar from "progressbar.js";
import { Spinner } from "spin.js";

const CORE_NAME = "mkxp-z";

// True if RetroArch was built with OPFS support by passing
// `HAVE_THREADS=1 PROXY_TO_PTHREAD=1 HAVE_AUDIOWORKLET=1 HAVE_RWEBAUDIO=0 HAVE_AL=0 HAVE_WASMFS=1 HAVE_EXTRA_WASMFS=1`
// when building RetroArch and building the core with `-pthread`, otherwise false.
// It's highly recommended to build with OPFS support because it allows loading downloaded games/RTPs directly from the disk instead of loading the entire game/RTP into memory.
const HAVE_OPFS =
  typeof import.meta.env.VITE_HAVE_OPFS !== "string" ||
  import.meta.env.VITE_HAVE_OPFS !== "false";

const REQUIRE_OPFS =
  HAVE_OPFS &&
  (typeof import.meta.env.VITE_REQUIRE_OPFS !== "string" ||
    import.meta.env.VITE_REQUIRE_OPFS !== "false");

const CORE_JS_PATH =
  typeof import.meta.env.VITE_CORE_JS_PATH === "string"
    ? new URL(import.meta.env.VITE_CORE_JS_PATH, location.href).toString()
    : new URL("./" + CORE_NAME + "_libretro.js", location.href).toString();
const CORE_WASM_PATH =
  typeof import.meta.env.VITE_CORE_WASM_PATH === "string"
    ? new URL(import.meta.env.VITE_CORE_WASM_PATH, location.href).toString()
    : new URL("./" + CORE_NAME + "_libretro.wasm", location.href).toString();
const GAME_PATH =
  typeof import.meta.env.VITE_GAME_PATH === "string"
    ? new URL(import.meta.env.VITE_GAME_PATH, location.href).toString()
    : null;
const RTP_PATH =
  typeof import.meta.env.VITE_RTP_PATH === "string"
    ? new URL(import.meta.env.VITE_RTP_PATH, location.href).toString()
    : null;

const CORE_JS_SIZE = parseInt(import.meta.env.VITE_CORE_JS_SIZE);
const CORE_WASM_SIZE = parseInt(import.meta.env.VITE_CORE_WASM_SIZE);
const GAME_SIZE = parseInt(import.meta.env.VITE_GAME_SIZE);
const RTP_SIZE = parseInt(import.meta.env.VITE_RTP_SIZE);

const XP_CONTROLS =
  typeof import.meta.env.VITE_XP_CONTROLS === "string" &&
  import.meta.env.VITE_XP_CONTROLS !== "false";

const GAME_NAME =
  typeof import.meta.env.VITE_GAME_NAME === "string"
    ? import.meta.env.VITE_GAME_NAME
    : null;

// This can be arbitrary but needs to have at least two path elements when using OPFS
const PERSISTENT_DIRECTORY = "/nostalgist/persistent";

// These can be arbitrary subdirectories of the persistent directory
const SAVE_DIRECTORY = PERSISTENT_DIRECTORY + "/saves/" + CORE_NAME;
const STATE_DIRECTORY = PERSISTENT_DIRECTORY + "/states/" + CORE_NAME;
const OPFS_SYSTEM_DIRECTORY = PERSISTENT_DIRECTORY + "/system/" + CORE_NAME;

const GAME_OPFS_PATH =
  GAME_PATH === null ? null : toBase64(GAME_PATH, true) + ".mkxpz";
const RTP_OPFS_PATH =
  RTP_PATH === null
    ? null
    : OPFS_SYSTEM_DIRECTORY.slice(PERSISTENT_DIRECTORY.length) +
      "/mkxp-z/RTP/" +
      RTP_PATH.split("/").slice(-1)[0];

if (GAME_NAME !== null) {
  document.title = GAME_NAME;
}

const spinner = new Spinner({
  color: "#fff",
});
const spinnerTarget = document.getElementById("spinner-target");
if (spinnerTarget !== null) {
  spinner.spin(spinnerTarget);
}

const progressbarTarget = document.getElementById("progressbar-target");
const bar = new ProgressBar.Circle(progressbarTarget, {
  color: "#fff",
  strokeWidth: 6.0,
  step: (_, bar) => {
    const text = Math.round(bar.value() * 100) + "%";
    // @ts-expect-error The type of `bar` is set incorrectly by @types/progressbar.js
    bar.setText(text);
  },
});
bar.text!.style.fontSize = "20px";

let currentBytes = 0;
let totalBytes = 0;

const updateBar = () => {
  bar.set(
    isNaN(totalBytes) || !isFinite(totalBytes) || totalBytes === 0
      ? 0
      : currentBytes / totalBytes,
  );
};

// Disable bfcache because it may undo the loading of the game (e.g. when the user refreshes the page in Chromium after the game successfully loads)
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted) {
    location.reload();
  }
});

// Multithreaded WebAssembly requires a secure context
if (!window.isSecureContext) {
  alert("This site only works if served over HTTPS.");
  throw "Not a secure context";
}

// Wait for coi-serviceworker.js to load
if (!window.crossOriginIsolated) {
  if (!("serviceWorker" in navigator)) {
    alert(
      "Your browser does not support service workers in private browsing mode. Either exit private browsing mode or try private browsing mode in a different browser.",
    );
    throw "Service workers are not available";
  }
  if (navigator.serviceWorker.controller === null) {
    throw "coi-serviceworker.js is not ready yet";
  }
}
const sessionStorageKey =
  "nostalgist status for " + CORE_NAME + " @ " + location.href;
if (window.sessionStorage.getItem(sessionStorageKey) !== "ready") {
  window.sessionStorage.setItem(sessionStorageKey, "ready");
  location.reload();
  throw "Reloading once to make coi-serviceworker.js less flaky";
}
if (!window.crossOriginIsolated) {
  console.error(
    "Cross-origin isolation is not enabled; reloading to enable it",
  );
  location.reload();
  throw "Reloading to enable cross-origin isolation";
}

const opfs = !HAVE_OPFS
  ? null
  : await (async () => {
      try {
        return await navigator.storage.getDirectory();
      } catch (err) {
        if (REQUIRE_OPFS) {
          alert(
            "Your browser does not support OPFS in private browsing mode. Either exit private browsing mode or try private browsing mode in a different browser.",
          );
          throw err;
        } else {
          // Fall back to not using OPFS
          console.error(err);
          return null;
        }
      }
    })();

const fetchWithCache = async (
  size: number,
  path: string,
  opfsPath?: string,
) => {
  totalBytes += size;
  updateBar();

  let blob: Blob | undefined = undefined;
  let blobSource: "fetch" | "indexeddb" | "opfs" = "fetch";

  let headers = (await fetch(path, { method: "HEAD" })).headers;
  const etag = headers.get("ETag");
  const lastModified = headers.get("Last-Modified");

  const db = new Dexie("nostalgist cache for " + CORE_NAME) as Dexie & {
    cache: EntityTable<
      {
        path: string;
        blob: Blob | null;
        etag: string | null;
        lastModified: string | null;
      },
      "path"
    >;
  };
  db.version(1).stores({
    cache: "path",
  });

  try {
    // Try restoring the blob from IndexedDB and OPFS
    if (etag !== null || lastModified !== null) {
      try {
        const result = await db.cache.get(path);
        if (
          result !== undefined &&
          (etag !== null
            ? result.etag === etag
            : result.lastModified === lastModified) &&
          (result.blob === null || result.blob.size === size)
        ) {
          if (result.blob !== null) {
            blobSource = "indexeddb";
            blob = result.blob;
          } else if (opfs !== null && opfsPath !== undefined) {
            let directory = opfs;
            const elements = opfsPath
              .split("/")
              .filter((element) => element.length !== 0);
            if (elements.length > 0) {
              for (const element of elements.slice(0, -1)) {
                directory = await directory.getDirectoryHandle(element, {
                  create: true,
                });
              }
              const fileHandle = await directory.getFileHandle(
                elements.slice(-1)[0],
              );
              const fileBlob = await fileHandle.getFile();
              if (fileBlob.size === size) {
                blobSource = "opfs";
                blob = fileBlob;
              }
            }
          }
        }
      } catch (err) {
        console.error(err);
      }
    }

    // If the blob is not cached, fetch it instead
    if (blob === undefined) {
      let fetchedBytes = 0;

      const response = await fetch(path).then(
        fetchProgress({
          onProgress: (progress) => {
            currentBytes += progress.transferred - fetchedBytes;
            fetchedBytes = progress.transferred;
            updateBar();
            if (progressbarTarget !== null) {
              spinner.stop();
              progressbarTarget.style.display = "initial";
            }
          },
        }),
      );

      headers = response.headers;
      blob = await response.blob();
    } else {
      currentBytes += size;
      updateBar();
    }

    // Store the blob into IndexedDB and OPFS if needed
    if (
      blobSource !==
      (opfs !== null && opfsPath !== undefined ? "opfs" : "indexeddb")
    ) {
      try {
        db.cache.put({
          path,
          blob: opfs !== null && opfsPath !== undefined ? null : blob,
          etag: headers.get("ETag"),
          lastModified: headers.get("Last-Modified"),
        });
      } catch (err) {
        console.error(err);
      }

      if (opfs !== null && opfsPath !== undefined) {
        try {
          let directory = opfs;
          const elements = opfsPath
            .split("/")
            .filter((element) => element.length !== 0);
          if (elements.length > 0) {
            for (const element of elements.slice(0, -1)) {
              directory = await directory.getDirectoryHandle(element, {
                create: true,
              });
            }
            const fileHandle = await directory.getFileHandle(
              elements.slice(-1)[0],
              { create: true },
            );
            const fileStream = await fileHandle.createWritable();
            await fileStream.write(blob);
            await fileStream.close();
            blob = await fileHandle.getFile();
          }
        } catch (err) {
          console.error(err);
        }
      }
    }

    return blob;
  } finally {
    db.close();
  }
};

const [coreJsBlob, coreWasmBlob, gameBlob, rtpBlob] = await Promise.all([
  fetchWithCache(CORE_JS_SIZE, CORE_JS_PATH),
  fetchWithCache(CORE_WASM_SIZE, CORE_WASM_PATH),
  GAME_PATH === null
    ? null
    : fetchWithCache(GAME_SIZE, GAME_PATH, GAME_OPFS_PATH ?? undefined),
  RTP_PATH === null
    ? null
    : fetchWithCache(RTP_SIZE, RTP_PATH, RTP_OPFS_PATH ?? undefined),
]);

const nostalgist = await Nostalgist.prepare({
  core: {
    name: CORE_NAME,
    js: coreJsBlob,
    wasm: coreWasmBlob,
  },
  rom:
    opfs !== null || GAME_PATH === null || gameBlob === null
      ? undefined
      : {
          fileName: toBase64(GAME_PATH, true) + ".mkxpz",
          fileContent: gameBlob,
        },
  bios:
    opfs !== null || rtpBlob === null
      ? undefined
      : {
          fileName: "RTP.mkxpz",
          fileContent: rtpBlob,
        },
  emscriptenModule: {
    preRun: [
      (module) => {
        if (opfs !== null) {
          // Indicate to RetroArch that we want to enable OPFS support if it's supported
          module.ENV.OPFS_MOUNT = PERSISTENT_DIRECTORY;
        }
      },
    ],
  },
  element: "#nostalgist-canvas",
  retroarchConfig: {
    savefile_directory: SAVE_DIRECTORY,
    savestate_directory: STATE_DIRECTORY,
    system_directory:
      opfs !== null
        ? OPFS_SYSTEM_DIRECTORY
        : "/home/web_user/retroarch/userdata/system",
    log_verbosity: true,
    libretro_log_level: import.meta.env.DEV ? 0 : 1,
    frontend_log_level: import.meta.env.DEV ? 0 : 1,
    input_toggle_fast_forward: "space",
    input_hold_fast_forward: "l",
    input_toggle_slowmotion: "g",
    input_hold_slowmotion: "e",
    input_menu_toggle: "f1",
    input_save_state: "f2",
    input_load_state: "f4",
    input_state_slot_decrease: "f6",
    input_state_slot_increase: "f7",
    input_screenshot: "f8",
    input_player1_a: XP_CONTROLS ? "c" : "z",
    input_player1_b: "x",
    input_player1_x: XP_CONTROLS ? "z" : "shift",
    input_player1_y: "a",
    input_player1_l3: "s",
    input_player1_r3: "d",
    input_player1_l: "q",
    input_player1_r: "w",
    input_player1_l2: "ctrl",
    input_player1_r2: "rshift",
    input_player1_start: "alt",
  },
});

const fs = nostalgist.getEmscriptenFS();

if (opfs !== null) {
  // Create the save, state and system directories
  for (const directoryPath of [
    SAVE_DIRECTORY,
    STATE_DIRECTORY,
    OPFS_SYSTEM_DIRECTORY,
  ]) {
    let directory = opfs;
    for (const element of directoryPath
      .slice(PERSISTENT_DIRECTORY.length)
      .split("/")
      .filter((element) => element.length !== 0)) {
      directory = await directory.getDirectoryHandle(element, {
        create: true,
      });
    }
  }

  // Tell RetroArch to load the game from OPFS
  if (GAME_PATH !== null) {
    const module = nostalgist.getEmscripten().Module;
    const args: string[] = module.arguments ?? [];
    args.push(PERSISTENT_DIRECTORY + "/" + GAME_OPFS_PATH);
    module.arguments = args;
  }
} else {
  // Move the RTP to the correct path
  if (RTP_PATH !== null) {
    const system_directory = "/home/web_user/retroarch/userdata/system";
    const system_directory_subdirectory = system_directory + "/mkxp-z/RTP";
    fs.mkdirTree(system_directory_subdirectory);
    fs.rename(
      system_directory + "/RTP.mkxpz",
      system_directory_subdirectory + "/" + RTP_PATH.split("/").slice(-1)[0],
    );
  }

  // If RetroArch was not built with OPFS support but was built with IDBFS support,
  // persist saves and save states to IndexedDB so that the user doesn't lose all of their saves and save states whenever the page is reloaded or closed
  if ("filesystems" in fs && "IDBFS" in fs.filesystems) {
    fs.mkdirTree(SAVE_DIRECTORY);
    fs.mkdirTree(STATE_DIRECTORY);
    fs.mount(fs.filesystems.IDBFS, { autoPersist: true }, SAVE_DIRECTORY);
    fs.mount(fs.filesystems.IDBFS, { autoPersist: true }, STATE_DIRECTORY);
    await new Promise<void>((resolve, reject) => {
      fs.syncfs(true, (err: Error | null) => {
        if (err === null) {
          resolve();
        } else {
          reject(err);
        }
      });
    });
  }
}

bar.destroy();
spinner.stop();

// Force the user to interact with the browser once before starting the game;
// otherwise the audio will not work because audio is gated behind sticky activation
// (see https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/User_activation)
while (!navigator.userActivation.hasBeenActive) {
  const prompt = document.getElementById("user-activation-prompt");
  if (prompt !== null) {
    prompt.style.display = "initial";
  }
  await new Promise<void>((resolve) => {
    const events = [
      "keydown",
      "mousedown",
      "pointerdown",
      "pointerup",
      "touchend",
    ];
    const listener = () => {
      for (const ev of events) {
        document.body.removeEventListener(ev, listener);
      }
      resolve();
    };
    for (const ev of events) {
      document.body.addEventListener(ev, listener);
    }
  });
  if (prompt !== null) {
    prompt.style.display = "none";
  }
}

// Show an on-screen gamepad overlay if the user is using a touchscreen device
const gamepadTarget = document.getElementById("gamepad-target");
if (primaryInput === "touch" && gamepadTarget !== null) {
  new Gamepad([
    new Button({
      id: "gamepad-x",
      text: "X",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "75px",
        right: "125px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "y" },
        );
      },
    }),
    new Button({
      id: "gamepad-y",
      text: "Y",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "75px",
        right: "75px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "l3" },
        );
      },
    }),
    new Button({
      id: "gamepad-z",
      text: "Z",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "75px",
        right: "25px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "r3" },
        );
      },
    }),
    new Button({
      id: "gamepad-a",
      text: "A",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "25px",
        right: "125px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "x" },
        );
      },
    }),
    new Button({
      id: "gamepad-b",
      text: "B",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "25px",
        right: "75px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "b" },
        );
      },
    }),
    new Button({
      id: "gamepad-c",
      text: "C",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "25px",
        right: "25px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "a" },
        );
      },
    }),
    new Button({
      id: "gamepad-down",
      text: "▼",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "25px",
        left: "62.5px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "down" },
        );
      },
    }),
    new Button({
      id: "gamepad-left",
      text: "◀",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "62.5px",
        left: "25px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "left" },
        );
      },
    }),
    new Button({
      id: "gamepad-right",
      text: "▶",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "62.5px",
        left: "100px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "right" },
        );
      },
    }),
    new Button({
      id: "gamepad-up",
      text: "▲",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "100px",
        left: "62.5px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "up" },
        );
      },
    }),
    new Button({
      id: "gamepad-save-state",
      text: "\u00a0SAVE\u00a0STATE\u00a0",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        top: "25px",
        left: "63px",
      },
      onInput: (state) => {
        // `nostalgist.sendCommand("SAVE_STATE")` doesn't always work for some reason
        nostalgist.getCanvas().dispatchEvent(
          new KeyboardEvent(state.isActive ? "keydown" : "keyup", {
            code: "F2",
          }),
        );
      },
    }),
    new Button({
      id: "gamepad-load-state",
      text: "\u00a0LOAD\u00a0STATE\u00a0",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        top: "75px",
        left: "63px",
      },
      onInput: (state) => {
        if (state.isActive) {
          nostalgist.sendCommand("LOAD_STATE");
        }
      },
    }),
    new Button({
      id: "gamepad-fast-forward",
      text: "\u00a0FAST\u00a0FORWARD\u00a0",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        top: "25px",
        right: "80px",
      },
      onInput: (state) => {
        if (state.isActive) {
          nostalgist.sendCommand("FAST_FORWARD");
        }
      },
    }),
    new Button({
      id: "gamepad-slow-motion",
      text: "\u00a0SLOW\u00a0MOTION\u00a0",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        top: "75px",
        right: "77px",
      },
      onInput: (state) => {
        if (state.isActive) {
          nostalgist.sendCommand("SLOWMOTION");
        }
      },
    }),
  ]);
}

await nostalgist.start();
