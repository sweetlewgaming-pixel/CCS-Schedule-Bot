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
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  getLastAvailability,
  saveLastAvailability,
  getWeeklyAvailability,
  saveWeeklyAvailability,
  buildCurrentWeekKeyEST,
} = require('../services/userAvailabilityStore');

const DAYS = [
  { key: 'tues', label: 'Tues' },
  { key: 'wed', label: 'Wed' },
  { key: 'thurs', label: 'Thurs' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const CUSTOM_PREFIX = 'availability';
const NOTES_MODAL_PREFIX = `${CUSTOM_PREFIX}:notes_modal`;
const SESSION_DATA_DIR = path.join(process.cwd(), '.data');
const SESSION_STORE_PATH = path.join(SESSION_DATA_DIR, 'availability-sessions.json');

const sessions = new Map();

async function ensureSessionStoreFile() {
  await fs.mkdir(SESSION_DATA_DIR, { recursive: true });
  try {
    await fs.access(SESSION_STORE_PATH);
  } catch {
    await fs.writeFile(SESSION_STORE_PATH, '{}', 'utf8');
  }
}

async function readSessionStore() {
  await ensureSessionStoreFile();
  const raw = await fs.readFile(SESSION_STORE_PATH, 'utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

async function writeSessionStore(data) {
  await ensureSessionStoreFile();
  await fs.writeFile(SESSION_STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

async function upsertSessionRecord(session) {
  const store = await readSessionStore();
  store[session.id] = session;
  await writeSessionStore(store);
}

async function removeSessionRecord(sessionId) {
  const store = await readSessionStore();
  if (Object.prototype.hasOwnProperty.call(store, sessionId)) {
    delete store[sessionId];
    await writeSessionStore(store);
  }
}

function buildTimeOptions() {
  const options = [];
  for (let hour = 12; hour < 24; hour += 1) {
    const meridiem = hour >= 12 ? 'PM' : 'AM';
    const hour12 = ((hour + 11) % 12) + 1;
    options.push({
      label: `${hour12}:00 ${meridiem}`,
      value: String(hour),
    });
  }
  return options;
}

const TIME_OPTIONS = buildTimeOptions();

function parseCustomId(customId) {
  if (!String(customId).startsWith(`${CUSTOM_PREFIX}:`)) {
    return null;
  }
  return String(customId).split(':');
}

async function createSession(interaction) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const dayState = {};
  for (const day of DAYS) {
    dayState[day.key] = {
      start: null,
      end: null,
      na: false,
      anytime: true,
      note: '',
    };
  }

  const session = {
    id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    selectedDayIndex: 0,
    dayState,
    hasLastSchedule: false,
    weekKey: buildCurrentWeekKeyEST(),
    hasWeeklySchedule: false,
    weeklyMessageId: null,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(id, session);
  await upsertSessionRecord(session);
  return session;
}

async function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    if (session.expiresAt <= Date.now()) {
      sessions.delete(sessionId);
      await removeSessionRecord(sessionId);
      return null;
    }
    return session;
  }

  const store = await readSessionStore();
  const persisted = store[sessionId];
  if (!persisted) {
    return null;
  }
  if (persisted.expiresAt <= Date.now()) {
    await removeSessionRecord(sessionId);
    return null;
  }

  sessions.set(sessionId, persisted);
  return persisted;
}

function formatHour(hour) {
  const n = Number(hour);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    return null;
  }
  const meridiem = n >= 12 ? 'PM' : 'AM';
  const hour12 = ((n + 11) % 12) + 1;
  return `${hour12}:00 ${meridiem}`;
}

function formatRange(start, end) {
  const from = formatHour(start);
  const to = formatHour(end);
  if (!from || !to) {
    return 'Time-Time';
  }
  return `${from} - ${to}`;
}

function formatDayValue(state) {
  if (state.na) {
    return 'N/A';
  }
  if (state.anytime) {
    return 'Anytime';
  }
  if (state.start !== null && state.end === null) {
    return `${formatHour(state.start)} - 12:00 AM`;
  }
  return formatRange(state.start, state.end);
}

function buildSummary(session) {
  const lines = ['Set your availability schedule (EST):'];
  lines.push(`Week Lock: ${session.weekKey}`);
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
  const startOptions = TIME_OPTIONS.map((option) => ({
    ...option,
    default: state.start !== null && Number(option.value) === Number(state.start),
  }));
  const endOptions = TIME_OPTIONS
    .filter((option) => state.start === null || Number(option.value) > Number(state.start))
    .map((option) => ({
      ...option,
      default: state.end !== null && Number(option.value) === Number(state.end),
    }));

  const startMenu = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:start:${session.id}:${currentDay.key}`)
    .setPlaceholder(`Start time (${currentDay.label})`)
    .setOptions(startOptions);

  const endMenu = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:end:${session.id}:${currentDay.key}`)
    .setPlaceholder(
      state.start === null
        ? `End time (${currentDay.label})`
        : `End time (${currentDay.label}) - after ${formatHour(state.start)}`
    )
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

  const submitButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:submit:${session.id}`)
    .setStyle(ButtonStyle.Success)
    .setLabel('Submit Schedule');

  const cancelButton = new ButtonBuilder()
    .setCustomId(`${CUSTOM_PREFIX}:cancel:${session.id}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Cancel');

  return [
    new ActionRowBuilder().addComponents(useLastButton),
    new ActionRowBuilder().addComponents(startMenu),
    new ActionRowBuilder().addComponents(endMenu),
    new ActionRowBuilder().addComponents(naButton, notesButton, prevButton, nextButton),
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
  }
  return null;
}

function buildPublicScheduleMessage(userId, session) {
  const lines = [`<@${userId}>`];
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
    const normalizedStart = Number.isInteger(Number(incoming.start)) ? Number(incoming.start) : null;
    let normalizedEnd = Number.isInteger(Number(incoming.end)) ? Number(incoming.end) : null;

    if (normalizedStart !== null && normalizedEnd === 0) {
      normalizedEnd = null;
    }

    normalized[day.key] = {
      start: normalizedStart,
      end: normalizedEnd,
      na: Boolean(incoming.na),
      anytime: Boolean(incoming.anytime),
      note: String(incoming.note || ''),
    };
  }
  return normalized;
}

async function ensureSessionOwner(interaction, session) {
  if (!session) {
    if (!interaction.isModalSubmit?.()) {
      const recovered = await createSession(interaction);
      const weekEntry = await getWeeklyAvailability(
        interaction.guildId,
        interaction.channelId,
        interaction.user.id,
        recovered.weekKey
      );
      if (weekEntry?.dayState) {
        recovered.dayState = normalizeStoredDayState(weekEntry.dayState);
        recovered.hasWeeklySchedule = true;
        recovered.weeklyMessageId = weekEntry.messageId || null;
      }

      const last = await getLastAvailability(interaction.guildId, interaction.user.id);
      recovered.hasLastSchedule = Boolean(last?.dayState);
      recovered.expiresAt = Date.now() + SESSION_TTL_MS;
      await upsertSessionRecord(recovered);

      const payload = {
        content: `${buildSummary(recovered)}\n\nYour previous form expired or restarted. This form was refreshed.`,
        components: buildComponents(recovered),
      };

      if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
        await interaction.update(payload);
      } else {
        await interaction.reply({
          ...payload,
          flags: MessageFlags.Ephemeral,
        });
      }
      return false;
    }

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
    .setName('availability')
    .setDescription('Build and post your weekly schedule with dropdowns')
    .setDMPermission(false),

  async handleChatInput(interaction) {
    if (!interaction.guild || !interaction.channel || !interaction.channel.isTextBased?.()) {
      await interaction.reply({
        content: 'Use this command in a server text channel.',
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

    const session = await createSession(interaction);
    const weekEntry = await getWeeklyAvailability(
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
      session.weekKey
    );
    if (weekEntry?.dayState) {
      session.dayState = normalizeStoredDayState(weekEntry.dayState);
      session.hasWeeklySchedule = true;
      session.weeklyMessageId = weekEntry.messageId || null;
    }

    const last = await getLastAvailability(interaction.guildId, interaction.user.id);
    session.hasLastSchedule = Boolean(last?.dayState);
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    await upsertSessionRecord(session);
    const weeklyNote = session.hasWeeklySchedule
      ? '\n\nYou already have a schedule this week. Edit it below and submit to update your existing weekly post.'
      : '';
    await interaction.reply({
      content: `${buildSummary(session)}${weeklyNote}`,
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

    const session = await getSession(sessionId);
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

    const selectedValue = Number(interaction.values[0]);
    if (!Number.isInteger(selectedValue) || selectedValue < 0 || selectedValue > 23) {
      await interaction.reply({
        content: 'Invalid time selection.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    state[action] = selectedValue;
    state.na = false;
    state.anytime = false;
    if (action === 'start' && state.end !== null && Number(state.end) <= Number(state.start)) {
      state.end = null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    await upsertSessionRecord(session);

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

    const session = await getSession(sessionId);
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
        state.anytime = false;
      } else {
        state.start = null;
        state.end = null;
        state.anytime = true;
      }
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      await upsertSessionRecord(session);

      await interaction.update({
        content: buildSummary(session),
        components: buildComponents(session),
      });
      return;
    }

    if (action === 'prev' || action === 'next') {
      const nextIndex = action === 'prev' ? session.selectedDayIndex - 1 : session.selectedDayIndex + 1;
      session.selectedDayIndex = Math.max(0, Math.min(DAYS.length - 1, nextIndex));
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      await upsertSessionRecord(session);

      await interaction.update({
        content: buildSummary(session),
        components: buildComponents(session),
      });
      return;
    }

    if (action === 'notes') {
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      await upsertSessionRecord(session);
      const currentDay = DAYS[session.selectedDayIndex];
      await interaction.showModal(buildNotesModal(session, currentDay.key));
      return;
    }

    if (action === 'use_last') {
      const last = await getLastAvailability(session.guildId, session.userId);
      if (!last?.dayState) {
        session.hasLastSchedule = false;
        await interaction.update({
          content: `${buildSummary(session)}\n\nNo previous schedule found yet.`,
          components: buildComponents(session),
        });
        await upsertSessionRecord(session);
        return;
      }

      session.dayState = normalizeStoredDayState(last.dayState);
      session.hasLastSchedule = true;
      session.selectedDayIndex = 0;
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      await upsertSessionRecord(session);

      await interaction.update({
        content: `${buildSummary(session)}\n\nLoaded your last schedule.`,
        components: buildComponents(session),
      });
      return;
    }

    if (action === 'cancel') {
      sessions.delete(session.id);
      await removeSessionRecord(session.id);
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

      const publicMessage = buildPublicScheduleMessage(interaction.user.id, session);
      let postedMessage = null;

      if (session.weeklyMessageId) {
        try {
          const existing = await interaction.channel.messages.fetch(session.weeklyMessageId);
          if (existing?.author?.id === interaction.client.user.id) {
            await existing.edit(publicMessage);
            postedMessage = existing;
          }
        } catch {
          // Fallback to posting a fresh weekly message below.
        }
      }

      if (!postedMessage) {
        postedMessage = await interaction.channel.send(publicMessage);
      }

      await saveLastAvailability(session.guildId, session.userId, {
        dayState: session.dayState,
      });
      await saveWeeklyAvailability(session.guildId, session.channelId, session.userId, session.weekKey, {
        dayState: session.dayState,
        messageId: postedMessage.id,
      });
      sessions.delete(session.id);
      await removeSessionRecord(session.id);
      await interaction.update({
        content: session.hasWeeklySchedule
          ? 'Weekly schedule updated in this channel.'
          : 'Schedule posted in this channel.',
        components: [],
      });
    }
  },

  async handleModalSubmit(interaction) {
    if (!String(interaction.customId || '').startsWith(`${NOTES_MODAL_PREFIX}:`)) {
      return;
    }

    const parts = String(interaction.customId).split(':');
    const sessionId = parts[2];
    const dayKey = parts[3];
    const session = await getSession(sessionId);
    if (!(await ensureSessionOwner(interaction, session))) {
      return;
    }

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
    await upsertSessionRecord(session);

    await interaction.reply({
      content: `${DAYS.find((d) => d.key === dayKey)?.label || 'Day'} note updated. Continue with the schedule form above.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
