const { exec } = require('child_process');
const task = process.argv[2] || 'unknown';
console.log(`Sub-agent started, task: ${task}`);
while (true) {
  exec('sleep 10', (error, stdout, stderr) => {
    if (error) {
      console.error(`sleep error: ${error.message}`);
    }
  });
}