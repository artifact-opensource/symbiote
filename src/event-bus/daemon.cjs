const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Start event watcher as a background process
function startEventWatcher() {
  const eventWatcherPath = path.join(path.resolve('.'), 'src', 'event-watcher.js');
  if (!fs.existsSync(eventWatcherPath)) {
    console.error('Event watcher script not found at:', eventWatcherPath);
    return false;
  }

  const childProcess = spawn('node', [eventWatcherPath], {
    cwd: path.resolve('.'),
    detached: true,
    stdio: 'ignore'
  });

  childProcess.unref(); // Detach from parent
  console.log('[EVENT] Event watcher daemon started');
  return true;
}

// Main daemon loop
function startDaemon() {
  console.log('[EVENT] Starting event bus daemon...');

  // Start the watcher
  if (startEventWatcher()) {
    console.log('[EVENT] Event bus daemon is now running continuously');
    return true;
  }

  return false;
}

// Daemon loop with restart capability
function runDaemon() {
  let running = false;

  const interval = setInterval(() => {
    if (!running) {
      running = startDaemon();
    } else {
      // Check if process is still alive
      const childProcesses = require('child_process').execSync('pgrep -f "node.*event-watcher"', { encoding: 'utf8' });
      if (!childProcesses.trim()) {
        running = false;
        console.log('[EVENT] Event watcher appears to have stopped. Restarting...');
      }
    }
  }, 60000); // Check every 60 seconds

  return running;
}

// Run the daemon
const daemonRunning = runDaemon();
if (daemonRunning) {
  console.log('[EVENT] Daemon is running');
} else {
  console.log('[EVENT] Daemon not running - attempting to start');
  const success = startDaemon();
  if (success) {
    console.log('[EVENT] Daemon started successfully');
  } else {
    console.log('[EVENT] Failed to start daemon');
  }
}
