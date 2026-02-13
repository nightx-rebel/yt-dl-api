# 🎵 YouTube Downloader API (yt-dl)

![Node.js](https://img.shields.io/badge/Node.js-Backend-339933?style=flat-square&logo=nodedotjs)
![Express.js](https://img.shields.io/badge/Express-Framework-000000?style=flat-square&logo=express)
![yt-dlp](https://img.shields.io/badge/yt--dlp-Downloader-red?style=flat-square)

A sleek, fast, YouTube video and audio downloader built with **Node.js**, **Express**, and **ytdlp-nodejs**.

---

## ✨ Features

- 📥 **Direct MP3/MP4 Downloads:** Fetch audio and video with a single click.
- ⚡ **Smart Caching:** Saves downloaded files in a `/cache` folder to serve repeated requests instantly. Auto-prunes old files to save disk space.
- 🍪 **Advanced Cookie Support:** Easily bypass YouTube bot protections using `cookies.txt`, base64 environment variables, or even local Chrome browser cookies.
- ⏯️ **Range Requests Supported:** You can stream/seek the downloaded media files directly in the browser.

---

## 🛠️ Tech Stack

- **Backend:** Node.js, Express.js, ytdlp-nodejs, child_process
- **Tools:** yt-dlp, FFmpeg

---

## 🚀 Getting Started

### Prerequisites

Make sure you have [Node.js](https://nodejs.org/) installed on your machine.

### Installation

1. Clone the repository:
   ```bash
   git clone [https://github.com/nightx-rebel/yt-dl-api.git](https://github.com/nightx-rebel/yt-dl-api.git)
   cd yt-dl-api
   ```

- Install dependencies:
  npm install

- Start the server:
  npm start

  The server will run on http://localhost:3000 by default.
  ⚙️ Environment Variables
  | Variable | Description | Default |
  |---|---|---|
  | PORT | The port the server runs on. | 3000 |
  | MAX_CACHE_FILES | Max number of media files kept in cache. | 80 |
  | YT_C | Base64 encoded string of your cookies.txt. | null |
  | USE_BROWSER_COOKIES | Set to 1 or true to extract cookies from local Chrome. | false |
  🌐 API Endpoints

1. Download MP3
   GET /api/mp3/url?url=<YOUTUBE_URL>

Returns an MP3 audio file. 2. Download MP4
GET /api/mp4/url?url=<YOUTUBE_URL>

Returns an MP4 video file (Highest quality). 3. Server Status
GET /\_status

Returns a JSON object containing the cache status, binary readiness (ffmpeg/yt-dlp), and cookie configuration. 4. Upload Cookies
POST /upload-cookies

Body: Raw text or JSON { "base64": "..." }. Updates the cookies.txt file dynamically to bypass age restrictions or bot checks.
🍪 Cookie Management
If you encounter a "Sign in to confirm you’re not a bot" error, you need to provide YouTube cookies.
You can do this in three ways:

- Place a cookies.txt (Netscape format) in the root folder.
- Convert your cookies.txt to Base64 and set it as the YT_C environment variable.
- Set USE_BROWSER_COOKIES=1 (Only works if the server is running on a machine with a local Chrome profile).
- 👨‍💻 Authors nightx-rebel: 𝘴น𝚖𝔞ꪦ_𝗿ǿⲩ

---
