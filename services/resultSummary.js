function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamNamesLikelyMatch(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftCompact = left.replace(/[\s-]+/g, '');
  const rightCompact = right.replace(/[\s-]+/g, '');
  if (leftCompact === rightCompact) {
    return true;
  }

  return left.includes(right) || right.includes(left);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getTeamWins(teamObj) {
  return toNumber(teamObj?.cumulative?.wins ?? teamObj?.wins);
}

function getPlayerScore(playerObj) {
  return toNumber(playerObj?.cumulative?.core?.score ?? playerObj?.cumulative?.score ?? playerObj?.score);
}

function sortByScoreDesc(players) {
  return [...players].sort((a, b) => getPlayerScore(b) - getPlayerScore(a));
}

function buildMatchSummary(groupData, homeTeam, awayTeam) {
  const teams = Array.isArray(groupData?.teams) ? groupData.teams : [];
  const players = Array.isArray(groupData?.players) ? groupData.players : [];

  let homeGroupTeam = teams.find((team) => teamNamesLikelyMatch(team?.name || team?.team, homeTeam)) || null;
  let awayGroupTeam = teams.find((team) => teamNamesLikelyMatch(team?.name || team?.team, awayTeam)) || null;

  if ((!homeGroupTeam || !awayGroupTeam) && teams.length === 2) {
    if (!homeGroupTeam && awayGroupTeam) {
      homeGroupTeam = teams.find((team) => team !== awayGroupTeam) || homeGroupTeam;
    }
    if (!awayGroupTeam && homeGroupTeam) {
      awayGroupTeam = teams.find((team) => team !== homeGroupTeam) || awayGroupTeam;
    }
    if (!homeGroupTeam && !awayGroupTeam) {
      homeGroupTeam = teams[0];
      awayGroupTeam = teams[1];
    }
  }

  const homeWins = getTeamWins(homeGroupTeam);
  const awayWins = getTeamWins(awayGroupTeam);
  const winningGroupTeam = [...teams]
    .sort((a, b) => getTeamWins(b) - getTeamWins(a))[0] || null;
  const winnerTeamName =
    (winningGroupTeam?.name || winningGroupTeam?.team) ||
    (homeWins > awayWins ? homeTeam : awayWins > homeWins ? awayTeam : (homeGroupTeam?.name || homeGroupTeam?.team || homeTeam));

  const allPlayersSorted = sortByScoreDesc(players);
  const scopedPlayers = players.filter((player) => {
    const teamName = player?.team || '';
    return teamNamesLikelyMatch(teamName, homeTeam) || teamNamesLikelyMatch(teamName, awayTeam) || teamNamesLikelyMatch(teamName, winnerTeamName);
  });
  const winningTeamPlayers = players.filter((player) =>
    teamNamesLikelyMatch(player?.team || '', winnerTeamName)
  );

  // MVP must be highest score on the series-winning team.
  const mvpPool =
    winningTeamPlayers.length > 0
      ? winningTeamPlayers
      : (scopedPlayers.length > 0 ? scopedPlayers : allPlayersSorted);
  const mvp = sortByScoreDesc(mvpPool)[0] || null;

  return {
    homeWins,
    awayWins,
    mvp: {
      name: String(mvp?.name || 'TBD').trim() || 'TBD',
      teamName: String(mvp?.team || '').trim(),
      goals: toNumber(mvp?.cumulative?.core?.goals),
      assists: toNumber(mvp?.cumulative?.core?.assists),
      saves: toNumber(mvp?.cumulative?.core?.saves),
      shots: toNumber(mvp?.cumulative?.core?.shots),
      score: getPlayerScore(mvp),
    },
    matchedTeams: {
      home: Boolean(homeGroupTeam),
      away: Boolean(awayGroupTeam),
    },
  };
}

module.exports = {
  buildMatchSummary,
  teamNamesLikelyMatch,
};
