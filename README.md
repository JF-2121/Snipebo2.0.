# Minimal Render.com Implementation

## Changes Required (3 files only)

### 1. Add HTTP Server to `src/index.ts`

```typescript
import { startBot } from './discordbot.js';
import { logger } from './lib/logger.js';
import http from 'http';

// Lightweight health check server (like Python reference)
function startHealthServer() {
  const port = parseInt(process.env.PORT || '10000', 10);
  
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Bot is alive!');
    } else {
      res.writeHead(405);
      res.end();
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info(`Health server running on port ${port}`);
  });
}

function main() {
  logger.info('Starte Snipebot Anwendung...');
  
  // Start health server first (non-blocking)
  startHealthServer();
  
  // Start Discord bot
  try {
    startBot();
  } catch (error) {
    logger.error('Fataler Fehler bei der Bot-Initialisierung:', error);
    process.exit(1);
  }
}

main();
```

### 2. Update `package.json`

```json
{
  "name": "snipebot",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "axios": "^1.6.0",
    "discord.js": "^14.14.0",
    "node-cron": "^3.0.3"
  },
  "devDependencies": {
    "typescript": "^5.3.3",
    "@types/node": "^20.11.0",
    "@types/node-cron": "^3.0.11"
  }
}
```

### 3. Create `.env.example`

```bash
DISCORD_BOT_TOKEN=your_token_here
VINTED_TOKEN=optional
WHOP_API_KEY=optional
WHOP_PRODUCT_ID=optional
PORT=10000
```

## Render.com Setup

1. **Create Web Service** (not Background Worker)
2. **Build Command:** `npm install && npm run build`
3. **Start Command:** `npm start`
4. **Environment Variables:** Add `DISCORD_BOT_TOKEN` and others
5. **Health Check Path:** `/` (returns 200)

## UptimeRobot Setup

- **Monitor Type:** HTTP(s)
- **URL:** `https://your-app.onrender.com/`
- **Interval:** 5 minutes
- **Method:** HEAD (more efficient)

## That's It!

No dependencies added. No architecture changes. Just a simple HTTP server running alongside the bot.
