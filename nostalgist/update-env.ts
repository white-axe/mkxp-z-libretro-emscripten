import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

await (await fs.open(".env", "a")).close();
process.loadEnvFile(".env");

let written = false;

for (const key of ["CORE_JS", "CORE_WASM", "GAME", "RTP"]) {
  const rawEnvPath = process.env["VITE_" + key + "_PATH"];
  if (rawEnvPath === undefined) {
    continue;
  }
  const envPath = path.join("public", rawEnvPath);

  const size = (await fs.stat(envPath)).size;
  const envSize = parseInt(process.env["VITE_" + key + "_SIZE"] ?? "");
  if (size !== envSize) {
    const file = await fs.open(".env", "a");
    try {
      if (!written) {
        written = true;
        file.write("\n");
      }
      file.write("VITE_" + key + "_SIZE=" + size + "\n");
    } finally {
      await file.close();
    }
  }

  const hasher = crypto.createHash("sha256");
  const stream = createReadStream(envPath);
  const hash = await (async () => {
    try {
      return await new Promise<string>((resolve, reject) => {
        stream.on("data", (data) => {
          hasher.update(data);
        });
        stream.on("end", () => {
          resolve(hasher.digest("hex"));
        });
        stream.on("error", (err) => {
          reject(err);
        });
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        stream.close((err) => {
          if (err === null || err === undefined) {
            resolve();
          } else {
            reject(err);
          }
        });
      });
    }
  })();
  const envHash = process.env["VITE_" + key + "_HASH"];
  if (hash !== envHash) {
    const file = await fs.open(".env", "a");
    try {
      if (!written) {
        written = true;
        file.write("\n");
      }
      file.write("VITE_" + key + "_HASH=" + hash + "\n");
    } finally {
      await file.close();
    }
  }
}
