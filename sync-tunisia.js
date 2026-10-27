require('dotenv').config();
const { Pool } = require('pg');
const { buildMatchMarketsPoints } = require('./pricingEngine');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const API_KEY = process.env.API_FOOTBALL_KEY;

function teamStrengthOffset(teamName, externalId) {
  let hash = Number(externalId) || 0;
  const str = String(teamName || 'Team');
  for (let i = 0; i < str.length; i++) hash = (hash * 33 + str.charCodeAt(i)) % 10000;
  return ((hash % 100) - 45) / 100;
}

async function syncTunisianLeague() {
  if (!API_KEY) {
    console.error("❌ Missing API_FOOTBALL_KEY in .env");
    process.exit(1);
  }

  try {
    // إجبار السكريبت على استخدام موسم 2024 لتخطي قيود الخطة المجانية
    const season = 2024;
    console.log(`🔍 Fetching matches for Tunisian Ligue 1 (ID: 202) - Season: ${season}...`);
    
    const fixRes = await fetch(`https://v3.football.api-sports.io/fixtures?league=202&season=${season}`, {
      headers: { 'x-apisports-key': API_KEY }
    });
    const fixJson = await fixRes.json();
    
    if (fixJson.errors && Object.keys(fixJson.errors).length > 0) {
        console.error("❌ API Error:", fixJson.errors);
        process.exit(1);
    }

    const fixtures = fixJson.response || [];
    if (fixtures.length === 0) {
        console.log("⚠️ No matches returned from the API for this season!");
        process.exit(0);
    }

    let updatedCount = 0;
    for (const f of fixtures) {
      const matchdayMatch = f.league.round.match(/\d+/);
      const matchday = matchdayMatch ? parseInt(matchdayMatch[0], 10) : 1;
      const roundKey = `MD-${matchday}`;

      let status = 'SCHEDULED';
      if (['FT', 'AET', 'PEN'].includes(f.fixture.status.short)) status = 'FINISHED';
      else if (['1H', '2H', 'HT', 'ET', 'P'].includes(f.fixture.status.short)) status = 'IN_PLAY';
      else if (['PST', 'CANC', 'ABD'].includes(f.fixture.status.short)) status = 'POSTPONED';

      const hOffset = teamStrengthOffset(f.teams.home.name, f.fixture.id);
      const aOffset = teamStrengthOffset(f.teams.away.name, f.fixture.id + 1);
      const lambdaHome = Number(Math.max(0.45, Math.min(3.50, 1.45 + hOffset)).toFixed(2));
      const lambdaAway = Number(Math.max(0.35, Math.min(3.10, 1.15 + aOffset)).toFixed(2));
      const marketsPoints = buildMatchMarketsPoints(lambdaHome, lambdaAway);

      await pool.query(
        `INSERT INTO matches (
           external_id, competition_code, stage, matchday, round_key,
           home_team, home_crest, away_team, away_crest,
           utc_date, status, home_score, away_score, ht_home_score, ht_away_score,
           home_goals_avg, away_goals_avg, markets_points, updated_at
         ) VALUES (
           $1, 'TU1', 'REGULAR_SEASON', $2, $3,
           $4, $5, $6, $7,
           $8, $9, $10, $11, $12, $13,
           $14, $15, $16::jsonb, NOW()
         )
         ON CONFLICT (external_id) DO UPDATE SET
           status = EXCLUDED.status,
           home_score = EXCLUDED.home_score,
           away_score = EXCLUDED.away_score,
           ht_home_score = EXCLUDED.ht_home_score,
           ht_away_score = EXCLUDED.ht_away_score,
           updated_at = NOW()`,
        [
          f.fixture.id, matchday, roundKey,
          f.teams.home.name, f.teams.home.logo,
          f.teams.away.name, f.teams.away.logo,
          f.fixture.date, status,
          f.goals.home, f.goals.away,
          f.score.halftime.home, f.score.halftime.away,
          lambdaHome, lambdaAway, JSON.stringify(marketsPoints)
        ]
      );
      updatedCount++;
    }
    
    console.log(`✅ Successfully synced ${updatedCount} Tunisian League matches from season 2024!`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Error syncing Tunisia:', err.message);
    process.exit(1);
  }
}

syncTunisianLeague();