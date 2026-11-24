require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL غير معرّف');
  process.exit(1);
}

const useSSL = /render\.com/.test(connectionString);
const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(session({
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30,
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto'
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  return res.status(401).json({ error: 'غير مصرح' });
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });
  if (String(username).trim().length < 3)
    return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل' });
  if (String(password).length < 8)
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [String(username).trim(), hash]
    );
    req.session.userId = result.rows[0].id;
    req.session.username = result.rows[0].username;
    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'اسم المستخدم مستعمل مسبقاً' });
    console.error(err);
    res.status(500).json({ error: 'خطأ في السيرفر' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });

  try {
    const result = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [String(username).trim()]
    );
    if (!result.rows.length)
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok)
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });

    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ ok: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في السيرفر' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'تعذر إنهاء الجلسة' });
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'غير مصرح' });
  res.json({ user: { id: req.session.userId, username: req.session.username } });
});

// حفظ مسودة مدخلات العملية الانتخابية تلقائياً لكل مستخدم.
app.get('/api/draft', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT total_votes, party_votes, updated_at FROM election_drafts WHERE user_id = $1',
      [req.session.userId]
    );
    res.json({ draft: rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحميل المسودة المحفوظة' });
  }
});

app.put('/api/draft', requireAuth, async (req, res) => {
  const { totalVotes, votes } = req.body || {};
  const total = totalVotes === null || totalVotes === '' || totalVotes === undefined ? null : Number(totalVotes);
  if (total !== null && (!Number.isSafeInteger(total) || total < 0))
    return res.status(400).json({ error: 'إجمالي الأصوات في المسودة غير صالح' });
  if (!votes || typeof votes !== 'object' || Array.isArray(votes) || !PARTY_KEYS.every(k => Object.hasOwn(votes, k)))
    return res.status(400).json({ error: 'بيانات أصوات الأحزاب غير مكتملة' });
  const normalized = {};
  for (const key of PARTY_KEYS) {
    const value = votes[key] === null || votes[key] === '' || votes[key] === undefined ? null : Number(votes[key]);
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      return res.status(400).json({ error: `قيمة غير صالحة للحزب ${key}` });
    normalized[key] = value;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO election_drafts (user_id, total_votes, party_votes, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET total_votes = EXCLUDED.total_votes, party_votes = EXCLUDED.party_votes, updated_at = NOW()
       RETURNING updated_at`,
      [req.session.userId, total, normalized]
    );
    res.json({ ok: true, updatedAt: rows[0].updated_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر حفظ المسودة' });
  }
});

app.delete('/api/draft', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM election_drafts WHERE user_id = $1', [req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر مسح المسودة' });
  }
});

app.post('/api/scenarios', requireAuth, async (req, res) => {
  const { totalVotes, fln, fm, msp } = req.body || {};
  const V = Number(totalVotes);
  const votes = { fln: Number(fln), fm: Number(fm), msp: Number(msp) };

  if (!Number.isSafeInteger(V) || V <= 0)
    return res.status(400).json({ error: 'عدد الأصوات الإجمالي يجب أن يكون عدداً صحيحاً موجباً' });

  for (const [key, value] of Object.entries(votes)) {
    if (!Number.isSafeInteger(value) || value < 0)
      return res.status(400).json({ error: `قيمة أصوات غير صالحة للحزب ${key}` });
  }

  const countedVotes = Object.values(votes).reduce((a, b) => a + b, 0);
  if (countedVotes !== V)
    return res.status(400).json({ error: 'يجب أن يساوي مجموع أصوات الأحزاب الثلاثة إجمالي الأصوات الصحيحة' });

  // الأهلية: الحزب الذي يحصل على 5% بالضبط مؤهل، وما دون ذلك مستبعد.
  const threshold = V * 0.05;
  const partyOrder = Object.keys(votes);
  const eligibleParties = partyOrder.filter(key => votes[key] >= threshold);
  const excludedParties = partyOrder.filter(key => votes[key] < threshold);
  const eligibleVotes = eligibleParties.reduce((sum, key) => sum + votes[key], 0);

  // بعد استبعاد الأحزاب غير المؤهلة، يُحسب معامل المقعد من أصوات الأحزاب المؤهلة فقط.
  const coefficient = eligibleVotes / 19;
  const results = {};
  let allocatedSeats = 0;

  for (const key of partyOrder) {
    const value = votes[key];
    const isEligible = value >= threshold;
    const baseSeats = isEligible ? Math.floor(value / coefficient) : 0;
    const remainder = isEligible ? value - baseSeats * coefficient : 0;
    results[key] = {
      votes: value,
      votePercentage: (value / V) * 100,
      eligible: isEligible,
      baseSeats,
      seats: baseSeats,
      remainder,
      extraSeat: false,
      belowThreshold: !isEligible
    };
    allocatedSeats += baseSeats;
  }

  // المقاعد المتبقية توزع على الأحزاب المؤهلة فقط حسب أكبر البواقي.
  const remainingSeats = 19 - allocatedSeats;
  const rankedParties = [...eligibleParties].sort((a, b) =>
    (results[b].remainder - results[a].remainder) || partyOrder.indexOf(a) - partyOrder.indexOf(b));
  for (let i = 0; i < remainingSeats; i++) {
    const winner = rankedParties[i];
    if (!winner) break;
    results[winner].seats += 1;
    results[winner].extraSeat = true;
  }
  const totalAllocatedSeats = Object.values(results).reduce((sum, r) => sum + r.seats, 0);

  try {
    const { rows } = await pool.query(
      `INSERT INTO scenarios (user_id, total_votes, threshold, coefficient, votes, results)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [req.session.userId, V, threshold, coefficient, votes, results]
    );

    res.json({
      ok: true,
      id: rows[0].id,
      createdAt: rows[0].created_at,
      threshold,
      coefficient,
      eligibleVotes,
      eligibleParties,
      excludedParties,
      totalAllocatedSeats,
      remainingSeats,
      results
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر حفظ نتيجة العملية' });
  }
});


const PARTY_KEYS = ['fln', 'fm', 'msp'];

async function getOwnedScenario(userId, scenarioId) {
  if (!Number.isSafeInteger(Number(scenarioId)) || Number(scenarioId) <= 0) return null;
  const result = await pool.query(
    'SELECT id, total_votes, results, created_at FROM scenarios WHERE id = $1 AND user_id = $2',
    [Number(scenarioId), userId]
  );
  return result.rows[0] || null;
}

app.get('/api/member-workspace/:scenarioId', requireAuth, async (req, res) => {
  try {
    const scenario = await getOwnedScenario(req.session.userId, req.params.scenarioId);
    if (!scenario) return res.status(404).json({ error: 'العملية الانتخابية غير موجودة' });

    const saved = await pool.query(
      `SELECT party_key, member_votes, updated_at
       FROM member_vote_lists WHERE user_id = $1 AND scenario_id = $2`,
      [req.session.userId, scenario.id]
    );
    const lists = {};
    for (const row of saved.rows) lists[row.party_key] = row.member_votes;

    const allListsSaved = PARTY_KEYS.every(key => Array.isArray(lists[key]) && lists[key].length === 26 && lists[key].every(x => Number.isSafeInteger(Number(x.votes)) && x.votes !== null && Number(x.votes) >= 0));
    let allocation = null;
    if (allListsSaved) {
      allocation = {};
      for (const key of PARTY_KEYS) {
        const seats = Number(scenario.results?.[key]?.seats || 0);
        const ranked = [...lists[key]].sort((a, b) =>
          Number(b.votes) - Number(a.votes) || Number(a.memberNo) - Number(b.memberNo));
        const cutoffVotes = seats > 0 && seats <= ranked.length ? Number(ranked[seats - 1].votes) : null;
        const tieAtCutoff = cutoffVotes !== null && ranked.filter(x => Number(x.votes) === cutoffVotes).length > 1
          && ranked.findIndex(x => Number(x.votes) === cutoffVotes) < seats
          && ranked.findIndex(x => Number(x.votes) === cutoffVotes) + ranked.filter(x => Number(x.votes) === cutoffVotes).length > seats;
        allocation[key] = {
          seats,
          ranked,
          winners: ranked.slice(0, seats).map(x => Number(x.memberNo)),
          tieAtCutoff
        };
      }
    }

    res.json({ scenario, lists, allListsSaved, allocation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحميل بيانات ترتيب الأعضاء' });
  }
});

app.post('/api/member-votes', requireAuth, async (req, res) => {
  const { scenarioId, partyKey, memberVotes } = req.body || {};
  if (!PARTY_KEYS.includes(partyKey))
    return res.status(400).json({ error: 'رمز الحزب غير صحيح' });
  if (!Array.isArray(memberVotes) || memberVotes.length !== 26)
    return res.status(400).json({ error: 'يجب إدخال أصوات الأعضاء الـ26 كاملة' });

  const normalized = [];
  const seen = new Set();
  for (const item of memberVotes) {
    const memberNo = Number(item?.memberNo);
    const votes = item?.votes === null || item?.votes === '' || item?.votes === undefined ? null : Number(item.votes);
    if (!Number.isSafeInteger(memberNo) || memberNo < 1 || memberNo > 26 || seen.has(memberNo))
      return res.status(400).json({ error: 'أرقام الأعضاء يجب أن تكون من 01 إلى 26 دون تكرار' });
    if (votes !== null && (!Number.isSafeInteger(votes) || votes < 0))
      return res.status(400).json({ error: `عدد الأصوات غير صالح للعضو ${String(memberNo).padStart(2, '0')}` });
    seen.add(memberNo);
    normalized.push({ memberNo, votes });
  }
  if (seen.size !== 26) return res.status(400).json({ error: 'تأكد من إدخال الأعضاء من 01 إلى 26' });
  normalized.sort((a, b) => a.memberNo - b.memberNo);

  try {
    const scenario = await getOwnedScenario(req.session.userId, scenarioId);
    if (!scenario) return res.status(404).json({ error: 'العملية الانتخابية غير موجودة' });
    await pool.query(
      `INSERT INTO member_vote_lists (user_id, scenario_id, party_key, member_votes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, scenario_id, party_key)
       DO UPDATE SET member_votes = EXCLUDED.member_votes, updated_at = NOW()`,
      [req.session.userId, scenario.id, partyKey, normalized]
    );
    res.json({ ok: true, message: 'تم حفظ أصوات أعضاء القائمة بنجاح' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر حفظ أصوات الأعضاء' });
  }
});

app.get('/api/scenarios', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, total_votes, threshold, coefficient, votes, results, created_at
       FROM scenarios WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.session.userId]
    );
    res.json({ scenarios: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحميل السجلات' });
  }
});

app.get('/members', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'members.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      total_votes BIGINT NOT NULL CHECK (total_votes > 0),
      threshold DOUBLE PRECISION NOT NULL,
      coefficient DOUBLE PRECISION NOT NULL,
      votes JSONB NOT NULL,
      results JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS scenarios_user_idx ON scenarios(user_id);

    CREATE TABLE IF NOT EXISTS election_drafts (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      total_votes BIGINT CHECK (total_votes IS NULL OR total_votes >= 0),
      party_votes JSONB NOT NULL DEFAULT '{"fln":null,"fm":null,"msp":null}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS member_vote_lists (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      party_key TEXT NOT NULL CHECK (party_key IN ('fln', 'fm', 'msp')),
      member_votes JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, scenario_id, party_key)
    );
    CREATE INDEX IF NOT EXISTS member_vote_lists_scenario_idx ON member_vote_lists(scenario_id, user_id);
  `);
}

initDb()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
