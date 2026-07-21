const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_INSECURE_DEFAULT';
const COOKIE_NAME = 'launch_session';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '15mb' })); // photos come in as base64
app.use(express.static(path.join(__dirname, '..', 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id            TEXT PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS launch_trackers (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      form_title     TEXT NOT NULL,
      description    TEXT,
      created_by     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      active         BOOLEAN NOT NULL DEFAULT TRUE,
      checklist_items JSONB NOT NULL DEFAULT '[]',
      conditional     JSONB NOT NULL DEFAULT '{"enabled":false,"trigger_label":"","items":[]}'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id                    TEXT PRIMARY KEY,
      tracker_id            TEXT NOT NULL REFERENCES launch_trackers(id) ON DELETE CASCADE,
      cafe                  TEXT NOT NULL,
      region                TEXT,
      submitted_by          TEXT NOT NULL,
      answers               JSONB NOT NULL DEFAULT '[]',
      conditional_triggered BOOLEAN NOT NULL DEFAULT FALSE,
      conditional_answers   JSONB,
      disclaimer_confirmed  BOOLEAN NOT NULL,
      submitted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_submissions_tracker ON submissions(tracker_id);`);

  // Migration-safe additions — safe to run against an already-live database with existing data
  await pool.query(`ALTER TABLE launch_trackers ADD COLUMN IF NOT EXISTS assigned_cafes JSONB NOT NULL DEFAULT '[]';`);
  await pool.query(`ALTER TABLE launch_trackers ADD COLUMN IF NOT EXISTS exemptions JSONB NOT NULL DEFAULT '[]';`);
}

const genId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

function setSessionCookie(res, admin) {
  const token = jwt.sign({ id: admin.id, username: admin.username, displayName: admin.display_name }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function getSessionUser(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.admin = user;
  next();
}

// ---------- Health ----------
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ---------- Auth ----------
app.get('/api/auth/status', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM admins`);
    const hasAdmins = rows[0].c > 0;
    const user = getSessionUser(req);
    res.json({ hasAdmins, authenticated: !!user, username: user ? user.displayName : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check auth status' });
  }
});

app.post('/api/auth/bootstrap', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM admins`);
    if (rows[0].c > 0) return res.status(409).json({ error: 'An admin account already exists — please log in instead.' });

    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const id = genId('adm');
    const hash = await bcrypt.hash(password, 10);
    const uname = username.trim().toLowerCase();
    await pool.query(
      `INSERT INTO admins (id, username, password_hash, display_name) VALUES ($1,$2,$3,$4)`,
      [id, uname, hash, displayName || username]
    );
    setSessionCookie(res, { id, username: uname, display_name: displayName || username });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create admin account' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    const uname = username.trim().toLowerCase();
    const { rows } = await pool.query(`SELECT * FROM admins WHERE username = $1`, [uname]);
    if (!rows.length) return res.status(401).json({ error: 'Incorrect username or password' });
    const admin = rows[0];
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect username or password' });
    setSessionCookie(res, admin);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/admins', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, username, display_name FROM admins ORDER BY created_at ASC`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch admins' });
  }
});

app.post('/api/admins', requireAuth, async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    const uname = username.trim().toLowerCase();
    const existing = await pool.query(`SELECT id FROM admins WHERE username = $1`, [uname]);
    if (existing.rows.length) return res.status(409).json({ error: 'That username is already taken' });

    const id = genId('adm');
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO admins (id, username, password_hash, display_name) VALUES ($1,$2,$3,$4)`,
      [id, uname, hash, displayName || username]
    );
    res.status(201).json({ id, username: uname, display_name: displayName || username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create admin' });
  }
});

// Edit an admin's username / display name / (optionally) password
app.patch('/api/admins/:id', requireAuth, async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    const existing = await pool.query(`SELECT * FROM admins WHERE id = $1`, [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Admin not found' });
    const cur = existing.rows[0];

    let uname = cur.username;
    if (username && username.trim().toLowerCase() !== cur.username) {
      uname = username.trim().toLowerCase();
      const clash = await pool.query(`SELECT id FROM admins WHERE username = $1 AND id <> $2`, [uname, req.params.id]);
      if (clash.rows.length) return res.status(409).json({ error: 'That username is already taken' });
    }

    const newDisplayName = displayName ? displayName.trim() : cur.display_name;
    const newHash = password ? await bcrypt.hash(password, 10) : cur.password_hash;

    const { rows } = await pool.query(
      `UPDATE admins SET username=$1, display_name=$2, password_hash=$3 WHERE id=$4 RETURNING id, username, display_name`,
      [uname, newDisplayName, newHash, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update admin' });
  }
});

// Delete an admin — refuses to remove the last remaining account so nobody gets locked out
app.delete('/api/admins/:id', requireAuth, async (req, res) => {
  try {
    const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS c FROM admins`);
    if (countRows[0].c <= 1) return res.status(400).json({ error: 'Cannot delete the last remaining admin account' });

    const { rows } = await pool.query(`DELETE FROM admins WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Admin not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete admin' });
  }
});

// ---------- Trackers ----------

app.get('/api/trackers', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        t.*,
        COALESCE(s.submission_count, 0)::int AS submission_count,
        COALESCE(s.flagged_count, 0)::int AS flagged_count
      FROM launch_trackers t
      LEFT JOIN (
        SELECT
          tracker_id,
          COUNT(*) AS submission_count,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements(answers) elem WHERE (elem->>'value')::boolean = false
            )
            OR (
              conditional_triggered AND conditional_answers IS NOT NULL AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(conditional_answers) elem2 WHERE (elem2->>'value')::boolean = false
              )
            )
          ) AS flagged_count
        FROM submissions
        GROUP BY tracker_id
      ) s ON s.tracker_id = t.id
      ORDER BY t.created_at DESC;
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch trackers' });
  }
});

app.post('/api/trackers', requireAuth, async (req, res) => {
  try {
    const { name, formTitle, description, checklistItems, conditional, assignedCafes, exemptions } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Launch name is required' });
    const id = genId('launch');
    const { rows } = await pool.query(
      `INSERT INTO launch_trackers (id, name, form_title, description, created_by, checklist_items, conditional, assigned_cafes, exemptions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        id, name.trim(), (formTitle || name).trim(), description || null, req.admin.displayName,
        JSON.stringify(checklistItems || []),
        JSON.stringify(conditional || { enabled: false, trigger_label: '', items: [] }),
        JSON.stringify(assignedCafes || []),
        JSON.stringify(exemptions || []),
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create tracker' });
  }
});

// PUBLIC — needed by the unauthenticated submission page (name/title/checklist only)
app.get('/api/trackers/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM launch_trackers WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Tracker not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tracker' });
  }
});

app.patch('/api/trackers/:id', requireAuth, async (req, res) => {
  try {
    const { active, name, formTitle, description, checklistItems, conditional, assignedCafes, exemptions } = req.body;
    const existing = await pool.query(`SELECT * FROM launch_trackers WHERE id = $1`, [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Tracker not found' });
    const cur = existing.rows[0];

    const updated = {
      active: typeof active === 'boolean' ? active : cur.active,
      name: name ? name.trim() : cur.name,
      form_title: formTitle ? formTitle.trim() : cur.form_title,
      description: typeof description === 'string' ? description : cur.description,
      checklist_items: checklistItems ? JSON.stringify(checklistItems) : JSON.stringify(cur.checklist_items),
      conditional: conditional ? JSON.stringify(conditional) : JSON.stringify(cur.conditional),
      assigned_cafes: assignedCafes ? JSON.stringify(assignedCafes) : JSON.stringify(cur.assigned_cafes),
      exemptions: exemptions ? JSON.stringify(exemptions) : JSON.stringify(cur.exemptions),
    };

    const { rows } = await pool.query(
      `UPDATE launch_trackers SET active=$1, name=$2, form_title=$3, description=$4, checklist_items=$5, conditional=$6, assigned_cafes=$7, exemptions=$8 WHERE id=$9 RETURNING *`,
      [updated.active, updated.name, updated.form_title, updated.description, updated.checklist_items, updated.conditional, updated.assigned_cafes, updated.exemptions, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update tracker' });
  }
});

// ---------- Insights ----------
// Aggregated per-question breakdown + missing/exempt café reporting for a tracker
app.get('/api/trackers/:id/insights', requireAuth, async (req, res) => {
  try {
    const trackerRes = await pool.query(`SELECT * FROM launch_trackers WHERE id = $1`, [req.params.id]);
    if (!trackerRes.rows.length) return res.status(404).json({ error: 'Tracker not found' });
    const tracker = trackerRes.rows[0];

    const subsRes = await pool.query(`SELECT * FROM submissions WHERE tracker_id = $1`, [req.params.id]);
    const submissions = subsRes.rows;

    const submittedCafes = Array.from(new Set(submissions.map((s) => s.cafe)));
    const exemptions = tracker.exemptions || [];
    const exemptCafeNames = exemptions.map((e) => e.cafe);

    // assigned_cafes empty = scope was "all stores" (also true for trackers created before this feature existed)
    const assigned = (tracker.assigned_cafes && tracker.assigned_cafes.length) ? tracker.assigned_cafes : null;

    let missingCafes = [];
    if (assigned) {
      missingCafes = assigned
        .map((c) => c.name || c)
        .filter((name) => !submittedCafes.includes(name) && !exemptCafeNames.includes(name));
    }

    function breakdown(items, getAnswers) {
      return items.map((item) => {
        const relevant = submissions.filter((s) => getAnswers(s) !== null);
        let yesCount = 0, noCount = 0;
        const noCafes = [];
        relevant.forEach((s) => {
          const ans = getAnswers(s) || [];
          const match = ans.find((a) => a.id === item.id);
          if (!match) return;
          if (match.value === true) yesCount += 1;
          else { noCount += 1; noCafes.push(s.cafe); }
        });
        return { id: item.id, label: item.label, yesCount, noCount, noCafes };
      });
    }

    const questionBreakdown = breakdown(tracker.checklist_items, (s) => s.answers);
    const conditionalBreakdown = tracker.conditional && tracker.conditional.enabled
      ? breakdown(tracker.conditional.items, (s) => (s.conditional_triggered ? s.conditional_answers : null))
      : [];

    res.json({
      tracker: { id: tracker.id, name: tracker.name, form_title: tracker.form_title },
      totalAssigned: assigned ? assigned.length : null,
      totalSubmitted: submittedCafes.length,
      totalExempted: exemptions.length,
      totalMissing: assigned ? missingCafes.length : null,
      missingCafes,
      exemptCafes: exemptions,
      questionBreakdown,
      conditionalBreakdown,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute insights' });
  }
});

// ---------- Submissions ----------

app.get('/api/trackers/:id/submissions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM submissions WHERE tracker_id = $1 ORDER BY submitted_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// PUBLIC — branches submit here, no login
app.post('/api/trackers/:id/submissions', async (req, res) => {
  try {
    const trackerId = req.params.id;
    const tracker = await pool.query(`SELECT id, active FROM launch_trackers WHERE id = $1`, [trackerId]);
    if (!tracker.rows.length) return res.status(404).json({ error: 'Launch tracker not found' });
    if (!tracker.rows[0].active) return res.status(403).json({ error: 'This launch tracker is archived and no longer accepting submissions' });

    const { cafe, region, submittedBy, answers, conditionalTriggered, conditionalAnswers, disclaimerConfirmed } = req.body;

    if (!cafe || !submittedBy) return res.status(400).json({ error: 'Café name and submitted by are required' });
    if (!disclaimerConfirmed) return res.status(400).json({ error: 'You must confirm the launch disclaimer' });

    const id = genId('sub');
    await pool.query(
      `INSERT INTO submissions (
        id, tracker_id, cafe, region, submitted_by, answers, conditional_triggered, conditional_answers, disclaimer_confirmed
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id, trackerId, cafe, region || null, submittedBy,
        JSON.stringify(answers || []),
        !!conditionalTriggered,
        conditionalTriggered ? JSON.stringify(conditionalAnswers || []) : null,
        !!disclaimerConfirmed,
      ]
    );
    res.status(201).json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save submission' });
  }
});

// SPA fallback — serve index.html for the public /launch/:id and admin /tracker/:id links
app.get(['/launch/*', '/tracker/*'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Launch tracker running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialise DB', err);
    process.exit(1);
  });
