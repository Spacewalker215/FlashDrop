# FlashDrop

One-time file sharing. Drop a file, get a link, share it. The file deletes itself after the first download — or after 10 minutes, whichever happens first. No accounts, no cloud storage, no trace.

![Node.js](https://img.shields.io/badge/node-%3E%3D18-333?style=flat&logo=node.js)
![License](https://img.shields.io/badge/license-MIT-333?style=flat)

---

## Why

I needed to send files between my own devices without signing into Google Drive, WeTransfer, or whatever else wants my email. Most "secure file sharing" tools are either overkill (PGP, Magic Wormhole CLI) or not actually ephemeral (the file sits on someone's S3 bucket forever).

FlashDrop is the middle ground: run it locally or on a cheap VPS, share a link, done. The file is physically removed from disk after one download. There's a 10-minute TTL cleanup as a safety net.

## How it works

```
You ──[upload]──> Server writes file to /uploads + stores metadata in memory
                  Returns a unique link: /d/<uuid>

Anyone ──[GET /d/<uuid>]──> Server streams the file back
                             Then immediately deletes it from disk
                             Link is now dead (404)

Meanwhile: a setInterval loop runs every 30s and purges
           anything older than 10 minutes that wasn't downloaded
```

There's no database. Metadata lives in a JSON file so it survives server restarts, but that's it.

## Quick start

```bash
git clone https://github.com/Spacewalker215/FlashDrop.git
cd FlashDrop
npm install
node server.js
```

Open `http://localhost:3000`. Drag a file in. You'll get a link.

## Configuration

Everything is hardcoded because it's a small tool, but the constants you'd want to change are at the top of `server.js`:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Server port |
| `TTL_MS` | `10 * 60 * 1000` | How long before auto-delete (ms) |
| `CLEANUP_INTERVAL` | `30 * 1000` | How often the cleanup loop runs (ms) |
| `fileSize` limit | `100 * 1024 * 1024` | Max upload size (100 MB) |

If you want to change these, just edit the file directly. I didn't add a `.env` setup because it felt like overengineering for four variables.

## Project structure

```
.
├── server.js           # Express server, upload/download routes, cleanup cron
├── public/
│   ├── index.html      # Frontend (vanilla JS, no framework)
│   └── style.css       # Dark UI, Inter font, minimal design
├── uploads/            # Temp storage — files live here briefly
├── package.json
└── .gitignore
```

## API

**`POST /upload`** — Multipart form, field name `file`. Returns:
```json
{
  "success": true,
  "id": "a1b2c3d4-...",
  "link": "/d/a1b2c3d4-...",
  "originalName": "document.pdf",
  "size": 204800,
  "expiresIn": "10 minutes"
}
```

**`GET /d/:id`** — Downloads the file. The file is deleted from disk after the response completes. Hitting this endpoint again returns `404`.

**`GET /info/:id`** — Check if a file still exists without downloading it. Returns `{ "exists": true/false }` and remaining TTL.

## Deployment

This is a Node.js server — it needs a runtime, not static hosting (so GitHub Pages won't work).

**Render** (free tier):
1. New → Web Service → connect this repo
2. Build command: `npm install`
3. Start command: `node server.js`
4. Deploy

Also works on Railway, Fly.io, or any VPS with Node installed.

> **Note:** The `uploads/` directory needs to be writable. On most platforms this works out of the box. On Render's free tier, the filesystem is ephemeral anyway (containers restart), which actually pairs well with FlashDrop's design — nothing persists.

## Limitations

- Files are stored unencrypted on disk. If you need end-to-end encryption, this isn't it.
- Single-server only. No clustering, no shared storage.
- The 100 MB limit is arbitrary — bump it in `server.js` if you want, but keep in mind memory/disk on whatever you're hosting on.
- No rate limiting. If you expose this to the internet, consider putting it behind Cloudflare or adding `express-rate-limit`.

## License

MIT — do whatever you want with it.
