import express from "express";
import fs from "fs";
import path from "path";
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

fs.mkdirSync(CACHE_DIR, { recursive: true });

// Helpers
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
    const res = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return res.status === 0 || res.status === null || res.status === undefined;
  } catch {
    return false;
  }
}
async function moveFileAtomic(src, dest) {
  try {
    await fs.promises.rename(src, dest);
    return;
  } catch (err) {
    if (err && err.code === "EXDEV") {
      await fs.promises.copyFile(src, dest);
      try {
        await fs.promises.unlink(src);
      } catch (e) {
        /* ignore */
      }
      return;
    }
    throw err;
  }
}
async function findCandidateAndMove(id, finalPath) {
  const all = await fs.promises.readdir(CACHE_DIR);
  const candidates = [];
  for (const f of all) {
    if (f.startsWith(id) && f !== path.basename(finalPath)) {
      const full = path.join(CACHE_DIR, f);
      try {
        const s = await fs.promises.stat(full);
        if (s.isFile() && s.size > 0)
          candidates.push({ path: full, size: s.size, mtime: s.mtimeMs });
      } catch {}
    }
  }
  if (candidates.length === 0) return false;
  candidates.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return b.mtime - a.mtime;
  });
  const chosen = candidates[0].path;
  await moveFileAtomic(chosen, finalPath);
  return true;
}

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

const ongoing = new Map();

// ytdlp + ffmpeg readiness
const ytdlp = new YtDlp();
let ffmpegReady = false;
async function prepareFfmpeg() {
  try {
    console.log("Trying to auto-download ffmpeg via ytdlp-nodejs...");
    await ytdlp.downloadFFmpeg();
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

async function getTitleFallback(url, id) {
  try {
    const t = await ytdlp.getTitleAsync(url);
    if (t) return sanitize(t).slice(0, 140);
  } catch (e) {}
  return id;
}

async function downloadAndCache(url, ext, ytdlpOptions = {}) {
  const id = hashUrl(url);
  const finalPath = finalFilePathFor(id, ext);
  const tmpPath = tmpFileNameFor(id, ext);

  try {
    await fs.promises.access(finalPath, fs.constants.R_OK);
    const now = new Date();
    await fs.promises.utimes(finalPath, now, now).catch(() => {});
    return { path: finalPath, id, cached: true };
  } catch {}

  const key = `${id}.${ext}`;
  if (ongoing.has(key)) return ongoing.get(key);

  const promise = (async () => {
    try {
      await fs.promises.unlink(tmpPath);
    } catch (e) {}

    let title = id;
    try {
      title = await getTitleFallback(url, id);
    } catch (e) {}

    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });

    const opts = { output: tmpPath, ...ytdlpOptions };

    if (ext === "mp3") {
      if (!ffmpegReady && !systemHasFfmpeg()) {
        throw new Error(
          "ffmpeg/ffprobe not available on server - mp3 cannot be created"
        );
      }
      opts.format = { filter: "audioonly", type: "mp3" };
    } else if (ext === "mp4") {
      opts.format = { filter: "audioandvideo", type: "mp4" };
    }

    try {
      console.log("Downloading:", url, "->", tmpPath);
      await ytdlp.download(url, opts).run();

      try {
        await moveFileAtomic(tmpPath, finalPath);
      } catch (mvErr) {
        if (mvErr && (mvErr.code === "ENOENT" || mvErr.code === "ENOENT")) {
          const found = await findCandidateAndMove(id, finalPath);
          if (!found) throw mvErr; // no candidate -> rethrow
        } else {
          throw mvErr;
        }
      }

      const now = new Date();
      await fs.promises.utimes(finalPath, now, now).catch(() => {});
      pruneCache().catch(() => {});
      console.log("Download complete:", finalPath);
      return { path: finalPath, id, title, cached: false };
    } catch (err) {
      try {
        await fs.promises.unlink(tmpPath);
      } catch (_) {}
      throw err;
    }
  })();

  ongoing.set(key, promise);
  promise.then(() => ongoing.delete(key)).catch(() => ongoing.delete(key));
  return promise;
}
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
    console.error("MP4 endpoint error:", err?.message || err);
    res.status(500).json({ error: "mp4 failed", detail: String(err) });
  }
});

// status endpoint
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

// boot
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
