const { Client, GatewayIntentBits, Collection, Events, REST, Routes, MessageFlags } = require('discord.js');
require('dotenv').config();

const scheduleCommand = require('./commands/schedule');
const rebuildWeekCommand = require('./commands/rebuild_week');
const requestCommand = require('./commands/request');
const suggestTimesCommand = require('./commands/suggest_times');
const uploadCommand = require('./commands/upload');
const uploadNullCommand = require('./commands/upload_null');

const requiredEnv = ['DISCORD_TOKEN', 'CLIENT_ID', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  throw new Error(`Missing required env vars: ${missingEnv.join(', ')}`);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection();
client.commands.set(scheduleCommand.data.name, scheduleCommand);
client.commands.set(rebuildWeekCommand.data.name, rebuildWeekCommand);
client.commands.set(requestCommand.data.name, requestCommand);
client.commands.set(suggestTimesCommand.data.name, suggestTimesCommand);
client.commands.set(uploadCommand.data.name, uploadCommand);
client.commands.set(uploadNullCommand.data.name, uploadNullCommand);

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = [...client.commands.values()].map((command) => command.data.toJSON());

  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log(`Registered ${commands.length} application command(s).`);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    await registerSlashCommands();
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (command?.handleChatInput) {
        await command.handleChatInput(interaction);
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await scheduleCommand.handleSelectMenu(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (scheduleCommand.handleButtonInteraction) {
        await scheduleCommand.handleButtonInteraction(interaction);
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

      if (rebuildWeekCommand.handleButtonInteraction) {
        await rebuildWeekCommand.handleButtonInteraction(interaction);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      await scheduleCommand.handleModalSubmit(interaction);
    }
  } catch (error) {
    console.error('Interaction handler error:', error);

    if (interaction.deferred || interaction.replied) {
      await interaction
        .followUp({ content: 'Something went wrong while processing that action.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    } else {
      await interaction
        .reply({ content: 'Something went wrong while processing that action.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
