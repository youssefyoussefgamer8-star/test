// oddsProvider.js
// Pulls bookmaker odds (default: Bet365, the same source Flashscore shows) from API-Football
// and turns them into the `markets_points` JSON used by the game.
'use strict';

const { buildMatchMarketsPointsFromOdds } = require('./pricingEngine');

const API_BASE = 'https://v3.football.api-sports.io';

// football-data.org competition code -> API-Football league id
const AF_LEAGUE_IDS = { PL: 39, PD: 140, BL1: 78, SA: 135, FL1: 61, CL: 2 };

const BOOKMAKER_ID = parseInt(process.env.ODDS_BOOKMAKER_ID || '8', 10); // 8 = Bet365
const WINDOW_DAYS = parseInt(process.env.ODDS_WINDOW_DAYS || '7', 10);   // only price matches kicking off within N days
const CALL_DELAY_MS = parseInt(process.env.ODDS_CALL_DELAY_MS || '1000', 10);
const MATCH_WINDOW_MIN = 180; // max kickoff difference when pairing our match with an API-Football fixture

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 'the-odds-api' (free tier, 500 credits/month) or 'api-football' (needs a paid plan for the current season)
const PROVIDER = (
  process.env.ODDS_PROVIDER ||
  (process.env.THE_ODDS_API_KEY && process.env.THE_ODDS_API_KEY.trim() ? 'the-odds-api' : 'api-football')
).toLowerCase();

const DEFAULT_CRON = '10 6 * * *'; // once a day: pre-match odds don't move enough to justify more, and it protects the free quota

function isEnabled() {
  const key = PROVIDER === 'the-odds-api' ? process.env.THE_ODDS_API_KEY : process.env.API_FOOTBALL_KEY;
  return Boolean(key && key.trim());
}

function currentSeason(now = new Date()) {
  if (process.env.ODDS_SEASON) return parseInt(process.env.ODDS_SEASON, 10);
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1; // seasons start in Jul/Aug
}

// ---------------------------------------------------------------- HTTP

let lastCallAt = 0;
let callsMade = 0;

async function afGet(path, params = {}, attempt = 1) {
  const wait = lastCallAt + CALL_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  callsMade++;

  const res = await fetch(`${API_BASE}${path}?${new URLSearchParams(params)}`, {
    headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY }
  });

  if (res.status === 429 && attempt <= 3) {
    await sleep(10000 * attempt);
    return afGet(path, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`API-Football HTTP ${res.status} on ${path}`);

  const json = await res.json();
  const errs = json.errors;
  const hasErr = Array.isArray(errs) ? errs.length > 0 : errs && Object.keys(errs).length > 0;
  if (hasErr) {
    const msg = JSON.stringify(errs);
    if (/rate/i.test(msg) && attempt <= 3) {
      await sleep(15000 * attempt);
      return afGet(path, params, attempt + 1);
    }
    throw new Error(`API-Football error on ${path}: ${msg}`);
  }
  return json;
}

// ---------------------------------------------------------------- parsing odds

function validOdd(x) {
  const n = parseFloat(x);
  return Number.isFinite(n) && n >= 1.01 ? n : null;
}

// Find a bet by (case-insensitive) name; fall back to the documented id.
// Every parser below validates the value labels, so a wrong id can never produce bad data.
function findBet(bets, names, id) {
  const lower = names.map(n => n.toLowerCase());
  return (
    bets.find(b => lower.includes(String(b.name || '').toLowerCase())) ||
    bets.find(b => b.id === id) ||
    null
  );
}

function threeWay(bet) {
  if (!bet) return null;
  const out = {};
  for (const v of bet.values || []) {
    const label = String(v.value).toLowerCase();
    const odd = validOdd(v.odd);
    if (odd === null) continue;
    if (label === 'home') out.HOME = odd;
    else if (label === 'draw') out.DRAW = odd;
    else if (label === 'away') out.AWAY = odd;
  }
  return out.HOME && out.DRAW && out.AWAY ? out : null;
}

function twoWay(bet, aLabel, bLabel, aKey, bKey) {
  if (!bet) return null;
  const out = {};
  for (const v of bet.values || []) {
    const label = String(v.value).toLowerCase();
    const odd = validOdd(v.odd);
    if (odd === null) continue;
    if (label === aLabel) out[aKey] = odd;
    else if (label === bLabel) out[bKey] = odd;
  }
  return out[aKey] && out[bKey] ? out : null;
}

function parseBets(bets) {
  bets = Array.isArray(bets) ? bets : [];
  const bundle = { outcome_1x2: null, exact_score: {}, extras: {} };

  bundle.outcome_1x2 = threeWay(findBet(bets, ['Match Winner'], 1));
  if (!bundle.outcome_1x2) return null;

  const htLeader = threeWay(findBet(bets, ['First Half Winner'], 13));
  if (htLeader) bundle.extras.ht_leader = htLeader;

  const btts = twoWay(findBet(bets, ['Both Teams Score', 'Both Teams To Score'], 8), 'yes', 'no', 'YES', 'NO');
  if (btts) bundle.extras.btts = btts;

  const oddEven = twoWay(findBet(bets, ['Odd/Even'], 21), 'odd', 'even', 'ODD', 'EVEN');
  if (oddEven) bundle.extras.odd_even_goals = oddEven;

  // Goals Over/Under: values look like "Over 2.5" / "Under 2.5"
  const ou = findBet(bets, ['Goals Over/Under'], 5);
  if (ou) {
    const lines = {};
    for (const v of ou.values || []) {
      const m = /^(over|under)\s+(\d+(?:\.\d+)?)$/i.exec(String(v.value).trim());
      const odd = validOdd(v.odd);
      if (!m || odd === null) continue;
      (lines[m[2]] ||= {})[m[1].toUpperCase()] = odd;
    }
    for (const line of ['1.5', '2.5', '3.5']) {
      const l = lines[line];
      if (l && l.OVER && l.UNDER) bundle.extras[`over_under_${line.replace('.', '_')}`] = l;
    }
  }

  // Exact Score: values look like "2:1"
  const cs = findBet(bets, ['Exact Score', 'Correct Score'], 10);
  if (cs) {
    for (const v of cs.values || []) {
      const m = /^(\d+)\s*[:\-]\s*(\d+)$/.exec(String(v.value).trim());
      const odd = validOdd(v.odd);
      if (!m || odd === null) continue;
      const h = parseInt(m[1], 10), a = parseInt(m[2], 10);
      if (h <= 7 && a <= 7) bundle.exact_score[`${h}-${a}`] = odd;
    }
  }

  // Highest Scoring Half: First / Draw / Second
  const hsh = findBet(bets, ['Highest Scoring Half'], 11);
  if (hsh) {
    const out = {};
    for (const v of hsh.values || []) {
      const label = String(v.value).toLowerCase();
      const odd = validOdd(v.odd);
      if (odd === null) continue;
      if (/^(first|1st)/.test(label)) out.FIRST = odd;
      else if (/^(second|2nd)/.test(label)) out.SECOND = odd;
      else if (/^(draw|equal|tie)/.test(label)) out.EQUAL = odd;
    }
    if (out.FIRST && out.SECOND && out.EQUAL) bundle.extras.highest_scoring_half = out;
  }

  return bundle;
}

// ---------------------------------------------------------------- team-name matching

const STOP = new Set([
  'fc', 'cf', 'afc', 'sc', 'ac', 'as', 'us', 'ssc', 'rc', 'rcd', 'ud', 'sv', 'vfl', 'vfb', 'tsg',
  'fsv', 'cd', 'ca', 'bsc', 'cp', 'club', 'calcio', 'de', 'the', '1', '04', '05', '1899', '1909', '1910'
]);

// keys and values are written AFTER stop-word removal (e.g. "ac milan" -> "milan")
const ALIASES = {
  'man united': 'manchester united', 'man utd': 'manchester united', 'man city': 'manchester city',
  'spurs': 'tottenham', 'tottenham hotspur': 'tottenham',
  'wolves': 'wolverhampton', 'wolverhampton wanderers': 'wolverhampton',
  'newcastle united': 'newcastle', 'newcastle utd': 'newcastle',
  'nottingham forest': 'nottingham', 'nottm forest': 'nottingham', 'forest': 'nottingham',
  'brighton hove albion': 'brighton', 'brighton and hove albion': 'brighton', 'brighton hove': 'brighton',
  'west ham united': 'west ham', 'leeds united': 'leeds', 'leicester city': 'leicester',
  'paris saint germain': 'paris sg', 'psg': 'paris sg',
  'internazionale': 'inter', 'inter milan': 'inter', 'internazionale milano': 'inter',
  'bayern munich': 'bayern', 'bayern munchen': 'bayern',
  'borussia monchengladbach': 'gladbach', 'monchengladbach': 'gladbach', 'mgladbach': 'gladbach',
  'borussia dortmund': 'dortmund', 'bayer leverkusen': 'leverkusen', 'rb leipzig': 'leipzig',
  'eintracht frankfurt': 'frankfurt', 'atleti': 'atletico madrid', 'atletico': 'atletico madrid',
  'athletic bilbao': 'athletic', 'athletic club': 'athletic', 'real sociedad': 'sociedad',
  'celta vigo': 'celta', 'celta de vigo': 'celta', 'rayo vallecano': 'rayo',
  'deportivo alaves': 'alaves', 'real betis': 'betis', 'real betis balompie': 'betis',
  'hellas verona': 'verona', 'olympique marseille': 'marseille', 'olympique de marseille': 'marseille',
  'olympique lyonnais': 'lyon', 'olympique lyon': 'lyon', 'stade rennais': 'rennes',
  'stade brestois 29': 'brest', 'stade brestois': 'brest', 'losc lille': 'lille', 'lille osc': 'lille',
  'sporting lisbon': 'sporting', 'sporting clube de portugal': 'sporting',
  'psv eindhoven': 'psv', 'red bull salzburg': 'salzburg', 'rb salzburg': 'salzburg',
  'shakhtar donetsk': 'shakhtar', 'slavia praha': 'slavia prague', 'sparta praha': 'sparta prague',
  'crvena zvezda': 'red star belgrade', 'fk crvena zvezda': 'red star belgrade',
  'young boys': 'young boys', 'club brugge kv': 'club brugge'
};

function normalizeName(raw) {
  let s = String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  s = s.split(' ').filter(t => t && !STOP.has(t)).join(' ');
  if (ALIASES[s]) s = ALIASES[s];
  return s.split(' ').filter(Boolean);
}

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function tokenEq(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return a.length >= 5 && b.length >= 5 && lev(a, b) <= 1;
}

function nameSim(x, y) {
  const ta = normalizeName(x), tb = normalizeName(y);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(' ') === tb.join(' ')) return 1;
  const used = new Set();
  let matched = 0;
  for (const t of ta) {
    const idx = tb.findIndex((u, i) => !used.has(i) && tokenEq(t, u));
    if (idx >= 0) { used.add(idx); matched++; }
  }
  const jaccard = matched / Math.max(ta.length, tb.length);
  const contain = (matched / Math.min(ta.length, tb.length)) * 0.85;
  return Math.max(jaccard, contain);
}

// ourMatches: [{ id, home_team, away_team, utc_date }], fixtures: [{ id, utcMs, home, away }]
// returns { mapped: Map(ourId -> fixtureId), unmatched: [ourMatch] }
function mapMatchesToFixtures(ourMatches, fixtures) {
  const pairs = [];
  for (const m of ourMatches) {
    const t = new Date(m.utc_date).getTime();
    for (const f of fixtures) {
      if (Math.abs(f.utcMs - t) > MATCH_WINDOW_MIN * 60000) continue;
      const sh = nameSim(m.home_team, f.home);
      const sa = nameSim(m.away_team, f.away);
      pairs.push({ m, f, sh, sa, score: sh + sa });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const mapped = new Map();
  const usedFixtures = new Set();
  for (const p of pairs) {
    if (mapped.has(p.m.id) || usedFixtures.has(p.f.id)) continue;
    // same league + kickoff within 3h: one strongly matching team is already conclusive
    if (p.score >= 1.0 && Math.max(p.sh, p.sa) >= 0.85) {
      mapped.set(p.m.id, p.f.id);
      usedFixtures.add(p.f.id);
    }
  }
  return { mapped, unmatched: ourMatches.filter(m => !mapped.has(m.id)) };
}

// ---------------------------------------------------------------- API-Football fetchers

async function fetchFixtures(leagueId, season, from, to) {
  const json = await afGet('/fixtures', { league: leagueId, season, from, to });
  return (json.response || []).map(f => ({
    id: f.fixture.id,
    utcMs: Date.parse(f.fixture.date),
    home: f.teams.home.name,
    away: f.teams.away.name
  }));
}

// Odds for every fixture of a league on one UTC date -> Map(fixtureId -> bundle)
async function fetchOddsForDate(leagueId, season, date, bookmakerId = BOOKMAKER_ID) {
  const out = new Map();
  let page = 1;
  let total = 1;
  do {
    const json = await afGet('/odds', { league: leagueId, season, date, bookmaker: bookmakerId, page });
    total = json.paging?.total || 1;
    for (const item of json.response || []) {
      const bm = (item.bookmakers || []).find(b => b.id === bookmakerId);
      if (!bm) continue;
      const bundle = parseBets(bm.bets);
      if (bundle) out.set(item.fixture.id, bundle);
    }
    page++;
  } while (page <= total);
  return out;
}

// ---------------------------------------------------------------- The Odds API (free tier)

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_API_SPORTS = {
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  BL1: 'soccer_germany_bundesliga',
  SA: 'soccer_italy_serie_a',
  FL1: 'soccer_france_ligue_one',
  CL: 'soccer_uefa_champs_league'
};
const ODDS_REGIONS = process.env.ODDS_REGIONS || 'uk';
const PREFERRED_BOOKMAKER = (process.env.ODDS_BOOKMAKER_KEY || '').trim().toLowerCase(); // e.g. "bet365" if your region has it

let creditsRemaining = null;

async function fetchTheOddsApiEvents(sportKey) {
  const run = async markets => {
    const params = new URLSearchParams({
      apiKey: process.env.THE_ODDS_API_KEY,
      regions: ODDS_REGIONS,
      markets,
      oddsFormat: 'decimal',
      dateFormat: 'iso'
    });
    return fetch(`${ODDS_API_BASE}/sports/${sportKey}/odds?${params}`);
  };

  let res = await run('h2h,totals');
  if (res.status === 422) res = await run('h2h'); // plan/market not available -> 1X2 only
  callsMade++;
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining !== null) creditsRemaining = remaining;
  if (!res.ok) throw new Error(`The Odds API HTTP ${res.status} for ${sportKey}`);
  return res.json();
}

function bookmakerView(event, bm) {
  const h2h = (bm.markets || []).find(m => m.key === 'h2h');
  if (!h2h) return null;
  const out = {};
  for (const o of h2h.outcomes || []) {
    const price = validOdd(o.price);
    if (price === null) continue;
    if (String(o.name).toLowerCase() === 'draw') out.DRAW = price;
    else if (nameSim(o.name, event.home_team) >= nameSim(o.name, event.away_team)) out.HOME = price;
    else out.AWAY = price;
  }
  if (!(out.HOME && out.DRAW && out.AWAY)) return null;

  const totals = {};
  const tm = (bm.markets || []).find(m => m.key === 'totals');
  for (const o of (tm && tm.outcomes) || []) {
    const price = validOdd(o.price);
    const side = String(o.name).toUpperCase();
    if (price === null || (side !== 'OVER' && side !== 'UNDER')) continue;
    (totals[String(o.point)] ||= {})[side] = price;
  }
  return { outcome_1x2: out, totals };
}

// Uses the preferred bookmaker if present, otherwise the average of all bookmakers.
function parseTheOddsApiEvent(event) {
  const views = [];
  for (const bm of event.bookmakers || []) {
    const v = bookmakerView(event, bm);
    if (v) views.push({ key: String(bm.key).toLowerCase(), ...v });
  }
  if (!views.length) return null;

  const preferred = views.find(v => v.key === PREFERRED_BOOKMAKER);
  const pool = preferred ? [preferred] : views;
  const avg = arr => Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));

  const bundle = {
    outcome_1x2: {
      HOME: avg(pool.map(v => v.outcome_1x2.HOME)),
      DRAW: avg(pool.map(v => v.outcome_1x2.DRAW)),
      AWAY: avg(pool.map(v => v.outcome_1x2.AWAY))
    },
    exact_score: {},
    extras: {}
  };

  for (const line of ['1.5', '2.5', '3.5']) {
    const withLine = pool.map(v => v.totals[line]).filter(t => t && t.OVER && t.UNDER);
    if (withLine.length) {
      bundle.extras[`over_under_${line.replace('.', '_')}`] = {
        OVER: avg(withLine.map(t => t.OVER)),
        UNDER: avg(withLine.map(t => t.UNDER))
      };
    }
  }
  return bundle;
}

async function refreshFromTheOddsApi(pool, competitions) {
  const summary = { calls: 0, updated: 0, unmatched: 0, noOdds: 0 };
  const startCalls = callsMade;

  const { rows: upcoming } = await pool.query(
    `SELECT id, competition_code, home_team, away_team, utc_date
     FROM matches
     WHERE status IN ('TIMED', 'SCHEDULED')
       AND utc_date > NOW()
       AND utc_date < NOW() + make_interval(days => $1::int)
       AND competition_code = ANY($2::text[])
     ORDER BY utc_date ASC`,
    [WINDOW_DAYS, competitions]
  );

  for (const comp of competitions) {
    const sportKey = ODDS_API_SPORTS[comp];
    const compMatches = upcoming.filter(m => m.competition_code === comp);
    if (!sportKey || compMatches.length === 0) continue;

    try {
      const events = await fetchTheOddsApiEvents(sportKey);
      const fixtures = events.map(e => ({
        id: e.id,
        utcMs: Date.parse(e.commence_time),
        home: e.home_team,
        away: e.away_team
      }));
      const { mapped, unmatched } = mapMatchesToFixtures(compMatches, fixtures);

      for (const m of unmatched) {
        summary.unmatched++;
        console.warn(`[Odds] No event match for ${comp}: "${m.home_team}" vs "${m.away_team}" @ ${new Date(m.utc_date).toISOString()} (no odds listed yet, or add an alias in oddsProvider.js)`);
      }

      for (const [matchId, eventId] of mapped) {
        const event = events.find(e => e.id === eventId);
        const bundle = event ? parseTheOddsApiEvent(event) : null;
        const points = bundle ? buildMatchMarketsPointsFromOdds(bundle) : null;
        if (!points) { summary.noOdds++; continue; }

        const { rowCount } = await pool.query(
          `UPDATE matches
           SET markets_points = $2::jsonb,
               home_goals_avg = $3,
               away_goals_avg = $4,
               odds_source = 'bookmaker',
               odds_updated_at = NOW(),
               updated_at = NOW()
           WHERE id = $1
             AND NOW() < utc_date
             AND status IN ('TIMED', 'SCHEDULED')`,
          [matchId, JSON.stringify(points), points.lambdas.home, points.lambdas.away]
        );
        if (rowCount) summary.updated++;
      }
    } catch (err) {
      console.error(`[Odds] ${comp} failed:`, err.message);
    }
  }

  summary.calls = callsMade - startCalls;
  summary.creditsRemaining = creditsRemaining;
  return summary;
}

// ---------------------------------------------------------------- refresh job

const isoDay = d => new Date(d).toISOString().slice(0, 10);

async function refreshUpcomingOdds(pool, competitions) {
  if (PROVIDER === 'the-odds-api') return refreshFromTheOddsApi(pool, competitions);
  const summary = { calls: 0, updated: 0, unmatched: 0, noOdds: 0 };
  const startCalls = callsMade;
  const season = currentSeason();

  const { rows: upcoming } = await pool.query(
    `SELECT id, competition_code, home_team, away_team, utc_date, af_fixture_id
     FROM matches
     WHERE status IN ('TIMED', 'SCHEDULED')
       AND utc_date > NOW()
       AND utc_date < NOW() + make_interval(days => $1::int)
       AND competition_code = ANY($2::text[])
     ORDER BY utc_date ASC`,
    [WINDOW_DAYS, competitions]
  );

  for (const comp of competitions) {
    const leagueId = AF_LEAGUE_IDS[comp];
    const compMatches = upcoming.filter(m => m.competition_code === comp);
    if (!leagueId || compMatches.length === 0) continue;

    try {
      // 1) map our matches to API-Football fixtures (once per match)
      const unmapped = compMatches.filter(m => !m.af_fixture_id);
      if (unmapped.length > 0) {
        const times = unmapped.map(m => new Date(m.utc_date).getTime());
        const from = isoDay(Math.min(...times) - 86400000);
        const to = isoDay(Math.max(...times) + 86400000);
        const fixtures = await fetchFixtures(leagueId, season, from, to);
        const { mapped, unmatched } = mapMatchesToFixtures(unmapped, fixtures);

        for (const [matchId, fixtureId] of mapped) {
          await pool.query('UPDATE matches SET af_fixture_id = $1 WHERE id = $2', [fixtureId, matchId]);
          compMatches.find(m => m.id === matchId).af_fixture_id = fixtureId;
        }
        for (const m of unmatched) {
          summary.unmatched++;
          console.warn(`[Odds] No fixture match for ${comp}: "${m.home_team}" vs "${m.away_team}" @ ${new Date(m.utc_date).toISOString()} (add an alias in oddsProvider.js)`);
        }
      }

      // 2) fetch odds, one request set per distinct match day
      const mappedMatches = compMatches.filter(m => m.af_fixture_id);
      const days = [...new Set(mappedMatches.map(m => isoDay(m.utc_date)))];
      const oddsByFixture = new Map();
      for (const day of days) {
        const dayOdds = await fetchOddsForDate(leagueId, season, day);
        for (const [fid, bundle] of dayOdds) oddsByFixture.set(String(fid), bundle);
      }

      // 3) price + save (never touches matches that already kicked off)
      for (const m of mappedMatches) {
        const bundle = oddsByFixture.get(String(m.af_fixture_id));
        const points = bundle ? buildMatchMarketsPointsFromOdds(bundle) : null;
        if (!points) { summary.noOdds++; continue; }

        const { rowCount } = await pool.query(
          `UPDATE matches
           SET markets_points = $2::jsonb,
               home_goals_avg = $3,
               away_goals_avg = $4,
               odds_source = 'bookmaker',
               odds_updated_at = NOW(),
               updated_at = NOW()
           WHERE id = $1
             AND NOW() < utc_date
             AND status IN ('TIMED', 'SCHEDULED')`,
          [m.id, JSON.stringify(points), points.lambdas.home, points.lambdas.away]
        );
        if (rowCount) summary.updated++;
      }
    } catch (err) {
      console.error(`[Odds] ${comp} failed:`, err.message);
    }
  }

  summary.calls = callsMade - startCalls;
  return summary;
}

module.exports = {
  isEnabled,
  PROVIDER,
  DEFAULT_CRON,
  ODDS_API_SPORTS,
  fetchTheOddsApiEvents,
  parseTheOddsApiEvent,
  refreshUpcomingOdds,
  // exported for tests / debugging
  afGet,
  parseBets,
  fetchFixtures,
  fetchOddsForDate,
  mapMatchesToFixtures,
  nameSim,
  currentSeason,
  AF_LEAGUE_IDS,
  BOOKMAKER_ID
};
