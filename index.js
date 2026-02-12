/**
 * Optimized yt-dlp API with caching + concurrent-download dedupe + Range support
 *
 * Endpoints:
 *  - GET /api/mp3/url?url=<VIDEO_URL>
 *  - GET /api/mp4/url?url=<VIDEO_URL>
 *
 * Behavior:
 *  - Caches files under ./cache/<hash>.<ext>
 *  - If same file requested while download is in-progress, waits for same download (no duplicate fetch)
 *  - MP4 served with Range support (works for in-browser play/seek)
 *  - Simple cache pruning: keep maxCacheFiles files
 *
 * Requirements:
 *  - Node 18+
 *  - npm install (see package.json)
 *  - ffmpeg recommended for MP3 conversion (auto-download attempted)
 *
 * Notes: If ytdlp-nodejs stream API differs, small adjustments may be needed.
 */

import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import sanitize from "sanitize-filename";
import { pipeline } from "stream/promises";
import { spawnSync } from "child_process";
import crypto from "crypto";
import { YtDlp } from "ytdlp-nodejs";

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.join(process.cwd(), "cache");
const publicDir = path.join(process.cwd(), "public");
const MAX_CACHE_FILES = 80; // adjust as needed

// ensure cache dir exists
fs.mkdirSync(CACHE_DIR, { recursive: true });

// helpers
function hashUrl(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 18);
}
function tmpFileNameFor(id, ext) {
  return path.join(os.tmpdir(), `${id}.${ext}.part`);
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
    const res = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return res.status === 0 || res.status === null || res.status === undefined;
  } catch {
    return false;
  }
}

// simple LRU-ish prune based on mtime: keep newest MAX_CACHE_FILES files
async function pruneCache() {
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    const filePaths = files.map((f) => path.join(CACHE_DIR, f));
    const stats = await Promise.all(
      filePaths.map(async (fp) => {
        try {
          const s = await fs.promises.stat(fp);
          return { path: fp, mtime: s.mtimeMs, size: s.size };
        } catch {
          return null;
        }
      })
    );
    const valid = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
    if (valid.length > MAX_CACHE_FILES) {
      const toRemove = valid.slice(MAX_CACHE_FILES);
      await Promise.all(
        toRemove.map((r) => fs.promises.unlink(r.path).catch(() => {}))
      );
      console.log("Pruned cache, removed", toRemove.length, "files");
    }
  } catch (e) {
    console.warn("pruneCache failed:", e?.message || e);
  }
}

// map to track ongoing downloads: key => Promise
const ongoing = new Map();

// ensure ffmpeg available (try auto-download via ytdlp-nodejs, fallback to system)
const ytdlp = new YtDlp();
let ffmpegReady = false;
async function prepareFfmpeg() {
  try {
    console.log("Trying to auto-download ffmpeg via ytdlp-nodejs...");
    await ytdlp.downloadFFmpeg(); // may throw if not supported
    ffmpegReady = true;
    console.log("ffmpeg auto-downloaded (ytdlp-nodejs).");
  } catch (err) {
    console.warn("Auto-download ffmpeg failed:", err?.message || err);
    if (systemHasFfmpeg()) {
      ffmpegReady = true;
      console.log("System ffmpeg available.");
    } else {
      ffmpegReady = false;
      console.warn(
        "ffmpeg not available. MP3 endpoint will be disabled until ffmpeg is installed."
      );
    }
  }
}

// utility: try to get a nice title (fallback to url hash)
async function getTitleFallback(url, id) {
  try {
    const t = await ytdlp.getTitleAsync(url);
    if (t) return sanitize(t).slice(0, 140);
  } catch (e) {}
  return id;
}

// Download-and-cache function (returns final file path when done)
async function downloadAndCache(url, ext, ytdlpOptions = {}) {
  // key by url+ext
  const id = hashUrl(url);
  const finalPath = finalFilePathFor(id, ext);
  const tmpPath = tmpFileNameFor(id, ext);

  // if final file exists -> return immediately
  try {
    await fs.promises.access(finalPath, fs.constants.R_OK);
    // update mtime for LRU behavior
    const now = new Date();
    await fs.promises.utimes(finalPath, now, now).catch(() => {});
    return { path: finalPath, id, cached: true };
  } catch {
    // not cached, continue
  }

  // If another download is ongoing for same key -> await it
  const key = `${id}.${ext}`;
  if (ongoing.has(key)) {
    // wait for existing promise
    return ongoing.get(key);
  }

  // start download, store a promise in map
  const promise = (async () => {
    // remove leftover tmp if exists
    try {
      await fs.promises.unlink(tmpPath);
    } catch (e) {}

    // determine output friendly name for metadata
    let title = id;
    try {
      title = await getTitleFallback(url, id);
    } catch (e) {}

    // ensure parent dir
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });

    // build download options for ytdlp-nodejs
    // For mp4: get audio+video and merge into mp4
    // For mp3: extract audio and convert to mp3 (ffmpeg required)
    let opts = {
      output: tmpPath,
      // default: let wrapper choose; we also pass format instructions
      ...ytdlpOptions,
    };

    // set format heuristics
    if (ext === "mp3") {
      // require ffmpeg
      if (!ffmpegReady && !systemHasFfmpeg()) {
        throw new Error(
          "ffmpeg/ffprobe not available on server - mp3 cannot be created"
        );
      }
      // request best audio and force mp3 conversion (wrapper will use ffmpeg)
      opts.format = { filter: "audioonly", type: "mp3" };
    } else if (ext === "mp4") {
      // request best audio+video with mp4 container if possible
      // Use audioandvideo + prefer mp4 container when possible
      opts.format = { filter: "audioandvideo", type: "mp4" };
    }

    try {
      console.log("Downloading:", url, "->", tmpPath);
      // use ytdlp.download(...).run() as before
      await ytdlp.download(url, opts).run();

      // rename tmp -> final (atomic-ish)
      await fs.promises.rename(tmpPath, finalPath);
      // update mtime
      const now = new Date();
      await fs.promises.utimes(finalPath, now, now).catch(() => {});
      // prune cache asynchronously
      pruneCache().catch(() => {});
      console.log("Download complete:", finalPath);
      return { path: finalPath, id, title, cached: false };
    } catch (err) {
      // cleanup tmp
      try {
        await fs.promises.unlink(tmpPath);
      } catch (_) {}
      throw err;
    }
  })();

  ongoing.set(key, promise);

  // when done or error, remove from ongoing
  promise.then(() => ongoing.delete(key)).catch(() => ongoing.delete(key));

  return promise;
}

// Serve file with Range support (for video), or full file for audio
async function serveFileWithRange(
  req,
  res,
  filePath,
  contentType,
  suggestedName
) {
  try {
    const stat = await fs.promises.stat(filePath);
    const total = stat.size;
    const range = req.headers.range;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${suggestedName}"`
    );

    if (!range) {
      res.setHeader("Content-Length", total);
      const stream = fs.createReadStream(filePath);
      await pipeline(stream, res);
      return;
    }

    // parse Range
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

    const stream = fs.createReadStream(filePath, { start, end });
    await pipeline(stream, res);
  } catch (err) {
    if (!res.headersSent)
      res.status(500).json({ error: "file serve error", detail: String(err) });
  }
}

// serve static UI
app.use(express.static(publicDir));
app.get("/", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

// mp3 endpoint
app.get("/api/mp3/url", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "missing url query param" });

  try {
    const id = hashUrl(url);
    const title = await getTitleFallback(url, id);
    const suggestedName = humanSafeName(title, "mp3");

    const result = await downloadAndCache(url, "mp3");
    await serveFileWithRange(
      req,
      res,
      result.path,
      "audio/mpeg",
      suggestedName
    );
  } catch (err) {
    console.error("MP3 endpoint error:", err?.message || err);
    res.status(500).json({ error: "mp3 failed", detail: String(err) });
  }
});

// mp4 endpoint (Range support for browser playback)
app.get("/api/mp4/url", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "missing url query param" });

  try {
    const id = hashUrl(url);
    const title = await getTitleFallback(url, id);
    const suggestedName = humanSafeName(title, "mp4");

    const result = await downloadAndCache(url, "mp4");
    // serve with range => supports play/seek in browser & fast start
    await serveFileWithRange(req, res, result.path, "video/mp4", suggestedName);
  } catch (err) {
    console.error("MP4 endpoint error:", err?.message || err);
    res.status(500).json({ error: "mp4 failed", detail: String(err) });
  }
});

// small status endpoint to check cache / ongoing
app.get("/_status", async (req, res) => {
  try {
    const cached = await fs.promises.readdir(CACHE_DIR).catch(() => []);
    res.json({
      cacheDir: CACHE_DIR,
      cachedFiles: cached.length,
      ongoing: Array.from(ongoing.keys()),
      ffmpegReady,
    });
  } catch (e) {
    res.json({ error: String(e) });
  }
});

// prepare ffmpeg & start server
prepareFfmpeg().finally(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    if (!ffmpegReady) {
      console.warn(
        "Warning: ffmpeg/ffprobe not found. MP3 endpoint will not work until ffmpeg is available."
      );
    }
  });
});
