/*
 * Yaniv networking layer (Phase 2)
 * Host-authoritative room logic + transport abstraction.
 *
 *   Transport { open(id?) -> Promise<ownId>, connect(remoteId) -> Conn, onConnection(fn), close() }
 *   Conn      { send(obj), onMessage(fn), onClose(fn), close(), remoteId }
 *
 * Two transports are provided:
 *   createMemoryHub().createTransport()  - in-memory, for Node tests
 *   createPeerTransport(options)         - PeerJS (browser only; uses global `Peer` when present)
 *
 * UMD-ish: browser -> window.YanivNet, Node -> module.exports
 * Does not depend on engine.js directly: the engine is injected into createHost.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.YanivNet = api;
  } else if (root) {
    root.YanivNet = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROTO = 1;
  var CODE_CHARS = '0123456789'; // room code = 4 digits ("0000".."9999")
  var TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var CODE_LEN = 4;
  var CODE_RE = /^\d{4}$/;
  var TOKEN_LEN = 16;
  var NAME_MAX = 12;
  var MAX_CODE_ATTEMPTS = 8;
  // App-specific prefix on the public PeerJS server: 4 digits alone would collide with other apps easily.
  var PEER_PREFIX = 'yaniv-kmz7-';
  var STAMP_INTERVAL_MS = 1500;

  /** Stamps (online only). Fixed ids -> emoji/label; the UI renders only these strings. */
  var STAMPS = [
    { id: 'joy', emoji: '😆', label: '嬉しい' },
    { id: 'angry', emoji: '😡', label: '怒り' },
    { id: 'sad', emoji: '😭', label: '悲しい' },
    { id: 'smug', emoji: '😏', label: 'ドヤ' },
    { id: 'shock', emoji: '😱', label: 'やばい' },
    { id: 'think', emoji: '🤔', label: '考え中' },
    { id: 'clap', emoji: '👏', label: 'ナイス' },
    { id: 'pray', emoji: '🙏', label: 'お願い' }
  ];
  function isStampId(id) {
    if (typeof id !== 'string') return false;
    for (var i = 0; i < STAMPS.length; i++) if (STAMPS[i].id === id) return true;
    return false;
  }

  // ---------- small helpers ----------
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function isInt(x) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x; }

  var cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') ? globalThis.crypto : null;
  function defaultRandom() {
    if (cryptoObj) {
      try {
        var buf = new Uint32Array(1);
        cryptoObj.getRandomValues(buf);
        return buf[0] / 4294967296;
      } catch (e) { /* fall through */ }
    }
    return Math.random();
  }

  function randomString(chars, len, rnd) {
    rnd = rnd || defaultRandom;
    var out = '';
    for (var i = 0; i < len; i++) out += chars.charAt(Math.floor(rnd() * chars.length) % chars.length);
    return out;
  }
  function randomCode(rnd) { return randomString(CODE_CHARS, CODE_LEN, rnd); }
  function randomToken(rnd) { return randomString(TOKEN_CHARS, TOKEN_LEN, rnd); }

  /**
   * Normalize user/URL input: full-width digits -> half-width, drop spaces/hyphens.
   * Does NOT strip other characters or truncate, so an old 6-char code ("ABC234") stays invalid
   * instead of silently turning into a different 4-digit room.
   */
  function normalizeCode(code) {
    if (typeof code !== 'string') return '';
    return code
      .replace(/[\uFF10-\uFF19]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
      .replace(/[\s\u3000\-\u2010-\u2015\u2212\u30FC\uFF0D]/g, '')
      .slice(0, 32);
  }
  function isValidCode(code) {
    return typeof code === 'string' && CODE_RE.test(code);
  }
  /** normalizeCode + validate; returns '' unless the result is exactly 4 digits. */
  function sanitizeCode(code) {
    var c = normalizeCode(code);
    return isValidCode(c) ? c : '';
  }
  /**
   * Parse what the user typed/pasted into the join field (pure; UI uses it, tests cover it).
   * Returns { value, code, error, fromUrl }:
   *   - a pasted share URL (or any text containing "room=1234", full-width digits OK) -> its 4 digits
   *   - digits only (after normalizeCode): 0-3 digits = still typing (no error), 4 = complete
   *   - anything else (letters such as an old "AB2345", 5+ digits) -> error; digits are NOT extracted,
   *     so an old code can never silently turn into a different 4-digit room.
   * value: what the input should show (normalized when OK, the raw text when in error).
   */
  function parseCodeInput(raw) {
    var str = typeof raw === 'string' ? raw : '';
    var half = str.replace(/[\uFF10-\uFF19]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
    var m = /room[=\uFF1D](\d{4})(?!\d)/i.exec(half);
    if (m) return { value: m[1], code: m[1], error: false, fromUrl: true };
    var n = String(half).replace(/[\s\u3000\-\u2010-\u2015\u2212\u30FC\uFF0D]/g, '');
    if (/^\d{0,4}$/.test(n)) return { value: n, code: n.length === CODE_LEN ? n : '', error: false, fromUrl: false };
    return { value: str, code: '', error: true, fromUrl: false };
  }
  function peerIdFor(code) { return PEER_PREFIX + code; }

  function sanitizeName(x) {
    if (typeof x !== 'string') return '';
    return x.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  }
  function isValidToken(t) {
    return typeof t === 'string' && t.length === TOKEN_LEN && /^[A-Za-z0-9]+$/.test(t);
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function callAll(list, a, b) {
    for (var i = 0; i < list.length; i++) {
      try { list[i](a, b); } catch (e) { /* listener errors must not break the room */ }
    }
  }

  function moveKey(m) {
    if (m.type === 'yaniv') return 'yaniv';
    return 'play|' + m.discard.slice().sort().join(',') + '|' + m.draw;
  }

  /** Validate and normalize a move coming over the wire. Returns null if malformed. */
  function normalizeMove(raw) {
    if (!isObj(raw)) return null;
    if (raw.type === 'yaniv') return { type: 'yaniv' };
    if (raw.type !== 'play') return null;
    if (!Array.isArray(raw.discard) || raw.discard.length === 0 || raw.discard.length > 16) return null;
    var discard = [];
    for (var i = 0; i < raw.discard.length; i++) {
      if (typeof raw.discard[i] !== 'string' || raw.discard[i].length > 16) return null;
      discard.push(raw.discard[i]);
    }
    if (typeof raw.draw !== 'string' || raw.draw.length > 16) return null;
    return { type: 'play', discard: discard, draw: raw.draw };
  }

  // =====================================================================
  // In-memory transport (tests, and usable for same-page simulations)
  // =====================================================================
  function createMemoryHub() {
    var registry = {};   // id -> transport record
    var counter = 0;
    var pending = 0;

    function later(fn) {
      pending++;
      setTimeout(function () { pending--; try { fn(); } catch (e) { /* ignore */ } }, 0);
    }

    function makeConn(remoteId) {
      var c = {
        remoteId: remoteId,
        _peer: null,
        _msgHandlers: [],
        _closeHandlers: [],
        _closed: false,
        send: function (obj) {
          if (c._closed) return;
          var copy;
          try { copy = clone(obj === undefined ? null : obj); } catch (e) { copy = null; }
          var peer = c._peer;
          later(function () {
            if (!peer || peer._closed) return;
            callAll(peer._msgHandlers, copy);
          });
        },
        onMessage: function (fn) { c._msgHandlers.push(fn); },
        onClose: function (fn) { c._closeHandlers.push(fn); },
        close: function (reason) {
          if (c._closed) return;
          c._closed = true;
          var peer = c._peer;
          callAll(c._closeHandlers, reason || 'local');
          if (peer && !peer._closed) later(function () { peer.close('remote'); });
        }
      };
      return c;
    }

    function createTransport() {
      var id = null;
      var connHandlers = [];
      var conns = [];
      var t = {
        open: function (wantedId) {
          return new Promise(function (resolve, reject) {
            var useId = typeof wantedId === 'string' && wantedId ? wantedId : ('mem-' + (++counter));
            if (registry[useId]) {
              var err = new Error('ID "' + useId + '" is taken');
              err.type = 'unavailable-id';
              reject(err);
              return;
            }
            id = useId;
            registry[id] = t;
            resolve(id);
          });
        },
        connect: function (remoteId) {
          if (!id) throw new Error('transport not open');
          var local = makeConn(remoteId);
          var remote = makeConn(id);
          local._peer = remote;
          remote._peer = local;
          conns.push(local);
          var target = registry[remoteId];
          later(function () {
            if (!target || target._closed) {
              local._peer = null;
              local.close('peer-unavailable');
              return;
            }
            target._accept(remote);
          });
          return local;
        },
        onConnection: function (fn) { connHandlers.push(fn); },
        close: function () {
          t._closed = true;
          if (id && registry[id] === t) delete registry[id];
          conns.slice().forEach(function (c) { c.close('local'); });
          id = null;
        },
        _closed: false,
        _accept: function (conn) {
          conns.push(conn);
          callAll(connHandlers, conn);
        },
        /** Test helper: drop every live connection (simulates a network loss) while keeping the transport open. */
        dropConnections: function () {
          conns.slice().forEach(function (c) { c.close('network'); });
          conns = [];
        },
        get id() { return id; }
      };
      return t;
    }

    return {
      createTransport: createTransport,
      /** Wait until no queued deliveries remain (plus a few idle ticks). */
      settle: function () {
        return new Promise(function (resolve) {
          var idle = 0;
          (function loop() {
            setTimeout(function () {
              if (pending > 0) { idle = 0; loop(); return; }
              if (++idle >= 3) { resolve(); return; }
              loop();
            }, 0);
          })();
        });
      },
      has: function (id) { return !!registry[id]; }
    };
  }

  // =====================================================================
  // PeerJS transport (browser)
  // =====================================================================
  function createPeerTransport(options) {
    options = options || {};
    var peer = null;
    var connHandlers = [];
    var wrapped = [];

    function unwrap(c) {
      var i = wrapped.indexOf(c);
      if (i >= 0) wrapped.splice(i, 1);
    }

    /** A connection that never opens and fails asynchronously (used when peer.connect() cannot be attempted). */
    function deadConn(remoteId, reason) {
      var closeHandlers = [];
      var closed = false;
      var c = {
        remoteId: remoteId,
        _isOpen: function () { return false; },
        send: function () { /* dropped */ },
        onMessage: function () { /* never */ },
        onClose: function (fn) { closeHandlers.push(fn); },
        close: function (r) { if (closed) return; closed = true; callAll(closeHandlers, r || 'local'); }
      };
      setTimeout(function () { c.close(reason); }, 0);
      return c;
    }

    function wrap(dc) {
      var open = false;
      var closed = false;
      var queue = [];
      var msgHandlers = [];
      var closeHandlers = [];
      var c = {
        remoteId: dc.peer,
        _dc: dc,
        _isOpen: function () { return open; },
        send: function (obj) {
          if (closed) return;
          if (!open) { queue.push(obj); return; }
          try { dc.send(obj); } catch (e) { /* ignore */ }
        },
        onMessage: function (fn) { msgHandlers.push(fn); },
        onClose: function (fn) { closeHandlers.push(fn); },
        close: function (reason) {
          if (closed) return;
          closed = true;
          unwrap(c);
          // flush:true (PeerJS >= 1.5) waits for buffered messages (e.g. 'closed') to go out first
          try { dc.close({ flush: true }); } catch (e) { try { dc.close(); } catch (e2) { /* ignore */ } }
          callAll(closeHandlers, reason || 'local');
        }
      };
      function fail(reason) {
        if (closed) return;
        closed = true;
        unwrap(c);
        callAll(closeHandlers, reason || 'remote');
      }
      dc.on('open', function () {
        open = true;
        var q = queue; queue = [];
        for (var i = 0; i < q.length; i++) { try { dc.send(q[i]); } catch (e) { /* ignore */ } }
      });
      dc.on('data', function (data) {
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch (e) { return; }
        }
        callAll(msgHandlers, data);
      });
      dc.on('close', function () { fail('remote'); });
      dc.on('error', function () { fail('error'); });
      wrapped.push(c);
      return c;
    }

    var t = {
      open: function (wantedId) {
        return new Promise(function (resolve, reject) {
          if (typeof Peer === 'undefined') {
            reject(new Error('PeerJS not loaded'));
            return;
          }
          var p = new Peer(wantedId || undefined, options.peerOptions || {});
          var settled = false;
          p.on('open', function (id) {
            settled = true;
            peer = p;
            resolve(id);
          });
          p.on('connection', function (dc) {
            var c = wrap(dc);
            callAll(connHandlers, c);
          });
          p.on('error', function (err) {
            var type = err && err.type;
            if (!settled) {
              settled = true;
              try { p.destroy(); } catch (e) { /* ignore */ }
              var e2 = new Error((err && err.message) || String(type || 'peer error'));
              e2.type = type;
              reject(e2);
              return;
            }
            if (type === 'peer-unavailable') {
              wrapped.slice().forEach(function (c) {
                if (!c._isOpen()) c.close('peer-unavailable');
              });
            } else if (type === 'network' || type === 'disconnected' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
              // signaling server lost: already-open data channels keep working; pending ones won't open
              wrapped.slice().forEach(function (c) {
                if (!c._isOpen()) c.close('network');
              });
            }
          });
          p.on('disconnected', function () {
            // try to get back to the signaling server so new peers can still find us
            try { if (!p.destroyed) p.reconnect(); } catch (e) { /* ignore */ }
          });
        });
      },
      connect: function (remoteId) {
        if (!peer) throw new Error('transport not open');
        if (peer.destroyed) return deadConn(remoteId, 'network');
        if (peer.disconnected) {
          // signaling server lost: peer.connect() returns undefined in this state. Kick a reconnect and report failure.
          try { peer.reconnect(); } catch (e) { /* ignore */ }
          return deadConn(remoteId, 'network');
        }
        var dc = null;
        try { dc = peer.connect(remoteId, { reliable: true, serialization: 'json' }); } catch (e) { dc = null; }
        if (!dc) return deadConn(remoteId, 'network');
        return wrap(dc);
      },
      onConnection: function (fn) { connHandlers.push(fn); },
      close: function () {
        wrapped.slice().forEach(function (c) { c.close('local'); });
        if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } }
        peer = null;
      },
      get id() { return peer ? peer.id : null; }
    };
    return t;
  }

  // =====================================================================
  // Host
  // =====================================================================
  /**
   * createHost({ transport, engine, rng?, hostName, random?, codeGen?, cpuDelay? })
   * Call host.open() (Promise<roomCode>) before anything else.
   */
  function createHost(opts) {
    opts = opts || {};
    var transport = opts.transport;
    var E = opts.engine;
    if (!transport) throw new Error('transport required');
    if (!E) throw new Error('engine required');
    var random = typeof opts.random === 'function' ? opts.random : defaultRandom;
    var rng = typeof opts.rng === 'function' ? opts.rng : E.createRng((random() * 0xffffffff) >>> 0);
    var codeGen = typeof opts.codeGen === 'function' ? opts.codeGen : function () { return randomCode(random); };
    var cpuDelay = Array.isArray(opts.cpuDelay) ? opts.cpuDelay : [600, 900];
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };

    var config = { jokers: 2, limit: 101, cpuLevel: 'normal', starter: 'zero', seatCount: 3 };
    var seats = [];
    var state = null;
    var moveNo = 0;
    var cpuTimer = null;
    var closed = false;
    var lobbyHandlers = [];
    var stateHandlers = [];
    var errorHandlers = [];
    var stampHandlers = [];

    function makeSeat(i) {
      return { type: 'empty', name: '', token: null, conn: null, connected: false, isHost: false, lastStamp: -Infinity };
    }
    function initSeats() {
      seats = [];
      for (var i = 0; i < config.seatCount; i++) seats.push(makeSeat(i));
      seats[0] = { type: 'human', name: sanitizeName(opts.hostName) || 'ホスト', token: null, conn: null, connected: true, isHost: true, lastStamp: -Infinity };
    }
    initSeats();

    var host = { roomCode: null };

    // ---------- lobby ----------
    function lobbySnapshot() {
      return {
        roomCode: host.roomCode,
        inGame: !!state,
        phase: state ? state.phase : 'lobby',
        config: clone(config),
        seats: seats.map(function (s) {
          return { name: s.type === 'empty' ? '' : s.name, type: s.type === 'empty' ? 'empty' : s.type, connected: !!s.connected, isHost: !!s.isHost };
        })
      };
    }
    function lobbyMessage() {
      var l = lobbySnapshot();
      return { t: 'lobby', seats: l.seats, config: l.config, inGame: l.inGame, roomCode: l.roomCode };
    }
    function broadcastLobby() {
      var msg = lobbyMessage();
      eachClient(function (s) { s.conn.send(msg); });
      callAll(lobbyHandlers, lobbySnapshot());
    }
    function eachClient(fn) {
      for (var i = 0; i < seats.length; i++) {
        var s = seats[i];
        if (s.isHost || s.type !== 'human' || !s.conn || !s.connected) continue;
        fn(s, i);
      }
    }
    function seatIndexOfConn(conn) {
      for (var i = 0; i < seats.length; i++) if (seats[i].conn === conn) return i;
      return -1;
    }
    function seatIndexOfToken(token) {
      for (var i = 0; i < seats.length; i++) if (seats[i].token && seats[i].token === token) return i;
      return -1;
    }

    // ---------- views ----------
    function viewFor(seat) {
      if (!state) return null;
      var s = state;
      var players = s.players.map(function (p, i) {
        var q = { name: p.name, type: p.type, score: p.score, eliminated: !!p.eliminated, handCount: p.hand.length };
        if (i === seat) q.hand = clone(p.hand);
        return q;
      });
      var top = s.discardPile.length ? s.discardPile[s.discardPile.length - 1] : null;
      var myTurn = s.phase === 'playing' && s.currentPlayer === seat;
      return {
        seat: seat,
        moveNo: moveNo,
        phase: s.phase,
        round: s.round,
        currentPlayer: s.currentPlayer,
        config: clone(s.config),
        players: players,
        deckCount: s.deck.length,
        discardPile: top ? [clone(top)] : [],
        roundResult: s.roundResult ? clone(s.roundResult) : null,
        lastMove: s.lastMove ? clone(s.lastMove) : null,
        winner: s.winner,
        legalMoves: myTurn ? E.legalMoves(s) : [],
        takeable: myTurn ? clone(E.takeableFromDiscard(s)) : [],
        seats: lobbySnapshot().seats
      };
    }
    function broadcastViews() {
      eachClient(function (s, i) { s.conn.send({ t: 'view', view: viewFor(i) }); });
    }
    function afterChange() {
      broadcastViews();
      callAll(stateHandlers, state);
      scheduleCpu();
    }

    // ---------- CPU ----------
    function clearCpu() { if (cpuTimer) { clearTimeout(cpuTimer); cpuTimer = null; } }
    function scheduleCpu() {
      if (cpuTimer || closed) return;
      if (!state || state.phase !== 'playing') return;
      var p = state.players[state.currentPlayer];
      if (p.type !== 'cpu') return;
      var delay = cpuDelay[0] + Math.floor(random() * Math.max(0, cpuDelay[1] - cpuDelay[0] + 1));
      cpuTimer = setTimeout(cpuTurn, delay);
    }
    function cpuTurn() {
      cpuTimer = null;
      if (closed || !state || state.phase !== 'playing') return;
      var pi = state.currentPlayer;
      if (state.players[pi].type !== 'cpu') return;
      try {
        var mv = E.chooseMove(state, pi, state.config.cpuLevel, rng);
        state = E.applyMove(state, mv, rng);
        moveNo++;
      } catch (e) {
        callAll(errorHandlers, { type: 'cpu', message: e && e.message ? e.message : String(e) });
        return;
      }
      afterChange();
    }

    // ---------- moves ----------
    /** Returns null on success, or an error message string. */
    function doMove(seat, rawMove) {
      if (!state || state.phase !== 'playing') return 'ゲームは進行中ではありません';
      if (state.currentPlayer !== seat) return 'あなたの番ではありません';
      var mv = normalizeMove(rawMove);
      if (!mv) return '不正な手です';
      var legal = E.legalMoves(state);
      var key = moveKey(mv);
      var ok = false;
      for (var i = 0; i < legal.length; i++) if (moveKey(legal[i]) === key) { ok = true; break; }
      if (!ok) return mv.type === 'yaniv' ? '手札合計が7点以下のときだけ宣言できます' : 'その手は打てません';
      try {
        state = E.applyMove(state, mv, rng);
        moveNo++;
      } catch (e) {
        return e && e.message ? e.message : '不正な手です';
      }
      afterChange();
      return null;
    }

    // ---------- incoming messages ----------
    function sendSafe(conn, msg) { try { conn.send(msg); } catch (e) { /* ignore */ } }

    function onJoin(conn, msg) {
      if (msg.proto !== PROTO) { sendSafe(conn, { t: 'reject', reason: 'proto' }); conn.close('rejected'); return; }
      var name = sanitizeName(msg.name);
      var existing = seatIndexOfConn(conn);
      if (existing >= 0) {
        // duplicate join on an already seated connection: just resend joined
        sendSafe(conn, { t: 'joined', seat: existing, seatToken: seats[existing].token, roomCode: host.roomCode });
        return;
      }
      if (isValidToken(msg.seatToken)) {
        var si = seatIndexOfToken(msg.seatToken);
        if (si >= 0 && seats[si].type === 'human' && !seats[si].isHost) {
          var s = seats[si];
          if (s.conn && s.conn !== conn) {
            // another tab/connection with the same token takes over: tell the old one to stop reconnecting
            var old = s.conn; s.conn = null;
            sendSafe(old, { t: 'closed', reason: 'replaced' });
            try { old.close('replaced'); } catch (e) { /* ignore */ }
          }
          s.conn = conn;
          s.connected = true;
          if (name) s.name = name;
          sendSafe(conn, { t: 'joined', seat: si, seatToken: s.token, roomCode: host.roomCode });
          broadcastLobby();
          if (state) { sendSafe(conn, { t: 'view', view: viewFor(si) }); callAll(stateHandlers, state); }
          return;
        }
        if (si >= 0) { sendSafe(conn, { t: 'reject', reason: 'replaced' }); conn.close('rejected'); return; }
        // unknown token: fall through to a fresh join
      }
      if (!name) { sendSafe(conn, { t: 'reject', reason: 'name' }); conn.close('rejected'); return; }
      if (state) { sendSafe(conn, { t: 'reject', reason: 'in-progress' }); conn.close('rejected'); return; }
      var free = -1;
      for (var i = 0; i < seats.length; i++) if (seats[i].type === 'empty') { free = i; break; }
      if (free < 0) { sendSafe(conn, { t: 'reject', reason: 'full' }); conn.close('rejected'); return; }
      seats[free] = { type: 'human', name: name, token: randomToken(random), conn: conn, connected: true, isHost: false, lastStamp: -Infinity };
      sendSafe(conn, { t: 'joined', seat: free, seatToken: seats[free].token, roomCode: host.roomCode });
      broadcastLobby();
    }

    function onMove(conn, msg) {
      var seat = seatIndexOfConn(conn);
      if (seat < 0) { sendSafe(conn, { t: 'error', message: '参加していません' }); return; }
      var err = doMove(seat, msg.move);
      if (err) sendSafe(conn, { t: 'error', message: err });
    }

    // ---------- stamps ----------
    /**
     * Validate and broadcast a stamp from `seat`. Silently ignored (returns false) unless:
     * the seat is a connected human, the id is known, the game is 'playing', and
     * STAMP_INTERVAL_MS has passed since that seat's previous stamp.
     */
    function doStamp(seat, id) {
      if (closed || !isInt(seat) || seat < 0 || seat >= seats.length) return false;
      var s = seats[seat];
      if (s.type !== 'human' || !s.connected) return false;
      if (!isStampId(id)) return false;
      if (!state || state.phase !== 'playing') return false;
      var t = now();
      var prev = typeof s.lastStamp === 'number' ? s.lastStamp : -Infinity;
      if (t - prev < STAMP_INTERVAL_MS) return false;
      s.lastStamp = t;
      var msg = { t: 'stamp', seat: seat, id: id };
      eachClient(function (c) { sendSafe(c.conn, msg); });
      callAll(stampHandlers, { seat: seat, id: id });
      return true;
    }

    function onStamp(conn, msg) {
      var seat = seatIndexOfConn(conn);
      if (seat < 0) return;
      doStamp(seat, msg.id);
    }

    function handleMessage(conn, msg) {
      try {
        if (!isObj(msg) || typeof msg.t !== 'string') return;
        if (msg.t === 'join') onJoin(conn, msg);
        else if (msg.t === 'move') onMove(conn, msg);
        else if (msg.t === 'stamp') onStamp(conn, msg);
        else if (msg.t === 'ping') sendSafe(conn, { t: 'pong' });
        // unknown: ignore
      } catch (e) {
        callAll(errorHandlers, { type: 'internal', message: e && e.message ? e.message : String(e) });
      }
    }

    function onConnClosed(conn) {
      var seat = seatIndexOfConn(conn);
      if (seat < 0) return;
      var s = seats[seat];
      s.conn = null;
      s.connected = false;
      broadcastLobby();
      if (state) { broadcastViews(); callAll(stateHandlers, state); }
    }

    transport.onConnection(function (conn) {
      if (closed) { try { conn.close('closed'); } catch (e) { /* ignore */ } return; }
      conn.onMessage(function (msg) { handleMessage(conn, msg); });
      conn.onClose(function () { onConnClosed(conn); });
    });

    // ---------- public API ----------
    host.open = function () {
      var attempt = 0;
      function tryOnce() {
        var code = normalizeCode(codeGen());
        if (!isValidCode(code)) code = randomCode(random);
        attempt++;
        return transport.open(peerIdFor(code)).then(function () {
          host.roomCode = code;
          return code;
        }, function (err) {
          if (err && err.type === 'unavailable-id' && attempt < MAX_CODE_ATTEMPTS) return tryOnce();
          throw err;
        });
      }
      return tryOnce();
    };

    host.setConfig = function (patch) {
      if (state) throw new Error('ゲーム中は設定を変更できません');
      patch = patch || {};
      var next = clone(config);
      if (patch.jokers != null) { if ([0, 1, 2].indexOf(patch.jokers) < 0) throw new Error('jokers'); next.jokers = patch.jokers; }
      if (patch.limit != null) { if ([31, 51, 71, 101].indexOf(patch.limit) < 0) throw new Error('limit'); next.limit = patch.limit; }
      if (patch.cpuLevel != null) { if (['weak', 'normal', 'strong'].indexOf(patch.cpuLevel) < 0) throw new Error('cpuLevel'); next.cpuLevel = patch.cpuLevel; }
      if (patch.starter != null) { if (['zero', 'highest'].indexOf(patch.starter) < 0) throw new Error('starter'); next.starter = patch.starter; }
      if (patch.seatCount != null) {
        if (!isInt(patch.seatCount) || patch.seatCount < 2 || patch.seatCount > 5) throw new Error('seatCount must be 2-5');
        var highest = 0;
        for (var i = 0; i < seats.length; i++) if (seats[i].type !== 'empty') highest = i;
        if (patch.seatCount < highest + 1) throw new Error('席が埋まっているため減らせません');
        next.seatCount = patch.seatCount;
      }
      config = next;
      while (seats.length < config.seatCount) seats.push(makeSeat(seats.length));
      while (seats.length > config.seatCount) seats.pop();
      broadcastLobby();
      return clone(config);
    };

    host.lobby = lobbySnapshot;
    host.config = function () { return clone(config); };
    host.state = function () { return state; };
    host.phase = function () { return state ? state.phase : 'lobby'; };
    host.view = function () { return viewFor(0); };
    host.seat = 0;

    /** Build engine players from the seats (the seats are the source of truth). Empty seats become CPU. */
    function playersFromSeats() {
      if (seats.length < 2) throw new Error('need 2 seats');
      var humans = 0;
      var players = seats.map(function (s, i) {
        if (s.type === 'empty') {
          seats[i] = { type: 'cpu', name: 'CPU ' + (i + 1), token: null, conn: null, connected: false, isHost: false, lastStamp: -Infinity };
          return { name: seats[i].name, type: 'cpu' };
        }
        if (s.type === 'cpu') return { name: s.name || 'CPU ' + (i + 1), type: 'cpu' };
        humans++;
        return { name: s.name, type: 'human' };
      });
      if (humans < 1) throw new Error('人間が1人以上必要です');
      return players;
    }

    host.start = function () {
      if (state) throw new Error('already started');
      var players = playersFromSeats();
      state = E.createGame({ players: players, jokers: config.jokers, limit: config.limit, cpuLevel: config.cpuLevel, starter: config.starter }, rng);
      state = E.startRound(state, rng);
      moveNo = 0;
      broadcastLobby();
      afterChange();
      return state;
    };

    host.nextRound = function () {
      if (!state || state.phase !== 'roundEnd') throw new Error('not at round end');
      state = E.startRound(state, rng);
      moveNo++;
      afterChange();
      return state;
    };

    host.restart = function () {
      if (!state || state.phase !== 'gameOver') throw new Error('not at game over');
      // rebuild from the seats, so a seat replaced by a CPU (or kicked) mid-game stays a CPU
      var cfg = clone(state.config);
      cfg.players = playersFromSeats();
      state = E.createGame(cfg, rng);
      state = E.startRound(state, rng);
      moveNo = 0;
      broadcastLobby();
      afterChange();
      return state;
    };

    host.backToLobby = function () {
      clearCpu();
      state = null;
      moveNo = 0;
      for (var i = 0; i < seats.length; i++) {
        if (seats[i].type === 'cpu') seats[i] = makeSeat(i);
      }
      broadcastLobby();
      callAll(stateHandlers, null);
    };

    host.submitMove = function (move) {
      var err = doMove(0, move);
      return err ? { ok: false, message: err } : { ok: true };
    };

    host.replaceWithCpu = function (seat) {
      if (!isInt(seat) || seat <= 0 || seat >= seats.length) throw new Error('bad seat');
      var s = seats[seat];
      if (s.type !== 'human') return;
      if (s.conn) { var c = s.conn; s.conn = null; sendSafe(c, { t: 'closed', reason: 'cpu' }); try { c.close('cpu'); } catch (e) { /* ignore */ } }
      s.type = 'cpu';
      s.connected = false;
      s.token = null;
      if (state) {
        var next = {};
        for (var k in state) if (Object.prototype.hasOwnProperty.call(state, k)) next[k] = state[k];
        next.players = state.players.map(function (p, i) {
          if (i !== seat) return p;
          var q = {};
          for (var kk in p) if (Object.prototype.hasOwnProperty.call(p, kk)) q[kk] = p[kk];
          q.type = 'cpu';
          return q;
        });
        state = next;
        broadcastLobby();
        afterChange();
      } else {
        seats[seat] = makeSeat(seat);
        broadcastLobby();
      }
    };

    host.kick = function (seat) {
      if (!isInt(seat) || seat <= 0 || seat >= seats.length) throw new Error('bad seat');
      var s = seats[seat];
      if (s.type !== 'human') return;
      if (s.conn) { var c = s.conn; s.conn = null; sendSafe(c, { t: 'closed', reason: 'kicked' }); try { c.close('kicked'); } catch (e) { /* ignore */ } }
      if (state) {
        host.replaceWithCpu(seat);
      } else {
        seats[seat] = makeSeat(seat);
        broadcastLobby();
      }
    };

    host.close = function (reason) {
      if (closed) return;
      closed = true;
      clearCpu();
      var msg = { t: 'closed', reason: reason || 'host-left' };
      for (var i = 0; i < seats.length; i++) {
        var s = seats[i];
        if (s.conn) { sendSafe(s.conn, msg); try { s.conn.close('closed'); } catch (e) { /* ignore */ } s.conn = null; s.connected = false; }
      }
      try { transport.close(); } catch (e) { /* ignore */ }
    };

    /** Host's own stamp: goes through the same validation/rate limit as a client's. Returns true if delivered. */
    host.sendStamp = function (id) { return doStamp(0, id); };

    host.onLobbyChange = function (fn) { lobbyHandlers.push(fn); };
    host.onStateChange = function (fn) { stateHandlers.push(fn); };
    host.onError = function (fn) { errorHandlers.push(fn); };
    host.onStamp = function (fn) { stampHandlers.push(fn); };

    return host;
  }

  // =====================================================================
  // Client
  // =====================================================================
  /**
   * createClient({ transport, roomCode, name, seatToken?, autoReconnect?, connectTimeoutMs?, backoff? })
   * client.connect() -> Promise<{seat, seatToken, roomCode}> (rejects on reject / failure)
   */
  function createClient(opts) {
    opts = opts || {};
    var transport = opts.transport;
    if (!transport) throw new Error('transport required');
    var roomCode = normalizeCode(opts.roomCode);
    var name = sanitizeName(opts.name);
    var seatToken = isValidToken(opts.seatToken) ? opts.seatToken : null;
    var autoReconnect = opts.autoReconnect !== false;
    var connectTimeoutMs = isInt(opts.connectTimeoutMs) ? opts.connectTimeoutMs : 10000;
    var backoff = Array.isArray(opts.backoff) && opts.backoff.length ? opts.backoff : [2000, 4000, 8000, 16000, 30000];

    var H = { lobby: [], view: [], error: [], disconnect: [], joined: [], closed: [], stamp: [] };
    var client = { seat: null, seatToken: seatToken, roomCode: roomCode };

    var opened = false;
    var openPromise = null;
    var conn = null;
    var joinTimer = null;
    var reconnectTimer = null;
    var attempt = 0;
    var everJoined = false;
    var stopped = false;
    var pendingResolve = null;
    var pendingReject = null;

    function clearJoinTimer() { if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; } }
    function clearReconnect() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }

    function settlePending(err, val) {
      var res = pendingResolve, rej = pendingReject;
      pendingResolve = pendingReject = null;
      if (err) { if (rej) rej(err); }
      else if (res) res(val);
    }

    function ensureOpen() {
      if (!openPromise) {
        openPromise = transport.open().then(function () { opened = true; }, function (e) { openPromise = null; throw e; });
      }
      return openPromise;
    }

    function sanitizeLobby(msg) {
      if (!Array.isArray(msg.seats)) return null;
      var seats = [];
      for (var i = 0; i < msg.seats.length && i < 5; i++) {
        var s = msg.seats[i];
        if (!isObj(s)) return null;
        var type = s.type === 'human' || s.type === 'cpu' ? s.type : 'empty';
        seats.push({ name: sanitizeName(s.name), type: type, connected: !!s.connected, isHost: !!s.isHost });
      }
      var cfg = isObj(msg.config) ? msg.config : {};
      return {
        seats: seats,
        inGame: !!msg.inGame,
        roomCode: sanitizeCode(msg.roomCode) || roomCode,
        config: {
          jokers: [0, 1, 2].indexOf(cfg.jokers) >= 0 ? cfg.jokers : 2,
          limit: [31, 51, 71, 101].indexOf(cfg.limit) >= 0 ? cfg.limit : 101,
          cpuLevel: ['weak', 'normal', 'strong'].indexOf(cfg.cpuLevel) >= 0 ? cfg.cpuLevel : 'normal',
          starter: ['zero', 'highest'].indexOf(cfg.starter) >= 0 ? cfg.starter : 'zero',
          seatCount: isInt(cfg.seatCount) ? cfg.seatCount : seats.length
        }
      };
    }

    function validView(v) {
      if (!isObj(v)) return false;
      if (['playing', 'roundEnd', 'gameOver'].indexOf(v.phase) < 0) return false;
      if (!isInt(v.seat) || !Array.isArray(v.players) || v.players.length < 2 || v.players.length > 5) return false;
      if (v.seat < 0 || v.seat >= v.players.length) return false;
      if (!isInt(v.currentPlayer) || !isInt(v.round) || !isInt(v.deckCount)) return false;
      if (!Array.isArray(v.discardPile) || !Array.isArray(v.legalMoves) || !Array.isArray(v.takeable)) return false;
      if (!isObj(v.config) || [31, 51, 71, 101].indexOf(v.config.limit) < 0) return false;
      if (v.config.starter != null && ['zero', 'highest'].indexOf(v.config.starter) < 0) return false;
      for (var i = 0; i < v.players.length; i++) {
        var p = v.players[i];
        if (!isObj(p) || typeof p.name !== 'string' || !isInt(p.handCount) || !isInt(p.score)) return false;
        if (i === v.seat && !Array.isArray(p.hand)) return false;
      }
      if (v.winner != null && (!isInt(v.winner) || v.winner < 0 || v.winner >= v.players.length)) return false;
      if (v.roundResult != null) {
        var r = v.roundResult;
        if (!isObj(r) || !Array.isArray(r.entries) || r.entries.length !== v.players.length) return false;
        if (!isInt(r.round) || !isInt(r.declarer) || r.declarer < 0 || r.declarer >= v.players.length) return false;
        if (r.assaf != null && (!isInt(r.assaf) || r.assaf < 0 || r.assaf >= v.players.length)) return false;
        if (r.declarerValue != null && !isInt(r.declarerValue)) return false;
        for (var k = 0; k < r.entries.length; k++) {
          var en = r.entries[k];
          if (!isObj(en) || typeof en.name !== 'string' || !Array.isArray(en.hand)) return false;
          if (!isInt(en.added) || !isInt(en.total)) return false;
          if (en.value != null && !isInt(en.value)) return false;
        }
      } else if (v.phase !== 'playing') {
        return false; // roundEnd / gameOver must carry a roundResult
      }
      return true;
    }

    function handle(msg) {
      try {
        if (!isObj(msg) || typeof msg.t !== 'string') return;
        switch (msg.t) {
          case 'joined':
            if (!isInt(msg.seat) || msg.seat < 0 || msg.seat > 4 || !isValidToken(msg.seatToken)) return;
            clearJoinTimer();
            client.seat = msg.seat;
            client.seatToken = seatToken = msg.seatToken;
            if (typeof msg.roomCode === 'string') client.roomCode = sanitizeCode(msg.roomCode) || roomCode;
            everJoined = true;
            attempt = 0;
            var info = { seat: client.seat, seatToken: seatToken, roomCode: client.roomCode };
            callAll(H.joined, info);
            settlePending(null, info);
            break;
          case 'reject':
            clearJoinTimer();
            stopped = true;
            var reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 40) : 'unknown';
            callAll(H.error, { type: 'reject', reason: reason });
            settlePending(Object.assign(new Error('rejected: ' + reason), { reason: reason }));
            if (conn) { var c0 = conn; conn = null; c0.close('rejected'); }
            break;
          case 'lobby':
            var l = sanitizeLobby(msg);
            if (l) callAll(H.lobby, l);
            break;
          case 'view':
            if (validView(msg.view)) callAll(H.view, msg.view);
            break;
          case 'error':
            callAll(H.error, { type: 'error', message: typeof msg.message === 'string' ? msg.message.slice(0, 200) : 'エラー' });
            break;
          case 'closed':
            clearJoinTimer();
            stopped = true;
            clearReconnect();
            var r2 = typeof msg.reason === 'string' ? msg.reason.slice(0, 40) : 'closed';
            callAll(H.closed, { reason: r2 });
            settlePending(Object.assign(new Error('closed: ' + r2), { reason: r2 }));
            if (conn) { var c1 = conn; conn = null; c1.close('closed'); }
            break;
          case 'stamp':
            if (!isInt(msg.seat) || msg.seat < 0 || msg.seat > 4 || !isStampId(msg.id)) return;
            callAll(H.stamp, { seat: msg.seat, id: msg.id });
            break;
          case 'pong':
            break;
          default:
            break; // unknown: ignore
        }
      } catch (e) { /* never let a bad message take the client down */ }
    }

    function scheduleReconnect(reason) {
      var delay = backoff[Math.min(attempt, backoff.length - 1)];
      attempt++;
      callAll(H.disconnect, { reason: typeof reason === 'string' ? reason : 'closed', attempt: attempt, nextDelayMs: autoReconnect ? delay : null });
      if (autoReconnect) {
        clearReconnect();
        reconnectTimer = setTimeout(function () {
          reconnectTimer = null;
          // any failure path of attemptConnect must lead back here, or the loop would stop silently
          attemptConnect().catch(function (e) { onAttemptFailed(e); });
        }, delay);
      }
    }

    /** attemptConnect() rejected before a conn was even established. */
    function onAttemptFailed(err) {
      if (stopped) return;
      if (reconnectTimer) return; // already scheduled by onConnClose
      if (!everJoined) { settlePending(err); return; }
      scheduleReconnect((err && err.reason) || 'open-failed');
    }

    function onConnClose(reason) {
      conn = null;
      clearJoinTimer();
      if (stopped) return;
      if (!everJoined) {
        // initial connection failed: report, do not loop forever
        callAll(H.error, { type: 'connect-failed', reason: typeof reason === 'string' ? reason : 'closed' });
        settlePending(Object.assign(new Error('connect failed'), { reason: reason }));
        return;
      }
      scheduleReconnect(reason);
    }

    function attemptConnect() {
      if (stopped) return Promise.reject(new Error('stopped'));
      if (!isValidCode(roomCode)) {
        var e = new Error('bad room code');
        callAll(H.error, { type: 'connect-failed', reason: 'bad-code' });
        return Promise.reject(e);
      }
      return ensureOpen().then(function () {
        if (stopped) throw new Error('stopped');
        if (conn) { var old = conn; conn = null; old.close('local'); }
        var c = transport.connect(peerIdFor(roomCode));
        if (!c || typeof c.onMessage !== 'function') {
          throw Object.assign(new Error('transport.connect returned no connection'), { reason: 'network' });
        }
        conn = c;
        c.onMessage(function (m) { if (conn === c) handle(m); });
        c.onClose(function (reason) { if (conn === c) onConnClose(reason); });
        var join = { t: 'join', name: name, proto: PROTO };
        if (seatToken) join.seatToken = seatToken;
        c.send(join);
        clearJoinTimer();
        if (connectTimeoutMs > 0) {
          joinTimer = setTimeout(function () {
            joinTimer = null;
            if (conn === c) { conn = null; c.close('timeout'); onConnClose('timeout'); }
          }, connectTimeoutMs);
        }
      }, function (err) {
        if (!everJoined) {
          callAll(H.error, { type: 'connect-failed', reason: 'open-failed', message: err && err.message });
          settlePending(err);
        }
        if (!err || typeof err !== 'object') err = new Error(String(err));
        if (!err.reason) err.reason = 'open-failed';
        throw err;
      });
    }

    client.connect = function () {
      return new Promise(function (resolve, reject) {
        pendingResolve = resolve;
        pendingReject = reject;
        attemptConnect().catch(function (e) { settlePending(e); onAttemptFailed(e); });
      });
    };
    client.reconnect = function () {
      clearReconnect();
      if (stopped) return Promise.reject(new Error('stopped'));
      return new Promise(function (resolve, reject) {
        pendingResolve = resolve;
        pendingReject = reject;
        attemptConnect().catch(function (e) { settlePending(e); onAttemptFailed(e); });
      });
    };
    client.submitMove = function (move) {
      if (!conn) { callAll(H.error, { type: 'error', message: 'ホストに接続していません' }); return false; }
      conn.send({ t: 'move', move: move });
      return true;
    };
    client.ping = function () { if (conn) conn.send({ t: 'ping' }); };
    client.sendStamp = function (id) {
      if (!conn || !isStampId(id)) return false;
      conn.send({ t: 'stamp', id: id });
      return true;
    };
    client.isConnected = function () { return !!conn; };
    client.leave = function () {
      stopped = true;
      clearJoinTimer();
      clearReconnect();
      if (conn) { var c = conn; conn = null; c.close('local'); }
      try { transport.close(); } catch (e) { /* ignore */ }
    };
    client.onLobby = function (fn) { H.lobby.push(fn); };
    client.onView = function (fn) { H.view.push(fn); };
    client.onError = function (fn) { H.error.push(fn); };
    client.onDisconnect = function (fn) { H.disconnect.push(fn); };
    client.onJoined = function (fn) { H.joined.push(fn); };
    client.onClosed = function (fn) { H.closed.push(fn); };
    client.onStamp = function (fn) { H.stamp.push(fn); };

    return client;
  }

  return {
    PROTO: PROTO,
    CODE_LEN: CODE_LEN,
    PEER_PREFIX: PEER_PREFIX,
    MAX_CODE_ATTEMPTS: MAX_CODE_ATTEMPTS,
    NAME_MAX: NAME_MAX,
    STAMPS: STAMPS,
    STAMP_INTERVAL_MS: STAMP_INTERVAL_MS,
    isStampId: isStampId,
    randomCode: randomCode,
    randomToken: randomToken,
    normalizeCode: normalizeCode,
    isValidCode: isValidCode,
    sanitizeCode: sanitizeCode,
    parseCodeInput: parseCodeInput,
    peerIdFor: peerIdFor,
    sanitizeName: sanitizeName,
    normalizeMove: normalizeMove,
    createMemoryHub: createMemoryHub,
    createPeerTransport: createPeerTransport,
    createHost: createHost,
    createClient: createClient
  };
});
