// ─────────────────────────────────────────────────────────────
//  FlashDrop — Secure Ephemeral File Sharing
//  server.js  ·  Express + Multer + UUID + Self-Destruct Logic
// ─────────────────────────────────────────────────────────────

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Paths ────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const META_FILE = path.join(__dirname, 'metadata.json');

// Ensure uploads dir exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ── Metadata Store ───────────────────────────────────────────
//  { id: { originalName, fileName, uploadedAt, expiresAt, size } }
let metadata = {};

// Load metadata from disk (survive restarts)
function loadMetadata() {
  try {
    if (fs.existsSync(META_FILE)) {
      metadata = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
    }
  } catch {
    metadata = {};
  }
}

function saveMetadata() {
  fs.writeFileSync(META_FILE, JSON.stringify(metadata, null, 2));
}

loadMetadata();

// ── Multer Config ────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    // Preserve extension but use UUID as filename
    const ext = path.extname(file.originalname);
    const id = uuidv4();
    cb(null, id + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB cap
});

// ── Security Headers ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],     // inline script in index.html
      imgSrc: ["'self'", "data:"],
    },
  },
}));

// ── Rate Limiting ────────────────────────────────────────────

// General limiter — 100 requests per minute per IP for normal browsing
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
});

// Strict upload limiter — 10 uploads per 15 minutes per IP
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Upload limit reached. Try again in a few minutes.' },
});

// Download limiter — 30 downloads per 5 minutes per IP (stops scraping)
const downloadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Download limit reached. Try again shortly.' },
});

// ── Middleware ────────────────────────────────────────────────
app.use(globalLimiter);
app.use(cors());
app.use(express.json());

// Trust proxy when behind Render / Railway / Cloudflare so rate
// limiting uses the real client IP instead of the proxy's IP.
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ───────────────────────────────────────────────────

// POST /upload  →  accept file, store metadata, return share link
app.post('/upload', uploadLimiter, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided.' });
  }

  const id = path.parse(req.file.filename).name; // UUID portion
  const TTL_MS = 10 * 60 * 1000; // 10 minutes

  metadata[id] = {
    originalName: req.file.originalname,
    fileName: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploadedAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  };

  saveMetadata();

  console.log(`[UPLOAD] ${req.file.originalname}  →  id: ${id}  (expires in 10 min)`);

  res.json({
    success: true,
    id,
    link: `/d/${id}`,
    originalName: req.file.originalname,
    size: req.file.size,
    expiresIn: '10 minutes',
  });
});

// GET /d/:id  →  download file, then IMMEDIATELY delete it (one-time download)
app.get('/d/:id', downloadLimiter, (req, res) => {
  const { id } = req.params;
  const entry = metadata[id];

  if (!entry) {
    return res.status(404).json({ error: 'File not found or already downloaded.' });
  }

  const filePath = path.join(UPLOADS_DIR, entry.fileName);

  if (!fs.existsSync(filePath)) {
    // File already cleaned up
    delete metadata[id];
    saveMetadata();
    return res.status(410).json({ error: 'File has been destroyed.' });
  }

  console.log(`[DOWNLOAD] ${entry.originalName}  ←  id: ${id}  (self-destructing…)`);

  // Stream the file, then self-destruct
  res.download(filePath, entry.originalName, (err) => {
    if (err) {
      console.error(`[ERROR] Download failed for ${id}:`, err.message);
      return;
    }

    // ── Self-Destruct: delete from disk + metadata ───────
    try {
      fs.unlinkSync(filePath);
      console.log(`[DESTROYED] File deleted from disk: ${entry.fileName}`);
    } catch (e) {
      console.error(`[WARN] Could not delete file ${entry.fileName}:`, e.message);
    }

    delete metadata[id];
    saveMetadata();
  });
});

// GET /info/:id  →  check if a file still exists (used by UI)
app.get('/info/:id', (req, res) => {
  const { id } = req.params;
  const entry = metadata[id];

  if (!entry) {
    return res.json({ exists: false });
  }

  res.json({
    exists: true,
    originalName: entry.originalName,
    size: entry.size,
    expiresAt: entry.expiresAt,
    remainingMs: Math.max(0, entry.expiresAt - Date.now()),
  });
});

// ── Background Cron — Expire files after 10 minutes ─────────
const CLEANUP_INTERVAL = 30 * 1000; // check every 30 seconds

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, entry] of Object.entries(metadata)) {
    if (now >= entry.expiresAt) {
      const filePath = path.join(UPLOADS_DIR, entry.fileName);

      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`[EXPIRED] Auto-deleted: ${entry.originalName} (id: ${id})`);
        }
      } catch (e) {
        console.error(`[CRON-ERR] Failed to delete ${entry.fileName}:`, e.message);
      }

      delete metadata[id];
      cleaned++;
    }
  }

  if (cleaned > 0) saveMetadata();
}, CLEANUP_INTERVAL);

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  FlashDrop is live');
  console.log(`  http://localhost:${PORT}`);
  console.log('  Files self-destruct after 1 download or 10 minutes');
  console.log('');
});
