// Usage: node run-odds-now.js
// Runs ONE odds refresh right now (costs ~12 credits on The Odds API free plan), prints the result and exits.
// Safe to run while the server is running.
require('dotenv').config();
const { Pool } = require('pg');
const odds = require('./oddsProvider');

const competitions = (process.env.COMPETITIONS || process.env.COMPETITION_CODE || 'PL,PD,BL1,SA,FL1,CL')
  .split(',').map(c => c.trim().toUpperCase()).filter(Boolean);

(async () => {
  if (!odds.isEnabled()) {
    console.log('No odds API key found in .env (THE_ODDS_API_KEY).');
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log(`provider=${odds.PROVIDER} competitions=${competitions.join(',')}`);
    const t = Date.now();
    const r = await odds.refreshUpcomingOdds(pool, competitions);
    console.log('result:', r, `(${Math.round((Date.now() - t) / 1000)}s)`);

    const { rows } = await pool.query(
      `SELECT competition_code, home_team, away_team, utc_date, odds_source,
              markets_points->'outcome_1x2' AS pts
       FROM matches
       WHERE odds_source = 'bookmaker' AND utc_date > NOW()
       ORDER BY utc_date ASC LIMIT 5`
    );
    console.log('sample of matches priced from odds:');
    for (const m of rows) {
      console.log(`  ${m.competition_code} ${m.home_team} vs ${m.away_team} ->`, JSON.stringify(m.pts));
    }
    if (!rows.length) console.log('  (none yet)');
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
  }
})();
