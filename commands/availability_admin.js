const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { getLastAvailability, saveLastAvailability } = require('../services/userAvailabilityStore');
const { isAdminAuthorized, hasNamedRole } = require('../utils/permissions');
const { DAY_KEYS: PARSER_DAY_KEYS, parseSchedulesFromText: sharedParseSchedulesFromText } = require('../utils/scheduleParser');

const DAYS = [
  { key: 'tues', label: 'Tues' },
  { key: 'wed', label: 'Wed' },
  { key: 'thurs', label: 'Thurs' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];
const SESSION_TTL_MS = 30 * 60 * 1000;
const CUSTOM_PREFIX = 'availability_admin';
const NOTES_MODAL_PREFIX = `${CUSTOM_PREFIX}:notes_modal`;
const IMPORT_MODAL_PREFIX = `${CUSTOM_PREFIX}:import_modal`;

const sessions = new Map();

function buildTimeOptions() {
  const options = [];
  for (let hour = 12; hour < 24; hour += 1) {
    for (const minute of [0, 30]) {
      const totalMinutes = hour * 60 + minute;
      const meridiem = hour >= 12 ? 'PM' : 'AM';
      const hour12 = ((hour + 11) % 12) + 1;
      options.push({
        label: `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`,
        value: String(totalMinutes),
      });
    }
  }
  return options;
}

const TIME_OPTIONS = buildTimeOptions();
const MIDNIGHT_END_OPTION = { label: '12 AM (Midnight)', value: 'midnight' };

function parseCustomId(customId) {
  if (!String(customId).startsWith(`${CUSTOM_PREFIX}:`)) {
    return null;
  }
  return String(customId).split(':');
}

function createSession(interaction) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const dayState = {};
  for (const day of DAYS) {
    dayState[day.key] = {
      start: null,
      end: null,
      secondStart: null,
      secondEnd: null,
      secondEnabled: false,
      na: false,
      anytime: true,
      note: '',
    };
  }

  sessions.set(id, {
    id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    targetUserId: interaction.user.id,
    selectedDayIndex: 0,
    activeRange: 1,
    dayState,
    hasLastSchedule: false,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return sessions.get(id);
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function normalizeTimeValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return null;
  }
  if (Number.isInteger(n) && n >= 0 && n <= 23) {
    return n * 60;
  }
  if (Number.isInteger(n) && n >= 0 && n < 24 * 60) {
    return n;
  }
  return null;
}

function formatHour(value) {
  const n = normalizeTimeValue(value);
  if (n === null) {
    return null;
  }
  const hour = Math.floor(n / 60);
  const minute = n % 60;
  const meridiem = hour >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour + 11) % 12) + 1;
  return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function formatRange(start, end) {
  const from = formatHour(start);
  const to = formatHour(end);
  if (!from || !to) {
    return 'Time-Time';
  }
  return `${from} - ${to}`;
}

const DAY_ALIASES = {
  tue: 'tues',
  tues: 'tues',
  tuesday: 'tues',
  wed: 'wed',
  wednesday: 'wed',
  thu: 'thurs',
  thurs: 'thurs',
  thursday: 'thurs',
  fri: 'fri',
  friday: 'fri',
  sat: 'sat',
  saturday: 'sat',
  sun: 'sun',
  sunday: 'sun',
};

function normalizeDayToken(token) {
  return DAY_ALIASES[String(token || '').trim().toLowerCase()] || null;
}

function parseTimePart(value) {
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/i);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] || '0');
  const meridiem = match[3]?.toLowerCase();

  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return null;
  }

  if (!meridiem) {
    if (hour !== 12) {
      hour += 12;
    }
  } else if (meridiem === 'am') {
    if (hour === 12) {
      hour = 0;
    }
  } else if (hour !== 12) {
    hour += 12;
  }

  return { hour, minute };
}

function parseAvailabilityTextToState(text) {
  const lowered = String(text || '').trim().toLowerCase();
  if (!lowered) {
    return null;
  }

  if (/\b(n\/a|na|unavailable|not available|can't|cant|no)\b/i.test(lowered)) {
    return { na: true, anytime: false, start: null, end: null };
  }

  if (/\b(anytime|any|open|all day|free)\b/i.test(lowered)) {
    return { na: false, anytime: true, start: null, end: null };
  }

  const afterMatch = lowered.match(/after\s+(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)/i);
  if (afterMatch) {
    const parsed = parseTimePart(afterMatch[1]);
    if (parsed?.minute === 0 && parsed.hour >= 12) {
      return { na: false, anytime: false, start: parsed.hour, end: null };
    }
  }

  const rangeMatch = lowered.match(
    /(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)\s*(?:-|to)\s*(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)/i
  );
  if (rangeMatch) {
    const startParsed = parseTimePart(rangeMatch[1]);
    const endParsed = parseTimePart(rangeMatch[2]);
    if (startParsed?.minute === 0 && endParsed?.minute === 0 && startParsed.hour >= 12) {
      if (endParsed.hour === 0) {
        return { na: false, anytime: false, start: startParsed.hour, end: null };
      }
      if (endParsed.hour > startParsed.hour) {
        return { na: false, anytime: false, start: startParsed.hour, end: endParsed.hour };
      }
    }
  }

  return null;
}

function importScheduleTextIntoSession(session, rawText) {
  const parsed = sharedParseSchedulesFromText(rawText);
  const blocks = parsed?.schedules || [];
  if (!blocks.length) {
    return 0;
  }

  const mergedByDay = {};
  for (const block of blocks) {
    for (const day of PARSER_DAY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(block, day)) {
        mergedByDay[day] = block[day];
      }
    }
  }

  let updatedCount = 0;
  for (const day of PARSER_DAY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(mergedByDay, day)) {
      continue;
    }

    const state = session.dayState[day];
    if (!state) {
      continue;
    }

    const ranges = mergedByDay[day];
    if (!Array.isArray(ranges) || ranges.length === 0) {
      state.na = true;
      state.anytime = false;
      state.start = null;
      state.end = null;
      state.secondStart = null;
      state.secondEnd = null;
      state.secondEnabled = false;
      updatedCount += 1;
      continue;
    }

    const hasAnytime = ranges.some((r) => Number(r.start) <= 0 && Number(r.end) >= 24 * 60);
    if (hasAnytime) {
      state.na = false;
      state.anytime = true;
      state.start = null;
      state.end = null;
      state.secondStart = null;
      state.secondEnd = null;
      state.secondEnabled = false;
      updatedCount += 1;
      continue;
    }

    const best = [...ranges].sort((a, b) => Number(b.end - b.start) - Number(a.end - a.start))[0];
    if (!best) {
      continue;
    }

    let startMinutes = Math.floor(Number(best.start) / 30) * 30;
    let endMinutes = Number(best.end) >= 24 * 60 ? null : Math.ceil(Number(best.end) / 30) * 30;
    if (!Number.isFinite(startMinutes)) {
      continue;
    }
    startMinutes = Math.max(12 * 60, Math.min(23 * 60 + 30, startMinutes));
    if (endMinutes !== null) {
      endMinutes = Math.max(12 * 60, Math.min(23 * 60 + 30, endMinutes));
      if (endMinutes <= startMinutes) {
        endMinutes = null;
      }
    }

    state.na = false;
    state.anytime = false;
    state.start = startMinutes;
    state.end = endMinutes;
    state.secondStart = null;
    state.secondEnd = null;
    state.secondEnabled = false;
    updatedCount += 1;
  }

  return updatedCount;
}

function formatDayValue(state) {
  if (state.na) {
    return 'N/A';
  }
  if (state.anytime) {
    return 'Anytime';
  }
  const ranges = [];
  if (state.start !== null) {
    ranges.push(state.end === null ? `${formatHour(state.start)} - 12:00 AM` : formatRange(state.start, state.end));
  }
  if (state.secondEnabled && state.secondStart !== null) {
    ranges.push(
      state.secondEnd === null
        ? `${formatHour(state.secondStart)} - 12:00 AM`
        : formatRange(state.secondStart, state.secondEnd)
    );
  }
  return ranges.length ? ranges.join(', ') : 'Time-Time';
}

function buildSummary(session) {
  const lines = [`Set availability schedule for <@${session.targetUserId}> (EST):`];
  for (const day of DAYS) {
    const state = session.dayState[day.key];
    const value = formatDayValue(state);
    const noteText = state.note ? ` | Note: ${state.note}` : '';
    lines.push(`${day.label}: ${value}${noteText}`);
  }
  return lines.join('\n');
}

function buildComponents(session) {
  const currentDay = DAYS[session.selectedDayIndex];
  const state = session.dayState[currentDay.key];
  const editingSecond = Number(session.activeRange) === 2;
  const rangeStartKey = editingSecond ? 'secondStart' : 'start';
  const rangeEndKey = editingSecond ? 'secondEnd' : 'end';
  const rangeStart = state[rangeStartKey];
  const rangeEnd = state[rangeEndKey];
  const secondMinStart = state.end;
  const secondRangeReady = state.secondEnabled && normalizeTimeValue(secondMinStart) !== null;
  const startPool = editingSecond
    ? secondRangeReady
      ? TIME_OPTIONS.filter((option) => Number(option.value) > Number(secondMinStart))
      : []
    : TIME_OPTIONS;
  const startOptions = startPool.map((option) => ({
    ...option,
    default: rangeStart !== null && Number(option.value) === Number(rangeStart),
  }));
  const safeStartOptions = startOptions.length
    ? startOptions
    : TIME_OPTIONS.map((option) => ({ ...option, default: false }));
  const endOptions = TIME_OPTIONS
    .filter((option) => rangeStart === null || Number(option.value) > Number(rangeStart))
    .map((option) => ({
      ...option,
      default: rangeEnd !== null && Number(option.value) === Number(rangeEnd),
    }));
  endOptions.push({
    ...MIDNIGHT_END_OPTION,
    default: rangeStart !== null && rangeEnd === null,
  });

  const startMenu = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:start:${session.id}:${currentDay.key}`)
    .setPlaceholder(
      editingSecond
        ? secondRangeReady
          ? `2nd start (${currentDay.label}) - after ${formatHour(secondMinStart)}`
          : `2nd start (${currentDay.label}) - set first range end first`
        : `Start time (${currentDay.label})`
    )
    .setDisabled(editingSecond && !secondRangeReady)
    .setOptions(safeStartOptions);

  const endMenu = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:end:${session.id}:${currentDay.key}`)
    .setPlaceholder(
      rangeStart === null
        ? editingSecond
          ? `2nd end (${currentDay.label})`
          : `End time (${currentDay.label})`
        : editingSecond
          ? `2nd end (${currentDay.label}) - after ${formatHour(rangeStart)}`
          : `End time (${currentDay.label}) - after ${formatHour(rangeStart)}`
    )
    .setDisabled(editingSecond && !secondRangeReady)
    .setOptions(endOptions);

  const naButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:na:${session.id}:${currentDay.key}`)
    .setStyle(ButtonStyle.Danger)
    .setLabel(state.na ? `Set Anytime (${currentDay.label})` : `Set N/A (${currentDay.label})`);
  
  const useLastButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:use_last:${session.id}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Use Last Schedule')
    .setDisabled(!session.hasLastSchedule);

  const prevButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:prev:${session.id}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Prev Day')
    .setDisabled(session.selectedDayIndex === 0);

  const nextButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:next:${session.id}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Next Day')
    .setDisabled(session.selectedDayIndex === DAYS.length - 1);
  
  const notesButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:notes:${session.id}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(state.note ? `Edit ${currentDay.label} Note` : `Add ${currentDay.label} Note`);
  
  const importButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:import:${session.id}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Import Text');
  
  const rangeButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:range:${session.id}:${currentDay.key}`)
    .setStyle(ButtonStyle.Primary)
    .setLabel(
      !state.secondEnabled
        ? `Add 2nd Time (${currentDay.label})`
        : editingSecond
          ? `Edit 1st Time (${currentDay.label})`
          : `Edit 2nd Time (${currentDay.label})`
    );
  
  const clearButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:clear:${session.id}:${currentDay.key}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(editingSecond ? `Clear 2nd (${currentDay.label})` : `Clear 1st (${currentDay.label})`);

  const submitButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:submit:${session.id}`)
    .setStyle(ButtonStyle.Success)
    .setLabel('Submit Schedule');

  const cancelButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:cancel:${session.id}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Cancel');

  return [
    new ActionRowBuilder().addComponents(useLastButton, importButton, clearButton),
    new ActionRowBuilder().addComponents(startMenu),
    new ActionRowBuilder().addComponents(endMenu),
    new ActionRowBuilder().addComponents(naButton, notesButton, prevButton, nextButton, rangeButton),
    new ActionRowBuilder().addComponents(submitButton, cancelButton),
  ];
}

function buildNotesModal(session, dayKey) {
  const day = DAYS.find((d) => d.key === dayKey);
  const label = day?.label || 'Day';
  const state = session.dayState[dayKey];
  const modal = new ModalBuilder()
    .setCustomId(`${NOTES_MODAL_PREFIX}:${session.id}:${dayKey}`)
    .setTitle(`${label} Note`);

  const notesInput = new TextInputBuilder()
    .setCustomId('notes')
    .setLabel(`${label} note (optional)`)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(300)
    .setPlaceholder(`Add anything helpful for ${label} scheduling...`)
    .setValue(state?.note || '');

  modal.addComponents(new ActionRowBuilder().addComponents(notesInput));
  return modal;
}

function buildImportModal(session) {
  const modal = new ModalBuilder()
    .setCustomId(`${IMPORT_MODAL_PREFIX}:${session.id}`)
    .setTitle('Import Schedule Text');

  const input = new TextInputBuilder()
    .setCustomId('schedule_text')
    .setLabel('Paste schedule text')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setPlaceholder('Tues: 7-10\nWed: N/A\nThurs: Anytime');

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function validateSession(session) {
  for (const day of DAYS) {
    const state = session.dayState[day.key];
    if (state.na) {
      continue;
    }
    if (state.anytime) {
      continue;
    }
    if (state.start === null && state.end !== null) {
      return `${day.label} has an end time without a start time.`;
    }

    // Backward compatibility: old saved schedules may have explicit midnight as end=0.
    // Current UX represents "until midnight" by leaving end blank.
    if (state.start !== null && Number(state.end) === 0) {
      state.end = null;
    }

    if (state.start !== null && state.end === null) {
      continue;
    }
    if (Number(state.end) <= Number(state.start)) {
      return `${day.label} end time must be after start time.`;
    }

    if (!state.secondEnabled) {
      continue;
    }
    if (state.end === null) {
      return `${day.label} second time frame requires a first range end time.`;
    }
    if (state.secondStart === null && state.secondEnd !== null) {
      return `${day.label} second range has an end time without a start time.`;
    }
    if (state.secondStart !== null && Number(state.secondStart) <= Number(state.end)) {
      return `${day.label} second start must be after first range end.`;
    }
    if (state.secondStart !== null && state.secondEnd !== null && Number(state.secondEnd) <= Number(state.secondStart)) {
      return `${day.label} second end time must be after second start time.`;
    }
  }
  return null;
}

function buildPublicScheduleMessage(session) {
  const lines = [`<@${session.targetUserId}>`];
  for (const day of DAYS) {
    const state = session.dayState[day.key];
    const value = formatDayValue(state);
    const withTimezone = state.na || state.anytime ? value : `${value} (EST)`;
    const noteText = state.note ? ` | Note: ${state.note}` : '';
    lines.push(`${day.label}: ${withTimezone}${noteText}`);
  }
  return lines.join('\n');
}

function cleanChannelName(name) {
  return String(name || '').replace(/[\u2705]+$/u, '').replace(/confirmed$/i, '').trim();
}

function isMatchupChannel(name) {
  return cleanChannelName(name).includes('-at-');
}

function isTeamChannel(name) {
  const cleaned = cleanChannelName(name).toLowerCase();
  return cleaned.endsWith('-organization') || cleaned.endsWith('-chat');
}

function isAvailabilityAllowedChannel(name) {
  return isMatchupChannel(name) || isTeamChannel(name);
}

function normalizeStoredDayState(storedDayState) {
  const normalized = {};
  for (const day of DAYS) {
    const incoming = storedDayState?.[day.key] || {};
    const normalizedStart = normalizeTimeValue(incoming.start);
    let normalizedEnd = normalizeTimeValue(incoming.end);

    if (normalizedStart !== null && normalizedEnd === 0) {
      normalizedEnd = null;
    }

    normalized[day.key] = {
      start: normalizedStart,
      end: normalizedEnd,
      secondStart: normalizeTimeValue(incoming.secondStart),
      secondEnd: normalizeTimeValue(incoming.secondEnd),
      secondEnabled: Boolean(incoming.secondEnabled),
      na: Boolean(incoming.na),
      anytime: Boolean(incoming.anytime),
      note: String(incoming.note || ''),
    };
  }
  return normalized;
}

async function ensureSessionOwner(interaction, session) {
  if (!session) {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: 'This availability session expired. Run /availability again.',
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: 'This availability session expired. Run /availability again.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return false;
  }

  if (session.userId !== interaction.user.id) {
    await interaction.reply({
      content: 'Only the user who started this schedule can edit it.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  return true;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('availability_admin')
    .setDescription('Build and post your weekly schedule with dropdowns')
    .addUserOption((option) =>
      option.setName('user').setDescription('User to create schedule for').setRequired(true)
    )
    .setDMPermission(false),

  async handleChatInput(interaction) {
    if (!interaction.guild || !interaction.channel || !interaction.channel.isTextBased?.()) {
      await interaction.reply({
        content: 'Use this command in a server text channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const hasRoleOwnerAccess = hasNamedRole(interaction.member, 'roleowner');
    if (!isAdminAuthorized(interaction) && !hasRoleOwnerAccess) {
      await interaction.reply({
        content: 'You need the required role level (Mods+) or CCS Times Keeper to use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isAvailabilityAllowedChannel(interaction.channel.name)) {
      await interaction.reply({
        content: 'Use this command inside a matchup or team channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    const session = createSession(interaction);
    session.targetUserId = targetUser.id;
    const last = await getLastAvailability(interaction.guildId, targetUser.id);
    session.hasLastSchedule = Boolean(last?.dayState);
    await interaction.reply({
      content: buildSummary(session),
      components: buildComponents(session),
      flags: MessageFlags.Ephemeral,
    });
  },

  async handleSelectMenu(interaction) {
    const parts = parseCustomId(interaction.customId);
    if (!parts) {
      return;
    }

    const action = parts[1];
    const sessionId = parts[2];
    const dayKey = parts[3];
    if (!['start', 'end'].includes(action)) {
      return;
    }

    const session = getSession(sessionId);
    if (!(await ensureSessionOwner(interaction, session))) {
      return;
    }

    const state = session.dayState[dayKey];
    if (!state) {
      await interaction.reply({
        content: 'Invalid day selection.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const selectedRaw = interaction.values[0];
    const selectedValue =
      action === 'end' && selectedRaw === MIDNIGHT_END_OPTION.value
        ? null
        : normalizeTimeValue(selectedRaw);
    if (
      selectedValue !== null &&
      (selectedValue < 0 || selectedValue >= 24 * 60)
    ) {
      await interaction.reply({
        content: 'Invalid time selection.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === 'start' && selectedValue === null) {
      await interaction.reply({
        content: 'Invalid time selection.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const editingSecond = Number(session.activeRange) === 2;
    const startKey = editingSecond ? 'secondStart' : 'start';
    const endKey = editingSecond ? 'secondEnd' : 'end';
    state[action === 'start' ? startKey : endKey] = selectedValue;
    state.na = false;
    state.anytime = false;
    if (!editingSecond && action === 'start' && state.end !== null && Number(state.end) <= Number(state.start)) {
      state.end = null;
    }
    if (editingSecond && action === 'start' && state.secondEnd !== null && Number(state.secondEnd) <= Number(state.secondStart)) {
      state.secondEnd = null;
    }
    if (!editingSecond && state.secondEnabled && state.end !== null && state.secondStart !== null && Number(state.secondStart) <= Number(state.end)) {
      state.secondStart = null;
      state.secondEnd = null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;

    await interaction.update({
      content: buildSummary(session),
      components: buildComponents(session),
    });
  },

  async handleButtonInteraction(interaction) {
    const parts = parseCustomId(interaction.customId);
    if (!parts) {
      return;
    }

    const action = parts[1];
    const sessionId = parts[2];
    const dayKey = parts[3];

    const session = getSession(sessionId);
    if (!(await ensureSessionOwner(interaction, session))) {
      return;
    }

    if (action === 'na') {
      const state = session.dayState[dayKey];
      if (!state) {
        await interaction.reply({ content: 'Invalid day selected.', flags: MessageFlags.Ephemeral });
        return;
      }

      state.na = !state.na;
      if (state.na) {
        state.start = null;
        state.end = null;
        state.secondStart = null;
        state.secondEnd = null;
        state.secondEnabled = false;
        state.anytime = false;
      } else {
        state.start = null;
        state.end = null;
        state.secondStart = null;
        state.secondEnd = null;
        state.secondEnabled = false;
        state.anytime = true;
      }
      session.activeRange = 1;
      session.expiresAt = Date.now() + SESSION_TTL_MS;

      await interaction.update({
        content: buildSummary(session),
        components: buildComponents(session),
      });
      return;
    }

    if (action === 'prev' || action === 'next') {
      const nextIndex = action === 'prev' ? session.selectedDayIndex - 1 : session.selectedDayIndex + 1;
      session.selectedDayIndex = Math.max(0, Math.min(DAYS.length - 1, nextIndex));
      session.activeRange = 1;
      session.expiresAt = Date.now() + SESSION_TTL_MS;

      await interaction.update({
        content: buildSummary(session),
        components: buildComponents(session),
      });
      return;
    }

    if (action === 'notes') {
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      const currentDay = DAYS[session.selectedDayIndex];
      await interaction.showModal(buildNotesModal(session, currentDay.key));
      return;
    }

    if (action === 'import') {
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      await interaction.showModal(buildImportModal(session));
      return;
    }

    if (action === 'range') {
      const state = session.dayState[dayKey];
      if (!state) {
        await interaction.reply({ content: 'Invalid day selected.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (!state.secondEnabled) {
        if (state.na || state.anytime || state.start === null || state.end === null) {
          await interaction.reply({
            content: 'Set a first time frame with both start and end before adding a second time frame.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        state.secondEnabled = true;
        state.secondStart = null;
        state.secondEnd = null;
        session.activeRange = 2;
      } else {
        session.activeRange = Number(session.activeRange) === 2 ? 1 : 2;
      }

      session.expiresAt = Date.now() + SESSION_TTL_MS;
      await interaction.update({
        content: buildSummary(session),
        components: buildComponents(session),
      });
      return;
    }

    if (action === 'clear') {
      const state = session.dayState[dayKey];
      if (!state) {
        await interaction.reply({ content: 'Invalid day selected.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (Number(session.activeRange) === 2) {
        state.secondStart = null;
        state.secondEnd = null;
        state.secondEnabled = false;
        session.activeRange = 1;
      } else {
        state.start = null;
        state.end = null;
        state.secondStart = null;
        state.secondEnd = null;
        state.secondEnabled = false;
        state.na = false;
        state.anytime = true;
        session.activeRange = 1;
      }

      session.expiresAt = Date.now() + SESSION_TTL_MS;
      await interaction.update({
        content: buildSummary(session),
        components: buildComponents(session),
      });
      return;
    }

    if (action === 'use_last') {
      const last = await getLastAvailability(session.guildId, session.targetUserId);
      if (!last?.dayState) {
        session.hasLastSchedule = false;
        await interaction.update({
          content: `${buildSummary(session)}\n\nNo previous schedule found yet.`,
          components: buildComponents(session),
        });
        return;
      }

      session.dayState = normalizeStoredDayState(last.dayState);
      session.hasLastSchedule = true;
      session.selectedDayIndex = 0;
      session.activeRange = 1;
      session.expiresAt = Date.now() + SESSION_TTL_MS;

      await interaction.update({
        content: `${buildSummary(session)}\n\nLoaded your last schedule.`,
        components: buildComponents(session),
      });
      return;
    }

    if (action === 'cancel') {
      sessions.delete(session.id);
      try {
        await interaction.deferUpdate();
        await interaction.deleteReply();
      } catch (error) {
        await interaction.editReply({
          content: 'Availability form canceled. You can dismiss this message.',
          components: [],
        });
      }
      return;
    }

    if (action === 'submit') {
      const error = validateSession(session);
      if (error) {
        await interaction.reply({
          content: error,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.channel.send(buildPublicScheduleMessage(session));
      await saveLastAvailability(session.guildId, session.targetUserId, {
        dayState: session.dayState,
      });
      sessions.delete(session.id);
      await interaction.update({
        content: 'Schedule posted in this channel.',
        components: [],
      });
    }
  },

  async handleModalSubmit(interaction) {
    const customId = String(interaction.customId || '');
    if (!customId.startsWith(`${NOTES_MODAL_PREFIX}:`) && !customId.startsWith(`${IMPORT_MODAL_PREFIX}:`)) {
      return;
    }

    const parts = customId.split(':');
    const sessionId = parts[2];
    const session = getSession(sessionId);
    if (!(await ensureSessionOwner(interaction, session))) {
      return;
    }

    if (customId.startsWith(`${IMPORT_MODAL_PREFIX}:`)) {
      const rawText = interaction.fields.getTextInputValue('schedule_text') || '';
      const updatedCount = importScheduleTextIntoSession(session, rawText);
      session.expiresAt = Date.now() + SESSION_TTL_MS;

      const suffix =
        updatedCount > 0
          ? `\n\nImported ${updatedCount} day(s). Review/edit below before submitting.`
          : '\n\nCould not parse any day lines. Use format like `Tues: 7-10` or `Wed: N/A`.';

      await interaction.reply({
        content: `${buildSummary(session)}${suffix}`,
        components: buildComponents(session),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const dayKey = parts[3];

    const state = session.dayState[dayKey];
    if (!state) {
      await interaction.reply({
        content: 'Invalid day for note update.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    state.note = interaction.fields.getTextInputValue('notes')?.trim() || '';
    session.expiresAt = Date.now() + SESSION_TTL_MS;

    await interaction.reply({
      content: `${DAYS.find((d) => d.key === dayKey)?.label || 'Day'} note updated. Continue with the schedule form above.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
