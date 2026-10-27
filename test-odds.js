// Usage: node test-odds.js [PL|PD|BL1|SA|FL1|CL] [YYYY-MM-DD]
// Checks the odds provider on the REAL API and prints the resulting points.
require('dotenv').config();
const o = require('./oddsProvider');
const { buildMatchMarketsPointsFromOdds } = require('./pricingEngine');

async function viaTheOddsApi(comp) {
  const sport = o.ODDS_API_SPORTS[comp];
  const events = await o.fetchTheOddsApiEvents(sport);
  console.log(`events returned: ${events.length}`);
  for (const e of events.slice(0, 8)) console.log(`  ${e.commence_time}  ${e.home_team} vs ${e.away_team}  (${(e.bookmakers || []).length} bookmakers)`);
  const first = events.find(e => (e.bookmakers || []).length);
  if (!first) return console.log('No event has odds yet.');
  console.log('bookmakers on first event:', first.bookmakers.map(b => b.key).join(', '));
  const bundle = o.parseTheOddsApiEvent(first);
  if (!bundle) return console.log('Could not read 1X2 odds.');
  console.log(`${first.home_team} vs ${first.away_team}`);
  console.log('\n1X2 odds per bookmaker (compare with Flashscore to pick ODDS_BOOKMAKER_KEY):');
  for (const b of first.bookmakers) {
    const m = (b.markets || []).find(x => x.key === 'h2h');
    if (!m) continue;
    const price = n => (m.outcomes.find(o => o.name === n) || {}).price;
    console.log(`  ${b.key.padEnd(16)} home ${price(first.home_team)}  draw ${price('Draw')}  away ${price(first.away_team)}`);
  }
  console.log('');
  console.log('parsed 1X2 odds:', bundle.outcome_1x2, '| totals lines:', Object.keys(bundle.extras));
  const pts = buildMatchMarketsPointsFromOdds(bundle);
  console.log('1X2 points:', pts.outcome_1x2);
  console.log('priced from model (not from bookmaker):', pts._meta.model_priced);
}

async function viaApiFootball(comp, date) {
  const league = o.AF_LEAGUE_IDS[comp];
  const season = o.currentSeason();
  const fixtures = await o.fetchFixtures(league, season, date, date);
  console.log('fixtures:', fixtures.map(f => `${f.id} ${f.home} vs ${f.away}`));
  if (!fixtures.length) return console.log('No fixtures that day - try another date.');
  const json = await o.afGet('/odds', { fixture: fixtures[0].id, bookmaker: o.BOOKMAKER_ID });
  const bm = json.response?.[0]?.bookmakers?.[0];
  if (!bm) return console.log('No odds returned for this fixture yet.');
  for (const b of bm.bets) console.log(`  ${b.id}\t${b.name}\t(${b.values.length} values)`);
  const bundle = o.parseBets(bm.bets);
  if (!bundle) return console.log('Could not read 1X2 odds - check bet names above.');
  const pts = buildMatchMarketsPointsFromOdds(bundle);
  console.log('1X2 points:', pts.outcome_1x2, '| model-priced:', pts._meta.model_priced);
}

(async () => {
  const comp = (process.argv[2] || 'PL').toUpperCase();
  const date = process.argv[3] || new Date().toISOString().slice(0, 10);
  console.log({ provider: o.PROVIDER, comp });
  if (!o.isEnabled()) return console.log('No API key set in .env for this provider.');
  if (o.PROVIDER === 'the-odds-api') await viaTheOddsApi(comp);
  else await viaApiFootball(comp, date);
})().catch(e => console.error('ERROR:', e.message));
