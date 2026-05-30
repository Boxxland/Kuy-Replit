module.exports = {
  apps: [
    {
      name: "burin102016-discord-bott-auto-restart",
      script: "index.js",
      watch: false,
      autorestart: true,       // รีสตาร์ทอัตโนมัติถ้า crash
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
