/**
 * Render-ready accelerated yt-dlp downloader
 * - prefers aria2c if available (installed in Dockerfile)
 * - falls back to yt-dlp concurrent fragments
 */
import express from "express";
import fs from "fs";
import path from "path";
import sanitize from "sanitize-filename";
import { pipeline } from "stream/promises";
import { spawnSync } from "child_process";
import crypto from "crypto";
import { YtDlp, helpers } from "ytdlp-nodejs";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const CACHE_DIR = path.join(process.cwd(), "cache");
const publicDir = path.join(process.cwd(), "public");
const MAX_CACHE_FILES = parseInt(process.env.MAX_CACHE_FILES || "80", 10);

// tuning env
const DOWNLOAD_THREADS = Math.max(1, parseInt(process.env.DOWNLOAD_THREADS || "8", 10)); // default 8
const USE_EXTERNAL_DOWNLOADER =
  (process.env.USE_EXTERNAL_DOWNLOADER === "1" || process.env.USE_EXTERNAL_DOWNLOADER === "true") || true;
// stream buffer
const STREAM_HIGH_WATER_MARK = 1024 * 1024; // 1 MiB

fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

app.use(express.text({ type: ["text/*", "application/octet-stream"], limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

let cookiesPath = null;
const cookieCandidate = path.join(process.cwd(), "cookies.txt");

// load cookies from env YT_C (base64) or existing cookies.txt
if (process.env.YT_C) {
  try {
    const txt = Buffer.from(process.env.YT_C, "base64");
    fs.writeFileSync(cookieCandidate, txt);
    cookiesPath = cookieCandidate;
    console.log("cookies.txt created from YT_C env");
  } catch (e) {
    console.warn("Failed to create cookies from YT_C:", e?.message || e);
  }
} else if (fs.existsSync(cookieCandidate)) {
  cookiesPath = cookieCandidate;
  console.log("Using existing cookies.txt");
}

function hashUrl(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 18);
}
function tmpFileNameFor(id, ext) {
  return path.join(CACHE_DIR, `${id}.${ext}.part`);
}
function finalFilePathFor(id, ext) {
  return path.join(CACHE_DIR, `${id}.${ext}`);
}
function humanSafeName(name, ext) {
  const s = sanitize(name || "file").slice(0, 120) || "file";
  return `${s}.${ext}`;
}
function systemHasFfmpeg() {
  try {
    const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return r.status === 0 || r.status === null || r.status === undefined;
  } catch {
    return false;
  }
}
function systemHasAria2c() {
  try {
    const r = spawnSync("aria2c", ["--version"], { stdio: "ignore" });
    return r.status === 0 || r.status === null || r.status === undefined;
  } catch {
    return false;
  }
}

async function moveFileAtomic(src, dest) {
  try {
    await fs.promises.rename(src, dest);
    return;
  } catch (err) {
    if (err && (err.code === "EXDEV" || err.code === "EEXIST")) {
      await fs.promises.copyFile(src, dest);
      try { await fs.promises.unlink(src); } catch {}
      return;
    }
    throw err;
  }
}
async function pruneCache() {
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    const stats = await Promise.all(files.map(async (f) => {
      const fp = path.join(CACHE_DIR, f);
      try { const s = await fs.promises.stat(fp); return { path: fp, mtime: s.mtimeMs, size: s.size }; }
      catch { return null; }
    }));
    const valid = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
    if (valid.length > MAX_CACHE_FILES) {
      const toRemove = valid.slice(MAX_CACHE_FILES);
      await Promise.all(toRemove.map(r => fs.promises.unlink(r.path).catch(() => {})));
      console.log("Pruned cache:", toRemove.length);
    }
  } catch (e) {
    console.warn("pruneCache error:", e?.message || e);
  }
}

const ongoing = new Map();
const ytdlp = new YtDlp();
let ffmpegReady = false;
let ytDlpBinaryReady = false;

async function prepareYtDlpBinary() {
  try {
    console.log("Ensuring yt-dlp binary...");
    await helpers.downloadYtDlp();
    ytDlpBinaryReady = true;
  } catch (e) {
    ytDlpBinaryReady = false;
    console.warn("yt-dlp binary download failed:", e?.message || e);
  }
}

async function prepareFfmpeg() {
  try {
    console.log("Ensuring ffmpeg...");
    await ytdlp.downloadFFmpeg().catch(()=>{});
    if (systemHasFfmpeg()) {
      ffmpegReady = true;
      console.log("system ffmpeg present");
    } else {
      ffmpegReady = false;
      console.warn("ffmpeg not available");
    }
  } catch (e) {
    console.warn("prepareFfmpeg error:", e?.message || e);
  }
}

async function getTitleFallback(url, id) {
  try {
    const t = await ytdlp.getTitleAsync(url);
    if (t) return sanitize(t).slice(0, 140);
  } catch {}
  return id;
}

async function downloadAndCache(url, ext, ytdlpOptions = {}) {
  const id = hashUrl(url);
  const finalPath = finalFilePathFor(id, ext);
  const tmpPath = tmpFileNameFor(id, ext);

  try {
    await fs.promises.access(finalPath, fs.constants.R_OK);
    const now = new Date();
    await fs.promises.utimes(finalPath, now, now).catch(()=>{});
    return { path: finalPath, id, cached: true };
  } catch {}

  const key = `${id}.${ext}`;
  if (ongoing.has(key)) return ongoing.get(key);

  const promise = (async () => {
    try { await fs.promises.unlink(tmpPath).catch(()=>{}); } catch {}
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });

    let title = id;
    try { title = await getTitleFallback(url, id); } catch {}

    const formatObj =
      ext === "mp3"
        ? { filter: "audioonly", type: "mp3", quality: "0" }
        : { filter: "audioandvideo", type: "mp4", quality: "best[ext=mp4]/best" };

    const opts = { output: tmpPath, format: formatObj, ...ytdlpOptions };

    try {
      console.log("Starting download:", url, "->", tmpPath);
      const builder = ytdlp.download(url, opts);

      // cookies
      let cookieApplied = false;
      const useBrowserCookiesFlag = process.env.USE_BROWSER_COOKIES === "1" || process.env.USE_BROWSER_COOKIES === "true";
      if (cookiesPath && fs.existsSync(cookiesPath)) {
        try { builder.cookies(cookiesPath); cookieApplied = true; console.log("Applied cookies file"); }
        catch (e) { try { builder.addArgs("--cookies", cookiesPath); cookieApplied = true; } catch {} }
      } else if (useBrowserCookiesFlag) {
        try { builder.cookiesFromBrowser("chrome"); cookieApplied = true; } catch (e){ console.warn("cookiesFromBrowser failed"); }
      }
      if (!cookieApplied && /youtube\.com|youtu\.be/.test(url)) {
        console.warn("No cookies applied for YouTube URL. This may cause throttling or login problems.");
      }

      // acceleration: prefer aria2c if allowed & installed
      const aria2cPresent = systemHasAria2c();
      if (USE_EXTERNAL_DOWNLOADER && aria2cPresent) {
        const x = Math.min(Math.max(2, DOWNLOAD_THREADS), 32); // clamp
        const s = Math.min(Math.max(2, DOWNLOAD_THREADS), 32);
        const k = "1M";
        builder.addArgs(
          "--external-downloader", "aria2c",
          "--external-downloader-args", `-x ${x} -s ${s} -k ${k} --file-allocation=none --timeout=60 --max-connection-per-server=${x}`
        );
        console.log(`Using aria2c external downloader (x=${x}, s=${s}).`);
      } else {
        // fallback to internal concurrency - use conservative numbers for Render
        const threads = Math.min(Math.max(2, DOWNLOAD_THREADS), 8);
        builder.addArgs(
          "--concurrent-fragments", String(threads),
          "--fragment-retries", "3",
          "--retries", "5",
          "--http-chunk-size", "5M"
        );
        console.log(`Using yt-dlp concurrent fragments=${threads}`);
      }

      // common safe args
      builder.addArgs(
        "--no-playlist",
        "--continue",
        "--no-mtime",
        "--socket-timeout", "20",
        "--no-embed-metadata",
        "--no-embed-thumbnail"
      );

      // reduce ffmpeg CPU threads for mp3 postprocessing
      if (ext === "mp3") {
        if (!ffmpegReady && !systemHasFfmpeg()) {
          throw new Error("ffmpeg not available on server - mp3 cannot be created");
        }
        builder.addArgs("--postprocessor-args", "ffmpeg:-threads 1");
      }

      // run
      await builder.run();

      // move to final
      try {
        await moveFileAtomic(tmpPath, finalPath);
      } catch (mvErr) {
        // fallback: look for other candidate parts
        try {
          const all = await fs.promises.readdir(CACHE_DIR);
          const candidates = all.filter(f => f.startsWith(id) && f !== path.basename(finalPath));
          if (candidates.length > 0) {
            await moveFileAtomic(path.join(CACHE_DIR, candidates[0]), finalPath);
          } else throw mvErr;
        } catch (e) { throw mvErr; }
      }

      // touch
      const now = new Date();
      await fs.promises.utimes(finalPath, now, now).catch(()=>{});
      pruneCache().catch(()=>{});
      console.log("Done:", finalPath);
      return { path: finalPath, id, title, cached: false };

    } catch (err) {
      try { await fs.promises.unlink(tmpPath).catch(()=>{}); } catch {}
      const strErr = String(err || "");
      if (strErr.includes("Sign in to confirm you’re not a bot") || strErr.toLowerCase().includes("cookies")) {
        throw new Error(`${strErr}\nHint: Provide cookies.txt or set USE_BROWSER_COOKIES=1 on a machine with Chrome profile access.`);
      }
      throw err;
    }
  })();

  ongoing.set(key, promise);
  promise.then(() => ongoing.delete(key)).catch(() => ongoing.delete(key));
  return promise;
}

async function serveFileWithRange(req, res, filePath, contentType, suggestedName) {
  try {
    const stat = await fs.promises.stat(filePath);
    const total = stat.size;
    const range = req.headers.range;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", `attachment; filename="${suggestedName}"`);

    if (!range) {
      res.setHeader("Content-Length", total);
      const rs = fs.createReadStream(filePath, { highWaterMark: STREAM_HIGH_WATER_MARK });
      await pipeline(rs, res);
      return;
    }

    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    if (isNaN(start) || isNaN(end) || start > end || end >= total) {
      res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
      return;
    }

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", chunkSize);
    const rs = fs.createReadStream(filePath, { start, end, highWaterMark: STREAM_HIGH_WATER_MARK });
    await pipeline(rs, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "file serve error", detail: String(err) });
  }
}

app.use(express.static(publicDir));
app.get("/", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

// MP3 endpoint
app.get("/api/mp3/url", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "missing url query param" });
  try {
    const id = hashUrl(url);
    const title = await getTitleFallback(url, id);
    const suggestedName = humanSafeName(title, "mp3");
    const result = await downloadAndCache(url, "mp3");
    await serveFileWithRange(req, res, result.path, "audio/mpeg", suggestedName);
  } catch (err) {
    console.error("MP3 error:", err?.message || err);
    res.status(500).json({ error: "mp3 failed", detail: String(err) });
  }
});

// MP4 endpoint
app.get("/api/mp4/url", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "missing url query param" });
  try {
    const id = hashUrl(url);
    const title = await getTitleFallback(url, id);
    const suggestedName = humanSafeName(title, "mp4");
    const result = await downloadAndCache(url, "mp4");
    await serveFileWithRange(req, res, result.path, "video/mp4", suggestedName);
  } catch (err) {
    console.error("MP4 error:", err?.message || err);
    res.status(500).json({ error: "mp4 failed", detail: String(err) });
  }
});

app.get("/_status", async (req, res) => {
  try {
    const cached = await fs.promises.readdir(CACHE_DIR).catch(()=>[]);
    res.json({
      cacheDir: CACHE_DIR,
      cachedFiles: cached.length,
      ongoing: Array.from(ongoing.keys()),
      ffmpegReady,
      ytDlpBinaryReady,
      cookiesConfigured: !!cookiesPath,
      downloadThreads: DOWNLOAD_THREADS,
      aria2cAvailable: systemHasAria2c(),
      useExternalDownloader: USE_EXTERNAL_DOWNLOADER
    });
  } catch (e) { res.json({ error: String(e) }); }
});

app.post("/upload-cookies", async (req, res) => {
  try {
    let contents = null;
    if (req.is("application/json") && req.body && req.body.base64) {
      contents = Buffer.from(req.body.base64, "base64").toString("utf8");
    } else if (typeof req.body === "string" && req.body.trim().length > 0) {
      contents = req.body;
    } else { return res.status(400).json({ error: "No cookie content provided." }); }
    await fs.promises.writeFile(cookieCandidate, contents);
    cookiesPath = cookieCandidate;
    return res.json({ ok: true, saved: cookieCandidate });
  } catch (e) {
    console.error("upload-cookies error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

process.on("unhandledRejection", (r) => { console.error("unhandledRejection:", r); });

(async () => {
  await prepareYtDlpBinary();
  await prepareFfmpeg();
  app.listen(PORT, () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
    console.log("Aria2c available:", systemHasAria2c());
    console.log("DOWNLOAD_THREADS:", DOWNLOAD_THREADS);
    console.log("USE_EXTERNAL_DOWNLOADER:", USE_EXTERNAL_DOWNLOADER);
  });
})();
