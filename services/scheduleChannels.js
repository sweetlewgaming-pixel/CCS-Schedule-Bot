const { ChannelType } = require('discord.js');

const { getMatchesByWeek } = require('./googleSheets');
const { slugifyTeamName } = require('../utils/slugify');
const { getRoleIdByTeamName } = require('../utils/teamRoles');

const CATEGORY_NAMES = {
  CCS: 'CCS SCHEDULING',
  CPL: 'CPL SCHEDULING',
  CAS: 'CAS Scheduling',
  CNL: 'CNL Scheduling',
};
const PROTECTED_CHANNEL_NAMES_BY_LEAGUE = {
  CCS: ['general'],
  CPL: [],
  CAS: [],
  CNL: [],
};

const CHANNEL_ORIENTATION = 'AWAY_AT_HOME';
const SEND_CHANNEL_BOOT_MESSAGE = true;
const DELETE_DELAY_MS = 500;
const CREATE_DELAY_MS = 500;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAvailabilityCommandMention(guild) {
  try {
    if (guild?.commands?.fetch) {
      const guildCommands = await guild.commands.fetch();
      const guildCommand = guildCommands.find((command) => command.name === 'availability');
      if (guildCommand) {
        return `</availability:${guildCommand.id}>`;
      }
    }

    if (guild?.client?.application?.commands?.fetch) {
      const globalCommands = await guild.client.application.commands.fetch();
      const globalCommand = globalCommands.find((command) => command.name === 'availability');
      if (globalCommand) {
        return `</availability:${globalCommand.id}>`;
      }
    }
  } catch (error) {
    // Fall back to plain command text if command mention lookup fails.
  }

  return '`/availability`';
}

function buildChannelName(match) {
  const teamA = CHANNEL_ORIENTATION === 'AWAY_AT_HOME' ? match.awayTeam : match.homeTeam;
  const teamB = CHANNEL_ORIENTATION === 'AWAY_AT_HOME' ? match.homeTeam : match.awayTeam;

  const left = slugifyTeamName(teamA);
  const right = slugifyTeamName(teamB);

  return `${left}-at-${right}`.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function buildMatchupTeams(match) {
  if (CHANNEL_ORIENTATION === 'AWAY_AT_HOME') {
    return {
      teamA: match.awayTeam,
      teamB: match.homeTeam,
    };
  }

  return {
    teamA: match.homeTeam,
    teamB: match.awayTeam,
  };
}

function makeUniqueNames(baseNames) {
  const seen = new Map();
  return baseNames.map((base) => {
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  });
}

async function findCategory(guild, league) {
  const categoryName = CATEGORY_NAMES[league];
  if (!categoryName) {
    throw new Error(`Unsupported league: ${league}`);
  }

  await guild.channels.fetch();
  const targetName = categoryName.trim().toLowerCase();
  const category = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory &&
      String(channel.name || '')
        .trim()
        .toLowerCase() === targetName
  );

  if (!category) {
    throw new Error(`Category not found: ${categoryName}`);
  }

  return category;
}

async function buildRebuildPlan(guild, league, week) {
  const matches = await getMatchesByWeek(league, String(week));
  const category = await findCategory(guild, league);

  const channelSpecs = matches
    .map((match) => {
      const { teamA, teamB } = buildMatchupTeams(match);
      return {
        name: buildChannelName(match),
        teamA,
        teamB,
      };
    })
    .filter((spec) => spec.name);
  const uniqueNames = makeUniqueNames(channelSpecs.map((spec) => spec.name));
  uniqueNames.forEach((name, idx) => {
    channelSpecs[idx].name = name;
  });

  await guild.channels.fetch();
  const protectedNames = new Set((PROTECTED_CHANNEL_NAMES_BY_LEAGUE[league] || []).map((name) => name.toLowerCase()));
  const existingTextChannels = guild.channels.cache
    .filter(
      (channel) =>
        channel.parentId === category.id &&
        channel.type === ChannelType.GuildText &&
        !protectedNames.has(channel.name.toLowerCase())
    )
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((channel) => channel);

  return {
    league,
    week,
    category,
    channelSpecs,
    existingTextChannels,
  };
}

async function applyRebuildPlan(guild, plan) {
  const { league, week, category, channelSpecs, existingTextChannels } = plan;

  let deletedCount = 0;
  for (const channel of existingTextChannels) {
    await channel.delete(`Rebuilding ${league} week ${week} scheduling channels`);
    deletedCount += 1;
    await wait(DELETE_DELAY_MS);
  }

  const createdNames = [];
  for (const spec of channelSpecs) {
    const created = await guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildText,
      parent: category.id,
    });

    createdNames.push(created.name);

    if (SEND_CHANNEL_BOOT_MESSAGE) {
      const roleAId = await getRoleIdByTeamName(guild, spec.teamA);
      const roleBId = await getRoleIdByTeamName(guild, spec.teamB);
      const mentionA = roleAId ? `<@&${roleAId}>` : `@${spec.teamA}`;
      const mentionB = roleBId ? `<@&${roleBId}>` : `@${spec.teamB}`;
      const availabilityCommandMention = await getAvailabilityCommandMention(guild);

      await created.send(
        `${mentionA} ${mentionB}\n\nPlease put your schedule in this format for this week:\n\nTues: Time-Time\nWed: Time-Time\nThurs: Time-Time\nFri: Time-Time\nSat: Time-Time\nSun: Time-Time\n\nALL IN EST PLEASE\n\n**Please use ${availabilityCommandMention} to make your schedule. This massively helps out the admin team and would be greatly appreciated!**`
      );
    }

    await wait(CREATE_DELAY_MS);
  }

  return {
    deletedCount,
    createdCount: createdNames.length,
    createdNames,
    categoryName: category.name,
  };
}

async function rebuildWeekChannels(guild, league, week) {
  const plan = await buildRebuildPlan(guild, league, week);
  return applyRebuildPlan(guild, plan);
}

async function rebuildWeekChannelsForLeagues(guild, leagues, week) {
  const plans = [];
  const skipped = [];
  for (const league of leagues) {
    try {
      plans.push(await buildRebuildPlan(guild, league, week));
    } catch (error) {
      skipped.push({ league, reason: error.message });
    }
  }

  if (plans.length === 0) {
    const reasons = skipped.map((s) => `${s.league}: ${s.reason}`).join(' | ');
    throw new Error(`No leagues could be rebuilt. ${reasons}`);
  }

  const results = [];
  for (const plan of plans) {
    const result = await applyRebuildPlan(guild, plan);
    results.push({ league: plan.league, ...result });
  }

  return {
    results,
    skipped,
  };
}

module.exports = {
  CATEGORY_NAMES,
  rebuildWeekChannels,
  rebuildWeekChannelsForLeagues,
};
