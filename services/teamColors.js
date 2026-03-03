function normalizeTeamName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COLOR_HEX = {
  teal: '#22b8a8',
  green: '#22c55e',
  black: '#d0d1d4',
  red: '#ef4444',
  yellow: '#facc15',
  white: '#c3c8d2',
  pink: '#ec4899',
  tan: '#d2b48c',
  brown: '#8b5a2b',
  blue: '#3b82f6',
  purple: '#a855f7',
  orange: '#f97316',
};

const GROUPS = [
  { color: 'teal', teams: ['Atlantis Anglers', 'Frenchmen Bay Fishermen', 'Bermuda Behemoths', 'Lyonesse Leviathans'] },
  { color: 'green', teams: ['Fiji Flyers', 'Lautoka Lory', 'Suva Skyhawks', 'Rakiraki Redwings'] },
  { color: 'black', teams: ['Nepal Ninjas', 'Sakala Shadows', 'Palpa Prowlers', 'Tohka Thieves'] },
  { color: 'red', teams: ['Shanghai Samurai', 'Wuhan Warriors', 'Shenzhen Shaman', 'Beijing Bushido'] },
  { color: 'yellow', teams: ['Venezuela Vipers', 'Caracas Cobras', 'Coro Copperheads', 'Anaco Anacondas'] },
  { color: 'white', teams: ['Zimbabwe Zebras', 'Bulawayo Buffalo', 'Epworth Elephants', 'Redcliff Rhinos'] },
  { color: 'pink', teams: ['Houston Howlers', 'Copper Canyon Coyotes', 'Waco Wolfpack', 'Temple Timberwolves'] },
  { color: 'tan', teams: ['Michigan Moose', 'Grand Rapids Groundhogs', 'Bad Axe Black Bears', 'Detroit Ducks'] },
  { color: 'brown', teams: ['Puerto Rico Pirates', 'Palm Beach Pirates', 'Marshall Island Marauders', 'Culebra Conquerors', 'Surfside Shipwreck'] },
  { color: 'blue', teams: ['San Jose Shockwave', 'San Diego Sonic Boom', 'San Francisco Surge', 'San Bernadino Sound'] },
  { color: 'purple', teams: ['Seattle Stars', 'Spokane Supernova', 'Aberdeen Astronauts', 'Raymond Rovers'] },
  { color: 'orange', teams: ['Boston Blasters', 'Massachusetts Mortars', 'Cambridge Cannons', 'Bedford Ballistics'] },
];

const TEAM_COLOR_BY_NAME = new Map();
for (const group of GROUPS) {
  const hex = COLOR_HEX[group.color];
  for (const team of group.teams) {
    TEAM_COLOR_BY_NAME.set(normalizeTeamName(team), hex);
    // Alias the mascot-only suffix when full city+mascot is provided.
    const parts = normalizeTeamName(team).split(' ');
    if (parts.length >= 2) {
      TEAM_COLOR_BY_NAME.set(parts.slice(1).join(' '), hex);
      TEAM_COLOR_BY_NAME.set(parts[parts.length - 1], hex);
    }
  }
}

function resolveTeamColor(teamName) {
  const key = normalizeTeamName(teamName);
  if (!key) {
    return '';
  }
  if (TEAM_COLOR_BY_NAME.has(key)) {
    return TEAM_COLOR_BY_NAME.get(key);
  }

  // Fallback fuzzy contains matching.
  for (const [name, color] of TEAM_COLOR_BY_NAME.entries()) {
    if (name.includes(key) || key.includes(name)) {
      return color;
    }
  }

  return '';
}

module.exports = {
  resolveTeamColor,
  normalizeTeamName,
};
