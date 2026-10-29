const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENT_BUS_DIR = path.join(path.resolve('.'), '.session', 'event-bus');
const LOG_PATH = path.join(path.resolve('.'), '.session', 'conversation-log.jsonl');

// Ensure directories exist
fs.mkdirSync(EVENT_BUS_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 0o700 });

// Event emitter function
function emitEvent(eventType, payload) {
  const timestamp = Date.now();
  const eventId = crypto.randomUUID();
  const event = {
    type: eventType,
    timestamp,
    payload,
    id: eventId
  };

  const eventPath = path.join(EVENT_BUS_DIR, `${eventId}.json`);
  fs.writeFileSync(eventPath, JSON.stringify(event, null, 2), { encoding: 'utf8', mode: 0o600 });
  console.log(`[EVENT] Emitted: ${eventType} (${eventId})`);
  return eventId;
}

// Journal logging
function logEvent(eventType, payload, message = '') {
  const entry = {
    timestamp: Date.now(),
    type: eventType,
    payload,
    message,
    channel: 'system'
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
}

// Handler dispatch
function handleEvent(event) {
  console.log(`[EVENT] Handling: ${event.type}`);

  switch(event.type) {
    case 'greeting':
      const now = new Date(event.timestamp);
      const greeting = `Good ${now.getHours() < 12 ? 'morning' : now.getHours() < 17 ? 'afternoon' : 'evening'}, Sirius.`;
      console.log(`[HANDLER] ${greeting}`);
      logEvent('greeting', event.payload, greeting);
      break;

    case 'system_status':
      const status = `System status at ${new Date(event.timestamp).toISOString()}`;
      console.log(`[HANDLER] ${status}`);
      logEvent('system_status', event.payload, status);
      break;

    case 'journal':
      console.log(`[HANDLER] Journal entry: ${event.payload.message}`);
      logEvent('journal', event.payload, event.payload.message);
      break;

    default:
      console.log(`[HANDLER] No handler for type: ${event.type}`);
  }
}

// Process all existing events
function processExistingEvents() {
  const files = fs.readdirSync(EVENT_BUS_DIR).filter(f => f.endsWith('.json'));
  console.log(`[EVENT] Processing ${files.length} existing events`);

  for (const file of files) {
    const filePath = path.join(EVENT_BUS_DIR, file);
    try {
      const event = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      handleEvent(event);
      // Remove processed event
      fs.unlinkSync(filePath);
    } catch(err) {
      console.error(`[EVENT] Error processing ${file}:`, err.message);
    }
  }
}

// Create a sample event
function createSampleEvent() {
  const eventId = emitEvent('greeting', {
    source: 'manual_test',
    user: '193011943382974466'
  });

  console.log(`[TEST] Created sample greeting event: ${eventId}`);
  return eventId;
}

// Main execution
console.log('[EVENT] Starting event bus test...');
processExistingEvents();
createSampleEvent();
processExistingEvents(); // Process the sample event we just created
console.log('[EVENT] Test complete.');

// Show log contents
if (fs.existsSync(LOG_PATH)) {
  const logs = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
  console.log(`\n[JOURNAL] Log contains ${logs.length} entries:`);
  logs.forEach((line, i) => {
    const entry = JSON.parse(line);
    console.log(`  [${i+1}] ${new Date(entry.timestamp).toISOString()} - ${entry.type}: ${entry.message}`);
  });
}
