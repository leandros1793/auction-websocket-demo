/**
 * AUCTION SERVER — WebSocket + Server-side Timer + Anti-Sniping
 * Stack: Node.js + Express + Socket.io
 *
 * Anti-snipe rule: if a bid arrives when timeLeft <= ANTI_SNIPE_WINDOW,
 * the clock resets to EXTENSION_SECONDS, guaranteeing fair final seconds.
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  AUCTION_DURATION   : 30,   // initial countdown (seconds) — short for demo
  ANTI_SNIPE_WINDOW  : 10,   // bids in last N seconds trigger extension
  EXTENSION_SECONDS  : 10,   // clock resets to this on anti-snipe
  MIN_BID_INCREMENT  : 100,  // minimum raise over current bid
};

// ─── AUCTION MANAGER ─────────────────────────────────────────────────────────
class AuctionManager {
  constructor() { this._timer = null; this.reset(); }

  // ── State ──
  reset() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._state = {
      auctionId      : 'DEMO-001',
      item           : 'Lote #7 — Obra Abstracta (demo)',
      status         : 'waiting',   // waiting | active | ended
      currentBid     : 0,
      minNextBid     : CONFIG.MIN_BID_INCREMENT,
      highBidder     : null,
      timeLeft       : CONFIG.AUCTION_DURATION,
      bids           : [],          // full history
      extensionCount : 0,
      lastExtendedBy : null,
      startedAt      : null,
      endedAt        : null,
    };
  }

  getState() { return { ...this._state, bids: [...this._state.bids] }; }

  // ── Start ──
  start() {
    if (this._state.status !== 'waiting')
      return { ok: false, msg: `Cannot start — auction is "${this._state.status}"` };

    this._state.status    = 'active';
    this._state.timeLeft  = CONFIG.AUCTION_DURATION;
    this._state.startedAt = new Date().toISOString();

    this._timer = setInterval(() => this._tick(), 1000);
    console.log(`\n[START] Auction started — ${CONFIG.AUCTION_DURATION}s on the clock`);
    return { ok: true };
  }

  // ── Timer tick ──
  _tick() {
    if (this._state.status !== 'active') return;

    this._state.timeLeft = Math.max(0, this._state.timeLeft - 1);

    // Broadcast lightweight tick (avoid sending full bid history every second)
    io.emit('auction:tick', {
      timeLeft       : this._state.timeLeft,
      status         : this._state.status,
      currentBid     : this._state.currentBid,
      highBidder     : this._state.highBidder,
      extensionCount : this._state.extensionCount,
    });

    if (this._state.timeLeft === 0) this._end();
  }

  // ── End ──
  _end() {
    clearInterval(this._timer);
    this._timer = null;
    this._state.status  = 'ended';
    this._state.endedAt = new Date().toISOString();

    const payload = {
      winner         : this._state.highBidder,
      finalBid       : this._state.currentBid,
      item           : this._state.item,
      extensionCount : this._state.extensionCount,
      totalBids      : this._state.bids.length,
      endedAt        : this._state.endedAt,
    };

    io.emit('auction:ended', payload);

    console.log('\n══════════════════════════════════════');
    console.log(' AUCTION ENDED');
    console.log(` Winner      : ${payload.winner || 'No bids'}`);
    console.log(` Final bid   : $${payload.finalBid}`);
    console.log(` Total bids  : ${payload.totalBids}`);
    console.log(` Extensions  : ${payload.extensionCount}`);
    console.log('══════════════════════════════════════\n');
  }

  // ── Place bid ──
  placeBid({ bidder, amount, socketId }) {
    if (this._state.status !== 'active')
      return { ok: false, msg: `Auction is "${this._state.status}"` };

    if (!bidder || typeof bidder !== 'string' || bidder.trim() === '')
      return { ok: false, msg: 'Bidder name is required' };

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0)
      return { ok: false, msg: 'Invalid amount' };

    const minRequired = this._state.currentBid + CONFIG.MIN_BID_INCREMENT;
    if (amt < minRequired)
      return { ok: false, msg: `Bid too low — minimum is $${minRequired}`, minRequired };

    // ── ANTI-SNIPE CHECK ──────────────────────────────────────────────────────
    const sniped = this._state.timeLeft <= CONFIG.ANTI_SNIPE_WINDOW;
    const prevTimeLeft = this._state.timeLeft;

    if (sniped) {
      this._state.timeLeft     = CONFIG.EXTENSION_SECONDS;
      this._state.extensionCount++;
      this._state.lastExtendedBy = bidder.trim();

      console.log(
        `[ANTI-SNIPE] Bid by "${bidder}" at ${prevTimeLeft}s ` +
        `→ clock extended to ${CONFIG.EXTENSION_SECONDS}s ` +
        `(extension #${this._state.extensionCount})`
      );
    }

    // ── Record bid ────────────────────────────────────────────────────────────
    const bid = {
      seq        : this._state.bids.length + 1,
      bidder     : bidder.trim(),
      amount     : amt,
      socketId,
      timeLeft   : prevTimeLeft,
      sniped,
      extendedTo : sniped ? CONFIG.EXTENSION_SECONDS : null,
      ts         : new Date().toISOString(),
    };

    this._state.currentBid  = amt;
    this._state.minNextBid  = amt + CONFIG.MIN_BID_INCREMENT;
    this._state.highBidder  = bidder.trim();
    this._state.bids.push(bid);

    console.log(
      `[BID #${bid.seq}] ${bid.bidder}: $${bid.amount} ` +
      `| timeLeft: ${this._state.timeLeft}s ` +
      `| sniped: ${sniped}`
    );

    return { ok: true, bid, sniped, extendedTo: bid.extendedTo };
  }
}

const auction = new AuctionManager();

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT]    ${socket.id}`);

  // Sync new client with current state immediately
  socket.emit('auction:state', auction.getState());

  // ── Start auction ──
  socket.on('auction:start', () => {
    const result = auction.start();
    if (result.ok) {
      io.emit('auction:state', auction.getState());
    } else {
      socket.emit('auction:error', { msg: result.msg });
    }
  });

  // ── Place bid ──
  socket.on('auction:bid', ({ bidder, amount }) => {
    const result = auction.placeBid({ bidder, amount, socketId: socket.id });

    if (result.ok) {
      // Broadcast accepted bid to ALL clients
      io.emit('auction:bid_accepted', {
        seq        : result.bid.seq,
        bidder     : result.bid.bidder,
        amount     : result.bid.amount,
        timeLeft   : auction.getState().timeLeft,
        sniped     : result.sniped,
        extendedTo : result.extendedTo,
        minNextBid : auction.getState().minNextBid,
        totalBids  : auction.getState().bids.length,
      });
      // Also push updated full state
      io.emit('auction:state', auction.getState());
    } else {
      // Only the sender gets the rejection
      socket.emit('auction:bid_rejected', {
        msg        : result.msg,
        amount,
        minRequired: result.minRequired,
      });
    }
  });

  // ── Reset (dev/test convenience) ──
  socket.on('auction:reset', () => {
    auction.reset();
    console.log('[RESET] Auction reset to initial state');
    io.emit('auction:state', auction.getState());
  });

  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);
  });
});

// ─── REST (quick state inspection without WS client) ─────────────────────────
app.get('/api/state', (_req, res) => res.json(auction.getState()));
app.get('/api/config', (_req, res) => res.json(CONFIG));

// ─── BOOT ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   AUCTION WEBSOCKET SERVER — READY   ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  URL          : http://localhost:${PORT}`);
  console.log(`  Duration     : ${CONFIG.AUCTION_DURATION}s`);
  console.log(`  Anti-snipe   : last ${CONFIG.ANTI_SNIPE_WINDOW}s`);
  console.log(`  Extension    : ${CONFIG.EXTENSION_SECONDS}s`);
  console.log(`  Min increment: $${CONFIG.MIN_BID_INCREMENT}`);
  console.log('');
  console.log('  Open multiple browser tabs to test.');
  console.log('  Or run:  node test-bots.js');
  console.log('');
});
