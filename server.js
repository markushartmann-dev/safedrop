'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Transform } = require('stream');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = parseInt(process.env.PORT || '3000');
const DATA_DIR = process.env.DATA_DIR || '/data';
const FILES_DIR = path.join(DATA_DIR, 'files');
const CHUNKS_DIR = path.join(DATA_DIR, 'chunks');
const DB_PATH = path.join(DATA_DIR, 'safedrop.db');
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

[DATA_DIR, FILES_DIR, CHUNKS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── STIG Password Generator ───────────────────────────────────────────────────

function generateStigPassword() {
  const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower   = 'abcdefghjkmnpqrstuvwxyz';
  const digits  = '23456789';
  const special = '!@#$%^&*()-_=+[]{}|;:,.<>?';
  const all     = upper + lower + digits + special;

  // 2 guaranteed from each category
  const chars = [
    upper[crypto.randomInt(upper.length)],   upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)],   lower[crypto.randomInt(lower.length)],
    digits[crypto.randomInt(digits.length)], digits[crypto.randomInt(digits.length)],
    special[crypto.randomInt(special.length)], special[crypto.randomInt(special.length)],
  ];
  // fill to 20 chars
  while (chars.length < 20) chars.push(all[crypto.randomInt(all.length)]);
  // Fisher-Yates shuffle with crypto random
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ── Database ─────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS files (
    id            TEXT    PRIMARY KEY,
    original_name TEXT    NOT NULL,
    mime_type     TEXT    NOT NULL DEFAULT 'application/octet-stream',
    size          INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    password_salt TEXT,
    expires_at    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    max_downloads  INTEGER NOT NULL DEFAULT 0,
    encrypted     INTEGER NOT NULL DEFAULT 0,
    iv            TEXT,
    auth_tag      TEXT,
    user_id       TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT    PRIMARY KEY,
    original_name   TEXT    NOT NULL,
    mime_type       TEXT    NOT NULL DEFAULT 'application/octet-stream',
    total_chunks    INTEGER NOT NULL,
    received_chunks TEXT    NOT NULL DEFAULT '[]',
    password        TEXT,
    expires_in      INTEGER NOT NULL,
    max_downloads   INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    user_id         TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT    PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    password_salt TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    created_at    INTEGER NOT NULL,
    last_login    INTEGER,
    active        INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id         TEXT    PRIMARY KEY,
    user_id    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip         TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS system_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT    NOT NULL,
    message    TEXT    NOT NULL,
    meta       TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS secrets (
    token           TEXT    PRIMARY KEY,
    content         TEXT    NOT NULL,
    views_max       INTEGER NOT NULL DEFAULT 1,
    views_used      INTEGER NOT NULL DEFAULT 0,
    expires_at      INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    created_by      TEXT,
    passphrase_hash TEXT,
    passphrase_salt TEXT
  );

  CREATE TABLE IF NOT EXISTS transfer_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id        TEXT    NOT NULL UNIQUE,
    original_name  TEXT    NOT NULL,
    size           INTEGER NOT NULL DEFAULT 0,
    encrypted      INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    max_downloads  INTEGER NOT NULL DEFAULT 0,
    download_count INTEGER NOT NULL DEFAULT 0,
    uploader_ip    TEXT,
    user_id        TEXT,
    uploader       TEXT,
    is_guest       INTEGER NOT NULL DEFAULT 0,
    status         TEXT    NOT NULL DEFAULT 'active',
    deleted_at     INTEGER
  );
`);

// ── Seed default settings ─────────────────────────────────────────────────────
{
  const DEFAULT_BW = '25600'; // 200 Mbit/s in KB/s
  if (!db.prepare("SELECT value FROM settings WHERE key = 'download_limit_kbps'").get())
    db.prepare("INSERT INTO settings (key, value) VALUES ('download_limit_kbps', ?)").run(DEFAULT_BW);
  if (!db.prepare("SELECT value FROM settings WHERE key = 'upload_limit_kbps'").get())
    db.prepare("INSERT INTO settings (key, value) VALUES ('upload_limit_kbps', ?)").run(DEFAULT_BW);
}

// Migrate: add columns if they don't exist yet
const _migrations = [
  'ALTER TABLE files ADD COLUMN user_id TEXT',
  'ALTER TABLE sessions ADD COLUMN user_id TEXT',
  'ALTER TABLE auth_sessions ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE files ADD COLUMN uploader_ip TEXT',
];
for (const m of _migrations) { try { db.exec(m); } catch (_) {} }

// Seed transfer_log from existing files (one-time migration for upgrades)
try {
  db.prepare(`
    INSERT OR IGNORE INTO transfer_log
      (file_id, original_name, size, encrypted, created_at, expires_at,
       max_downloads, download_count, uploader_ip, user_id, uploader, is_guest, status)
    SELECT
      f.id, f.original_name, f.size, f.encrypted, f.created_at, f.expires_at,
      f.max_downloads, f.download_count, f.uploader_ip, f.user_id,
      COALESCE(u.username, 'Guest'),
      CASE WHEN f.user_id IS NULL THEN 1 ELSE 0 END,
      CASE WHEN f.expires_at < ? THEN 'expired' ELSE 'active' END
    FROM files f
    LEFT JOIN users u ON u.id = f.user_id
  `).run(Date.now());
} catch (_) {}

// ── Settings helpers ──────────────────────────────────────────────────────────

function getSetting(key, def = '0') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}
function getSettingInt(key, def = 0) {
  return parseInt(getSetting(key, String(def))) || def;
}

// ── System log ────────────────────────────────────────────────────────────────

function logEvent(type, message, meta = null) {
  try {
    db.prepare('INSERT INTO system_log (event_type, message, meta, created_at) VALUES (?, ?, ?, ?)')
      .run(type, message, meta ? JSON.stringify(meta) : null, Date.now());
  } catch (_) {}
}

// ── Bandwidth throttle ────────────────────────────────────────────────────────

// Download: per-request token-bucket throttle stream
function createDownloadThrottle(kbps) {
  if (!kbps || kbps <= 0) return null;
  const bps = kbps * 1024;
  let sent = 0;
  const start = Date.now();
  return new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length;
      const elapsed = (Date.now() - start) / 1000;
      const target  = sent / bps;          // how many seconds this should have taken
      const delay   = Math.max(0, (target - elapsed) * 1000);
      if (delay > 5) {
        setTimeout(() => { this.push(chunk); cb(); }, delay);
      } else {
        this.push(chunk); cb();
      }
    }
  });
}

// Upload: global token-bucket – delays finalization of chunk handler
const _upBucket = { tokens: 0, last: Date.now() };
function waitUploadThrottle(bytes) {
  const kbps = getSettingInt('upload_limit_kbps');
  if (!kbps) return Promise.resolve();
  const bps = kbps * 1024;
  const now = Date.now();
  const elapsed = (now - _upBucket.last) / 1000;
  _upBucket.tokens = Math.min(bps * 2, _upBucket.tokens + elapsed * bps);
  _upBucket.last   = now;
  _upBucket.tokens -= bytes;
  if (_upBucket.tokens < 0) {
    const wait = Math.min((-_upBucket.tokens / bps) * 1000, 15000);
    return new Promise(r => setTimeout(r, wait));
  }
  return Promise.resolve();
}

// ── Bootstrap admin user ──────────────────────────────────────────────────────

{
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (count.c === 0) {
    const pw = 'SZ7@W57PWiv25lk8';
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
    const id = uuidv4();
    db.prepare(`
      INSERT INTO users (id, username, password_hash, password_salt, role, created_at, active)
      VALUES (?, 'admin', ?, ?, 'admin', ?, 1)
    `).run(id, hash, salt, Date.now());
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║         INITIAL ADMIN USER CREATED           ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Username: admin                             ║`);
    console.log(`║  Password: ${pw}  ║`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth Middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.fs_session;
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const session = db.prepare(`
    SELECT s.*,
           COALESCE(u.id,       s.id)     AS uid,
           COALESCE(u.username, 'Guest')  AS uname,
           COALESCE(u.role,     'guest')  AS urole,
           COALESCE(u.active,   1)        AS uactive
    FROM auth_sessions s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?
  `).get(token, Date.now());

  if (!session) {
    res.clearCookie('fs_session');
    return res.status(401).json({ error: 'Session expired' });
  }
  if (!session.is_guest && !session.uactive)
    return res.status(403).json({ error: 'Account disabled' });

  req.user = {
    id:       session.uid,
    username: session.uname,
    role:     session.is_guest ? 'guest' : session.urole,
    isGuest:  !!session.is_guest
  };
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    next();
  });
}

// ── Multer: chunk storage ─────────────────────────────────────────────────────

const chunkStorage = multer.diskStorage({
  destination(req, _file, cb) {
    const sid = (req.body.sessionId || '').replace(/[^a-zA-Z0-9\-]/g, '');
    if (!sid) return cb(new Error('Missing sessionId'));
    const dir = path.join(CHUNKS_DIR, sid);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, _file, cb) {
    const idx = parseInt(req.body.chunkIndex ?? '-1');
    if (idx < 0) return cb(new Error('Invalid chunkIndex'));
    cb(null, `chunk_${idx}`);
  }
});

const upload = multer({
  storage: chunkStorage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ── Auth Routes ───────────────────────────────────────────────────────────────

// Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const hash = crypto.pbkdf2Sync(password, user.password_salt, 100000, 32, 'sha256').toString('hex');
  if (hash !== user.password_hash) return res.status(401).json({ error: 'Invalid credentials' });

  // Delete old sessions for this user to keep it clean
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND expires_at < ?').run(user.id, Date.now());

  const token = uuidv4();
  const now = Date.now();
  const expires = now + SESSION_TTL_MS;
  const ip = req.ip || req.connection.remoteAddress || '';

  db.prepare(`
    INSERT INTO auth_sessions (id, user_id, created_at, expires_at, ip)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, user.id, now, expires, ip);

  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now, user.id);

  res.cookie('fs_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    secure: process.env.NODE_ENV === 'production'
  });

  res.json({ ok: true, username: user.username, role: user.role });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies && req.cookies.fs_session;
  if (token) db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(token);
  res.clearCookie('fs_session');
  res.json({ ok: true });
});

// Me
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role, isGuest: req.user.isGuest });
});

// Guest (anonymous) session
app.post('/api/auth/guest', (req, res) => {
  const token = uuidv4();
  const now   = Date.now();
  const GUEST_TTL = 4 * 60 * 60 * 1000; // 4 hours
  const ip = req.ip || req.connection.remoteAddress || '';
  db.prepare(`
    INSERT INTO auth_sessions (id, user_id, created_at, expires_at, ip, is_guest)
    VALUES (?, '', ?, ?, ?, 1)
  `).run(token, now, now + GUEST_TTL, ip);

  res.cookie('fs_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   GUEST_TTL,
    secure:   process.env.NODE_ENV === 'production'
  });
  res.json({ ok: true });
});

// Generate STIG password (authenticated users only)
app.get('/api/password/generate', requireAuth, (_req, res) => {
  res.json({ password: generateStigPassword() });
});

// ── Upload Routes (require Auth) ──────────────────────────────────────────────

// 1. Init upload session
app.post('/api/upload/init', requireAuth, (req, res) => {
  const { filename, mimeType, totalChunks, password, expiresIn, maxDownloads } = req.body;

  if (!filename || !totalChunks || expiresIn == null) {
    return res.status(400).json({ error: 'filename, totalChunks and expiresIn are required' });
  }

  // Guest restrictions: max 4h, password mandatory
  if (req.user.isGuest) {
    if (!password) return res.status(400).json({ error: 'Guests must set a password (required)' });
    const maxGuest = 4 * 3600;
    if (parseInt(expiresIn) === 0 || parseInt(expiresIn) > maxGuest) {
      return res.status(400).json({ error: 'Guests can store files for a maximum of 4 hours' });
    }
  }

  const sessionId = uuidv4();
  db.prepare(`
    INSERT INTO sessions (id, original_name, mime_type, total_chunks, password, expires_in, max_downloads, created_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    filename,
    mimeType || 'application/octet-stream',
    parseInt(totalChunks),
    password || null,
    parseInt(expiresIn),
    parseInt(maxDownloads || 0),
    Date.now(),
    req.user.id
  );

  res.json({ sessionId });
});

// 2. Upload chunk (require Auth)
app.post('/api/upload/chunk', requireAuth, upload.single('chunk'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No chunk received' });

  const { sessionId, chunkIndex } = req.body;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Apply upload throttle (delays response proportionally to chunk size)
  await waitUploadThrottle(req.file.size);

  const received = new Set(JSON.parse(session.received_chunks));
  received.add(parseInt(chunkIndex));
  db.prepare('UPDATE sessions SET received_chunks = ? WHERE id = ?')
    .run(JSON.stringify([...received]), sessionId);

  res.json({ received: received.size, total: session.total_chunks });
});

// 3. Finalize (require Auth)
app.post('/api/upload/finalize', requireAuth, async (req, res) => {
  const { sessionId } = req.body;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const received = JSON.parse(session.received_chunks);
  if (received.length < session.total_chunks) {
    return res.status(400).json({
      error: `Incomplete: ${received.length}/${session.total_chunks} chunks received`
    });
  }

  const fileId = uuidv4();
  const sessionDir = path.join(CHUNKS_DIR, sessionId);
  const filePath = path.join(FILES_DIR, fileId);

  try {
    await assembleChunks(sessionDir, filePath, session.total_chunks);
    const { size } = fs.statSync(filePath);

    let encrypted = 0, iv = null, authTag = null, passwordHash = null, passwordSalt = null;

    if (session.password) {
      const enc = await encryptFile(filePath, session.password);
      iv = enc.iv;
      authTag = enc.authTag;
      passwordSalt = enc.salt;
      passwordHash = crypto.createHash('sha256')
        .update(session.password + passwordSalt).digest('hex');
      encrypted = 1;
    }

    const now = Date.now();
    const uploaderIp = req.ip || req.connection.remoteAddress || null;
    db.prepare(`
      INSERT INTO files
        (id, original_name, mime_type, size, password_hash, password_salt,
         expires_at, created_at, max_downloads, encrypted, iv, auth_tag, user_id, uploader_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fileId, session.original_name, session.mime_type, size,
      passwordHash, passwordSalt,
      session.expires_in === 0 ? 9999999999999 : now + session.expires_in * 1000, now,
      session.max_downloads, encrypted, iv, authTag,
      req.user.isGuest ? null : req.user.id,
      uploaderIp
    );

    // Mirror upload into transfer_log for persistent history
    db.prepare(`
      INSERT OR IGNORE INTO transfer_log
        (file_id, original_name, size, encrypted, created_at, expires_at,
         max_downloads, download_count, uploader_ip, user_id, uploader, is_guest, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'active')
    `).run(
      fileId, session.original_name, size, encrypted,
      now,
      session.expires_in === 0 ? 9999999999999 : now + session.expires_in * 1000,
      session.max_downloads, uploaderIp,
      req.user.isGuest ? null : req.user.id,
      req.user.isGuest ? 'Guest' : req.user.username,
      req.user.isGuest ? 1 : 0
    );

    fs.rmSync(sessionDir, { recursive: true, force: true });
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    res.json({ fileId, expiresAt: now + session.expires_in * 1000 });
  } catch (err) {
    console.error('Finalize error:', err);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ── Download Routes (public) ──────────────────────────────────────────────────

// 4. File metadata (public)
app.get('/api/info/:id', (req, res) => {
  const file = db.prepare(`
    SELECT id, original_name, mime_type, size, expires_at, created_at,
           download_count, max_downloads, encrypted
    FROM files WHERE id = ?
  `).get(req.params.id);

  if (!file) return res.status(404).json({ error: 'Not found' });
  if (Date.now() > file.expires_at) return res.status(410).json({ error: 'Expired' });

  res.json({
    id: file.id,
    name: file.original_name,
    size: file.size,
    mimeType: file.mime_type,
    expiresAt: file.expires_at,
    createdAt: file.created_at,
    downloads: file.download_count,
    maxDownloads: file.max_downloads,
    passwordProtected: file.encrypted === 1
  });
});

// helper: no-cache
function noCache(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
}

// 5. Download file (public)
app.get('/api/download/:id', (req, res) => {
  noCache(res);

  if (req.method === 'HEAD') return res.status(200).end();

  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);

  if (!file) return res.status(404).json({ error: 'Not found' });
  if (Date.now() > file.expires_at) return res.status(410).json({ error: 'Expired' });

  const password = req.query.password;

  if (file.encrypted) {
    if (!password) return res.status(401).json({ error: 'Password required' });
    const hash = crypto.createHash('sha256').update(password + file.password_salt).digest('hex');
    if (hash !== file.password_hash) return res.status(401).json({ error: 'Wrong password' });
  }

  const filePath = path.join(FILES_DIR, file.id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });

  const result = db.prepare(`
    UPDATE files
    SET download_count = download_count + 1
    WHERE id = ?
      AND expires_at > ?
      AND (max_downloads = 0 OR download_count < max_downloads)
  `).run(file.id, Date.now());

  if (result.changes === 0) {
    return res.status(410).json({ error: 'Download limit reached' });
  }

  // Keep transfer_log download count in sync
  db.prepare('UPDATE transfer_log SET download_count = download_count + 1 WHERE file_id = ?').run(file.id);

  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');

  const throttle = createDownloadThrottle(getSettingInt('download_limit_kbps'));

  if (file.encrypted) {
    const key = crypto.pbkdf2Sync(
      password, Buffer.from(file.password_salt, 'hex'), 100000, 32, 'sha256'
    );
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm', key, Buffer.from(file.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(file.auth_tag, 'hex'));
    const stream = fs.createReadStream(filePath);
    res.on('close', () => stream.destroy());
    if (throttle) {
      stream.pipe(decipher).pipe(throttle).pipe(res);
      decipher.on('error', () => res.destroy());
    } else {
      stream.pipe(decipher).pipe(res);
      decipher.on('error', () => res.destroy());
    }
  } else {
    if (!throttle) res.setHeader('Content-Length', file.size);
    const stream = fs.createReadStream(filePath);
    res.on('close', () => stream.destroy());
    if (throttle) {
      stream.pipe(throttle).pipe(res);
    } else {
      stream.pipe(res);
    }
  }
});

// 5b. Image preview (public, no download-count increment)
app.get('/api/preview/:id', (req, res) => {
  noCache(res);
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!file) return res.status(404).end();
  if (Date.now() > file.expires_at) return res.status(410).end();
  if (file.encrypted) return res.status(403).json({ error: 'Encrypted – preview not available' });
  const mime = file.mime_type || '';
  if (!mime.startsWith('image/')) return res.status(415).end();
  const filePath = path.join(FILES_DIR, file.id);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', file.size);
  fs.createReadStream(filePath).pipe(res);
});

// 6. Verify password (public)
app.post('/api/verify/:id', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  if (Date.now() > file.expires_at) return res.status(410).json({ error: 'Expired' });

  if (!file.encrypted) return res.json({ ok: true });

  const { password } = req.body;
  if (!password) return res.status(401).json({ error: 'Password required' });
  const hash = crypto.createHash('sha256').update(password + file.password_salt).digest('hex');
  if (hash !== file.password_hash) return res.status(401).json({ error: 'Wrong password' });
  res.json({ ok: true });
});

// ── Anonymous upload log (admin) ─────────────────────────────────────────────

// Legacy anon-log (kept for backwards compat)
app.get('/api/admin/anon-log', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT id, original_name, size, created_at, expires_at,
           download_count, max_downloads, encrypted, uploader_ip
    FROM files WHERE user_id IS NULL
    ORDER BY created_at DESC LIMIT 200
  `).all();
  res.json(rows);
});

// All-transfers protocol — reads from persistent transfer_log (includes deleted/expired)
app.get('/api/admin/transfers', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT file_id AS id, original_name, size, created_at, expires_at,
           download_count, max_downloads, encrypted, uploader_ip,
           user_id, uploader, is_guest, status, deleted_at
    FROM transfer_log
    ORDER BY created_at DESC
    LIMIT 500
  `).all();
  res.json(rows);
});

// Delete anon file (admin) — also used for transfers tab
app.delete('/api/admin/anon-log/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const file = db.prepare('SELECT id, original_name FROM files WHERE id = ?').get(id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  const fp = path.join(FILES_DIR, id);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('UPDATE transfer_log SET status = ?, deleted_at = ? WHERE file_id = ?').run('deleted', Date.now(), id);
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  logEvent('file_deleted_admin', `Admin "${req.user.username}" deleted file: ${file.original_name}`, { fileId: id });
  res.json({ ok: true });
});

// ── Storage breakdown (admin) ─────────────────────────────────────────────────

app.get('/api/admin/storage', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT COALESCE(u.username, '(deleted)') AS username,
           COUNT(f.id)            AS file_count,
           COALESCE(SUM(f.size), 0) AS used_bytes
    FROM files f
    LEFT JOIN users u ON u.id = f.user_id
    WHERE f.expires_at > ?
    GROUP BY f.user_id
    ORDER BY used_bytes DESC
    LIMIT 12
  `).all(Date.now());
  res.json(rows);
});

// ── Settings Routes ───────────────────────────────────────────────────────────

app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  res.json({
    download_limit_kbps: getSettingInt('download_limit_kbps'),
    upload_limit_kbps:   getSettingInt('upload_limit_kbps')
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const dl = parseInt(req.body.download_limit_kbps) || 0;
  const ul = parseInt(req.body.upload_limit_kbps)   || 0;
  if (dl < 0 || ul < 0) return res.status(400).json({ error: 'Negative values not allowed' });
  setSetting('download_limit_kbps', dl);
  setSetting('upload_limit_kbps',   ul);
  // reset upload bucket so new setting takes effect immediately
  _upBucket.tokens = 0;
  _upBucket.last   = Date.now();
  res.json({ ok: true, download_limit_kbps: dl, upload_limit_kbps: ul });
});

// ── My Files Route ────────────────────────────────────────────────────────────

app.get('/api/my/files', requireAuth, (req, res) => {
  const files = db.prepare(`
    SELECT id, original_name, mime_type, size, created_at, expires_at,
           download_count, max_downloads, encrypted
    FROM files
    WHERE user_id = ? AND expires_at > ?
    ORDER BY created_at DESC
  `).all(req.user.id, Date.now());
  res.json(files);
});

// ── Admin Routes ──────────────────────────────────────────────────────────────

// Stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalFiles = db.prepare('SELECT COUNT(*) as c FROM files').get().c;
  const activeFiles = db.prepare('SELECT COUNT(*) as c FROM files WHERE expires_at > ?').get(Date.now()).c;
  const totalDownloads = db.prepare('SELECT COALESCE(SUM(download_count),0) as c FROM files').get().c;
  const totalStorage = db.prepare('SELECT COALESCE(SUM(size),0) as c FROM files WHERE expires_at > ?').get(Date.now()).c;
  res.json({ totalUsers, totalFiles, activeFiles, totalDownloads, totalStorage });
});

// List users
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const users = db.prepare(`
    SELECT id, username, role, created_at, last_login, active FROM users ORDER BY created_at DESC
  `).all();
  res.json(users);
});

// Create user
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username } = req.body;
  if (!username || username.trim().length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters' });
  }
  const trimmed = username.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(trimmed);
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const pw = generateStigPassword();
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
  const id = uuidv4();

  db.prepare(`
    INSERT INTO users (id, username, password_hash, password_salt, role, created_at, active)
    VALUES (?, ?, ?, ?, 'user', ?, 1)
  `).run(id, trimmed, hash, salt, Date.now());

  res.status(201).json({ id, username: trimmed, password: pw, role: 'user' });
});

// Update user (toggle active or reset password)
app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { action } = req.body;

  if (action === 'toggleActive') {
    const newActive = user.active ? 0 : 1;
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(newActive, id);
    if (!newActive) {
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
    }
    return res.json({ ok: true, active: newActive });
  }

  if (action === 'resetPassword') {
    const pw = generateStigPassword();
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, id);
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
    return res.json({ ok: true, password: pw });
  }

  if (action === 'setPassword') {
    const { password } = req.body;
    if (!password || password.trim().length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = crypto.pbkdf2Sync(password.trim(), salt, 100000, 32, 'sha256').toString('hex');
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, id);
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
    return res.json({ ok: true });
  }

  res.status(400).json({ error: 'Unknown action' });
});

// Delete user
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (req.user.id === id) return res.status(400).json({ error: 'Cannot delete own account' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// List all files (admin)
app.get('/api/admin/files', requireAdmin, (_req, res) => {
  const files = db.prepare(`
    SELECT f.id, f.original_name, f.size, f.created_at, f.expires_at,
           f.download_count, f.max_downloads, f.encrypted,
           u.username as uploader
    FROM files f
    LEFT JOIN users u ON u.id = f.user_id
    ORDER BY f.created_at DESC
  `).all();
  res.json(files);
});

// Bulk-delete files (admin)
app.post('/api/admin/files/bulk-delete', requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No IDs provided' });
  }
  let deleted = 0;
  const deletedNames = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) continue;
    const file = db.prepare('SELECT id, original_name FROM files WHERE id = ?').get(id);
    if (!file) continue;
    const fp = path.join(FILES_DIR, id);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    db.prepare('UPDATE transfer_log SET status = ?, deleted_at = ? WHERE file_id = ?').run('deleted', Date.now(), id);
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
    deletedNames.push(file.original_name);
    deleted++;
  }
  if (deleted > 0)
    logEvent('files_deleted_admin', `Admin "${req.user.username}" deleted ${deleted} file(s) (bulk)`, { count: deleted, names: deletedNames });
  res.json({ ok: true, deleted });
});

// Admin download – no counter increment, admin auth required
app.get('/api/admin/download/:id', requireAdmin, (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(FILES_DIR, file.id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });

  if (file.encrypted) {
    const password = req.query.password;
    if (!password) return res.status(401).json({ error: 'Password required', encrypted: true });
    const hash = crypto.createHash('sha256').update(password + file.password_salt).digest('hex');
    if (hash !== file.password_hash) return res.status(401).json({ error: 'Wrong password' });

    noCache(res);
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');

    const key = crypto.pbkdf2Sync(
      password, Buffer.from(file.password_salt, 'hex'), 100000, 32, 'sha256'
    );
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm', key, Buffer.from(file.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(file.auth_tag, 'hex'));
    const stream = fs.createReadStream(filePath);
    res.on('close', () => stream.destroy());
    stream.pipe(decipher).pipe(res);
    decipher.on('error', () => { try { res.destroy(); } catch (_) {} });
  } else {
    noCache(res);
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    const stream = fs.createReadStream(filePath);
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
});

// Delete file (admin)
app.delete('/api/admin/files/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const file = db.prepare('SELECT id, original_name FROM files WHERE id = ?').get(id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const fp = path.join(FILES_DIR, id);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('UPDATE transfer_log SET status = ?, deleted_at = ? WHERE file_id = ?').run('deleted', Date.now(), id);
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  logEvent('file_deleted_admin', `Admin "${req.user.username}" deleted file: ${file.original_name}`, { fileId: id });
  res.json({ ok: true });
});

// ── System Log (admin) ────────────────────────────────────────────────────────

app.get('/api/admin/syslog', requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM system_log ORDER BY created_at DESC LIMIT 1000').all();
  res.json(rows);
});

// ── Password Pusher ───────────────────────────────────────────────────────────

// Create a secret (auth required)
app.post('/api/secret', requireAuth, (req, res) => {
  const { content, viewsMax, expiresIn, passphrase } = req.body;
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'Content must not be empty' });
  if (String(content).length > 50000) return res.status(400).json({ error: 'Content too long (max. 50,000 characters)' });

  const token = crypto.randomBytes(32).toString('hex');
  const now   = Date.now();
  const ttl   = Math.max(300, parseInt(expiresIn) || 86400);  // min 5 min
  const vmax  = Math.min(Math.max(parseInt(viewsMax) || 1, 1), 50);

  let passphraseHash = null, passphraseSalt = null;
  if (passphrase && String(passphrase).trim().length > 0) {
    passphraseSalt = crypto.randomBytes(16).toString('hex');
    passphraseHash = crypto.pbkdf2Sync(String(passphrase), passphraseSalt, 100000, 32, 'sha256').toString('hex');
  }

  db.prepare(`
    INSERT INTO secrets (token, content, views_max, views_used, expires_at, created_at, created_by, passphrase_hash, passphrase_salt)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
  `).run(token, String(content).trim(), vmax, now + ttl * 1000, now, req.user.id, passphraseHash, passphraseSalt);

  logEvent('secret_created',
    `Secret created by "${req.user.username}" (${vmax} view${vmax > 1 ? 's' : ''}, TTL ${ttl}s)`,
    { tokenPrefix: token.substring(0, 8), user: req.user.username, viewsMax: vmax });

  res.json({ token, url: '/p/' + token });
});

// Get secret info (public — does NOT consume a view)
app.get('/api/secret/:token/info', (req, res) => {
  const { token } = req.params;
  if (!/^[0-9a-f]{64}$/.test(token)) return res.status(400).json({ error: 'Invalid token' });
  const s = db.prepare('SELECT token, expires_at, views_max, views_used, passphrase_hash FROM secrets WHERE token = ?').get(token);
  if (!s) return res.status(404).json({ error: 'Not found or already retrieved' });
  if (Date.now() > s.expires_at) {
    db.prepare('DELETE FROM secrets WHERE token = ?').run(token);
    return res.status(410).json({ error: 'Expired' });
  }
  res.json({
    exists: true,
    passphraseRequired: !!s.passphrase_hash,
    viewsMax: s.views_max,
    viewsUsed: s.views_used,
    viewsLeft: s.views_max - s.views_used,
    expiresAt: s.expires_at
  });
});

// Reveal secret (public — consumes one view)
app.post('/api/secret/:token', (req, res) => {
  const { token } = req.params;
  if (!/^[0-9a-f]{64}$/.test(token)) return res.status(400).json({ error: 'Invalid token' });

  const s = db.prepare('SELECT * FROM secrets WHERE token = ?').get(token);
  if (!s) return res.status(404).json({ error: 'Not found or already retrieved' });
  if (Date.now() > s.expires_at) {
    db.prepare('DELETE FROM secrets WHERE token = ?').run(token);
    return res.status(410).json({ error: 'Expired' });
  }

  if (s.passphrase_hash) {
    const { passphrase } = req.body;
    if (!passphrase) return res.status(401).json({ error: 'Password required', passphraseRequired: true });
    const hash = crypto.pbkdf2Sync(String(passphrase), s.passphrase_salt, 100000, 32, 'sha256').toString('hex');
    if (hash !== s.passphrase_hash) return res.status(401).json({ error: 'Wrong password' });
  }

  const newUsed = s.views_used + 1;
  const destroyed = newUsed >= s.views_max;

  if (destroyed) {
    db.prepare('DELETE FROM secrets WHERE token = ?').run(token);
    logEvent('secret_viewed',
      `Secret retrieved and deleted (${newUsed}/${s.views_max} views used)`,
      { tokenPrefix: token.substring(0, 8) });
  } else {
    db.prepare('UPDATE secrets SET views_used = ? WHERE token = ?').run(newUsed, token);
  }

  res.json({
    content: s.content,
    viewsUsed: newUsed,
    viewsMax: s.views_max,
    destroyed,
    viewsLeft: destroyed ? 0 : s.views_max - newUsed
  });
});

// ── SPA Routes ────────────────────────────────────────────────────────────────

app.get('/d/:id', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'download.html')));

app.get('/admin', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/login', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.get('/push', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'push.html')));

app.get('/p/:token', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'secret.html')));

// ── Helpers ───────────────────────────────────────────────────────────────────

function assembleChunks(sessionDir, outputPath, totalChunks) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outputPath);
    let i = 0;

    const next = () => {
      if (i >= totalChunks) { out.end(); return; }
      const inp = fs.createReadStream(path.join(sessionDir, `chunk_${i++}`));
      inp.pipe(out, { end: false });
      inp.on('end', next);
      inp.on('error', reject);
    };

    out.on('finish', resolve);
    out.on('error', reject);
    next();
  });
}

async function encryptFile(filePath, password) {
  const salt = crypto.randomBytes(32);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const tmpPath = filePath + '.enc';

  await new Promise((resolve, reject) => {
    const inp = fs.createReadStream(filePath);
    const out = fs.createWriteStream(tmpPath);
    inp.pipe(cipher).pipe(out);
    out.on('finish', resolve);
    inp.on('error', reject);
    cipher.on('error', reject);
  });

  const authTag = cipher.getAuthTag().toString('hex');
  fs.renameSync(tmpPath, filePath);
  return { salt: salt.toString('hex'), iv: iv.toString('hex'), authTag };
}

// ── Cleanup job ───────────────────────────────────────────────────────────────

function cleanup() {
  const now = Date.now();

  const expiredFiles = db.prepare('SELECT id, original_name FROM files WHERE expires_at < ?').all(now);
  for (const { id } of expiredFiles) {
    const fp = path.join(FILES_DIR, id);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    db.prepare('UPDATE transfer_log SET status = ?, deleted_at = ? WHERE file_id = ?').run('expired', now, id);
  }
  if (expiredFiles.length) {
    db.prepare('DELETE FROM files WHERE expires_at < ?').run(now);
    logEvent('file_expired',
      `${expiredFiles.length} expired file(s) automatically deleted`,
      { count: expiredFiles.length, names: expiredFiles.map(f => f.original_name) });
    console.log(`[cleanup] ${expiredFiles.length} expired file(s) deleted`);
  }

  const cutoff = now - 24 * 3600 * 1000;
  const oldSessions = db.prepare('SELECT id FROM sessions WHERE created_at < ?').all(cutoff);
  for (const { id } of oldSessions) {
    const dir = path.join(CHUNKS_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (oldSessions.length) {
    db.prepare('DELETE FROM sessions WHERE created_at < ?').run(cutoff);
    console.log(`[cleanup] ${oldSessions.length} stale session(s) deleted`);
  }

  // Cleanup expired auth sessions
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now);

  // Cleanup expired secrets
  const expiredSecrets = db.prepare('SELECT token FROM secrets WHERE expires_at < ?').all(now);
  if (expiredSecrets.length) {
    db.prepare('DELETE FROM secrets WHERE expires_at < ?').run(now);
    logEvent('secret_expired',
      `${expiredSecrets.length} expired secret(s) deleted`,
      { count: expiredSecrets.length });
    console.log(`[cleanup] ${expiredSecrets.length} expired secret(s) deleted`);
  }
}

cleanup();
setInterval(cleanup, 60 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`SafeDrop running on port ${PORT}`);
  logEvent('server_start', `SafeDrop server started on port ${PORT}`, { port: PORT });
});
