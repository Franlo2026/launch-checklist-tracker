// BOS Dashboard — server
// Express + PostgreSQL, with JWT auth and three roles:
//   admin  — full access + user management
//   editor — full access to log/edit data
//   viewer — read-only ("mirror" access, no write capability)
//
// Reference data (GAAP/KeyTech/Beeline/FSM structure) ships inside
// public/index.html and never touches this server — only live, user-logged
// data (visits/actions/ltl audits/trainer visits) and user accounts live here.

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '8mb' }));

const CAFE_SUBMISSION_KEY = process.env.CAFE_SUBMISSION_KEY || 'bootlegger-newcafe-2026';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set.');
  process.exit(1);
}
const TOKEN_TTL = '12h';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) { console.error('Could not create upload dir:', e.message); }

function saveBase64Photo(dataUrl, subfolder) {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const dir = path.join(UPLOAD_DIR, subfolder);
  fs.mkdirSync(dir, { recursive: true });
  const filename = newId('img') + '.' + ext;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return `/uploads/${subfolder}/${filename}`;
}

function deletePhotoFile(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, url.replace('/uploads/', ''))); }
  catch (e) { /* already gone — fine */ }
}

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
      display_name  TEXT,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  for (const table of ['visits', 'actions', 'ltl_audits', 'trainer_visits']) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id         TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_tasks (
      id               TEXT PRIMARY KEY,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      submitter_name   TEXT NOT NULL,
      department       TEXT NOT NULL,
      cafe             TEXT NOT NULL,
      region           TEXT,
      escalation_label TEXT NOT NULL,
      escalation_hours INTEGER NOT NULL,
      comments         TEXT,
      completed        BOOLEAN NOT NULL DEFAULT FALSE,
      completed_by     TEXT,
      completed_at     TIMESTAMPTZ
    );
  `);
  await pool.query(`ALTER TABLE ops_tasks ADD COLUMN IF NOT EXISTS photo_url TEXT;`);
  await pool.query(`ALTER TABLE ops_tasks ADD COLUMN IF NOT EXISTS photo_urls JSONB DEFAULT '[]'::jsonb;`);
  await pool.query(`ALTER TABLE ops_tasks ADD COLUMN IF NOT EXISTS responsible_person TEXT;`);
  await pool.query(`ALTER TABLE ops_tasks ADD COLUMN IF NOT EXISTS edit_log JSONB DEFAULT '[]'::jsonb;`);
  await pool.query(`ALTER TABLE ops_tasks ADD COLUMN IF NOT EXISTS resolution_comment TEXT;`);
  await pool.query(`ALTER TABLE ops_tasks ADD COLUMN IF NOT EXISTS is_non_conformance BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE ops_tasks ADD COLUMN IF NOT EXISTS due_date_override DATE;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS storage (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cafe_status (
      store_key  TEXT PRIMARY KEY,
      store_name TEXT,
      fsm        TEXT,
      region     TEXT,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'changeme123';
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES ($1,$2,$3,$4)',
      [username, hash, 'admin', 'Administrator']
    );
    console.log(`Created initial admin user "${username}". Log in and change the password / add real users via the Admin tab.`);
  }
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, displayName: user.display_name },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }
}

function requireEditor(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'editor') {
    return res.status(403).json({ error: 'View-only account — editing is disabled' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !user.active) return res.status(401).json({ error: 'Invalid username or password' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
    const token = signToken(user);
    res.json({ token, username: user.username, role: user.role, displayName: user.display_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/me', authRequired, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role, displayName: req.user.displayName });
});

app.post('/api/change-password', authRequired, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.sub]);
    const user = rows[0];
    const ok = await bcrypt.compare(currentPassword || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.sub]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users', authRequired, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, role, display_name, active, created_at FROM users ORDER BY created_at ASC');
  res.json(rows);
});

app.post('/api/admin/users', authRequired, requireAdmin, async (req, res) => {
  try {
    const { username, password, role, displayName } = req.body;
    if (!username || !password || !role) return res.status(400).json({ error: 'username, password and role are required' });
    if (!['admin', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'role must be admin, editor or viewer' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES ($1,$2,$3,$4) RETURNING id, username, role, display_name, active, created_at',
      [username, hash, role, displayName || username]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is already taken' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/users/:id', authRequired, requireAdmin, async (req, res) => {
  try {
    const { role, active, password } = req.body;
    if (role && !['admin', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (role) await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);
    if (active !== undefined) await pool.query('UPDATE users SET active = $1 WHERE id = $2', [active, req.params.id]);
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    }
    const { rows } = await pool.query('SELECT id, username, role, display_name, active, created_at FROM users WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/state', authRequired, async (req, res) => {
  try {
    const [visits, actions, ltl, trainer] = await Promise.all([
      pool.query('SELECT data FROM visits ORDER BY created_at ASC'),
      pool.query('SELECT data FROM actions ORDER BY created_at ASC'),
      pool.query('SELECT data FROM ltl_audits ORDER BY created_at ASC'),
      pool.query('SELECT data FROM trainer_visits ORDER BY created_at ASC'),
    ]);
    res.json({
      visits: visits.rows.map(r => r.data),
      actions: actions.rows.map(r => r.data),
      ltlAudits: ltl.rows.map(r => r.data),
      trainerVisits: trainer.rows.map(r => r.data),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/visits', authRequired, requireEditor, async (req, res) => {
  try {
    const { fsm, store, date, type, notes, actions, grindResponses, fullReport } = req.body;
    if (!fsm || !store || !date || !type) return res.status(400).json({ error: 'fsm, store, date and type are required' });
    const visitId = newId('v');
    const photos = fullReport && fullReport.photos;
    const photoUrls = {};
    if (photos && typeof photos === 'object') {
      for (const [itemId, dataUrls] of Object.entries(photos)) {
        const list = Array.isArray(dataUrls) ? dataUrls : (dataUrls ? [dataUrls] : []);
        const saved = [];
        for (const dataUrl of list) {
          if (typeof dataUrl === 'string' && dataUrl.length > 6 * 1024 * 1024) continue;
          const url = dataUrl && dataUrl.startsWith('data:') ? saveBase64Photo(dataUrl, 'cafe-visits') : dataUrl;
          if (url) saved.push(url);
        }
        if (saved.length) photoUrls[itemId] = saved;
      }
    }
    const storedFullReport = fullReport ? { ...fullReport, photos: photoUrls } : null;
    const visitRow = {
      id: visitId, fsm, store, date, type, notes: notes || '',
      actionCount: (actions || []).length,
      grindResponses: grindResponses || [],
      photos: photoUrls,
      fullReport: storedFullReport,
    };
    await pool.query('INSERT INTO visits (id, data) VALUES ($1,$2)', [visitId, visitRow]);

    for (const a of (actions || [])) {
      const actionRow = {
        ...a,
        id: newId('a'), fsm, store, pillar: a.pillar, description: a.description,
        owner: a.owner, dueDate: a.dueDate, status: 'open', createdDate: date, visitId,
      };
      await pool.query('INSERT INTO actions (id, data) VALUES ($1,$2)', [actionRow.id, actionRow]);
    }
    res.json({ ok: true, visitId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/visits/:id', authRequired, requireEditor, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM visits WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'visit not found' });
    const visit = rows[0].data;
    const { fsm, store, date, type, notes, fullReport } = req.body;
    if (!fsm || !store || !date || !type) return res.status(400).json({ error: 'fsm, store, date and type are required' });

    const photos = fullReport && fullReport.photos;
    const photoUrls = {};
    if (photos && typeof photos === 'object') {
      for (const [itemId, dataUrls] of Object.entries(photos)) {
        const list = Array.isArray(dataUrls) ? dataUrls : (dataUrls ? [dataUrls] : []);
        const saved = [];
        for (const entry of list) {
          if (typeof entry === 'string' && entry.startsWith('data:')) {
            if (entry.length > 6 * 1024 * 1024) continue;
            const url = saveBase64Photo(entry, 'cafe-visits');
            if (url) saved.push(url);
          } else if (entry) {
            saved.push(entry);
          }
        }
        if (saved.length) photoUrls[itemId] = saved;
      }
    }

    const oldPhotos = (visit.fullReport && visit.fullReport.photos) || visit.photos || {};
    const stillReferenced = new Set(Object.values(photoUrls).flat());
    Object.values(oldPhotos).flat().forEach(url => {
      if (url && !stillReferenced.has(url)) deletePhotoFile(url);
    });

    const storedFullReport = fullReport ? { ...fullReport, photos: photoUrls } : visit.fullReport;
    const editor = req.user.displayName || req.user.username;
    if (!Array.isArray(visit.editLog)) visit.editLog = [];
    visit.editLog.push({ editedBy: editor, editedAt: new Date().toISOString() });

    const updatedVisit = {
      ...visit,
      fsm, store, date, type, notes: notes || visit.notes || '',
      photos: photoUrls,
      fullReport: storedFullReport,
      editLog: visit.editLog,
    };
    await pool.query('UPDATE visits SET data = $1 WHERE id = $2', [updatedVisit, req.params.id]);
    res.json({ ok: true, visit: updatedVisit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/visits/:id', authRequired, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM visits WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'visit not found' });
    const visit = rows[0].data;
    const photos = (visit.fullReport && visit.fullReport.photos) || visit.photos || {};
    Object.values(photos).forEach(urls => {
      (Array.isArray(urls) ? urls : [urls]).forEach(deletePhotoFile);
    });
    await pool.query('DELETE FROM visits WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/actions/:id', authRequired, requireEditor, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM actions WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'action not found' });
    const action = rows[0].data;
    const editor = req.user.displayName || req.user.username;
    if (!Array.isArray(action.editLog)) action.editLog = [];

    const editableFields = ['description', 'pillar', 'owner', 'store', 'fsm', 'dueDate'];
    editableFields.forEach(field => {
      if (req.body[field] !== undefined && req.body[field] !== action[field]) {
        action.editLog.push({ field, oldValue: action[field] ?? null, newValue: req.body[field], editedBy: editor, editedAt: new Date().toISOString() });
        action[field] = req.body[field];
      }
    });

    if (req.body.status && req.body.status !== action.status) {
      action.editLog.push({ field: 'status', oldValue: action.status ?? null, newValue: req.body.status, editedBy: editor, editedAt: new Date().toISOString() });
      action.status = req.body.status;
    }
    if (req.body.status === 'closed' && !action.closedDate) {
      action.closedDate = new Date().toISOString().slice(0, 10);
    }
    if (req.body.status && req.body.status !== 'closed') {
      delete action.closedDate;
    }
    if (req.body.comment && req.body.comment.trim()) {
      if (!Array.isArray(action.comments)) action.comments = [];
      action.comments.push({
        text: req.body.comment.trim(),
        author: editor,
        at: new Date().toISOString(),
      });
    }
    await pool.query('UPDATE actions SET data = $1 WHERE id = $2', [action, req.params.id]);
    res.json({ ok: true, action });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ltl', authRequired, requireEditor, async (req, res) => {
  try {
    const { fsm, store, date, score } = req.body;
    if (!fsm || !store || !date || score === undefined) return res.status(400).json({ error: 'fsm, store, date and score are required' });
    const audit = {
      id: newId('l'), fsm, store, date,
      score: Number(score), cspi: Number(req.body.cspi || 0),
      ncRaised: Number(req.body.ncRaised || 0), ncClosed: Number(req.body.ncClosed || 0),
      notes: req.body.notes || '',
    };
    await pool.query('INSERT INTO ltl_audits (id, data) VALUES ($1,$2)', [audit.id, audit]);
    res.json({ ok: true, audit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trainer-visits', authRequired, requireEditor, async (req, res) => {
  try {
    const { trainer, store, date } = req.body;
    if (!trainer || !store || !date) return res.status(400).json({ error: 'trainer, store and date are required' });
    const visit = { id: newId('t'), ...req.body };
    await pool.query('INSERT INTO trainer_visits (id, data) VALUES ($1,$2)', [visit.id, visit]);
    res.json({ ok: true, visit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ops-tasks', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ops_tasks ORDER BY created_at DESC');
    res.json(rows.map(r => {
      // photo_urls is the current multi-photo column; photo_url is the
      // older single-photo one from before this existed. Merge both so old
      // tasks (single photo_url only) and new ones (photo_urls array) both
      // render correctly without duplicating an already-included URL.
      const urls = Array.isArray(r.photo_urls) ? r.photo_urls.slice() : [];
      if (r.photo_url && !urls.includes(r.photo_url)) urls.unshift(r.photo_url);
      return {
        id: r.id, createdAt: r.created_at, submitterName: r.submitter_name,
        department: r.department, cafe: r.cafe, region: r.region,
        escalationLabel: r.escalation_label, escalationHours: r.escalation_hours,
        comments: r.comments, completed: r.completed, completedBy: r.completed_by,
        completedAt: r.completed_at, photoUrl: r.photo_url, photoUrls: urls, responsiblePerson: r.responsible_person,
        editLog: r.edit_log || [], resolutionComment: r.resolution_comment, isNonConformance: r.is_non_conformance,
        dueDateOverride: r.due_date_override ? new Date(r.due_date_override).toISOString().slice(0,10) : null,
      };
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ops-tasks', authRequired, async (req, res) => {
  try {
    const { department, cafe, region, escalationLabel, escalationHours, comments, submitterName, photoUrl, photoUrls, responsiblePerson, isNonConformance } = req.body;
    if (!department || !cafe || !escalationLabel || !escalationHours) {
      return res.status(400).json({ error: 'department, cafe, escalationLabel and escalationHours are required' });
    }
    // photoUrls (array) is the current multi-photo path from the Add Task
    // form; a lone photoUrl is still accepted for anything older that only
    // ever sends one. Either way everything ends up saved to disk and
    // recorded in the new photo_urls column.
    const incomingPhotos = Array.isArray(photoUrls) ? photoUrls : (photoUrl ? [photoUrl] : []);
    const MAX_PHOTOS = 6;
    if (incomingPhotos.length > MAX_PHOTOS) {
      return res.status(400).json({ error: `Up to ${MAX_PHOTOS} photos per task` });
    }
    for (const p of incomingPhotos) {
      if (p && p.length > 6 * 1024 * 1024) {
        return res.status(400).json({ error: 'One of those photos is too large — please use smaller images.' });
      }
    }
    const id = newId('t');
    const savedUrls = incomingPhotos.map(p => (p && p.startsWith('data:')) ? saveBase64Photo(p, 'ops-tasks') : p).filter(Boolean);
    const legacyPhotoUrl = savedUrls[0] || null; // keep first photo mirrored into the old column too, for anything still reading it
    await pool.query(
      `INSERT INTO ops_tasks (id, submitter_name, department, cafe, region, escalation_label, escalation_hours, comments, photo_url, photo_urls, responsible_person, is_non_conformance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, (submitterName && submitterName.trim()) || req.user.displayName || req.user.username, department, cafe, region || '', escalationLabel, escalationHours, comments || '', legacyPhotoUrl, JSON.stringify(savedUrls), responsiblePerson || null, !!isNonConformance]
    );
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/ops-tasks/:id', authRequired, requireEditor, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ops_tasks WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'task not found' });
    const current = rows[0];
    const editor = req.user.displayName || req.user.username;
    const editLog = Array.isArray(current.edit_log) ? current.edit_log : [];

    const fieldMap = {
      department: 'department', cafe: 'cafe', region: 'region',
      escalationLabel: 'escalation_label', escalationHours: 'escalation_hours',
      comments: 'comments', responsiblePerson: 'responsible_person', submitterName: 'submitter_name',
      dueDateOverride: 'due_date_override', isNonConformance: 'is_non_conformance',
    };
    const updates = {};
    Object.entries(fieldMap).forEach(([bodyKey, col]) => {
      if (req.body[bodyKey] !== undefined && req.body[bodyKey] !== current[col]) {
        editLog.push({ field: bodyKey, oldValue: current[col] ?? null, newValue: req.body[bodyKey], editedBy: editor, editedAt: new Date().toISOString() });
        updates[col] = req.body[bodyKey];
      }
    });

    // Photo can be updated/replaced/removed from the edit form too. A new
    // data: URL gets saved to disk (and the old file cleaned up); an empty
    // string means "remove the photo"; undefined means "leave it alone".
    if (req.body.photoUrl !== undefined) {
      const incoming = req.body.photoUrl;
      if (incoming && incoming.length > 6 * 1024 * 1024) {
        return res.status(400).json({ error: 'Photo is too large — please use a smaller image.' });
      }
      let newPhotoUrl = current.photo_url;
      if (!incoming) {
        if (current.photo_url) deletePhotoFile(current.photo_url);
        newPhotoUrl = null;
      } else if (incoming.startsWith('data:')) {
        const saved = saveBase64Photo(incoming, 'ops-tasks');
        if (saved) {
          if (current.photo_url) deletePhotoFile(current.photo_url);
          newPhotoUrl = saved;
        }
      } else {
        newPhotoUrl = incoming; // already a saved URL, unchanged
      }
      if (newPhotoUrl !== current.photo_url) {
        editLog.push({ field: 'photoUrl', oldValue: current.photo_url ?? null, newValue: newPhotoUrl, editedBy: editor, editedAt: new Date().toISOString() });
        updates.photo_url = newPhotoUrl;
      }
    }

    // Full-array replace: the client sends the complete list it wants to
    // end up with (a mix of already-saved URLs it's keeping, plus any new
    // data: URLs for photos just added). Anything that was there before
    // but isn't in the new list gets its file deleted.
    if (req.body.photoUrls !== undefined) {
      const incoming = Array.isArray(req.body.photoUrls) ? req.body.photoUrls : [];
      const MAX_PHOTOS = 6;
      if (incoming.length > MAX_PHOTOS) {
        return res.status(400).json({ error: `Up to ${MAX_PHOTOS} photos per task` });
      }
      for (const p of incoming) {
        if (p && p.length > 6 * 1024 * 1024) {
          return res.status(400).json({ error: 'One of those photos is too large — please use smaller images.' });
        }
      }
      const currentUrls = Array.isArray(current.photo_urls) ? current.photo_urls : (current.photo_url ? [current.photo_url] : []);
      const newUrls = incoming.map(p => (p && p.startsWith('data:')) ? saveBase64Photo(p, 'ops-tasks') : p).filter(Boolean);
      currentUrls.filter(u => !newUrls.includes(u)).forEach(u => deletePhotoFile(u));
      if (JSON.stringify(newUrls) !== JSON.stringify(currentUrls)) {
        editLog.push({ field: 'photoUrls', oldValue: currentUrls, newValue: newUrls, editedBy: editor, editedAt: new Date().toISOString() });
        updates.photo_urls = JSON.stringify(newUrls);
        updates.photo_url = newUrls[0] || null; // keep the legacy single-photo column mirrored to the first photo
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ ok: true, unchanged: true });
    }
    // BUG FIX: edit_log is its own top-level JSONB column here (unlike
    // actions.data, which nests editLog inside one big object column) —
    // passing the bare JS array straight to node-pg makes it serialize as
    // a Postgres ARRAY literal instead of JSON, which Postgres then rejects
    // for a JSONB column with "invalid input syntax for type json". It has
    // to be explicitly stringified first.
    updates.edit_log = JSON.stringify(editLog);
    const setClauses = Object.keys(updates).map((col, i) => `${col} = $${i + 2}`).join(', ');
    await pool.query(`UPDATE ops_tasks SET ${setClauses} WHERE id = $1`, [req.params.id, ...Object.values(updates)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/ops-tasks/:id/complete', authRequired, requireEditor, async (req, res) => {
  try {
    const comment = (req.body && req.body.comment && req.body.comment.trim()) || null;
    await pool.query(
      `UPDATE ops_tasks SET completed = TRUE, completed_by = $1, completed_at = NOW(), resolution_comment = COALESCE($3, resolution_comment) WHERE id = $2`,
      [req.user.displayName || req.user.username, req.params.id, comment]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/storage/:key', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM storage WHERE key = $1', [req.params.key]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/storage/:key', authRequired, requireEditor, async (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'value is required' });
    await pool.query(
      `INSERT INTO storage (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [req.params.key, value]
    );
    res.json({ key: req.params.key, value });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/public/cafe-submissions', async (req, res) => {
  try {
    const { key, submittedBy, stores } = req.body || {};
    if (key !== CAFE_SUBMISSION_KEY) return res.status(403).json({ error: 'Invalid or missing submission link' });
    if (!Array.isArray(stores) || !stores.length) return res.status(400).json({ error: 'No store rows in submission' });
    const { rows } = await pool.query("SELECT value FROM storage WHERE key = 'cafe-submissions-v1'");
    const existing = rows[0] ? JSON.parse(rows[0].value) : [];
    const now = new Date().toISOString();
    const added = stores.map((s, i) => ({
      id: 'sub_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 7),
      status: 'pending',
      submittedBy: (submittedBy || 'New Business Team').toString().slice(0, 200),
      submittedAt: now,
      ...s,
    }));
    const updated = [...existing, ...added];
    await pool.query(
      `INSERT INTO storage (key, value) VALUES ('cafe-submissions-v1', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(updated)]
    );
    res.json({ ok: true, count: added.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cafe-status', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT store_key, store_name, fsm, region, data FROM cafe_status');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cafe-status', authRequired, requireEditor, async (req, res) => {
  try {
    const { store_key, store_name, fsm, region, data } = req.body;
    if (!store_key || data === undefined) return res.status(400).json({ error: 'store_key and data are required' });
    await pool.query(
      `INSERT INTO cafe_status (store_key, store_name, fsm, region, data, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (store_key) DO UPDATE SET store_name=$2, fsm=$3, region=$4, data=$5, updated_at=NOW()`,
      [store_key, store_name || store_key, fsm || '', region || '', data]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/reference-data', authRequired, (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const match = html.match(/<script id="bos-data" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return res.status(500).json({ error: 'reference data block not found in index.html' });
    res.json(JSON.parse(match[1]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PHOTO_RETENTION_DAYS = 30;
async function cleanupOldTaskPhotos() {
  try {
    const { rows } = await pool.query(
      `SELECT id, photo_url, photo_urls FROM ops_tasks
       WHERE completed = TRUE AND (photo_url IS NOT NULL OR jsonb_array_length(COALESCE(photo_urls, '[]'::jsonb)) > 0)
         AND completed_at < NOW() - INTERVAL '${PHOTO_RETENTION_DAYS} days'`
    );
    if (!rows.length) return;
    for (const r of rows) {
      if (r.photo_url) deletePhotoFile(r.photo_url);
      (Array.isArray(r.photo_urls) ? r.photo_urls : []).forEach(deletePhotoFile);
    }
    await pool.query(
      `UPDATE ops_tasks SET photo_url = NULL, photo_urls = '[]'::jsonb
       WHERE completed = TRUE AND (photo_url IS NOT NULL OR jsonb_array_length(COALESCE(photo_urls, '[]'::jsonb)) > 0)
         AND completed_at < NOW() - INTERVAL '${PHOTO_RETENTION_DAYS} days'`
    );
    console.log(`Photo cleanup: cleared photos from ${rows.length} task(s) completed over ${PHOTO_RETENTION_DAYS} days ago.`);
  } catch (e) {
    console.error('Photo cleanup failed:', e.message);
  }
}

app.get('/api/admin/photo-stats', authRequired, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        count(*) FILTER (WHERE photo_url IS NOT NULL) AS total_with_photo,
        count(*) FILTER (WHERE photo_url LIKE 'data:%') AS legacy_base64_in_db,
        count(*) FILTER (WHERE photo_url LIKE '/uploads/%') AS on_disk,
        count(*) FILTER (WHERE completed = TRUE AND photo_url IS NOT NULL AND completed_at < NOW() - INTERVAL '${PHOTO_RETENTION_DAYS} days') AS eligible_for_cleanup,
        pg_size_pretty(coalesce(sum(length(photo_url)) FILTER (WHERE photo_url LIKE 'data:%'), 0)) AS legacy_base64_size
      FROM ops_tasks
    `);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/cleanup-photos', authRequired, requireAdmin, async (req, res) => {
  try {
    await cleanupOldTaskPhotos();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`BOS Dashboard running on port ${PORT}`));
    cleanupOldTaskPhotos();
    setInterval(cleanupOldTaskPhotos, 24 * 60 * 60 * 1000);
  })
  .catch(err => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
