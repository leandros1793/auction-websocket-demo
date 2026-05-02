/**
 * TEST BOTS — Automated auction simulation
 *
 * Spawns N bot clients via socket.io-client.
 * One bot starts the auction, then all bots compete.
 * Designed to trigger anti-snipe at the end.
 *
 * Usage:
 *   node test-bots.js
 *   node test-bots.js --bots 5 --aggressive
 */

const { io } = require('socket.io-client');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const URL        = 'http://localhost:3000';
const NUM_BOTS   = 3;
const ARGS       = process.argv.slice(2);
const AGGRESSIVE = ARGS.includes('--aggressive'); // bots bid more frequently

const BOT_NAMES  = ['Alice', 'Bob', 'Carlos', 'Diana', 'Eva', 'Frank', 'Grace'];

const COL = {
  reset  : '\x1b[0m',
  yellow : '\x1b[33m',
  green  : '\x1b[32m',
  red    : '\x1b[31m',
  cyan   : '\x1b[36m',
  magenta: '\x1b[35m',
  gray   : '\x1b[90m',
  bold   : '\x1b[1m',
};

function ts()   { return new Date().toLocaleTimeString('es-AR', { hour12: false }); }
function pad(s) { return String(s).padEnd(10); }

// ─── BOT FACTORY ─────────────────────────────────────────────────────────────
function createBot(name, index) {
  const socket = io(URL, { transports: ['websocket'] });
  let   state  = null;

  const prefix = `${COL.cyan}[${pad(name)}]${COL.reset}`;

  socket.on('connect', () => {
    console.log(`${prefix} ${COL.green}connected${COL.reset} (${socket.id})`);

    // Bot 0 starts the auction after a short delay
    if (index === 0) {
      setTimeout(() => {
        console.log(`\n${prefix} ${COL.bold}${COL.yellow}▶ Starting auction...${COL.reset}\n`);
        socket.emit('auction:start');
      }, 1000);
    }
  });

  socket.on('auction:state', (s) => {
    state = s;
  });

  socket.on('auction:tick', (t) => {
    state = { ...state, ...t };

    if (t.status !== 'active') return;

    // Each bot decides whether to bid this second
    const timeLeft  = t.timeLeft;
    const amLeading = state.highBidder === name;

    // Base probability: bid every ~5-8 seconds, more often near the end
    let bidProb = AGGRESSIVE ? 0.3 : 0.15;

    // Simulate snipe attempt in last 5 seconds
    if (timeLeft <= 5 && timeLeft > 0) bidProb = AGGRESSIVE ? 0.7 : 0.5;

    // Don't bid if already winning and time > 15s
    if (amLeading && timeLeft > 15) bidProb = 0;

    if (Math.random() > bidProb) return;

    const minBid = state.minNextBid || 100;
    const extra  = Math.floor(Math.random() * 5) * 100; // 0-400 above min
    const amount = minBid + extra;

    console.log(
      `${prefix} ${COL.yellow}→ bid $${amount}${COL.reset} ` +
      `${COL.gray}(timeLeft: ${timeLeft}s)${COL.reset}`
    );
    socket.emit('auction:bid', { bidder: name, amount });
  });

  socket.on('auction:bid_accepted', (b) => {
    if (b.bidder === name) {
      const snipeTag = b.sniped
        ? ` ${COL.red}${COL.bold}⚡ ANTI-SNIPE → extended to ${b.extendedTo}s${COL.reset}`
        : '';
      console.log(
        `${prefix} ${COL.green}✓ Bid #${b.seq} ACCEPTED — $${b.amount}${COL.reset}${snipeTag}`
      );
    }
  });

  socket.on('auction:bid_rejected', (r) => {
    console.log(`${prefix} ${COL.red}✗ Rejected: ${r.msg}${COL.reset}`);
  });

  socket.on('auction:ended', (e) => {
    const won = e.winner === name;
    if (won) {
      console.log(`\n${prefix} ${COL.bold}${COL.green}🏆 WON! Final bid: $${e.finalBid}${COL.reset}`);
    }
    // Disconnect all bots after short delay
    setTimeout(() => socket.disconnect(), 500);
  });

  socket.on('disconnect', () => {
    console.log(`${prefix} ${COL.gray}disconnected${COL.reset}`);
  });

  socket.on('connect_error', (err) => {
    console.error(`${prefix} ${COL.red}Connection error: ${err.message}${COL.reset}`);
    console.error('  → Is the server running? npm start');
    process.exit(1);
  });

  return socket;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
console.log('');
console.log(`${COL.bold}${COL.yellow}══ AUCTION BOTS TEST ══${COL.reset}`);
console.log(`Connecting ${NUM_BOTS} bots to ${URL}`);
console.log(`Mode: ${AGGRESSIVE ? 'AGGRESSIVE' : 'normal'}`);
console.log('');

const bots = BOT_NAMES.slice(0, NUM_BOTS).map((name, i) => createBot(name, i));

// Keep process alive until all disconnect
let disconnected = 0;
bots.forEach(bot => {
  bot.on('disconnect', () => {
    disconnected++;
    if (disconnected === bots.length) {
      console.log(`\n${COL.gray}All bots disconnected. Done.${COL.reset}\n`);
      process.exit(0);
    }
  });
});

// Safety exit after 120s
setTimeout(() => {
  console.log('\nTimeout — forcing exit.');
  process.exit(0);
}, 120_000);
