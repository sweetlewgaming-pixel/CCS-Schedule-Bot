const { Client, GatewayIntentBits, Collection, Events, REST, Routes, MessageFlags } = require('discord.js');
const dotenv = require('dotenv');

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID || !process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
  dotenv.config({ path: process.env.ENV_FILE || '.env' });
}

const scheduleCommand = require('./commands/schedule');
const rescheduleCommand = require('./commands/reschedule');
const rebuildWeekCommand = require('./commands/rebuild_week');
const requestCommand = require('./commands/request');
const suggestTimesCommand = require('./commands/suggest_times');
const suggestPlayersCommand = require('./commands/suggest_players');
const uploadCommand = require('./commands/upload');
const uploadNullCommand = require('./commands/upload_null');
const availabilityCommand = require('./commands/availability');
const availabilityAdminCommand = require('./commands/availability_admin');
const helpCommand = require('./commands/help');
const postResultCommand = require('./commands/post_result');
const { startMatchReminderService } = require('./services/matchReminderService');
const { prewarmRenderer } = require('./services/resultCardRenderer');

const requiredEnv = ['DISCORD_TOKEN', 'CLIENT_ID', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  throw new Error(`Missing required env vars: ${missingEnv.join(', ')}`);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function shouldSkipCommandRegistration() {
  return String(process.env.SKIP_COMMAND_REGISTRATION || '').trim().toLowerCase() === 'true';
}

client.commands = new Collection();
client.commands.set(scheduleCommand.data.name, scheduleCommand);
client.commands.set(rescheduleCommand.data.name, rescheduleCommand);
client.commands.set(rebuildWeekCommand.data.name, rebuildWeekCommand);
client.commands.set(requestCommand.data.name, requestCommand);
client.commands.set(suggestTimesCommand.data.name, suggestTimesCommand);
client.commands.set(suggestPlayersCommand.data.name, suggestPlayersCommand);
client.commands.set(uploadCommand.data.name, uploadCommand);
client.commands.set(uploadNullCommand.data.name, uploadNullCommand);
client.commands.set(availabilityCommand.data.name, availabilityCommand);
client.commands.set(availabilityAdminCommand.data.name, availabilityAdminCommand);
client.commands.set(helpCommand.data.name, helpCommand);
client.commands.set(postResultCommand.data.name, postResultCommand);

async function registerSlashCommands() {
  if (shouldSkipCommandRegistration()) {
    console.log('Skipping slash command registration (SKIP_COMMAND_REGISTRATION=true).');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = [...client.commands.values()].map((command) => command.data.toJSON());

  if (process.env.GUILD_ID) {
    try {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
      console.log(`Registered ${commands.length} guild command(s) for ${process.env.GUILD_ID}.`);
    } catch (error) {
      if (Number(error?.code) === 50001) {
        console.log(
          `Skipping guild command registration for ${process.env.GUILD_ID} due to Missing Access (50001).`
        );
        return;
      }
      throw error;
    }
    return;
  }

  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log(`Registered ${commands.length} global application command(s).`);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    await registerSlashCommands();
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }

  const remindersDisabled = String(process.env.DISABLE_REMINDERS || '').trim().toLowerCase() === 'true';
  if (!remindersDisabled) {
    startMatchReminderService(readyClient);
  } else {
    console.log('Match reminder service disabled via DISABLE_REMINDERS=true');
  }

  prewarmRenderer()
    .then(() => console.log('Result card renderer prewarmed.'))
    .catch((error) => console.error('Result card renderer prewarm failed:', error?.message || error));
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (command?.handleChatInput) {
        await command.handleChatInput(interaction);
      } else {
        await interaction.reply({
          content: `Command "${interaction.commandName}" is not available on this bot instance right now.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (command?.handleAutocomplete) {
        await command.handleAutocomplete(interaction);
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (availabilityCommand.handleSelectMenu) {
        await availabilityCommand.handleSelectMenu(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (availabilityAdminCommand.handleSelectMenu) {
        await availabilityAdminCommand.handleSelectMenu(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (uploadNullCommand.handleSelectMenu) {
        await uploadNullCommand.handleSelectMenu(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (suggestPlayersCommand.handleSelectMenu) {
        await suggestPlayersCommand.handleSelectMenu(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (postResultCommand.handleSelectMenu) {
        await postResultCommand.handleSelectMenu(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      await scheduleCommand.handleSelectMenu(interaction);
      if (interaction.deferred || interaction.replied) {
        return;
      }

      await interaction.reply({
        content: 'That menu action is no longer available. Please run the command again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isButton()) {
      if (availabilityCommand.handleButtonInteraction) {
        await availabilityCommand.handleButtonInteraction(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (availabilityAdminCommand.handleButtonInteraction) {
        await availabilityAdminCommand.handleButtonInteraction(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (scheduleCommand.handleButtonInteraction) {
        await scheduleCommand.handleButtonInteraction(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (rescheduleCommand.handleButtonInteraction) {
        await rescheduleCommand.handleButtonInteraction(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (requestCommand.handleButtonInteraction) {
        await requestCommand.handleButtonInteraction(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (uploadCommand.handleButtonInteraction) {
        await uploadCommand.handleButtonInteraction(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (uploadNullCommand.handleButtonInteraction) {
        await uploadNullCommand.handleButtonInteraction(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (rebuildWeekCommand.handleButtonInteraction) {
        await rebuildWeekCommand.handleButtonInteraction(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (suggestPlayersCommand.handleButtonInteraction) {
        await suggestPlayersCommand.handleButtonInteraction(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (postResultCommand.handleButtonInteraction) {
        await postResultCommand.handleButtonInteraction(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      await interaction.reply({
        content: 'That button action is no longer available. Please run the command again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isModalSubmit()) {
      if (availabilityCommand.handleModalSubmit) {
        await availabilityCommand.handleModalSubmit(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (availabilityAdminCommand.handleModalSubmit) {
        await availabilityAdminCommand.handleModalSubmit(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (uploadNullCommand.handleModalSubmit) {
        await uploadNullCommand.handleModalSubmit(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (requestCommand.handleModalSubmit) {
        await requestCommand.handleModalSubmit(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      await scheduleCommand.handleModalSubmit(interaction);

      if (interaction.deferred || interaction.replied) {
        return;
      }

      if (rescheduleCommand.handleModalSubmit) {
        await rescheduleCommand.handleModalSubmit(interaction);
      }

      if (interaction.deferred || interaction.replied) {
        return;
      }

      await interaction.reply({
        content: 'That modal action is no longer available. Please run the command again.',
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    console.error('Interaction handler error:', error);
    const debugMessage = String(error?.message || 'Unknown error').slice(0, 250);
    const responseText = `Something went wrong while processing that action.\nError: ${debugMessage}`;

    if (interaction.deferred || interaction.replied) {
      await interaction
        .followUp({ content: responseText, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    } else {
      await interaction
        .reply({ content: responseText, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
