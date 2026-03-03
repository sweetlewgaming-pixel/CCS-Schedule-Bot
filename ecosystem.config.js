module.exports = {
  apps: [
    {
      name: 'ccs-scheduler-bot',
      script: './scripts/start-bot.sh',
      interpreter: 'bash',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
