// server.js
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const { Pool } = require('pg');

const {
  MARKET_CONFIG,
  buildMatchMarketsPoints,
  resolveMatchOutcomes
} = require('./pricingEngine');
const oddsProvider = require('./oddsProvider');

// 1. التحقق من متغيرات البيئة عند التشغيل (Fail-Fast)
const REQUIRED_ENV = [
  'DATABASE_URL',
  'JWT_SECRET',
  'KICK_CLIENT_ID',
  'KICK_CLIENT_SECRET',
  'KICK_REDIRECT_URI',
  'FOOTBALL_DATA_API_KEY',
  'FRONTEND_URL',
  'MAX_BOOSTS_PER_MATCHDAY'
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key] || process.env[key].trim() === '') {
    console.error(`[FATAL] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const SUPPORTED_COMPETITIONS = (process.env.COMPETITIONS || process.env.COMPETITION_CODE || 'PL,PD,BL1,SA,FL1,CL')
  .split(',')
  .map(c => c.trim().toUpperCase())
  .filter(Boolean);

const MAX_BOOSTS = parseInt(process.env.MAX_BOOSTS_PER_MATCHDAY, 10);
if (isNaN(MAX_BOOSTS) || MAX_BOOSTS < 0) {
  console.error('[FATAL] MAX_BOOSTS_PER_MATCHDAY must be a valid non-negative integer.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// 2. محددات معدل الطلبات (Rate Limiters)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 250,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const writeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions, slow down.' }
});

app.use('/api', globalLimiter);

// 3. وسيط المصادقة (Auth Middleware)
function authenticate(req, res, next) {
  const token = req.cookies.kp_session;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function optionalAuth(req, _res, next) {
  const token = req.cookies.kp_session;
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {}
  }
  next();
}

function computeRoundKey(stage, matchday) {
  const cleanStage = String(stage || 'REGULAR_SEASON').trim().toUpperCase();
  const hasMd = matchday !== null && matchday !== undefined && !isNaN(Number(matchday));
  if (cleanStage === 'REGULAR_SEASON' || cleanStage === 'LEAGUE_STAGE') {
    return hasMd ? `MD-${Number(matchday)}` : cleanStage;
  }
  if (cleanStage === 'GROUP_STAGE' && hasMd) {
    return `GS-MD-${Number(matchday)}`;
  }
  return cleanStage;
}

// 4. مسارات تسجيل الدخول عبر Kick OAuth 2.1 (PKCE)
app.get('/api/auth/kick', (req, res) => {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  const oauthCookie = jwt.sign({ codeVerifier, state }, process.env.JWT_SECRET, { expiresIn: '10m' });
  res.cookie('kp_oauth_state', oauthCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.KICK_CLIENT_ID,
    redirect_uri: process.env.KICK_REDIRECT_URI,
    scope: 'user:read',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state
  });

  res.redirect(`https://id.kick.com/oauth/authorize?${params.toString()}`);
});

app.get('/api/auth/kick/callback', async (req, res) => {
  const { code, state } = req.query;
  const oauthCookie = req.cookies.kp_oauth_state;
  res.clearCookie('kp_oauth_state');

  if (!code || !state || !oauthCookie) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=oauth_invalid`);
  }

  let savedState;
  try {
    savedState = jwt.verify(oauthCookie, process.env.JWT_SECRET);
  } catch (err) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=oauth_expired`);
  }

  if (savedState.state !== state) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=state_mismatch`);
  }

  try {
    const tokenRes = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.KICK_CLIENT_ID,
        client_secret: process.env.KICK_CLIENT_SECRET,
        redirect_uri: process.env.KICK_REDIRECT_URI,
        code_verifier: savedState.codeVerifier,
        code: String(code)
      })
    });

    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const tokenData = await tokenRes.json();

    const userRes = await fetch('https://api.kick.com/public/v1/users', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userRes.ok) throw new Error('User fetch failed');
    const userPayload = await userRes.json();
    const kickUser = Array.isArray(userPayload.data) ? userPayload.data[0] : userPayload.data || userPayload;

    const kickId = String(kickUser.user_id || kickUser.id);
    const username = kickUser.name || kickUser.username || `kick_${kickId}`;
    const avatarUrl = kickUser.profile_picture || kickUser.avatar_url || null;

    const { rows } = await pool.query(
      `INSERT INTO users (kick_id, username, avatar_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (kick_id) DO UPDATE
       SET username = EXCLUDED.username, avatar_url = EXCLUDED.avatar_url
       RETURNING id, kick_id, username, avatar_url, total_points, exact_scores_count`,
      [kickId, username, avatarUrl]
    );

    const user = rows[0];
    const sessionToken = jwt.sign(
      { id: user.id, kickId: user.kick_id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('kp_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.redirect(process.env.FRONTEND_URL);
  } catch (err) {
    console.error('[OAuth Error]', err);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('kp_session');
  res.json({ ok: true });
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, kick_id, username, avatar_url, total_points, exact_scores_count FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ user: rows[0] });
});

// 5. جلب المباريات مع ضمان توليد وسائط النقاط (markets_points) دائماً على الطائر
app.get('/api/matches', optionalAuth, async (req, res) => {
  try {
    const requestedComp = req.query.competition ? String(req.query.competition).toUpperCase() : null;
    const comp =
      requestedComp && SUPPORTED_COMPETITIONS.includes(requestedComp)
        ? requestedComp
        : SUPPORTED_COMPETITIONS[0];

    const { rows: roundRows } = await pool.query(
      `SELECT round_key, stage, matchday, MIN(utc_date) AS first_kickoff
       FROM matches
       WHERE competition_code = $1
       GROUP BY round_key, stage, matchday
       ORDER BY MIN(utc_date) ASC`,
      [comp]
    );

    const availableRounds = roundRows.map(r => r.round_key);
    let selectedRound = req.query.round ? String(req.query.round) : null;

    if (!selectedRound || !availableRounds.includes(selectedRound)) {
      const currentRes = await pool.query(
        `SELECT round_key FROM matches
         WHERE competition_code = $1 AND utc_date >= NOW() - INTERVAL '3 days'
         ORDER BY utc_date ASC LIMIT 1`,
        [comp]
      );
      selectedRound =
        currentRes.rows[0]?.round_key ||
        availableRounds[availableRounds.length - 1] ||
        'MD-1';
    }

    const { rows: matches } = await pool.query(
      `SELECT m.id, m.external_id, m.competition_code, m.stage, m.matchday, m.round_key,
              m.home_team, m.home_crest, m.away_team, m.away_crest,
              m.utc_date, m.status, m.home_score, m.away_score,
              m.ht_home_score, m.ht_away_score,
              m.home_goals_avg, m.away_goals_avg,
              m.markets_points, m.settled_outcomes,
              (NOW() >= m.utc_date OR (m.status != 'TIMED' AND m.status != 'SCHEDULED')) AS is_locked
       FROM matches m
       WHERE m.competition_code = $1 AND m.round_key = $2
       ORDER BY m.utc_date ASC`,
      [comp, selectedRound]
    );

    const userPredictions = {};
    let boostsUsed = 0;

    if (req.user && matches.length > 0) {
      const predRes = await pool.query(
        `SELECT match_id, predicted_outcome, predicted_home, predicted_away, is_boosted,
                outcome_points_locked, exact_points_locked, extras_picks, points_awarded
         FROM predictions
         WHERE user_id = $1 AND match_id = ANY($2::bigint[])`,
        [req.user.id, matches.map(m => m.id)]
      );
      for (const p of predRes.rows) {
        userPredictions[p.match_id] = p;
      }

      const boostRes = await pool.query(
        `SELECT boosts_used FROM user_matchday_boosts
         WHERE user_id = $1 AND competition_code = $2 AND round_key = $3`,
        [req.user.id, comp, selectedRound]
      );
      boostsUsed = boostRes.rows[0]?.boosts_used || 0;
    }

    res.json({
      competitions: SUPPORTED_COMPETITIONS,
      competitionCode: comp,
      roundKey: selectedRound,
      availableRounds,
      maxBoosts: MAX_BOOSTS,
      boostsUsed,
      matches: matches.map(m => {
        let computedMarkets = m.markets_points;
        if (typeof computedMarkets === 'string') {
          try { computedMarkets = JSON.parse(computedMarkets); } catch (e) { computedMarkets = null; }
        }
        // توليد النقاط فوراً إذا لم تكن موجودة أو كانت فارغة
        if (!computedMarkets || !computedMarkets.exact_score || Object.keys(computedMarkets.exact_score).length === 0) {
          computedMarkets = buildMatchMarketsPoints(Number(m.home_goals_avg || 1.50), Number(m.away_goals_avg || 1.20));
        }

        return {
          ...m,
          markets_points: computedMarkets,
          prediction: userPredictions[m.id] || null
        };
      })
    });
  } catch (err) {
    console.error('[GET /api/matches]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 6. إرسال وتثبيت التوقعات
app.post('/api/predictions', authenticate, writeLimiter, async (req, res) => {
  const { matchId, predictedOutcome, predictedHome, predictedAway, isBoosted, extras } = req.body;
  const h = parseInt(predictedHome, 10);
  const a = parseInt(predictedAway, 10);
  const wantBoost = Boolean(isBoosted);
  const rawExtras = Array.isArray(extras) ? extras : [];

  if (!['HOME', 'DRAW', 'AWAY'].includes(predictedOutcome)) {
    return res.status(400).json({ error: 'Please select Who Wins (HOME, DRAW, or AWAY).' });
  }

  if (!matchId || isNaN(h) || isNaN(a) || h < 0 || h > 7 || a < 0 || a > 7) {
    return res.status(400).json({ error: 'Predicted scores must be within the 0-7 x 0-7 grid.' });
  }

  if (rawExtras.length > 3) {
    return res.status(400).json({ error: 'You may pick at most 3 extras per match.' });
  }

  const seenMarkets = new Set();
  for (const item of rawExtras) {
    if (!item || typeof item.market !== 'string' || typeof item.selection !== 'string') {
      return res.status(400).json({ error: 'Invalid extra pick format.' });
    }
    if (!MARKET_CONFIG.EXTRAS[item.market]) {
      return res.status(400).json({ error: `Unknown extra market: ${item.market}` });
    }
    if (seenMarkets.has(item.market)) {
      return res.status(400).json({ error: `Duplicate extra market: ${item.market}` });
    }
    seenMarkets.add(item.market);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const matchRes = await client.query(
      `SELECT id, competition_code, matchday, round_key, utc_date, status,
              home_goals_avg, away_goals_avg, markets_points,
              (NOW() >= utc_date OR (status != 'TIMED' AND status != 'SCHEDULED')) AS locked
       FROM matches WHERE id = $1 FOR SHARE`,
      [matchId]
    );

    if (!matchRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Match not found.' });
    }

    const match = matchRes.rows[0];
    if (match.locked) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Predictions are locked after kickoff.' });
    }

    let marketsPoints = match.markets_points;
    if (typeof marketsPoints === 'string') {
      try { marketsPoints = JSON.parse(marketsPoints); } catch (e) { marketsPoints = null; }
    }
    if (!marketsPoints || !marketsPoints.exact_score) {
      marketsPoints = buildMatchMarketsPoints(Number(match.home_goals_avg), Number(match.away_goals_avg));
    }

    const scoreKey = `${h}-${a}`;
    const outcomePointsLocked = marketsPoints.outcome_1x2?.[predictedOutcome] ?? 12;
    const exactPointsLocked = marketsPoints.exact_score?.[scoreKey] ?? 35;

    const lockedExtras = [];
    for (const pick of rawExtras) {
      const marketTable = marketsPoints.extras?.[pick.market];
      const lockedPts = marketTable?.[pick.selection];
      if (typeof lockedPts !== 'number') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Invalid selection '${pick.selection}' for market '${pick.market}'.`
        });
      }
      lockedExtras.push({
        market: pick.market,
        selection: pick.selection,
        points_locked: lockedPts
      });
    }

    await client.query(
      `INSERT INTO user_matchday_boosts (user_id, competition_code, round_key, matchday, boosts_used)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (user_id, competition_code, round_key) DO NOTHING`,
      [req.user.id, match.competition_code, match.round_key, match.matchday]
    );

    const boostRow = await client.query(
      `SELECT boosts_used FROM user_matchday_boosts
       WHERE user_id = $1 AND competition_code = $2 AND round_key = $3
       FOR UPDATE`,
      [req.user.id, match.competition_code, match.round_key]
    );

    const existingPred = await client.query(
      `SELECT is_boosted FROM predictions WHERE user_id = $1 AND match_id = $2 FOR UPDATE`,
      [req.user.id, match.id]
    );

    const wasBoosted = existingPred.rows[0]?.is_boosted || false;
    let currentBoosts = boostRow.rows[0].boosts_used;

    if (!wasBoosted && wantBoost) {
      if (currentBoosts >= MAX_BOOSTS) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `All ${MAX_BOOSTS} boost(s) already used for this round.` });
      }
      currentBoosts += 1;
    } else if (wasBoosted && !wantBoost) {
      currentBoosts = Math.max(0, currentBoosts - 1);
    }

    await client.query(
      `UPDATE user_matchday_boosts
       SET boosts_used = $1
       WHERE user_id = $2 AND competition_code = $3 AND round_key = $4`,
      [currentBoosts, req.user.id, match.competition_code, match.round_key]
    );

    const upsertRes = await client.query(
      `INSERT INTO predictions (
         user_id, match_id, predicted_outcome, predicted_home, predicted_away, is_boosted,
         outcome_points_locked, exact_points_locked, extras_picks, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
       ON CONFLICT (user_id, match_id) DO UPDATE
       SET predicted_outcome = EXCLUDED.predicted_outcome,
           predicted_home = EXCLUDED.predicted_home,
           predicted_away = EXCLUDED.predicted_away,
           is_boosted = EXCLUDED.is_boosted,
           outcome_points_locked = EXCLUDED.outcome_points_locked,
           exact_points_locked = EXCLUDED.exact_points_locked,
           extras_picks = EXCLUDED.extras_picks,
           updated_at = NOW()
       RETURNING match_id, predicted_outcome, predicted_home, predicted_away, is_boosted,
                 outcome_points_locked, exact_points_locked, extras_picks, points_awarded`,
      [
        req.user.id,
        match.id,
        predictedOutcome,
        h,
        a,
        wantBoost,
        outcomePointsLocked,
        exactPointsLocked,
        JSON.stringify(lockedExtras)
      ]
    );

    await client.query('COMMIT');
    res.json({ prediction: upsertRes.rows[0], boostsUsed: currentBoosts });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /api/predictions]', err);
    res.status(500).json({ error: 'Could not save prediction.' });
  } finally {
    client.release();
  }
});

// 7. لوحة المتصدرين (Leaderboard)
app.get('/api/leaderboard', async (req, res) => {
  const search = (req.query.search || '').trim();
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  try {
    const { rows } = await pool.query(
      `WITH ranked_users AS (
         SELECT
           id,
           username,
           avatar_url,
           total_points,
           exact_scores_count,
           RANK() OVER (
             ORDER BY total_points DESC, exact_scores_count DESC, created_at ASC
           ) AS global_rank
         FROM users
       )
       SELECT id, username, avatar_url, total_points, exact_scores_count, global_rank::int AS rank
       FROM ranked_users
       WHERE ($1 = '' OR username ILIKE '%' || $1 || '%')
       ORDER BY global_rank ASC, id ASC
       LIMIT $2 OFFSET $3`,
      [search, limit, offset]
    );

    res.json({ leaderboard: rows });
  } catch (err) {
    console.error('[GET /api/leaderboard]', err);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// 8. Cron Jobs لمزامنة المباريات وتسوية النقاط
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let isSyncRunning = false;

async function syncCompetitionMatches(comp) {
  const res = await fetch(`https://api.football-data.org/v4/competitions/${comp}/matches`, {
    headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY }
  });

  if (!res.ok) {
    console.warn(`[Sync] football-data.org returned HTTP ${res.status} for ${comp}`);
    return;
  }

  const data = await res.json();
  const matches = data.matches || [];

  const teamStats = {};
  let totalHomeGoals = 0;
  let totalAwayGoals = 0;
  let finishedCount = 0;

  const ensureTeam = name => {
    if (!teamStats[name]) {
      teamStats[name] = {
        homeScored: 0,
        homeConceded: 0,
        homeGames: 0,
        awayScored: 0,
        awayConceded: 0,
        awayGames: 0
      };
    }
    return teamStats[name];
  };

  for (const m of matches) {
    const hName = m.homeTeam?.shortName || m.homeTeam?.name;
    const aName = m.awayTeam?.shortName || m.awayTeam?.name;
    const ftH = m.score?.fullTime?.home;
    const ftA = m.score?.fullTime?.away;

    if (m.status === 'FINISHED' && hName && aName && ftH != null && ftA != null) {
      const hs = ensureTeam(hName);
      const as = ensureTeam(aName);
      hs.homeScored += ftH;
      hs.homeConceded += ftA;
      hs.homeGames += 1;
      as.awayScored += ftA;
      as.awayConceded += ftH;
      as.awayGames += 1;

      totalHomeGoals += ftH;
      totalAwayGoals += ftA;
      finishedCount += 1;
    }
  }

  const leagueHomeAvg = finishedCount >= 10 ? totalHomeGoals / finishedCount : 1.54;
  const leagueAwayAvg = finishedCount >= 10 ? totalAwayGoals / finishedCount : 1.22;
  const PRIOR_WEIGHT = 4;

  for (const m of matches) {
    const stage = m.stage || 'REGULAR_SEASON';
    const matchday = m.matchday ?? null;
    const roundKey = computeRoundKey(stage, matchday);

    const homeTeam = m.homeTeam?.shortName || m.homeTeam?.name || 'TBD';
    const awayTeam = m.awayTeam?.shortName || m.awayTeam?.name || 'TBD';
    const ftHome = m.score?.fullTime?.home ?? null;
    const ftAway = m.score?.fullTime?.away ?? null;
    const htHome = m.score?.halfTime?.home ?? null;
    const htAway = m.score?.halfTime?.away ?? null;

    const hs = teamStats[homeTeam];
    const as = teamStats[awayTeam];

    const hPrior = leagueHomeAvg;
    const aPrior = leagueAwayAvg;

    const homeAttack = hs
      ? (hs.homeScored + hs.awayScored * 0.85 + PRIOR_WEIGHT * hPrior) /
        (hs.homeGames + hs.awayGames * 0.85 + PRIOR_WEIGHT)
      : hPrior;
    const homeDefense = hs
      ? (hs.homeConceded + hs.awayConceded * 0.85 + PRIOR_WEIGHT * leagueAwayAvg) /
        (hs.homeGames + hs.awayGames * 0.85 + PRIOR_WEIGHT)
      : leagueAwayAvg;

    const awayAttack = as
      ? (as.awayScored + as.homeScored * 0.85 + PRIOR_WEIGHT * aPrior) /
        (as.awayGames + as.homeGames * 0.85 + PRIOR_WEIGHT)
      : aPrior;
    const awayDefense = as
      ? (as.awayConceded + as.homeConceded * 0.85 + PRIOR_WEIGHT * leagueHomeAvg) /
        (as.awayGames + as.homeGames * 0.85 + PRIOR_WEIGHT)
      : leagueHomeAvg;

    const rawLambdaH = (homeAttack * (awayDefense / leagueHomeAvg)) * 1.08;
    const rawLambdaA = (awayAttack * (homeDefense / leagueAwayAvg)) * 0.92;

    const lambdaHome = Number(Math.max(0.45, Math.min(3.50, rawLambdaH)).toFixed(2));
    const lambdaAway = Number(Math.max(0.35, Math.min(3.10, rawLambdaA)).toFixed(2));

    const marketsPoints = buildMatchMarketsPoints(lambdaHome, lambdaAway);

    await pool.query(
      `INSERT INTO matches (
         external_id, competition_code, stage, matchday, round_key,
         home_team, home_crest, away_team, away_crest,
         utc_date, status, home_score, away_score, ht_home_score, ht_away_score,
         home_goals_avg, away_goals_avg, markets_points, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15,
         $16, $17, $18::jsonb, NOW()
       )
       ON CONFLICT (external_id) DO UPDATE SET
         stage = EXCLUDED.stage,
         matchday = EXCLUDED.matchday,
         round_key = EXCLUDED.round_key,
         home_team = EXCLUDED.home_team,
         home_crest = EXCLUDED.home_crest,
         away_team = EXCLUDED.away_team,
         away_crest = EXCLUDED.away_crest,
         utc_date = EXCLUDED.utc_date,
         status = EXCLUDED.status,
         home_score = EXCLUDED.home_score,
         away_score = EXCLUDED.away_score,
         ht_home_score = EXCLUDED.ht_home_score,
         ht_away_score = EXCLUDED.ht_away_score,
         home_goals_avg = CASE
           WHEN NOW() < matches.utc_date AND matches.status IN ('TIMED', 'SCHEDULED')
                AND matches.odds_source IS DISTINCT FROM 'bookmaker'
           THEN EXCLUDED.home_goals_avg
           ELSE matches.home_goals_avg
         END,
         away_goals_avg = CASE
           WHEN NOW() < matches.utc_date AND matches.status IN ('TIMED', 'SCHEDULED')
                AND matches.odds_source IS DISTINCT FROM 'bookmaker'
           THEN EXCLUDED.away_goals_avg
           ELSE matches.away_goals_avg
         END,
         markets_points = CASE
           WHEN NOW() < matches.utc_date AND matches.status IN ('TIMED', 'SCHEDULED')
                AND matches.odds_source IS DISTINCT FROM 'bookmaker'
           THEN EXCLUDED.markets_points
           ELSE COALESCE(matches.markets_points, EXCLUDED.markets_points)
         END,
         updated_at = NOW()`,
      [
        m.id,
        comp,
        stage,
        matchday,
        roundKey,
        homeTeam,
        m.homeTeam?.crest || null,
        awayTeam,
        m.awayTeam?.crest || null,
        m.utcDate,
        m.status,
        ftHome,
        ftAway,
        htHome,
        htAway,
        lambdaHome,
        lambdaAway,
        JSON.stringify(marketsPoints)
      ]
    );
  }
}

async function settleFinishedMatches() {
  const { rows: finishedMatches } = await pool.query(
    `SELECT id, home_score, away_score, ht_home_score, ht_away_score
     FROM matches
     WHERE status = 'FINISHED'
       AND points_calculated = FALSE
       AND home_score IS NOT NULL
       AND away_score IS NOT NULL
       AND ht_home_score IS NOT NULL
       AND ht_away_score IS NOT NULL`
  );

  for (const m of finishedMatches) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const lockedMatch = await client.query(
        `SELECT id, home_score, away_score, ht_home_score, ht_away_score
         FROM matches
         WHERE id = $1 AND status = 'FINISHED' AND points_calculated = FALSE
         FOR UPDATE SKIP LOCKED`,
        [m.id]
      );

      if (lockedMatch.rowCount === 0) {
        await client.query('ROLLBACK');
        continue;
      }

      const row = lockedMatch.rows[0];
      const outcomes = resolveMatchOutcomes(
        row.home_score,
        row.away_score,
        row.ht_home_score,
        row.ht_away_score
      );

      const { rows: preds } = await client.query(
        `SELECT id, user_id, predicted_outcome, predicted_home, predicted_away, is_boosted,
                outcome_points_locked, exact_points_locked, extras_picks
         FROM predictions
         WHERE match_id = $1 AND points_awarded IS NULL
         FOR UPDATE`,
        [m.id]
      );

      for (const pred of preds) {
        const userScoreKey = `${pred.predicted_home}-${pred.predicted_away}`;
        const isExact = userScoreKey === outcomes.exact_score;
        const isOutcomeCorrect = pred.predicted_outcome === outcomes.outcome_1x2;

        let basePoints = 0;
        if (isOutcomeCorrect) basePoints += Number(pred.outcome_points_locked || 0);
        if (isExact) basePoints += Number(pred.exact_points_locked || 0);

        const settledExtras = [];
        const picks = Array.isArray(pred.extras_picks) ? pred.extras_picks : [];
        for (const pick of picks) {
          const actualResult = outcomes.extras[pick.market];
          const won = actualResult === pick.selection;
          const earned = won ? Number(pick.points_locked || 0) : 0;
          basePoints += earned;
          settledExtras.push({
            ...pick,
            status: won ? 'WON' : 'LOST',
            won,
            points_earned: earned
          });
        }

        const finalPoints = basePoints * (pred.is_boosted ? 2 : 1);

        await client.query(
          `UPDATE predictions
           SET points_awarded = $1,
               extras_picks = $2::jsonb,
               updated_at = NOW()
           WHERE id = $3`,
          [finalPoints, JSON.stringify(settledExtras), pred.id]
        );

        await client.query(
          `UPDATE users
           SET total_points = total_points + $1,
               exact_scores_count = exact_scores_count + $2
           WHERE id = $3`,
          [finalPoints, isExact ? 1 : 0, pred.user_id]
        );
      }

      await client.query(
        `UPDATE matches
         SET points_calculated = TRUE,
             settled_outcomes = $1::jsonb,
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(outcomes), m.id]
      );

      await client.query('COMMIT');
      console.log(`[Cron] Settled match ID ${m.id} (${preds.length} predictions)`);
    } catch (txErr) {
      await client.query('ROLLBACK');
      console.error(`[Cron] Failed settling match ${m.id}:`, txErr);
    } finally {
      client.release();
    }
  }
}

async function runSyncAndSettleCycle() {
  if (isSyncRunning) return;
  isSyncRunning = true;
  try {
    for (let i = 0; i < SUPPORTED_COMPETITIONS.length; i++) {
      const comp = SUPPORTED_COMPETITIONS[i];
      await syncCompetitionMatches(comp);
      if (i < SUPPORTED_COMPETITIONS.length - 1) {
        await sleep(7500);
      }
    }
    await settleFinishedMatches();
  } catch (err) {
    console.error('[Cron Cycle Error]', err);
  } finally {
    isSyncRunning = false;
  }
}

cron.schedule('*/3 * * * *', runSyncAndSettleCycle);

// Bookmaker odds (Bet365 via API-Football) -> points. Needs API_FOOTBALL_KEY in .env.
let isOddsRunning = false;
async function runOddsCycle(onlyIfStale = false) {
  if (!oddsProvider.isEnabled()) return;
  if (isOddsRunning) return;
  isOddsRunning = true;
  try {
    // on server restart, skip if odds were refreshed recently (protects the free API quota)
    if (onlyIfStale) {
      const fresh = await pool.query(
        "SELECT 1 FROM matches WHERE odds_updated_at > NOW() - INTERVAL '12 hours' LIMIT 1"
      );
      if (fresh.rowCount > 0) {
        console.log('[Odds] Recently refreshed - skipping startup refresh.');
        return;
      }
    }
    const r = await oddsProvider.refreshUpcomingOdds(pool, SUPPORTED_COMPETITIONS);
    console.log(`[Odds] provider=${oddsProvider.PROVIDER} updated=${r.updated} noOdds=${r.noOdds} unmatched=${r.unmatched} apiCalls=${r.calls}` + (r.creditsRemaining != null ? ` creditsLeft=${r.creditsRemaining}` : ''));
  } catch (err) {
    console.error('[Odds Cycle Error]', err);
  } finally {
    isOddsRunning = false;
  }
}

if (oddsProvider.isEnabled()) {
  cron.schedule(process.env.ODDS_CRON || oddsProvider.DEFAULT_CRON, () => runOddsCycle(false));
} else {
  console.warn('[Odds] No odds API key set (THE_ODDS_API_KEY or API_FOOTBALL_KEY) - points will use the statistical model only.');
}

app.listen(process.env.PORT, () => {
  console.log(`KickPredict backend listening on port ${process.env.PORT}`);
  runOddsCycle(true); // odds don't have to wait for the (slow) full match sync
  runSyncAndSettleCycle();
});