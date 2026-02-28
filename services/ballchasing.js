function extractGroupIdFromUrl(groupUrl) {
  const value = String(groupUrl || '').trim();
  const match = value.match(/ballchasing\.com\/group\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

async function fetchBallchasingGroup(groupUrl) {
  const token = String(process.env.BALLCHASING_API_KEY || '').trim();
  if (!token) {
    throw new Error('BALLCHASING_API_KEY is missing from environment.');
  }

  const groupId = extractGroupIdFromUrl(groupUrl);
  if (!groupId) {
    throw new Error('Invalid ballchasing group link.');
  }

  const response = await fetch(`https://ballchasing.com/api/groups/${groupId}`, {
    headers: {
      Authorization: token,
    },
  });

  if (!response.ok) {
    let message = `Ballchasing API error (${response.status})`;
    try {
      const body = await response.json();
      if (body?.error) {
        message = `${message}: ${body.error}`;
      }
    } catch (_) {
      // Ignore JSON parse issues for non-JSON error bodies.
    }
    throw new Error(message);
  }

  const data = await response.json();
  return {
    groupId,
    data,
  };
}

function getPathValue(obj, path) {
  if (!obj || !path) {
    return undefined;
  }

  const parts = String(path).split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function getFirstValue(obj, paths, fallback = '') {
  for (const path of paths) {
    const value = getPathValue(obj, path);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return fallback;
}

function normalizeWeekLabel(week) {
  const raw = String(week || '').trim();
  if (!raw) {
    return '';
  }
  if (/^week\s+\d+/i.test(raw)) {
    return raw.replace(/^week/i, 'Week');
  }
  if (/^\d+$/.test(raw)) {
    return `Week ${raw}`;
  }
  return raw;
}

function roundNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return '';
  }
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function buildPlayerRow(match, player) {
  const cumulative = player?.cumulative || {};
  const gameAverage = player?.game_average || {};
  const games = Number(cumulative.games || 0);
  const wins = Number(cumulative.wins || 0);
  const losses = games > 0 ? games - wins : '';

  const goals = Number(getFirstValue(player, ['cumulative.core.goals'], 0)) || 0;
  const assists = Number(getFirstValue(player, ['cumulative.core.assists'], 0)) || 0;
  const saves = Number(getFirstValue(player, ['cumulative.core.saves'], 0)) || 0;
  const shots = Number(getFirstValue(player, ['cumulative.core.shots'], 0)) || 0;
  const mvpr = games > 0 ? (goals + assists + saves + shots / 3) / games : '';

  return {
    team_name: player?.team || '',
    player_name: player?.name || '',
    games: games || '',
    wins: Number.isFinite(wins) ? wins : '',
    win_percentage: getFirstValue(player, ['cumulative.win_percentage'], ''),
    score: getFirstValue(player, ['cumulative.core.score'], ''),
    score_per_game: getFirstValue(player, ['game_average.core.score'], ''),
    goals: getFirstValue(player, ['cumulative.core.goals'], ''),
    goals_per_game: getFirstValue(player, ['game_average.core.goals'], ''),
    assists: getFirstValue(player, ['cumulative.core.assists'], ''),
    assists_per_game: getFirstValue(player, ['game_average.core.assists'], ''),
    saves: getFirstValue(player, ['cumulative.core.saves'], ''),
    saves_per_game: getFirstValue(player, ['game_average.core.saves'], ''),
    shots: getFirstValue(player, ['cumulative.core.shots'], ''),
    shots_per_game: getFirstValue(player, ['game_average.core.shots'], ''),
    week: normalizeWeekLabel(match?.week),
    losses,
    goals_conceded: getFirstValue(player, ['cumulative.core.goals_against'], ''),
    goals_conceded_per_game: getFirstValue(player, ['game_average.core.goals_against'], ''),
    mvpr,
    series_played: 1,
    shooting_percentage: getFirstValue(player, ['cumulative.core.shooting_percentage'], ''),
    bpm_per_game: getFirstValue(player, ['game_average.boost.bpm', 'cumulative.boost.bpm'], ''),
    avg_boost_amount_per_game: getFirstValue(player, ['game_average.boost.avg_amount', 'cumulative.boost.avg_amount'], ''),
    amount_collected: getFirstValue(player, ['cumulative.boost.amount_collected'], ''),
    amount_collected_per_game: getFirstValue(player, ['game_average.boost.amount_collected'], ''),
    amount_collected_big_pads: getFirstValue(player, ['cumulative.boost.amount_collected_big'], ''),
    amount_collected_big_pads_per_game: getFirstValue(player, ['game_average.boost.amount_collected_big'], ''),
    amount_collected_small_pads: getFirstValue(player, ['cumulative.boost.amount_collected_small'], ''),
    amount_collected_small_pads_per_game: getFirstValue(player, ['game_average.boost.amount_collected_small'], ''),
    count_collected_big_pads: getFirstValue(player, ['cumulative.boost.count_collected_big'], ''),
    count_collected_big_pads_per_game: getFirstValue(player, ['game_average.boost.count_collected_big'], ''),
    count_collected_small_pads: getFirstValue(player, ['cumulative.boost.count_collected_small'], ''),
    count_collected_small_pads_per_game: getFirstValue(player, ['game_average.boost.count_collected_small'], ''),
    amount_stolen: getFirstValue(player, ['cumulative.boost.amount_stolen'], ''),
    amount_stolen_per_game: getFirstValue(player, ['game_average.boost.amount_stolen'], ''),
    amount_stolen_big_pads: getFirstValue(player, ['cumulative.boost.amount_stolen_big'], ''),
    amount_stolen_big_pads_per_game: getFirstValue(player, ['game_average.boost.amount_stolen_big'], ''),
    amount_stolen_small_pads: getFirstValue(player, ['cumulative.boost.amount_stolen_small'], ''),
    amount_stolen_small_pads_per_game: getFirstValue(player, ['game_average.boost.amount_stolen_small'], ''),
    count_stolen_big_pads: getFirstValue(player, ['cumulative.boost.count_stolen_big'], ''),
    count_stolen_big_pads_per_game: getFirstValue(player, ['game_average.boost.count_stolen_big'], ''),
    count_stolen_small_pads: getFirstValue(player, ['cumulative.boost.count_stolen_small'], ''),
    count_stolen_small_pads_per_game: getFirstValue(player, ['game_average.boost.count_stolen_small'], ''),
    '0_boost_time': getFirstValue(player, ['cumulative.boost.time_zero_boost'], ''),
    '0_boost_time_per_game': getFirstValue(player, ['game_average.boost.time_zero_boost'], ''),
    '100_boost_time': getFirstValue(player, ['cumulative.boost.time_full_boost'], ''),
    '100_boost_time_per_game': getFirstValue(player, ['game_average.boost.time_full_boost'], ''),
    amount_used_while_supersonic: getFirstValue(player, ['cumulative.boost.amount_used_while_supersonic'], ''),
    amount_used_while_supersonic_per_game: getFirstValue(player, ['game_average.boost.amount_used_while_supersonic'], ''),
    amount_overfill_total: getFirstValue(player, ['cumulative.boost.amount_overfill'], ''),
    amount_overfill_total_per_game: getFirstValue(player, ['game_average.boost.amount_overfill'], ''),
    amount_overfill_stolen: getFirstValue(player, ['cumulative.boost.amount_overfill_stolen'], ''),
    amount_overfill_stolen_per_game: getFirstValue(player, ['game_average.boost.amount_overfill_stolen'], ''),
    avg_speed_per_game: getFirstValue(player, ['game_average.movement.avg_speed', 'cumulative.movement.avg_speed'], ''),
    total_distance: getFirstValue(player, ['cumulative.movement.total_distance'], ''),
    total_distance_per_game: getFirstValue(player, ['game_average.movement.total_distance'], ''),
    time_slow_speed: getFirstValue(player, ['cumulative.movement.time_slow_speed'], ''),
    time_slow_speed_per_game: getFirstValue(player, ['game_average.movement.time_slow_speed'], ''),
    time_boost_speed: getFirstValue(player, ['cumulative.movement.time_boost_speed'], ''),
    time_boost_speed_per_game: getFirstValue(player, ['game_average.movement.time_boost_speed'], ''),
    time_supersonic_speed: getFirstValue(player, ['cumulative.movement.time_supersonic_speed'], ''),
    time_supersonic_speed_per_game: getFirstValue(player, ['game_average.movement.time_supersonic_speed'], ''),
    time_on_ground: getFirstValue(player, ['cumulative.movement.time_ground'], ''),
    time_on_ground_per_game: getFirstValue(player, ['game_average.movement.time_ground'], ''),
    time_low_in_air: getFirstValue(player, ['cumulative.movement.time_low_air'], ''),
    time_low_in_air_per_game: getFirstValue(player, ['game_average.movement.time_low_air'], ''),
    time_high_in_air: getFirstValue(player, ['cumulative.movement.time_high_air'], ''),
    time_high_in_air_per_game: getFirstValue(player, ['game_average.movement.time_high_air'], ''),
    time_powerslide: getFirstValue(player, ['cumulative.movement.time_powerslide'], ''),
    time_powerslide_per_game: getFirstValue(player, ['game_average.movement.time_powerslide'], ''),
    avg_powerslide_time_per_game: getFirstValue(player, ['game_average.movement.avg_powerslide_duration', 'cumulative.movement.avg_powerslide_duration'], ''),
    count_powerslide: getFirstValue(player, ['cumulative.movement.count_powerslide'], ''),
    count_powerslide_per_game: getFirstValue(player, ['game_average.movement.count_powerslide'], ''),
    time_most_back: getFirstValue(player, ['cumulative.positioning.time_most_back'], ''),
    time_most_back_per_game: getFirstValue(player, ['game_average.positioning.time_most_back'], ''),
    time_most_forward: getFirstValue(player, ['cumulative.positioning.time_most_forward'], ''),
    time_most_forward_per_game: getFirstValue(player, ['game_average.positioning.time_most_forward'], ''),
    time_in_front_of_ball: getFirstValue(player, ['cumulative.positioning.time_infront_ball', 'cumulative.positioning.time_in_front_ball'], ''),
    time_in_front_of_ball_per_game: getFirstValue(player, ['game_average.positioning.time_infront_ball', 'game_average.positioning.time_in_front_ball'], ''),
    time_behind_ball: getFirstValue(player, ['cumulative.positioning.time_behind_ball'], ''),
    time_behind_ball_per_game: getFirstValue(player, ['game_average.positioning.time_behind_ball'], ''),
    time_defensive_half: getFirstValue(player, ['cumulative.positioning.time_defensive_half'], ''),
    time_defensive_half_per_game: getFirstValue(player, ['game_average.positioning.time_defensive_half'], ''),
    time_offensive_half: getFirstValue(player, ['cumulative.positioning.time_offensive_half'], ''),
    time_offensive_half_per_game: getFirstValue(player, ['game_average.positioning.time_offensive_half'], ''),
    time_defensive_third: getFirstValue(player, ['cumulative.positioning.time_defensive_third'], ''),
    time_defensive_third_per_game: getFirstValue(player, ['game_average.positioning.time_defensive_third'], ''),
    time_neutral_third: getFirstValue(player, ['cumulative.positioning.time_neutral_third'], ''),
    time_neutral_third_per_game: getFirstValue(player, ['game_average.positioning.time_neutral_third'], ''),
    time_offensive_third: getFirstValue(player, ['cumulative.positioning.time_offensive_third'], ''),
    time_offensive_third_per_game: getFirstValue(player, ['game_average.positioning.time_offensive_third'], ''),
    avg_distance_to_ball_per_game: getFirstValue(player, ['game_average.positioning.avg_distance_to_ball', 'cumulative.positioning.avg_distance_to_ball'], ''),
    avg_distance_to_ball_has_possession_per_game: getFirstValue(
      player,
      [
        'game_average.positioning.avg_distance_to_ball_possession',
        'game_average.positioning.avg_distance_to_ball_has_possession',
        'cumulative.positioning.avg_distance_to_ball_possession',
        'cumulative.positioning.avg_distance_to_ball_has_possession',
      ],
      ''
    ),
    avg_distance_to_ball_no_possession_per_game: getFirstValue(
      player,
      [
        'game_average.positioning.avg_distance_to_ball_no_possession',
        'game_average.positioning.avg_distance_to_ball_without_possession',
        'cumulative.positioning.avg_distance_to_ball_no_possession',
        'cumulative.positioning.avg_distance_to_ball_without_possession',
      ],
      ''
    ),
    avg_distance_to_team_mates_per_game: getFirstValue(
      player,
      [
        'game_average.positioning.avg_distance_to_mates',
        'game_average.positioning.avg_distance_to_teammates',
        'cumulative.positioning.avg_distance_to_mates',
        'cumulative.positioning.avg_distance_to_teammates',
      ],
      ''
    ),
    demos_inflicted: getFirstValue(player, ['cumulative.demo.inflicted'], ''),
    demos_inflicted_per_game: getFirstValue(player, ['game_average.demo.inflicted'], ''),
    demos_taken: getFirstValue(player, ['cumulative.demo.taken'], ''),
    demos_taken_per_game: getFirstValue(player, ['game_average.demo.taken'], ''),
  };
}

function normalizeStatsValue(value) {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return value;
    }
    return roundNumber(value, 2);
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return value ?? '';
}

function buildBallchasingPlayerRows(match, groupData) {
  const players = Array.isArray(groupData?.players) ? groupData.players : [];
  return players.map((player) => {
    const row = buildPlayerRow(match, player);
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key] = normalizeStatsValue(value);
    }
    return normalized;
  });
}

function computePerGame(total, games) {
  const t = Number(total);
  const g = Number(games);
  if (!Number.isFinite(t) || !Number.isFinite(g) || g <= 0) {
    return '';
  }
  return t / g;
}

function buildTeamRowFromTeamStats(teamName, teamStats) {
  const cumulative = teamStats?.cumulative || {};
  const gameAverage = teamStats?.game_average || {};
  const games = Number(cumulative.games || 0);
  const wins = Number(cumulative.wins || 0);
  const losses = games > 0 ? games - wins : '';
  const seriesWin = wins >= 3 ? 1 : 0;
  const seriesLoss = seriesWin === 1 ? 0 : 1;

  const row = {
    team_name: teamName || '',
    games: games || '',
    wins: Number.isFinite(wins) ? wins : '',
    series_win: seriesWin,
    score: getFirstValue(teamStats, ['cumulative.core.score'], ''),
    score_per_game: getFirstValue(teamStats, ['game_average.core.score'], computePerGame(getFirstValue(teamStats, ['cumulative.core.score'], 0), games)),
    goals: getFirstValue(teamStats, ['cumulative.core.goals'], ''),
    goals_per_game: getFirstValue(teamStats, ['game_average.core.goals'], computePerGame(getFirstValue(teamStats, ['cumulative.core.goals'], 0), games)),
    assists: getFirstValue(teamStats, ['cumulative.core.assists'], ''),
    assists_per_game: getFirstValue(teamStats, ['game_average.core.assists'], computePerGame(getFirstValue(teamStats, ['cumulative.core.assists'], 0), games)),
    saves: getFirstValue(teamStats, ['cumulative.core.saves'], ''),
    saves_per_game: getFirstValue(teamStats, ['game_average.core.saves'], computePerGame(getFirstValue(teamStats, ['cumulative.core.saves'], 0), games)),
    shots: getFirstValue(teamStats, ['cumulative.core.shots'], ''),
    shots_per_game: getFirstValue(teamStats, ['game_average.core.shots'], computePerGame(getFirstValue(teamStats, ['cumulative.core.shots'], 0), games)),
    losses,
    series_loss: seriesLoss,
    goals_conceded: getFirstValue(teamStats, ['cumulative.core.goals_against'], ''),
    goals_conceded_per_game: getFirstValue(teamStats, ['game_average.core.goals_against'], computePerGame(getFirstValue(teamStats, ['cumulative.core.goals_against'], 0), games)),
    shooting_percentage: getFirstValue(teamStats, ['cumulative.core.shooting_percentage'], ''),
    bpm_per_game: getFirstValue(teamStats, ['game_average.boost.bpm', 'cumulative.boost.bpm'], ''),
    avg_boost_amount_per_game: getFirstValue(teamStats, ['game_average.boost.avg_amount', 'cumulative.boost.avg_amount'], ''),
    amount_collected: getFirstValue(teamStats, ['cumulative.boost.amount_collected'], ''),
    amount_collected_per_game: getFirstValue(teamStats, ['game_average.boost.amount_collected'], ''),
    amount_collected_big_pads: getFirstValue(teamStats, ['cumulative.boost.amount_collected_big'], ''),
    amount_collected_big_pads_per_game: getFirstValue(teamStats, ['game_average.boost.amount_collected_big'], ''),
    amount_collected_small_pads: getFirstValue(teamStats, ['cumulative.boost.amount_collected_small'], ''),
    amount_collected_small_pads_per_game: getFirstValue(teamStats, ['game_average.boost.amount_collected_small'], ''),
    count_collected_big_pads: getFirstValue(teamStats, ['cumulative.boost.count_collected_big'], ''),
    count_collected_big_pads_per_game: getFirstValue(teamStats, ['game_average.boost.count_collected_big'], ''),
    count_collected_small_pads: getFirstValue(teamStats, ['cumulative.boost.count_collected_small'], ''),
    count_collected_small_pads_per_game: getFirstValue(teamStats, ['game_average.boost.count_collected_small'], ''),
    amount_stolen: getFirstValue(teamStats, ['cumulative.boost.amount_stolen'], ''),
    amount_stolen_per_game: getFirstValue(teamStats, ['game_average.boost.amount_stolen'], ''),
    amount_stolen_big_pads: getFirstValue(teamStats, ['cumulative.boost.amount_stolen_big'], ''),
    amount_stolen_big_pads_per_game: getFirstValue(teamStats, ['game_average.boost.amount_stolen_big'], ''),
    amount_stolen_small_pads: getFirstValue(teamStats, ['cumulative.boost.amount_stolen_small'], ''),
    amount_stolen_small_pads_per_game: getFirstValue(teamStats, ['game_average.boost.amount_stolen_small'], ''),
    count_stolen_big_pads: getFirstValue(teamStats, ['cumulative.boost.count_stolen_big'], ''),
    count_stolen_big_pads_per_game: getFirstValue(teamStats, ['game_average.boost.count_stolen_big'], ''),
    count_stolen_small_pads: getFirstValue(teamStats, ['cumulative.boost.count_stolen_small'], ''),
    count_stolen_small_pads_per_game: getFirstValue(teamStats, ['game_average.boost.count_stolen_small'], ''),
    '0_boost_time': getFirstValue(teamStats, ['cumulative.boost.time_zero_boost'], ''),
    '0_boost_time_per_game': getFirstValue(teamStats, ['game_average.boost.time_zero_boost'], ''),
    '100_boost_time': getFirstValue(teamStats, ['cumulative.boost.time_full_boost'], ''),
    '100_boost_time_per_game': getFirstValue(teamStats, ['game_average.boost.time_full_boost'], ''),
    amount_used_while_supersonic: getFirstValue(teamStats, ['cumulative.boost.amount_used_while_supersonic'], ''),
    amount_used_while_supersonic_per_game: getFirstValue(teamStats, ['game_average.boost.amount_used_while_supersonic'], ''),
    amount_overfill_total: getFirstValue(teamStats, ['cumulative.boost.amount_overfill'], ''),
    amount_overfill_total_per_game: getFirstValue(teamStats, ['game_average.boost.amount_overfill'], ''),
    amount_overfill_stolen: getFirstValue(teamStats, ['cumulative.boost.amount_overfill_stolen'], ''),
    amount_overfill_stolen_per_game: getFirstValue(teamStats, ['game_average.boost.amount_overfill_stolen'], ''),
    total_distance: getFirstValue(teamStats, ['cumulative.movement.total_distance'], ''),
    total_distance_per_game: getFirstValue(teamStats, ['game_average.movement.total_distance'], ''),
    time_slow_speed: getFirstValue(teamStats, ['cumulative.movement.time_slow_speed'], ''),
    time_slow_speed_per_game: getFirstValue(teamStats, ['game_average.movement.time_slow_speed'], ''),
    time_boost_speed: getFirstValue(teamStats, ['cumulative.movement.time_boost_speed'], ''),
    time_boost_speed_per_game: getFirstValue(teamStats, ['game_average.movement.time_boost_speed'], ''),
    time_supersonic_speed: getFirstValue(teamStats, ['cumulative.movement.time_supersonic_speed'], ''),
    time_supersonic_speed_per_game: getFirstValue(teamStats, ['game_average.movement.time_supersonic_speed'], ''),
    time_on_ground: getFirstValue(teamStats, ['cumulative.movement.time_ground'], ''),
    time_on_ground_per_game: getFirstValue(teamStats, ['game_average.movement.time_ground'], ''),
    time_low_in_air: getFirstValue(teamStats, ['cumulative.movement.time_low_air'], ''),
    time_low_in_air_per_game: getFirstValue(teamStats, ['game_average.movement.time_low_air'], ''),
    time_high_in_air: getFirstValue(teamStats, ['cumulative.movement.time_high_air'], ''),
    time_high_in_air_per_game: getFirstValue(teamStats, ['game_average.movement.time_high_air'], ''),
    time_powerslide: getFirstValue(teamStats, ['cumulative.movement.time_powerslide'], ''),
    time_powerslide_per_game: getFirstValue(teamStats, ['game_average.movement.time_powerslide'], ''),
    avg_powerslide_time_per_game: 0,
    count_powerslide: getFirstValue(teamStats, ['cumulative.movement.count_powerslide'], ''),
    count_powerslide_per_game: getFirstValue(teamStats, ['game_average.movement.count_powerslide'], ''),
    time_behind_ball: getFirstValue(teamStats, ['cumulative.positioning.time_behind_ball'], ''),
    time_behind_ball_per_game: getFirstValue(teamStats, ['game_average.positioning.time_behind_ball'], ''),
    time_in_front_of_ball: getFirstValue(teamStats, ['cumulative.positioning.time_infront_ball', 'cumulative.positioning.time_in_front_ball'], ''),
    time_in_front_of_ball_per_game: getFirstValue(teamStats, ['game_average.positioning.time_infront_ball', 'game_average.positioning.time_in_front_ball'], ''),
    time_defensive_half: getFirstValue(teamStats, ['cumulative.positioning.time_defensive_half'], ''),
    time_defensive_half_per_game: getFirstValue(teamStats, ['game_average.positioning.time_defensive_half'], ''),
    time_offensive_half: getFirstValue(teamStats, ['cumulative.positioning.time_offensive_half'], ''),
    time_offensive_half_per_game: getFirstValue(teamStats, ['game_average.positioning.time_offensive_half'], ''),
    time_defensive_third: getFirstValue(teamStats, ['cumulative.positioning.time_defensive_third'], ''),
    time_defensive_third_per_game: getFirstValue(teamStats, ['game_average.positioning.time_defensive_third'], ''),
    time_neutral_third: getFirstValue(teamStats, ['cumulative.positioning.time_neutral_third'], ''),
    time_neutral_third_per_game: getFirstValue(teamStats, ['game_average.positioning.time_neutral_third'], ''),
    time_offensive_third: getFirstValue(teamStats, ['cumulative.positioning.time_offensive_third'], ''),
    time_offensive_third_per_game: getFirstValue(teamStats, ['game_average.positioning.time_offensive_third'], ''),
    avg_distance_to_ball_per_game: getFirstValue(teamStats, ['game_average.positioning.avg_distance_to_ball', 'cumulative.positioning.avg_distance_to_ball'], ''),
    avg_distance_to_ball_has_possession_per_game: getFirstValue(
      teamStats,
      [
        'game_average.positioning.avg_distance_to_ball_possession',
        'game_average.positioning.avg_distance_to_ball_has_possession',
        'cumulative.positioning.avg_distance_to_ball_possession',
        'cumulative.positioning.avg_distance_to_ball_has_possession',
      ],
      ''
    ),
    avg_distance_to_ball_no_possession_per_game: getFirstValue(
      teamStats,
      [
        'game_average.positioning.avg_distance_to_ball_no_possession',
        'game_average.positioning.avg_distance_to_ball_without_possession',
        'cumulative.positioning.avg_distance_to_ball_no_possession',
        'cumulative.positioning.avg_distance_to_ball_without_possession',
      ],
      ''
    ),
    avg_distance_to_team_mates_per_game: getFirstValue(
      teamStats,
      [
        'game_average.positioning.avg_distance_to_mates',
        'game_average.positioning.avg_distance_to_teammates',
        'cumulative.positioning.avg_distance_to_mates',
        'cumulative.positioning.avg_distance_to_teammates',
      ],
      ''
    ),
    demos_inflicted: getFirstValue(teamStats, ['cumulative.demo.inflicted'], ''),
    demos_inflicted_per_game: getFirstValue(teamStats, ['game_average.demo.inflicted'], ''),
    demos_taken: getFirstValue(teamStats, ['cumulative.demo.taken'], ''),
    demos_taken_per_game: getFirstValue(teamStats, ['game_average.demo.taken'], ''),
  };

  return row;
}

function buildFallbackTeamRows(playerRows) {
  const byTeam = new Map();
  for (const row of playerRows) {
    const team = String(row.team_name || '').trim();
    if (!team) {
      continue;
    }
    if (!byTeam.has(team)) {
      byTeam.set(team, []);
    }
    byTeam.get(team).push(row);
  }

  const rows = [];
  for (const [teamName, teamPlayers] of byTeam.entries()) {
    const games = Math.max(...teamPlayers.map((r) => Number(r.games || 0)), 0);
    const wins = Math.max(...teamPlayers.map((r) => Number(r.wins || 0)), 0);
    const sum = (key) => teamPlayers.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
    const max = (key) => Math.max(...teamPlayers.map((r) => Number(r[key] || 0)), 0);
    const losses = games > 0 ? games - wins : '';
    const seriesWin = wins >= 3 ? 1 : 0;
    const seriesLoss = seriesWin === 1 ? 0 : 1;
    const goals = sum('goals');
    const shots = sum('shots');
    const goalsConceded = max('goals_conceded');

    rows.push({
      team_name: teamName,
      games,
      wins,
      series_win: seriesWin,
      score: sum('score'),
      score_per_game: computePerGame(sum('score'), games),
      goals,
      goals_per_game: computePerGame(goals, games),
      assists: sum('assists'),
      assists_per_game: computePerGame(sum('assists'), games),
      saves: sum('saves'),
      saves_per_game: computePerGame(sum('saves'), games),
      shots,
      shots_per_game: computePerGame(shots, games),
      losses,
      series_loss: seriesLoss,
      goals_conceded: goalsConceded,
      goals_conceded_per_game: computePerGame(goalsConceded, games),
      shooting_percentage: shots > 0 ? (goals / shots) * 100 : '',
      bpm_per_game: sum('bpm_per_game'),
      avg_boost_amount_per_game: sum('avg_boost_amount_per_game'),
      amount_collected: sum('amount_collected'),
      amount_collected_per_game: computePerGame(sum('amount_collected'), games),
      amount_collected_big_pads: sum('amount_collected_big_pads'),
      amount_collected_big_pads_per_game: computePerGame(sum('amount_collected_big_pads'), games),
      amount_collected_small_pads: sum('amount_collected_small_pads'),
      amount_collected_small_pads_per_game: computePerGame(sum('amount_collected_small_pads'), games),
      count_collected_big_pads: sum('count_collected_big_pads'),
      count_collected_big_pads_per_game: computePerGame(sum('count_collected_big_pads'), games),
      count_collected_small_pads: sum('count_collected_small_pads'),
      count_collected_small_pads_per_game: computePerGame(sum('count_collected_small_pads'), games),
      amount_stolen: sum('amount_stolen'),
      amount_stolen_per_game: computePerGame(sum('amount_stolen'), games),
      amount_stolen_big_pads: sum('amount_stolen_big_pads'),
      amount_stolen_big_pads_per_game: computePerGame(sum('amount_stolen_big_pads'), games),
      amount_stolen_small_pads: sum('amount_stolen_small_pads'),
      amount_stolen_small_pads_per_game: computePerGame(sum('amount_stolen_small_pads'), games),
      count_stolen_big_pads: sum('count_stolen_big_pads'),
      count_stolen_big_pads_per_game: computePerGame(sum('count_stolen_big_pads'), games),
      count_stolen_small_pads: sum('count_stolen_small_pads'),
      count_stolen_small_pads_per_game: computePerGame(sum('count_stolen_small_pads'), games),
      '0_boost_time': sum('0_boost_time'),
      '0_boost_time_per_game': computePerGame(sum('0_boost_time'), games),
      '100_boost_time': sum('100_boost_time'),
      '100_boost_time_per_game': computePerGame(sum('100_boost_time'), games),
      amount_used_while_supersonic: sum('amount_used_while_supersonic'),
      amount_used_while_supersonic_per_game: computePerGame(sum('amount_used_while_supersonic'), games),
      amount_overfill_total: sum('amount_overfill_total'),
      amount_overfill_total_per_game: computePerGame(sum('amount_overfill_total'), games),
      amount_overfill_stolen: sum('amount_overfill_stolen'),
      amount_overfill_stolen_per_game: computePerGame(sum('amount_overfill_stolen'), games),
      total_distance: sum('total_distance'),
      total_distance_per_game: computePerGame(sum('total_distance'), games),
      time_slow_speed: sum('time_slow_speed'),
      time_slow_speed_per_game: computePerGame(sum('time_slow_speed'), games),
      time_boost_speed: sum('time_boost_speed'),
      time_boost_speed_per_game: computePerGame(sum('time_boost_speed'), games),
      time_supersonic_speed: sum('time_supersonic_speed'),
      time_supersonic_speed_per_game: computePerGame(sum('time_supersonic_speed'), games),
      time_on_ground: sum('time_on_ground'),
      time_on_ground_per_game: computePerGame(sum('time_on_ground'), games),
      time_low_in_air: sum('time_low_in_air'),
      time_low_in_air_per_game: computePerGame(sum('time_low_in_air'), games),
      time_high_in_air: sum('time_high_in_air'),
      time_high_in_air_per_game: computePerGame(sum('time_high_in_air'), games),
      time_powerslide: sum('time_powerslide'),
      time_powerslide_per_game: computePerGame(sum('time_powerslide'), games),
      avg_powerslide_time_per_game: computePerGame(sum('time_powerslide_per_game'), Math.max(sum('count_powerslide_per_game'), 1)),
      count_powerslide: sum('count_powerslide'),
      count_powerslide_per_game: computePerGame(sum('count_powerslide'), games),
      time_behind_ball: sum('time_behind_ball'),
      time_behind_ball_per_game: computePerGame(sum('time_behind_ball'), games),
      time_in_front_of_ball: sum('time_in_front_of_ball'),
      time_in_front_of_ball_per_game: computePerGame(sum('time_in_front_of_ball'), games),
      time_defensive_half: sum('time_defensive_half'),
      time_defensive_half_per_game: computePerGame(sum('time_defensive_half'), games),
      time_offensive_half: sum('time_offensive_half'),
      time_offensive_half_per_game: computePerGame(sum('time_offensive_half'), games),
      time_defensive_third: sum('time_defensive_third'),
      time_defensive_third_per_game: computePerGame(sum('time_defensive_third'), games),
      time_neutral_third: sum('time_neutral_third'),
      time_neutral_third_per_game: computePerGame(sum('time_neutral_third'), games),
      time_offensive_third: sum('time_offensive_third'),
      time_offensive_third_per_game: computePerGame(sum('time_offensive_third'), games),
      avg_distance_to_ball_per_game: sum('avg_distance_to_ball_per_game'),
      avg_distance_to_ball_has_possession_per_game: sum('avg_distance_to_ball_has_possession_per_game'),
      avg_distance_to_ball_no_possession_per_game: sum('avg_distance_to_ball_no_possession_per_game'),
      demos_inflicted: sum('demos_inflicted'),
      demos_inflicted_per_game: computePerGame(sum('demos_inflicted'), games),
      demos_taken: sum('demos_taken'),
      demos_taken_per_game: computePerGame(sum('demos_taken'), games),
    });
  }

  return rows;
}

function buildBallchasingTeamRows(groupData, playerRows) {
  const teams = Array.isArray(groupData?.teams) ? groupData.teams : [];
  if (teams.length > 0) {
    return teams.map((team) => {
      const row = buildTeamRowFromTeamStats(team?.name || team?.team || '', team);
      if (row.avg_distance_to_team_mates_per_game === '' || row.avg_distance_to_team_mates_per_game === undefined) {
        const teamName = String(row.team_name || '').trim().toLowerCase();
        const teammatesDistance = playerRows
          .filter((player) => String(player.team_name || '').trim().toLowerCase() === teamName)
          .reduce((acc, player) => acc + (Number(player.avg_distance_to_team_mates_per_game) || 0), 0);
        if (teammatesDistance > 0) {
          row.avg_distance_to_team_mates_per_game = teammatesDistance;
        }
      }
      const normalized = {};
      for (const [key, value] of Object.entries(row)) {
        normalized[key] = normalizeStatsValue(value);
      }
      return normalized;
    });
  }

  return buildFallbackTeamRows(playerRows).map((row) => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key] = normalizeStatsValue(value);
    }
    return normalized;
  });
}

module.exports = {
  extractGroupIdFromUrl,
  fetchBallchasingGroup,
  buildBallchasingPlayerRows,
  buildBallchasingTeamRows,
};
