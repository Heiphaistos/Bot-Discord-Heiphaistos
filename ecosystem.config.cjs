module.exports = {
  apps: [{
    name: 'heiphaisbot',
    script: 'src/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '1G',
    env: { NODE_ENV: 'production' },
    out_file: 'logs/out.log',
    error_file: 'logs/error.log',
    merge_logs: true,
    time: true,
  }],
};
