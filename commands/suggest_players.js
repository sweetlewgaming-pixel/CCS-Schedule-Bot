const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const { isAdminAuthorized, normalizeRoleName } = require('../utils/permissions');
const { slugifyTeamName } = require('../utils/slugify');
const {
  DAY_KEYS,
  parseSchedulesFromText: sharedParseSchedulesFromText,
  isScheduleTemplateMessage: sharedIsScheduleTemplateMessage,
} = require('../utils/scheduleParser');

const DAY_LABELS = {
  tues: 'Tuesday',
  wed: 'Wednesday',
  thurs: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_TEAM_SELECT = 4;
const MAX_MENU_OPTIONS = 25;
const sessions = new Map();

function cleanChannelName(name) {
  return String(name || '').replace(/[\u2705]+$/u, '').replace(/confirmed$/i, '').trim();
}

function parseMatchupSlugsFromChannel(channelName) {
  const cleaned = cleanChannelName(channelName);
  const parts = cleaned.split('-at-');
  if (parts.length !== 2) {
    return null;
  }

  const left = parts[0].trim();
  const right = parts[1].trim();
  if (!left || !right) {
    return null;
  }

  return { leftSlug: left, rightSlug: right };
}

async function resolveRoleBySlug(guild, teamSlug) {
  if (!guild || !teamSlug) {
    return null;
  }

  if (!guild.roles.cache.size) {
    await guild.roles.fetch();
  }

  const targetSlug = slugifyTeamName(teamSlug);
  let bestRole = null;
  let bestScore = 0;

  for (const role of guild.roles.cache.values()) {
    const roleSlug = slugifyTeamName(role.name);
    let score = 0;
    if (roleSlug === targetSlug) {
      score = 1000;
    } else if (roleSlug.endsWith(`-${targetSlug}`) || roleSlug.startsWith(`${targetSlug}-`)) {
      score = 900;
    } else if (roleSlug.includes(targetSlug)) {
      score = 600;
    }

    if (score > bestScore) {
      bestScore = score;
      bestRole = role;
    }
  }

  return bestScore >= 600 ? bestRole : null;
}

function parseTimePart(part) {
  const text = String(part || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/\b(?:e|c|m|p)(?:s|d)?t\b/gi, '')
    .replace(/\b(?:eastern|central|mountain|pacific)\b/gi, '')
    .trim();
  const match = text.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/i);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] || '0');
  const meridiem = match[3];
  if (hour < 1 || hour > 12) {
    return null;
  }

  if (!meridiem) {
    if (hour !== 12) {
      hour += 12;
    }
  } else if (meridiem.toLowerCase() === 'am') {
    if (hour === 12) {
      hour = 0;
    }
  } else if (meridiem.toLowerCase() === 'pm') {
    if (hour !== 12) {
      hour += 12;
    }
  }

  return hour * 60 + minute;
}

function parseRange(value) {
  const cleaned = String(value || '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+to\s+/gi, '-')
    .replace(/@/g, '')
    .trim();
  const parts = cleaned.split('-').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }

  const start = parseTimePart(parts[0]);
  const end = parseTimePart(parts[1]);
  if (start === null || end === null) {
    return null;
  }

  const adjustedEnd = end <= start ? 24 * 60 : end;
  if (adjustedEnd <= start) {
    return null;
  }

  return { start, end: adjustedEnd };
}

function parseProposedTimeWindowsFromMessage(content) {
  const text = String(content || '');
  const dayMatch = text.match(/\*\*Day:\*\*\s*([^\n\r]+)/i);
  const timeMatch = text.match(/\*\*Time:\*\*\s*([^\n\r]+)/i);
  if (!dayMatch || !timeMatch) {
    return [];
  }

  const dayTokenRaw = String(dayMatch[1] || '').trim().toLowerCase();
  const dayToken = dayTokenRaw.startsWith('tue')
    ? 'tues'
    : dayTokenRaw.startsWith('wed')
      ? 'wed'
      : dayTokenRaw.startsWith('thu')
        ? 'thurs'
        : dayTokenRaw.startsWith('fri')
          ? 'fri'
          : dayTokenRaw.startsWith('sat')
            ? 'sat'
            : dayTokenRaw.startsWith('sun')
              ? 'sun'
              : null;
  if (!dayToken || !DAY_KEYS.includes(dayToken)) {
    return [];
  }

  const parsed = parseRange(timeMatch[1]);
  if (!parsed) {
    return [];
  }

  return [{ day: dayToken, start: parsed.start, end: parsed.end }];
}

function getReactionCount(message, emoji) {
  return message.reactions?.cache?.find((reaction) => reaction.emoji?.name === emoji)?.count || 0;
}

function collectRejectedProposalWindows(messages, botUserId) {
  const windows = [];
  for (const message of messages) {
    if (message.author?.id !== botUserId) {
      continue;
    }

    const content = String(message.content || '');
    if (!content.includes('**Scheduling request from**') || !content.includes('React with')) {
      continue;
    }

    const windowsFromMessage = parseProposedTimeWindowsFromMessage(content);
    if (!windowsFromMessage.length) {
      continue;
    }

    const yesCount = getReactionCount(message, '✅');
    const noCount = getReactionCount(message, '❌');
    if (noCount <= yesCount) {
      continue;
    }

    windows.push(...windowsFromMessage);
  }

  return windows;
}

function excludeWindowsFromOverlaps(overlaps, windows) {
  if (!windows.length || !overlaps.length) {
    return overlaps;
  }

  const byDay = new Map();
  for (const window of windows) {
    const day = String(window.day || '');
    if (!byDay.has(day)) {
      byDay.set(day, []);
    }
    byDay.get(day).push(window);
  }

  const result = [];
  for (const overlap of overlaps) {
    const windowsForDay = byDay.get(overlap.day) || [];
    if (!windowsForDay.length) {
      result.push(overlap);
      continue;
    }

    let segments = [{ start: overlap.start, end: overlap.end }];
    for (const window of windowsForDay) {
      const nextSegments = [];
      for (const segment of segments) {
        if (window.end <= segment.start || window.start >= segment.end) {
          nextSegments.push(segment);
          continue;
        }

        if (window.start > segment.start) {
          nextSegments.push({ start: segment.start, end: window.start });
        }
        if (window.end < segment.end) {
          nextSegments.push({ start: window.end, end: segment.end });
        }
      }
      segments = nextSegments;
      if (!segments.length) {
        break;
      }
    }

    for (const segment of segments) {
      if (segment.end > segment.start) {
        result.push({
          day: overlap.day,
          start: segment.start,
          end: segment.end,
          duration: segment.end - segment.start,
        });
      }
    }
  }

  return result.sort((a, b) => b.duration - a.duration);
}

function countDaysInScheduleBlock(block) {
  if (!block || typeof block !== 'object') {
    return 0;
  }
  return DAY_KEYS.filter((day) => Array.isArray(block[day]) && block[day].length > 0).length;
}

function mergeParsedBlocks(blocks) {
  const merged = {};
  for (const block of blocks || []) {
    for (const day of DAY_KEYS) {
      if (Array.isArray(block?.[day])) {
        merged[day] = block[day];
      }
    }
  }
  return merged;
}

function isFullScheduleBlock(block, handledDayLines) {
  return countDaysInScheduleBlock(block) >= 3 || Number(handledDayLines || 0) >= 3;
}

function computeOverlaps(userSchedules, options = {}) {
  const allowDiscouraged = Boolean(options.allowDiscouraged);
  const overlaps = [];
  for (const day of DAY_KEYS) {
    const perUserRanges = userSchedules.map((schedule) => schedule[day]).filter(Boolean);
    if (perUserRanges.length !== userSchedules.length) {
      continue;
    }

    const effectivePerUser = perUserRanges.map((ranges) =>
      allowDiscouraged ? ranges : ranges.filter((range) => !range.discouraged)
    );
    if (effectivePerUser.some((ranges) => !ranges.length)) {
      continue;
    }

    const points = [];
    for (const ranges of effectivePerUser) {
      for (const range of ranges) {
        points.push(range.start, range.end);
      }
    }

    const sortedPoints = [...new Set(points)].sort((a, b) => a - b);
    if (sortedPoints.length < 2) {
      continue;
    }

    const dayOverlaps = [];
    for (let i = 0; i < sortedPoints.length - 1; i += 1) {
      const start = sortedPoints[i];
      const end = sortedPoints[i + 1];
      if (end <= start) {
        continue;
      }

      const midpoint = (start + end) / 2;
      const allCovered = effectivePerUser.every((ranges) =>
        ranges.some((range) => midpoint >= range.start && midpoint < range.end)
      );
      if (!allCovered) {
        continue;
      }

      const previous = dayOverlaps[dayOverlaps.length - 1];
      if (previous && previous.end === start) {
        previous.end = end;
      } else {
        dayOverlaps.push({ day, start, end });
      }
    }

    for (const overlap of dayOverlaps) {
      if (overlap.end > overlap.start) {
        overlaps.push({ ...overlap, duration: overlap.end - overlap.start });
      }
    }
  }

  return overlaps.sort((a, b) => b.duration - a.duration);
}

function formatMinutesAsTime(totalMinutes) {
  const normalized = totalMinutes >= 24 * 60 ? totalMinutes % (24 * 60) : totalMinutes;
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

async function fetchRecentMessages(channel, max = 300) {
  const all = [];
  let before;
  while (all.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) {
      break;
    }

    const values = [...batch.values()];
    all.push(...values);
    before = values[values.length - 1].id;
    if (batch.size < 100) {
      break;
    }
  }
  return all;
}

function splitBotMentionScheduleBlocks(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const blocks = [];
  let current = null;

  const pushCurrent = () => {
    if (!current) {
      return;
    }
    const content = current.lines.join('\n').trim();
    if (!content) {
      return;
    }
    blocks.push({
      userId: current.userId,
      authorName: current.authorName,
      content,
    });
  };

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) {
      if (current) {
        current.lines.push('');
      }
      continue;
    }

    const mentionMatch = line.match(/^<@!?(\d+)>\s*$/);
    if (mentionMatch) {
      pushCurrent();
      const userId = mentionMatch[1];
      current = {
        userId,
        authorName: `<@${userId}>`,
        lines: [],
      };
      continue;
    }

    const plainHandleMatch = line.match(/^@([A-Za-z0-9_.-]{2,64})\s*$/);
    if (plainHandleMatch) {
      pushCurrent();
      const handle = plainHandleMatch[1];
      current = {
        userId: null,
        authorName: `@${handle}`,
        lines: [],
      };
      continue;
    }

    if (current) {
      current.lines.push(rawLine);
    }
  }

  pushCurrent();
  return blocks;
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(sessionId);
    }
  }
}

function buildSessionSummary(session) {
  const selectedALabels = session.selectedA
    .map((id) => session.teamA.candidates.find((candidate) => candidate.userId === id)?.displayName || id)
    .join(', ');
  const selectedBLabels = session.selectedB
    .map((id) => session.teamB.candidates.find((candidate) => candidate.userId === id)?.displayName || id)
    .join(', ');

  const lines = [
    `Select up to ${MAX_TEAM_SELECT} players per team, then click Run.`,
    `Team A (${session.teamA.label}) candidates: ${session.teamA.candidates.length}`,
    `Team B (${session.teamB.label}) candidates: ${session.teamB.candidates.length}`,
    `Selected Team A: ${selectedALabels || '(none)'}`,
    `Selected Team B: ${selectedBLabels || '(none)'}`,
  ];

  if (session.teamA.candidates.length > MAX_MENU_OPTIONS || session.teamB.candidates.length > MAX_MENU_OPTIONS) {
    lines.push('(Menus show first 25 candidates per team due Discord limits.)');
  }

  return lines.join('\n');
}

function buildSessionComponents(session, disabled = false) {
  const teamAOptions = session.teamA.candidates.slice(0, MAX_MENU_OPTIONS).map((candidate) => ({
    label: candidate.displayName.slice(0, 100),
    value: candidate.userId,
    default: session.selectedA.includes(candidate.userId),
  }));

  const teamBOptions = session.teamB.candidates.slice(0, MAX_MENU_OPTIONS).map((candidate) => ({
    label: candidate.displayName.slice(0, 100),
    value: candidate.userId,
    default: session.selectedB.includes(candidate.userId),
  }));

  const teamARow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`suggest_players_select_a:${session.id}`)
      .setPlaceholder(`Team A (${session.teamA.label})`)
      .setMinValues(0)
      .setMaxValues(Math.min(MAX_TEAM_SELECT, Math.max(teamAOptions.length, 1)))
      .setDisabled(disabled || !teamAOptions.length)
      .addOptions(teamAOptions.length ? teamAOptions : [{ label: 'No candidates found', value: 'none', default: false }])
  );

  const teamBRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`suggest_players_select_b:${session.id}`)
      .setPlaceholder(`Team B (${session.teamB.label})`)
      .setMinValues(0)
      .setMaxValues(Math.min(MAX_TEAM_SELECT, Math.max(teamBOptions.length, 1)))
      .setDisabled(disabled || !teamBOptions.length)
      .addOptions(teamBOptions.length ? teamBOptions : [{ label: 'No candidates found', value: 'none', default: false }])
  );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`suggest_players_run:${session.id}`)
      .setLabel('Run')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`suggest_players_cancel:${session.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  return [teamARow, teamBRow, buttonRow];
}

async function resolveTimeskeeperMention(guild) {
  const explicitId = process.env.CCS_TIMESKEEPER_ROLE_ID;
  if (explicitId) {
    return `<@&${explicitId}>`;
  }

  if (!guild.roles.cache.size) {
    await guild.roles.fetch();
  }

  const role = guild.roles.cache.find((r) => normalizeRoleName(r.name) === 'ccstimeskeeper');
  return role ? `<@&${role.id}>` : '@ccs timeskeeper';
}

async function buildTeamCandidates(interaction, roleA, roleB) {
  const messages = await fetchRecentMessages(interaction.channel, 300);
  const latestScheduleByUser = new Map();
  const memberCache = new Map();

  const getMember = async (userId, messageMember) => {
    if (messageMember?.id) {
      return messageMember;
    }
    if (memberCache.has(userId)) {
      return memberCache.get(userId);
    }
    const fetched = await interaction.guild.members.fetch(userId).catch(() => null);
    memberCache.set(userId, fetched);
    return fetched;
  };

  for (const message of messages) {
    if (message.author?.bot && message.author.id !== interaction.client.user.id) {
      continue;
    }

    const candidates = [];
    if (message.author?.id === interaction.client.user.id) {
      const botBlocks = splitBotMentionScheduleBlocks(message.content || '');
      for (const block of botBlocks) {
        if (!block.userId) {
          continue;
        }
        const member = await getMember(block.userId, null);
        if (!member) {
          continue;
        }
        candidates.push({
          userId: block.userId,
          displayName: member.displayName || block.authorName || `<@${block.userId}>`,
          member,
          content: block.content,
        });
      }
    } else {
      const member = await getMember(message.author.id, message.member);
      if (member) {
        candidates.push({
          userId: message.author.id,
          displayName: member.displayName || message.author.globalName || message.author.username || message.author.id,
          member,
          content: message.content || '',
        });
      }
    }

    for (const candidate of candidates) {
      if (sharedIsScheduleTemplateMessage(candidate.content || '')) {
        continue;
      }

      const parsedResult = sharedParseSchedulesFromText(candidate.content || '');
      if (!parsedResult.schedules.length) {
        continue;
      }

      const mergedBlock = mergeParsedBlocks(parsedResult.schedules);
      if (!countDaysInScheduleBlock(mergedBlock)) {
        continue;
      }

      const hasTeamA = Boolean(roleA?.id && candidate.member.roles?.cache?.has(roleA.id));
      const hasTeamB = Boolean(roleB?.id && candidate.member.roles?.cache?.has(roleB.id));
      if (!hasTeamA && !hasTeamB) {
        continue;
      }

      const teamKey = hasTeamA && !hasTeamB ? 'A' : !hasTeamA && hasTeamB ? 'B' : null;
      if (!teamKey) {
        continue;
      }

      const isFull = isFullScheduleBlock(mergedBlock, parsedResult.handledDayLines);
      const existing = latestScheduleByUser.get(candidate.userId);
      if (!existing) {
        latestScheduleByUser.set(candidate.userId, {
          userId: candidate.userId,
          displayName: candidate.displayName,
          teamKey,
          schedule: mergedBlock,
          isFull,
        });
        continue;
      }

      if (!existing.isFull && isFull) {
        latestScheduleByUser.set(candidate.userId, {
          ...existing,
          teamKey,
          schedule: mergedBlock,
          isFull,
        });
      }
    }
  }

  const teamA = [];
  const teamB = [];
  for (const entry of latestScheduleByUser.values()) {
    if (entry.teamKey === 'A') {
      teamA.push(entry);
    } else if (entry.teamKey === 'B') {
      teamB.push(entry);
    }
  }

  teamA.sort((a, b) => a.displayName.localeCompare(b.displayName));
  teamB.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { messages, teamA, teamB };
}

function getSelectedSchedules(session) {
  const byId = new Map();
  for (const candidate of session.teamA.candidates) {
    byId.set(candidate.userId, candidate);
  }
  for (const candidate of session.teamB.candidates) {
    byId.set(candidate.userId, candidate);
  }

  const selected = [];
  for (const userId of [...session.selectedA, ...session.selectedB]) {
    const entry = byId.get(userId);
    if (entry) {
      selected.push(entry);
    }
  }
  return selected;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('suggest_players')
    .setDescription('Pick up to 4 players per team and suggest overlap times from their posted schedules')
    .setDMPermission(false),

  async handleChatInput(interaction) {
    if (!interaction.guild || !interaction.channel || !interaction.channel.isTextBased?.()) {
      await interaction.reply({
        content: 'Use this in a server text channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isAdminAuthorized(interaction)) {
      await interaction.reply({
        content: 'You need the required role level (Mods+) or CCS Times Keeper to use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const slugs = parseMatchupSlugsFromChannel(interaction.channel.name);
    if (!slugs) {
      await interaction.reply({
        content: 'Use this inside a matchup channel named like `team-a-at-team-b`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [roleA, roleB] = await Promise.all([
      resolveRoleBySlug(interaction.guild, slugs.leftSlug),
      resolveRoleBySlug(interaction.guild, slugs.rightSlug),
    ]);

    if (!roleA || !roleB) {
      await interaction.editReply(
        'Could not map one or both matchup team slugs to Discord roles in this server.'
      );
      return;
    }

    const candidateData = await buildTeamCandidates(interaction, roleA, roleB);
    if (!candidateData.teamA.length || !candidateData.teamB.length) {
      await interaction.editReply(
        `Not enough posted schedules from team-role members yet.\n${roleA.name}: ${candidateData.teamA.length}\n${roleB.name}: ${candidateData.teamB.length}`
      );
      return;
    }

    pruneExpiredSessions();
    const sessionId = `${interaction.id}:${Date.now()}`;
    const session = {
      id: sessionId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      ownerUserId: interaction.user.id,
      teamA: { label: roleA.name, roleId: roleA.id, candidates: candidateData.teamA },
      teamB: { label: roleB.name, roleId: roleB.id, candidates: candidateData.teamB },
      selectedA: candidateData.teamA.slice(0, MAX_TEAM_SELECT).map((entry) => entry.userId),
      selectedB: candidateData.teamB.slice(0, MAX_TEAM_SELECT).map((entry) => entry.userId),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    sessions.set(session.id, session);

    await interaction.editReply({
      content: buildSessionSummary(session),
      components: buildSessionComponents(session),
    });
  },

  async handleSelectMenu(interaction) {
    const customId = String(interaction.customId || '');
    if (!customId.startsWith('suggest_players_select_')) {
      return;
    }

    const [prefix, sessionId] = customId.split(':');
    const teamKey = prefix.endsWith('_a') ? 'A' : prefix.endsWith('_b') ? 'B' : null;
    if (!sessionId || !teamKey) {
      return;
    }

    pruneExpiredSessions();
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: 'This suggest_players session expired. Run `/suggest_players` again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== session.ownerUserId) {
      await interaction.reply({
        content: 'Only the staff member who started this session can edit selections.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const allowed = new Set(
      (teamKey === 'A' ? session.teamA.candidates : session.teamB.candidates).map((entry) => entry.userId)
    );
    const selected = interaction.values.filter((value) => allowed.has(value)).slice(0, MAX_TEAM_SELECT);

    if (teamKey === 'A') {
      session.selectedA = selected;
    } else {
      session.selectedB = selected;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(session.id, session);

    await interaction.update({
      content: buildSessionSummary(session),
      components: buildSessionComponents(session),
    });
  },

  async handleButtonInteraction(interaction) {
    const customId = String(interaction.customId || '');
    if (!customId.startsWith('suggest_players_run:') && !customId.startsWith('suggest_players_cancel:')) {
      return;
    }

    const [, sessionId] = customId.split(':');
    pruneExpiredSessions();
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: 'This suggest_players session expired. Run `/suggest_players` again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== session.ownerUserId) {
      await interaction.reply({
        content: 'Only the staff member who started this session can run or cancel it.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (customId.startsWith('suggest_players_cancel:')) {
      sessions.delete(session.id);
      await interaction.update({
        content: 'suggest_players session canceled.',
        components: [],
      });
      return;
    }

    if (!session.selectedA.length || !session.selectedB.length) {
      await interaction.reply({
        content: 'Select at least 1 player from each side before running.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const selectedEntries = getSelectedSchedules(session);
    const allSchedules = selectedEntries.map((entry) => entry.schedule);
    const messages = await fetchRecentMessages(interaction.channel, 300);
    const rejectedProposalWindows = collectRejectedProposalWindows(messages, interaction.client.user.id);

    const preferredOverlapsRaw = computeOverlaps(allSchedules, { allowDiscouraged: false });
    const preferredOverlaps = excludeWindowsFromOverlaps(preferredOverlapsRaw, rejectedProposalWindows);
    const fallbackRaw = preferredOverlaps.length
      ? preferredOverlaps
      : computeOverlaps(allSchedules, { allowDiscouraged: true });
    const overlaps = excludeWindowsFromOverlaps(fallbackRaw, rejectedProposalWindows);
    const usedDiscouragedFallback = !preferredOverlaps.length && overlaps.length;

    if (!overlaps.length) {
      const timeskeeperMention = await resolveTimeskeeperMention(interaction.guild);
      const teamALabels = session.selectedA.map((id) => `<@${id}>`).join(', ');
      const teamBLabels = session.selectedB.map((id) => `<@${id}>`).join(', ');
      const rejectedProposalNote = rejectedProposalWindows.length
        ? `\n(Excluded ${rejectedProposalWindows.length} rejected /propose_time window(s) based on reactions.)`
        : '';
      await interaction.channel.send(
        `${timeskeeperMention} No overlapping availability found for selected players.\nTeam A: ${teamALabels}\nTeam B: ${teamBLabels}${rejectedProposalNote}`
      );
      sessions.delete(session.id);
      await interaction.update({
        content: 'No common overlap found. I pinged the CCS timeskeeper role.',
        components: [],
      });
      return;
    }

    const top = overlaps.slice(0, 3);
    const lines = top.map(
      (overlap) => `- ${DAY_LABELS[overlap.day]}: ${formatMinutesAsTime(overlap.start)} - ${formatMinutesAsTime(overlap.end)} EST`
    );
    const teamALabels = session.selectedA.map((id) => `<@${id}>`).join(', ');
    const teamBLabels = session.selectedB.map((id) => `<@${id}>`).join(', ');
    const fallbackNote = usedDiscouragedFallback
      ? '\n(Used "would prefer not" / discouraged slots because no fully preferred overlap was found.)'
      : '';
    const rejectedProposalNote = rejectedProposalWindows.length
      ? `\n(Excluded ${rejectedProposalWindows.length} rejected /propose_time window(s) based on reactions.)`
      : '';

    await interaction.channel.send(
      `Suggested best overlap times for selected players:\nTeam A: ${teamALabels}\nTeam B: ${teamBLabels}\n${lines.join('\n')}${fallbackNote}${rejectedProposalNote}`
    );

    sessions.delete(session.id);
    await interaction.update({
      content: 'Posted best overlap suggestions in this channel.',
      components: [],
    });
  },
};
