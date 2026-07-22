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

  // Enforce one submission per café per launch at the DB level (belt-and-braces alongside the app-level check).
  // Wrapped in try/catch: if older duplicate data already exists on a live DB, creating the index would fail —
  // in that case we log it and skip, rather than crashing the whole app on boot.
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_submission_per_cafe
      ON submissions (tracker_id, LOWER(TRIM(cafe)));
    `);
  } catch (err) {
    console.error('Could not create one-submission-per-café unique index (likely pre-existing duplicate data):', err.message);
  }
}

const genId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

// ---- Legacy café name reconciliation ----
// Submissions made before the masterfile-based café list existed used names like
// "Salt River (XS)" or "Grandwest XS". The current list uses clean names ("Salt River",
// "Grandwest"). This resolves old-style names to their current equivalent for matching
// purposes only — it never rewrites stored data, just how names are compared.
const LEGACY_CAFE_ALIASES = {
  'n1 city kiosk': 'n1 city mall',
  'aquarium (xs)': 'aquarium kiosk',
  'aquarium xs': 'aquarium kiosk',
};
function stripFormatSuffix(name) {
  let n = (name || '').trim();
  n = n.replace(/\s*\(\s*(xs\s*kiosk|xs\s*petroleum\/?c-?store|petroleum\/?c-?store|c-?store|kiosk|xs)\s*\)\s*$/i, '');
  n = n.replace(/\s+(xs\s*kiosk|xs\s*petroleum\/?c-?store|petroleum\/?c-?store|c-?store|kiosk|xs)\s*$/i, '');
  return n.trim();
}
// Finds which candidate name a given café name refers to, checking in priority order so two
// distinct *current* café names (e.g. "Aquarium" and "Aquarium Kiosk") can never collide with
// each other — only a name with no exact match anywhere in the list falls through to legacy
// alias/suffix-based reconciliation.
//   1. Exact match (case/whitespace-insensitive) — always wins if present.
//   2. Known direct alias for an ambiguous old-style name (e.g. "Aquarium (XS)" -> "Aquarium Kiosk").
//   3. Generic legacy suffix stripping — only tried if the input actually had a suffix to strip,
//      so a bare canonical name is never coerced into matching a different café by accident.
function resolveCafeMatch(targetName, candidates) {
  const raw = (targetName || '').trim().toLowerCase();
  const exact = candidates.find((c) => (c || '').trim().toLowerCase() === raw);
  if (exact) return exact;

  if (LEGACY_CAFE_ALIASES[raw]) {
    const aliasTarget = LEGACY_CAFE_ALIASES[raw];
    const aliased = candidates.find((c) => {
      const cRaw = (c || '').trim().toLowerCase();
      return cRaw === aliasTarget || stripFormatSuffix(c).toLowerCase() === aliasTarget;
    });
    if (aliased) return aliased;
  }

  const stripped = stripFormatSuffix(targetName).toLowerCase();
  if (stripped !== raw) {
    const found = candidates.find((c) => (c || '').trim().toLowerCase() === stripped);
    if (found) return found;
  }

  // Last resort: the old submitted name may have had NO suffix at all, while the current
  // canonical name gained one later (e.g. "Hoedspruit" -> "Hoedspruit (C-Store)"). Compare
  // stripped forms on both sides, but only accept the match if it's unambiguous — if two
  // different candidates both strip down to the same key, decline rather than guess.
  const symmetricMatches = candidates.filter((c) => stripFormatSuffix(c).toLowerCase() === stripped);
  if (symmetricMatches.length === 1) return symmetricMatches[0];

  return null;
}

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

    const subRes = await pool.query(`SELECT DISTINCT cafe FROM submissions WHERE tracker_id = $1`, [req.params.id]);
    const tracker = rows[0];
    tracker.submitted_cafes = subRes.rows.map((r) => r.cafe);
    res.json(tracker);
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

// Update the comment/actioned status on one specific answer within a submission (admin follow-up)
app.patch('/api/submissions/:id/answer', requireAuth, async (req, res) => {
  try {
    const { itemId, isConditional, comment, actioned } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });

    const { rows } = await pool.query(`SELECT * FROM submissions WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Submission not found' });
    const sub = rows[0];

    const column = isConditional ? 'conditional_answers' : 'answers';
    const list = sub[column] || [];
    const idx = list.findIndex((a) => a.id === itemId);
    if (idx === -1) return res.status(404).json({ error: 'Answer not found on this submission' });

    list[idx] = {
      ...list[idx],
      comment: typeof comment === 'string' ? comment : (list[idx].comment || ''),
      actioned: typeof actioned === 'boolean' ? actioned : !!list[idx].actioned,
    };

    await pool.query(
      `UPDATE submissions SET ${column} = $1 WHERE id = $2`,
      [JSON.stringify(list), req.params.id]
    );
    res.json({ ok: true, answer: list[idx] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update answer' });
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
    let submittedInScope = submittedCafes;
    let unscopedSubmittedCafes = [];
    if (assigned) {
      const assignedNames = assigned.map((c) => c.name || c);

      // Only count a submission toward "Submitted" if its café matches the assigned list —
      // matching goes through resolveCafeMatch so a legacy name (e.g. "Salt River (XS)") still
      // correctly matches the current name ("Salt River") instead of inflating "Submitted"
      // without ever clearing "Not Yet Submitted". Exact matches always take priority, so two
      // distinct current cafés (e.g. "Aquarium" vs "Aquarium Kiosk") never get confused.
      // Note: the submitted name must be passed as the target (not the assigned name), since
      // legacy aliases are keyed by old-style submitted names.
      const matchedAssignedNames = new Set();
      submittedInScope = submittedCafes.filter((name) => {
        const match = resolveCafeMatch(name, assignedNames);
        if (match) matchedAssignedNames.add(match);
        return match !== null;
      });
      unscopedSubmittedCafes = submittedCafes.filter((name) => resolveCafeMatch(name, assignedNames) === null);

      const exemptMatchedAssignedNames = new Set();
      exemptCafeNames.forEach((name) => {
        const match = resolveCafeMatch(name, assignedNames);
        if (match) exemptMatchedAssignedNames.add(match);
      });

      missingCafes = assignedNames.filter((name) => !matchedAssignedNames.has(name) && !exemptMatchedAssignedNames.has(name));
    }

    function breakdown(items, getAnswers) {
      return items.map((item) => {
        const relevant = submissions.filter((s) => getAnswers(s) !== null);
        let yesCount = 0, noCount = 0;
        const noEntries = [];
        relevant.forEach((s) => {
          const ans = getAnswers(s) || [];
          const match = ans.find((a) => a.id === item.id);
          if (!match) return;
          if (match.value === true) yesCount += 1;
          else {
            noCount += 1;
            noEntries.push({
              submissionId: s.id,
              cafe: s.cafe,
              comment: match.comment || '',
              actioned: !!match.actioned,
            });
          }
        });
        return { id: item.id, label: item.label, yesCount, noCount, noEntries };
      });
    }

    const questionBreakdown = breakdown(tracker.checklist_items, (s) => s.answers);
    const conditionalBreakdown = tracker.conditional && tracker.conditional.enabled
      ? breakdown(tracker.conditional.items, (s) => (s.conditional_triggered ? s.conditional_answers : null))
      : [];

    // ---- Summary stats ----
    // "Submitted vs Assigned" — how much of the assigned café list has actually submitted.
    const submissionRate = assigned && assigned.length
      ? Math.round((submittedInScope.length / assigned.length) * 1000) / 10
      : null;

    const allNoEntries = questionBreakdown.concat(conditionalBreakdown).flatMap((q) => q.noEntries);
    const totalFlaggedInputs = allNoEntries.length;
    const actionedFlaggedInputs = allNoEntries.filter((e) => e.actioned).length;
    const pendingFlaggedInputs = totalFlaggedInputs - actionedFlaggedInputs;

    // Launch Success Rate = % of assigned cafés that have submitted (same basis as "Submitted vs Assigned").
    // Launch Accuracy Rate = % of flagged inputs relative to total submissions received.
    const launchAccuracyRate = submissions.length
      ? Math.round((totalFlaggedInputs / submissions.length) * 1000) / 10
      : null;
    // Launch Action Rate = % of flagged inputs that have been actioned.
    const launchActionRate = totalFlaggedInputs
      ? Math.round((actionedFlaggedInputs / totalFlaggedInputs) * 1000) / 10
      : null;

    res.json({
      tracker: { id: tracker.id, name: tracker.name, form_title: tracker.form_title },
      totalAssigned: assigned ? assigned.length : null,
      totalSubmitted: assigned ? submittedInScope.length : submittedCafes.length,
      totalExempted: exemptions.length,
      totalMissing: assigned ? missingCafes.length : null,
      missingCafes,
      exemptCafes: exemptions,
      unscopedSubmittedCafes, // no longer shown as its own report section — surfaced instead in the template editor
      questionBreakdown,
      conditionalBreakdown,
      summary: {
        submissionRate,          // % of assigned cafés that have submitted — this IS the "Launch Success Rate"
        totalFlaggedInputs,      // total "No" answers across all questions
        actionedFlaggedInputs,   // of those, how many are marked actioned
        pendingFlaggedInputs,    // remaining un-actioned flagged inputs
        launchAccuracyRate,      // % of flagged inputs relative to total submissions received
        launchActionRate,        // % of flagged inputs that have been actioned
        totalSubmissions: submissions.length,
      },
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
    const trackerRes = await pool.query(`SELECT id, active, assigned_cafes FROM launch_trackers WHERE id = $1`, [trackerId]);
    if (!trackerRes.rows.length) return res.status(404).json({ error: 'Launch tracker not found' });
    if (!trackerRes.rows[0].active) return res.status(403).json({ error: 'This launch tracker is archived and no longer accepting submissions' });

    const { cafe, region, submittedBy, answers, conditionalTriggered, conditionalAnswers, disclaimerConfirmed } = req.body;

    if (!cafe || !submittedBy) return res.status(400).json({ error: 'Café name and submitted by are required' });
    if (!disclaimerConfirmed) return res.status(400).json({ error: 'You must confirm the launch disclaimer' });

    // One submission per café per launch — checked in JS so legacy naming (e.g. "Salt River (XS)")
    // is recognised as the same café as its current name. Names are first resolved against the
    // tracker's assigned café list (the authoritative source) before comparing — this is what
    // prevents two distinct current cafés (e.g. "Aquarium" vs "Aquarium Kiosk") from ever being
    // treated as duplicates of each other just because one happens to be a prefix of the other.
    const assignedNamesForDupeCheck = (trackerRes.rows[0].assigned_cafes && trackerRes.rows[0].assigned_cafes.length)
      ? trackerRes.rows[0].assigned_cafes.map((c) => c.name || c)
      : null;
    function canonicalCafeForm(name) {
      if (assignedNamesForDupeCheck) {
        const match = resolveCafeMatch(name, assignedNamesForDupeCheck);
        if (match) return match.trim().toLowerCase();
      }
      return (name || '').trim().toLowerCase();
    }
    const existingRes = await pool.query(`SELECT cafe FROM submissions WHERE tracker_id = $1`, [trackerId]);
    const targetCanonical = canonicalCafeForm(cafe);
    const alreadySubmitted = existingRes.rows.some((r) => canonicalCafeForm(r.cafe) === targetCanonical);
    if (alreadySubmitted) {
      return res.status(409).json({ error: 'This café has already submitted a confirmation for this launch. Contact your regional manager if this needs to be corrected.' });
    }

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
    if (err.code === '23505') { // unique_violation — race-condition backstop
      return res.status(409).json({ error: 'This café has already submitted a confirmation for this launch.' });
    }
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
