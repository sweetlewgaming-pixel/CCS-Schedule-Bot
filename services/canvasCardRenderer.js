const path = require('path');
const { weekResultCard } = require('../src/render/cards/weekResultCard');
const { mvpCard } = require('../src/render/cards/mvpCard');
const { FONT_STACKS, STYLE_TUNING, PATHS } = require('../src/render/config');
const { loadFontsFromDir, resolveFontRoles } = require('../src/render/fontResolver');

let cachedFonts = null;
const RESULT_OUTPUT_SIZE = {
  width: Number(process.env.RESULT_CARD_WIDTH || 1200),
  height: Number(process.env.RESULT_CARD_HEIGHT || 675),
};
const MVP_OUTPUT_SIZE = {
  width: Number(process.env.MVP_CARD_WIDTH || 900),
  height: Number(process.env.MVP_CARD_HEIGHT || 1200),
};

function getFonts() {
  if (cachedFonts) {
    return cachedFonts;
  }
  loadFontsFromDir(PATHS.fontsDir, () => {});
  cachedFonts = resolveFontRoles(FONT_STACKS, () => {});
  return cachedFonts;
}

async function renderResultCardCanvas(data) {
  const fonts = getFonts();
  const out = await weekResultCard(
    {
      matchId: String(data.matchId || 'match').trim(),
      leagueTitle: data.leagueLabel || data.league || '',
      weekLabel: `WEEK ${String(data.week || '').replace(/^week\s*/i, '')} RESULT`,
      // Match existing layout intent: away on left, home on right.
      homeTeamName: data.awayTeam || '',
      awayTeamName: data.homeTeam || '',
      homeScore: Number(data.awayWins ?? 0),
      awayScore: Number(data.homeWins ?? 0),
      homeRecord: data.awayRecord || '',
      awayRecord: data.homeRecord || '',
      homeLogoPath: data.awayLogoPath || '',
      awayLogoPath: data.homeLogoPath || '',
    },
    { fonts, tuning: STYLE_TUNING, outputSize: RESULT_OUTPUT_SIZE }
  );
  return out.buffer;
}

async function renderMvpCardCanvas(data) {
  const fonts = getFonts();
  const out = await mvpCard(
    {
      matchId: String(data.matchId || 'match').trim(),
      title: 'MVP',
      playerName: data.mvpName || 'TBD',
      statsLine1: data.mvpLine1 || '',
      statsLine2: data.mvpLine2 || '',
      totalScore: String(data.mvpScore ?? ''),
      footer: 'MORE INFO ON THE WEBSITE BELOW',
      accentColor: data.mvpAccentColor || '#D1D5DB',
    },
    { fonts, tuning: STYLE_TUNING, outputSize: MVP_OUTPUT_SIZE }
  );
  return out.buffer;
}

module.exports = {
  renderResultCardCanvas,
  renderMvpCardCanvas,
};
