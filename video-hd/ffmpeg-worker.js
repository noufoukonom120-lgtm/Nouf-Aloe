// Nouf Vidéo HD : convertit en H.264 les vidéos que le navigateur ne sait pas afficher
// (ex. HEVC / H.265 des téléphones récents sur un ordinateur sans le décodeur).
// Worker classique : charge ffmpeg.wasm (version mono-fil) depuis un CDN.
const CORES = [
  "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js",
  "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js",
];
let ff = null;

function loadCore() {
  let lastErr = null;
  for (const url of CORES) {
    try {
      importScripts(url);
      return url;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("core");
}

async function init() {
  if (ff) { return; }
  const coreURL = loadCore();
  const wasmURL = coreURL.replace(/\.js$/, ".wasm");
  const workerURL = coreURL.replace(/\.js$/, ".worker.js");
  ff = await self.createFFmpegCore({
    mainScriptUrlOrBlob: coreURL + "#" + btoa(JSON.stringify({ wasmURL, workerURL })),
  });
  ff.setLogger(d => self.postMessage({ type: "log", data: d && d.message }));
  ff.setProgress(d => self.postMessage({ type: "progress", data: d }));
}

function run(args) {
  ff.setTimeout(-1);
  ff.exec(...args);
  const ret = ff.ret;
  ff.reset();
  return ret;
}

self.onmessage = async (e) => {
  const { file, maxSide } = e.data;
  try {
    self.postMessage({ type: "stage", data: "load" });
    await init();
    self.postMessage({ type: "stage", data: "convert" });
    try { ff.FS.mkdir("/in"); } catch (err) {}
    ff.FS.mount(ff.FS.filesystems.WORKERFS, { files: [file] }, "/in");
    const inPath = "/in/" + file.name;
    const scale = `scale='if(gt(iw,ih),min(${maxSide},iw),-2)':'if(gt(iw,ih),-2,min(${maxSide},ih))',format=yuv420p`;
    const base = ["-i", inPath, "-map", "0:v:0", "-map", "0:a:0?", "-vf", scale,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p"];
    // 1er essai : son AAC recopié tel quel (plus rapide) ; sinon réencodé en AAC.
    let ret = run([...base, "-c:a", "copy", "-movflags", "+faststart", "-y", "/out.mp4"]);
    if (ret !== 0) {
      try { ff.FS.unlink("/out.mp4"); } catch (err) {}
      ret = run([...base, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-y", "/out.mp4"]);
    }
    try { ff.FS.unmount("/in"); } catch (err) {}
    if (ret !== 0) { throw new Error("ffmpeg " + ret); }
    const data = ff.FS.readFile("/out.mp4");
    try { ff.FS.unlink("/out.mp4"); } catch (err) {}
    self.postMessage({ type: "done", data }, [data.buffer]);
  } catch (err) {
    self.postMessage({ type: "error", data: String(err && err.message || err) });
  }
};
