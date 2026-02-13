/**
 * @author nightx-rebel
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
const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.join(process.cwd(), "cache");
const publicDir = path.join(process.cwd(), "public");
const MAX_CACHE_FILES = parseInt(process.env.MAX_CACHE_FILES || "80", 10);

fs.mkdirSync(CACHE_DIR, { recursive: true });

app.use(
  express.text({ type: ["text/*", "application/octet-stream"], limit: "1mb" })
);
app.use(express.json({ limit: "1mb" }));

let cookiesPath = null;
const cookieCandidate = path.join(process.cwd(), "cookies.txt");

if (process.env.YT_C) {
  try {
    cookiesPath = cookieCandidate;
    if (!fs.existsSync(cookiesPath)) {
      fs.writeFileSync(cookiesPath, Buffer.from(process.env.YT_C, "base64"));
      console.log("cookies.txt written from YT_C env");
    } else {
      console.log("cookies.txt already exists, using it");
    }
  } catch (e) {
    console.warn("Failed to write cookies from YT_C env:", e?.message || e);
    cookiesPath = null;
  }
} else if (fs.existsSync(cookieCandidate)) {
  cookiesPath = cookieCandidate;
  console.log("Found existing cookies.txt");
}

// Helper utilities
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
    // cross-device fallback
    if (err && (err.code === "EXDEV" || err.code === "EEXIST")) {
      await fs.promises.copyFile(src, dest);
      try {
        await fs.promises.unlink(src);
      } catch (e) {
        // ignore
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
        if (s.isFile() && s.size > 0) {
          candidates.push({ path: full, size: s.size, mtime: s.mtimeMs });
        }
      } catch {
        // ignore
      }
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
const ytdlp = new YtDlp();
let ffmpegReady = false;
let ytDlpBinaryReady = false;

async function prepareYtDlpBinary() {
  try {
    console.log("Ensuring yt-dlp binary is present...");
    await helpers.downloadYtDlp();
    ytDlpBinaryReady = true;
    console.log("yt-dlp binary is ready.");
  } catch (err) {
    ytDlpBinaryReady = false;
    console.warn("Could not auto-download yt-dlp binary:", err?.message || err);
  }
}

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
  } catch {
    // ignore
  }
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
  } catch {
    // not cached
  }

  const key = `${id}.${ext}`;
  if (ongoing.has(key)) return ongoing.get(key);

  const promise = (async () => {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // ignore
    }

    let title = id;
    try {
      title = await getTitleFallback(url, id);
    } catch {
      // ignore
    }

    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });

    // format options
    const formatObj =
      ext === "mp3"
        ? { filter: "audioonly", type: "mp3", quality: "0" }
        : { filter: "audioandvideo", type: "mp4", quality: "highest" };

    const opts = {
      output: tmpPath,
      format: formatObj,
      ...ytdlpOptions,
    };

    try {
      console.log("Starting ytdlp download:", url, "->", tmpPath);
      const builder = ytdlp.download(url, opts);

      // apply cookies if available
      let cookieApplied = false;
      const useBrowserCookiesFlag =
        process.env.USE_BROWSER_COOKIES === "1" ||
        process.env.USE_BROWSER_COOKIES === "true";

      if (cookiesPath && fs.existsSync(cookiesPath)) {
        try {
          builder.cookies(cookiesPath);
          console.log(
            "Applied cookies file via builder.cookies():",
            cookiesPath
          );
          cookieApplied = true;
        } catch (e) {
          try {
            builder.addArgs("--cookies", cookiesPath);
            console.log("Applied cookies via --cookies arg:", cookiesPath);
            cookieApplied = true;
          } catch (e2) {
            console.warn(
              "Failed to apply cookies via builder APIs:",
              e2?.message || e2
            );
          }
        }
      } else if (useBrowserCookiesFlag) {
        try {
          builder.cookiesFromBrowser("chrome");
          console.log(
            "Using cookiesFromBrowser('chrome') (USE_BROWSER_COOKIES=1)."
          );
          cookieApplied = true;
        } catch (e) {
          console.warn(
            "cookiesFromBrowser failed (no accessible browser profile):",
            e?.message || e
          );
        }
      }

      if (!cookieApplied && /youtube\.com|youtu\.be/.test(url)) {
        console.warn(
          "No cookies applied for YouTube URL. If YouTube requires login, export cookies to cookies.txt or set YT_C env."
        );
      }

      if (ext === "mp3" && !ffmpegReady && !systemHasFfmpeg()) {
        throw new Error(
          "ffmpeg/ffprobe not available on server - mp3 cannot be created"
        );
      }

      // run ytdlp
      await builder.run();

      try {
        await moveFileAtomic(tmpPath, finalPath);
      } catch (mvErr) {
        if (
          mvErr &&
          (mvErr.code === "ENOENT" ||
            mvErr.code === "EXDEV" ||
            mvErr.code === "EEXIST")
        ) {
          const found = await findCandidateAndMove(id, finalPath);
          if (!found) throw mvErr;
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
      } catch {
        // ignore
      }

      const strErr = String(err || "");
      if (
        strErr.includes("Sign in to confirm you’re not a bot") ||
        strErr.toLowerCase().includes("cookies") ||
        strErr.toLowerCase().includes("could not find chrome cookies database")
      ) {
        throw new Error(
          `${strErr}\n\nHint: Ensure cookies.txt exists and is in netscape format, or set USE_BROWSER_COOKIES=1 on a machine with Chrome profile access. You can create cookies.txt locally with: yt-dlp --cookies-from-browser chrome --cookies cookies.txt "https://www.youtube.com/watch?v=..."`
        );
      }

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
    if (!res.headersSent) {
      res.status(500).json({ error: "file serve error", detail: String(err) });
    }
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
      ytDlpBinaryReady,
      cookiesConfigured: !!cookiesPath,
      useBrowserCookiesAllowed: !!(
        process.env.USE_BROWSER_COOKIES === "1" ||
        process.env.USE_BROWSER_COOKIES === "true"
      ),
    });
  } catch (e) {
    res.json({ error: String(e) });
  }
});

app.post("/upload-cookies", async (req, res) => {
  try {
    let contents = null;

    if (req.is("application/json") && req.body && req.body.base64) {
      contents = Buffer.from(req.body.base64, "base64").toString("utf8");
    } else if (typeof req.body === "string" && req.body.trim().length > 0) {
      contents = req.body;
    } else {
      return res.status(400).json({
        error:
          "No cookie content provided. Send raw cookies text or JSON { base64 }.",
      });
    }

    await fs.promises.writeFile(cookieCandidate, contents);
    cookiesPath = cookieCandidate;
    return res.json({ ok: true, saved: cookieCandidate });
  } catch (e) {
    console.error("upload-cookies error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

process.on("unhandledRejection", (r) => {
  console.error("unhandledRejection:", r);
});

// Boot sequence
(async () => {
  await prepareYtDlpBinary();
  await prepareFfmpeg();

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);

    if (!ffmpegReady) {
      console.warn(
        "Warning: ffmpeg/ffprobe not found. MP3 endpoint will not work until ffmpeg is available."
      );
    }

    if (!ytDlpBinaryReady) {
      console.warn(
        "Warning: yt-dlp binary may not have been downloaded automatically. If downloads fail, install yt-dlp on the system or allow auto-download."
      );
    }

    if (!cookiesPath) {
      console.warn(
        "Warning: No cookies configured. YouTube downloads may fail. Set YT_C env variable or create cookies.txt file (or use /upload-cookies)."
      );
    } else {
      console.log("Cookies configured from:", cookiesPath);
    }
  });
})();
