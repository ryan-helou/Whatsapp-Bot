// pm2 process config — keeps the bot alive 24/7 and restarts it on crash/reboot.
// Usage:
//   npm install -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup   (so it survives server reboots)
module.exports = {
  apps: [
    {
      name: 'whatsapp-scheduler',
      script: 'index.js',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000, // wait 5s between restarts
      watch: false,
      time: true, // timestamp log lines
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
