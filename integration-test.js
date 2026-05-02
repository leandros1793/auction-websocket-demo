/**
 * Self-contained integration test.
 * Boots the server in-process, runs assertions via a WS client.
 * Run with: node integration-test.js
 */

const { createServer } = require('http');
const express          = require('express');
const { Server }       = require('socket.io');
const { io: ClientIO } = require('socket.io-client');

// ── Config (shorter durations for fast tests) ────────────────────────────────
const CONFIG = {
  AUCTION_DURATION  : 12,
  ANTI_SNIPE_WINDOW : 5,
  EXTENSION_SECONDS : 5,
  MIN_BID_INCREMENT : 100,
};

// ── AuctionManager (mirrors server.js logic) ─────────────────────────────────
let IO; // set after Server is created

class AuctionManager {
  constructor() { this._timer = null; this.reset(); }

  reset() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._state = {
      status: 'waiting', currentBid: 0,
      minNextBid: CONFIG.MIN_BID_INCREMENT,
      highBidder: null, timeLeft: CONFIG.AUCTION_DURATION,
      bids: [], extensionCount: 0, lastExtendedBy: null,
    };
  }

  getState() { return Object.assign({}, this._state, { bids: this._state.bids.slice() }); }

  start() {
    if (this._state.status !== 'waiting') return { ok: false };
    this._state.status   = 'active';
    this._state.timeLeft = CONFIG.AUCTION_DURATION;
    this._timer          = setInterval(() => this._tick(), 1000);
    return { ok: true };
  }

  _tick() {
    if (this._state.status !== 'active') return;
    this._state.timeLeft = Math.max(0, this._state.timeLeft - 1);
    IO.emit('auction:tick', {
      timeLeft: this._state.timeLeft, status: this._state.status,
      currentBid: this._state.currentBid, highBidder: this._state.highBidder,
      extensionCount: this._state.extensionCount,
    });
    if (this._state.timeLeft === 0) this._end();
  }

  _end() {
    clearInterval(this._timer); this._timer = null;
    this._state.status = 'ended';
    IO.emit('auction:ended', {
      winner: this._state.highBidder, finalBid: this._state.currentBid,
      extensionCount: this._state.extensionCount, totalBids: this._state.bids.length,
    });
  }

  placeBid(bidder, amount, socketId) {
    if (this._state.status !== 'active') return { ok: false, msg: 'not active' };
    const amt = Number(amount);
    const min = this._state.currentBid + CONFIG.MIN_BID_INCREMENT;
    if (amt < min) return { ok: false, msg: 'too low', minRequired: min };

    const sniped = this._state.timeLeft <= CONFIG.ANTI_SNIPE_WINDOW;
    const prevTL = this._state.timeLeft;
    if (sniped) {
      this._state.timeLeft      = CONFIG.EXTENSION_SECONDS;
      this._state.extensionCount++;
      this._state.lastExtendedBy = bidder;
    }
    const bid = {
      seq: this._state.bids.length + 1, bidder, amount: amt, socketId,
      timeLeft: prevTL, sniped, extendedTo: sniped ? CONFIG.EXTENSION_SECONDS : null,
      ts: new Date().toISOString(),
    };
    this._state.currentBid = amt;
    this._state.minNextBid = amt + CONFIG.MIN_BID_INCREMENT;
    this._state.highBidder = bidder;
    this._state.bids.push(bid);
    return { ok: true, bid, sniped };
  }
}

// ── Boot test server ─────────────────────────────────────────────────────────
const app      = express();
const httpSrv  = createServer(app);
IO             = new Server(httpSrv, { cors: { origin: '*' } });
const auction  = new AuctionManager();

app.use(express.json());
app.get('/api/state',  (_, res) => res.json(auction.getState()));
app.get('/api/config', (_, res) => res.json(CONFIG));

IO.on('connection', (socket) => {
  socket.emit('auction:state', auction.getState());

  socket.on('auction:start', () => {
    const r = auction.start();
    if (r.ok) IO.emit('auction:state', auction.getState());
    else socket.emit('auction:error', { msg: 'cannot start' });
  });

  socket.on('auction:bid', (data) => {
    const r = auction.placeBid(data.bidder, data.amount, socket.id);
    if (r.ok) {
      IO.emit('auction:bid_accepted', {
        seq: r.bid.seq, bidder: r.bid.bidder, amount: r.bid.amount,
        timeLeft: auction.getState().timeLeft, sniped: r.sniped,
        extendedTo: r.bid.extendedTo, minNextBid: auction.getState().minNextBid,
        totalBids: auction.getState().bids.length,
      });
      IO.emit('auction:state', auction.getState());
    } else {
      socket.emit('auction:bid_rejected', { msg: r.msg, amount: data.amount, minRequired: r.minRequired });
    }
  });

  socket.on('auction:reset', () => { auction.reset(); IO.emit('auction:state', auction.getState()); });
});

// ── Test runner ──────────────────────────────────────────────────────────────
const PORT  = 3099;
let passed  = 0;
let failed  = 0;

function ok(label)         { console.log('  \u2705 ' + label); passed++; }
function fail(label, note) { console.log('  \u274C ' + label + (note ? '  [' + note + ']' : '')); failed++; }
function assert(label, cond, note) { if (cond) ok(label); else fail(label, note); }

httpSrv.listen(PORT, async () => {
  console.log('\n\u2550\u2550 AUCTION INTEGRATION TESTS \u2550\u2550\n');

  try {
    await testInitialState();
    await testWsFlowAndAntiSnipe();
    await testBidRejection();
    await testReset();
  } catch (e) {
    console.error('Unexpected error:', e.message);
    failed++;
  }

  console.log('\n\u2550\u2550 RESULTS: ' + passed + ' passed, ' + failed + ' failed \u2550\u2550\n');
  httpSrv.close();
  process.exit(failed > 0 ? 1 : 0);
});

// ── T1: REST initial state ───────────────────────────────────────────────────
async function testInitialState() {
  console.log('T1: Initial state (REST /api/state)');
  const s = await fetch('http://localhost:' + PORT + '/api/state').then(r => r.json());
  assert('status = waiting',            s.status === 'waiting');
  assert('currentBid = 0',              s.currentBid === 0);
  assert('timeLeft = AUCTION_DURATION', s.timeLeft === CONFIG.AUCTION_DURATION);
  assert('minNextBid = MIN_INCREMENT',  s.minNextBid === CONFIG.MIN_BID_INCREMENT);
  assert('bids array empty',            Array.isArray(s.bids) && s.bids.length === 0);
}

// ── T2: Full WS flow + anti-snipe ────────────────────────────────────────────
async function testWsFlowAndAntiSnipe() {
  console.log('\nT2: WebSocket flow + anti-snipe extension');

  return new Promise(function(resolve) {
    const cli       = ClientIO('http://localhost:' + PORT, { transports: ['websocket'] });
    const events    = [];
    let   antiSnipeFired = false;
    let   endPayload     = null;
    let   sniperBidSent  = false;

    cli.on('connect', function() {
      events.push('connected');
      cli.emit('auction:start');
    });

    cli.on('auction:state', function(s) {
      if (s.status === 'active' && events.indexOf('started') === -1) {
        events.push('started');
        // First bid — should be accepted
        cli.emit('auction:bid', { bidder: 'Alice', amount: 100 });
      }
    });

    cli.on('auction:tick', function(t) {
      // Fire snipe bid exactly at the anti-snipe boundary
      if (t.timeLeft === CONFIG.ANTI_SNIPE_WINDOW - 1 && !sniperBidSent) {
        sniperBidSent = true;
        const minBid = auction.getState().minNextBid;
        cli.emit('auction:bid', { bidder: 'Sniper', amount: minBid });
      }
    });

    cli.on('auction:bid_accepted', function(b) {
      events.push('bid:' + b.seq);
      if (b.sniped) {
        antiSnipeFired = true;
        events.push('sniped');
        assert('Anti-snipe: extendedTo = EXTENSION_SECONDS', b.extendedTo === CONFIG.EXTENSION_SECONDS, 'got ' + b.extendedTo);
        assert('Anti-snipe: sniped flag is true',            b.sniped === true);
      }
    });

    cli.on('auction:bid_rejected', function(r) {
      events.push('rejected');
    });

    cli.on('auction:ended', function(e) {
      endPayload = e;
      cli.disconnect();
    });

    cli.on('disconnect', function() {
      assert('WS connected',             events.indexOf('connected') !== -1);
      assert('Auction started',          events.indexOf('started')   !== -1);
      assert('First bid accepted (seq1)',events.indexOf('bid:1')     !== -1);
      assert('Anti-snipe triggered',     antiSnipeFired, 'events: ' + events.join(', '));
      assert('extensionCount >= 1',      (endPayload && endPayload.extensionCount >= 1), JSON.stringify(endPayload));
      assert('Auction ended with winner',endPayload && !!endPayload.winner);
      resolve();
    });
  });
}

// ── T3: Bid rejection (below minimum) ───────────────────────────────────────
async function testBidRejection() {
  console.log('\nT3: Bid rejection — amount below minimum');
  auction.reset();

  return new Promise(function(resolve) {
    const cli        = ClientIO('http://localhost:' + PORT, { transports: ['websocket'] });
    let   rejected   = false;
    let   minReturned = null;

    cli.on('connect', function() {
      cli.emit('auction:start');
    });

    cli.on('auction:state', function(s) {
      if (s.status === 'active' && !rejected) {
        // First bid: valid
        cli.emit('auction:bid', { bidder: 'Bob', amount: 100 });
      }
    });

    cli.on('auction:bid_accepted', function() {
      // Now try to bid below minimum (current=100, min next=200)
      cli.emit('auction:bid', { bidder: 'Bob', amount: 50 });
    });

    cli.on('auction:bid_rejected', function(r) {
      rejected    = true;
      minReturned = r.minRequired;
      assert('Bid rejected for low amount',        true);
      assert('minRequired is correct (200)',        r.minRequired === 200, 'got ' + r.minRequired);
      auction.reset();
      cli.disconnect();
    });

    cli.on('disconnect', function() {
      assert('Rejection event received', rejected);
      resolve();
    });

    // Safety: if no rejection fires in 5s, move on
    setTimeout(function() { if (!rejected) { fail('Rejection event received', 'timeout'); cli.disconnect(); } }, 5000);
  });
}

// ── T4: Reset ────────────────────────────────────────────────────────────────
async function testReset() {
  console.log('\nT4: Auction reset');

  return new Promise(function(resolve) {
    const cli = ClientIO('http://localhost:' + PORT, { transports: ['websocket'] });
    let stateAfterReset = null;

    cli.on('connect', function() {
      cli.emit('auction:start');
    });

    cli.on('auction:state', function(s) {
      if (s.status === 'active') {
        cli.emit('auction:bid', { bidder: 'Carl', amount: 100 });
      }
      if (s.status === 'waiting' && stateAfterReset === null) {
        stateAfterReset = s;
        assert('After reset: status = waiting',   s.status === 'waiting');
        assert('After reset: currentBid = 0',     s.currentBid === 0);
        assert('After reset: highBidder = null',  s.highBidder === null);
        assert('After reset: bids = []',          s.bids.length === 0);
        cli.disconnect();
      }
    });

    cli.on('auction:bid_accepted', function() {
      // Trigger reset
      cli.emit('auction:reset');
    });

    cli.on('disconnect', function() { resolve(); });

    setTimeout(function() { cli.disconnect(); resolve(); }, 8000);
  });
}
