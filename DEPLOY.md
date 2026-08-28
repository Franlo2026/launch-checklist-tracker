# Deploying the Bootlegger Launch Checklist Tracker

Same GitHub → Railway workflow you already use for the Ops Task Tracker.

## What's new in this update
- **Copy Template**: a "Duplicate" button on the Tracker Detail page opens the template editor
  pre-filled from an existing launch (checklist/sections/café assignments/scenario), as a brand
  new tracker with fresh section/item ids — rename, tweak, and save without touching the original.
- **A "Test" café for dry runs**: every submission link now has a "Testing" group in the café
  dropdown with a single "Test" entry, available regardless of that launch's assigned café list.
  Submissions from Test never affect submission counts, flagged counts, or Insights — they're
  filtered out of every reporting aggregation — but stay visible in the tracker's raw submissions
  list so you can double-check what a test run captured. Test is also exempt from the
  one-submission-per-café lock on standard trackers, so it can be resubmitted as many times as
  needed for testing.
- **Fixed: partial section submissions no longer blocked or duplicated.** Previously, resubmitting
  a section with some questions still blank was either rejected outright or created a confusing
  pile-up of "(photo)"/"(date)" validation errors for the same section. Now, submitting a section
  merges into the most recent incomplete entry — whatever's newly answered is saved, whatever's
  left blank keeps its previous value (if any) — so a café can leave certain questions unanswered
  and finish them in a later visit, exactly as the workflow expects. Validation only requires a
  photo/date for a question that's actually been answered, not for ones left blank.
- **Fixed: unanswered questions no longer counted as flagged "No" responses** in Insights/PDF —
  this was a side effect of the same underlying issue and is corrected on both the sectioned and
  standard reporting paths.

## Previously shipped
- **Redesigned submission page for sectioned launches**: everything on one page. Each section
  carries a dropdown ("Skip for now" / fill it in, or a count of new entries for repeatable ones
  like Training Proof) instead of its own submit button.
- **One declaration, one submit** at the bottom of the page, covering whatever was filled in.
- **Photo fields are required, not optional** — "(optional)" wording removed, enforced by
  validation wherever a checklist item requires one and has been answered.
- **Mix-and-match sections**: the template editor offers every Standard, Pre-Launch, and
  Post-Launch section as an individual "+ Add" button, grouped by category.
- **Archived tab** on the dashboard (Active / Archived, with live counts).
- **Standard scenario** (no sections added) is unchanged — one flat submission per café.
- **Branding**: Bootlegger wordmark only in the PDF header, no repeated company name in footers,
  and the final declaration reads: *"I hereby declare that this task/launch/confirmation is 100%
  accurate and as per the requirements set out."*

This is a **database-safe update** — every change is additive (new columns, a replacement unique
index using the same underlying columns) and nothing here touches or migrates existing data. Just
push the code.

### Building a template with mixed sections
In **+ New Launch Tracker**, under "Add Sections" you'll see three groups — Standard, Pre-Launch,
and Post-Launch — each listing its available sections as individual buttons. Click any that apply
(you're not limited to one category) to add an editable copy to the template; rename, add/remove
items, or mark a section **Repeatable** with a Min/Max submission count (e.g. Training Proof: min
3, max 4) as needed before saving.

### What a café sees on a sectioned link
After picking their café, everything is on one page: each section shows a dropdown to either skip
it for now or fill it in (a count of entries for repeatable sections). Sections already fully
submitted show a "✓ Complete" badge instead of a dropdown. At the bottom there's one declaration
and one Submit button — clicking it saves whatever sections/entries were filled in, even if others
were left for a later visit.

## 1. Push to GitHub
1. Create a new **private** repo, e.g. `Franlo2026/launch-checklist-tracker`
2. In this folder:
   ```bash
   git init
   git add .
   git commit -m "Initial launch checklist tracker"
   git branch -M main
   git remote add origin https://github.com/Franlo2026/launch-checklist-tracker.git
   git push -u origin main
   ```

## 2. Deploy on Railway
1. railway.app → **New Project** → **Deploy from GitHub repo** → select the repo
2. **+ Add Service** → **Database** → **PostgreSQL** (auto-wires `DATABASE_URL`)
3. Variables tab on the web service → add:
   - `NODE_ENV=production`
   - `JWT_SECRET=<a long random string>` — this signs admin login sessions.
     Generate one with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
     **Keep this secret** — anyone with it could forge an admin session.
4. Settings → Networking → **Generate Domain** — this is your dashboard URL
   (e.g. `https://launch-checklist-tracker-production.up.railway.app`)

The app creates its own database tables on first boot.

## 3. First-time setup (do this once, right after deploying)
1. Open the Railway domain in a browser.
2. Since no admin account exists yet, you'll land on **"Create Admin Account"**.
   Set your own username + password here — this becomes the first admin.
3. Once logged in, go to **Manage Admins** (top nav) and add accounts for
   Charlene, Brent, Liam, or anyone else who needs dashboard access.
   Each person gets their own username/password.
4. Log out and confirm login works before handing accounts out.

## 4. Using it day-to-day
- **Dashboard** (the domain root) — bookmark this. Requires login.
- **+ New Launch Tracker** opens the full template editor:
  - Launch Name (internal) and Submission Form Title (what branches see) are separate fields
  - Add/remove/reword checklist items, toggle "Add Picture" per item
  - Optionally enable a conditional section (e.g. store-type specific checks)
    with its own trigger question and items
- Open a tracker → copy the **Submission Link** (`.../launch/<id>`) and send
  it to branches (WhatsApp, email, etc.) — **no login required on their end**,
  by design, since this is the one thing branch staff need one-tap access to.
- **Edit Template** lets you adjust an existing launch's checklist at any
  time — note this doesn't retroactively change submissions already made;
  those keep whatever questions were live when they were submitted.
- **Archive** a tracker once a launch is done to close the submission link.

## Access model (confirmed)
- `/` and `/tracker/<id>` (the dashboard and its detail views) — **admin login required**.
- `/launch/<id>` (the branch submission form) — **public, no login**, by design.
- Only an admin can create/edit trackers, view submissions, or manage other admins.

## Ongoing updates
Same as the Ops Tracker:
```bash
git add .
git commit -m "Describe the change"
git push
```
Railway redeploys automatically in ~60–90 seconds. The database (and admin
accounts) are untouched by code deploys.

## Notes
- Passwords are hashed with bcrypt before storage — never stored in plain text.
- Admin sessions are httpOnly signed cookies (30-day expiry); logging out clears them.
- Photos are compressed client-side (resized + JPEG ~65% quality) before
  upload, then stored directly in Postgres as base64 — no separate file
  storage/S3 setup needed.
- The café dropdown uses your current 128-store masterfile, grouped by region.
- If you ever need to add a new admin without anyone being logged in (e.g.
  first admin forgot their password), the simplest fix is to delete their row
  directly from the `admins` table in Railway's Postgres data tab, which will
  make the bootstrap screen reappear if it's the last admin — or just add a
  new admin manually via a one-off SQL insert and reset their password later.
