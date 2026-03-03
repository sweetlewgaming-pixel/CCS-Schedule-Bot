const path = require('path');
const { PATHS, FONT_STACKS, STYLE_TUNING } = require('./config');
const { loadFontsFromDir, resolveFontRoles } = require('./fontResolver');
const { weekResultCard } = require('./cards/weekResultCard');
const { mvpCard } = require('./cards/mvpCard');

async function run() {
  loadFontsFromDir(PATHS.fontsDir, console.log);
  const fonts = resolveFontRoles(FONT_STACKS, console.log);

  const sampleMatchId = 'sample-match-001';

  const weekResult = await weekResultCard(
    {
      matchId: sampleMatchId,
      leagueTitle: 'CLUTCH AMATEUR SERIES',
      weekLabel: 'WEEK 4 RESULT',
      homeTeamName: 'EPWORTH ELEPHANTS',
      awayTeamName: 'BAD AXE BLACK BEARS',
      homeScore: 3,
      awayScore: 2,
      homeRecord: '1-3',
      awayRecord: '2-2',
      homeLogoPath: path.join('assets', 'logos', 'home.png'),
      awayLogoPath: path.join('assets', 'logos', 'away.png'),
    },
    { fonts, tuning: STYLE_TUNING }
  );

  const mvp = await mvpCard(
    {
      matchId: sampleMatchId,
      title: 'MVP',
      playerName: 'CALEL',
      statsLine1: '6 GOALS, 4 ASSISTS, 5 SAVES',
      statsLine2: 'AND 10 SHOTS!',
      totalScore: '1856',
      footer: 'MORE INFO ON THE WEBSITE BELOW',
      accentColor: '#22b8a8',
    },
    { fonts, tuning: STYLE_TUNING }
  );

  console.log(`[render] week result: ${weekResult.filePath}`);
  console.log(`[render] mvp card: ${mvp.filePath}`);
}

run().catch((error) => {
  console.error('[render] failed:', error);
  process.exit(1);
});
