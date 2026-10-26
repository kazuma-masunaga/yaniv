'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');
const N = require('../net.js');

// ---------- helpers ----------
function seqCodes(list) {
  let i = 0;
  return () => list[Math.min(i++, list.length - 1)];
}

/** Host + N clients wired through one in-memory hub. CPU delay 0 so games advance quickly. */
async function setupRoom(opts = {}) {
  const hub = N.createMemoryHub();
  const host = N.createHost({
    transport: hub.createTransport(),
    engine: E,
    rng: E.createRng(opts.seed || 11),
    random: E.createRng((opts.seed || 11) + 1),
    hostName: opts.hostName || 'ホスト',
    cpuDelay: [0, 0],
    codeGen: opts.codeGen
  });
  const code = await host.open();
  if (opts.config) host.setConfig(opts.config);
  const clients = [];
  for (const name of opts.names || []) {
    const c = await joinClient(hub, code, name);
    clients.push(c);
  }
  await hub.settle();
  return { hub, host, code, clients };
}

async function joinClient(hub, code, name, extra = {}) {
  const c = N.createClient(Object.assign({ transport: hub.createTransport(), roomCode: code, name, connectTimeoutMs: 0, backoff: [1, 1] }, extra));
  c.lobbies = []; c.views = []; c.errors = []; c.closed = []; c.disconnects = [];
  c.onLobby((l) => c.lobbies.push(l));
  c.onView((v) => c.views.push(v));
  c.onError((e) => c.errors.push(e));
  c.onClosed((x) => c.closed.push(x));
  c.onDisconnect((x) => c.disconnects.push(x));
  c.info = await c.connect();
  return c;
}

const last = (arr) => arr[arr.length - 1];

function assertViewIsSafe(view, seat, hostState) {
  assert.equal(view.seat, seat);
  assert.equal(typeof view.deckCount, 'number');
  assert.ok(!('deck' in view), 'view must not include deck');
  assert.ok(view.discardPile.length <= 1, 'discardPile is at most the top group');
  view.players.forEach((p, i) => {
    assert.equal(typeof p.handCount, 'number');
    if (i === seat) {
      assert.ok(Array.isArray(p.hand));
      assert.equal(p.hand.length, p.handCount);
    } else {
      assert.ok(!('hand' in p), `player ${i} hand leaked to seat ${seat}`);
    }
  });
  // nothing anywhere in the JSON (outside own hand / roundResult) should contain another player's card ids
  if (hostState && view.phase === 'playing') {
    const json = JSON.stringify(Object.assign({}, view, { roundResult: null, players: view.players.map((p, i) => (i === seat ? {} : p)) , discardPile: [], legalMoves: [], takeable: [], lastMove: null }));
    hostState.players.forEach((p, i) => {
      if (i === seat) return;
      p.hand.forEach((c) => assert.ok(!json.includes('"' + c.id + '"'), `card ${c.id} of player ${i} leaked`));
    });
  }
}

// ---------- tests ----------
test('room code: 4 digits (leading zeros kept); app-prefixed peer id; retries on unavailable-id', async () => {
  const hub = N.createMemoryHub();
  for (let i = 0; i < 200; i++) {
    const code = N.randomCode();
    assert.match(code, /^\d{4}$/);
  }
  assert.equal(N.CODE_LEN, 4);
  // leading zero: rnd() -> 0 gives "0000"; rnd just under 1 gives "9999"
  assert.equal(N.randomCode(() => 0), '0000');
  assert.equal(N.randomCode(() => 0.99999), '9999');
  const a = N.createHost({ transport: hub.createTransport(), engine: E, hostName: 'A', codeGen: seqCodes(['0042']) });
  assert.equal(await a.open(), '0042');
  assert.ok(hub.has('yaniv-kmz7-0042'), 'peer id uses the app-specific prefix');
  assert.ok(!hub.has('yaniv-0042'));
  const b = N.createHost({ transport: hub.createTransport(), engine: E, hostName: 'B', codeGen: seqCodes(['0042', '0042', '1234']) });
  assert.equal(await b.open(), '1234');
  // gives up after MAX_CODE_ATTEMPTS (8) collisions
  let calls = 0;
  const c = N.createHost({ transport: hub.createTransport(), engine: E, hostName: 'C', codeGen: () => { calls++; return '0042'; } });
  await assert.rejects(c.open(), /taken/);
  assert.equal(calls, 8);
  assert.equal(N.MAX_CODE_ATTEMPTS, 8);
  // an invalid code from codeGen falls back to a random 4-digit code
  const d = N.createHost({ transport: hub.createTransport(), engine: E, hostName: 'D', codeGen: seqCodes(['ABC234']) });
  assert.match(await d.open(), /^\d{4}$/);
  a.close(); b.close(); c.close(); d.close();
});

test('room code: full-width digits accepted, old 6-char codes rejected', async () => {
  assert.equal(N.normalizeCode('\uFF10\uFF11\uFF12\uFF13'), '0123');
  assert.equal(N.normalizeCode(' 12-34 '), '1234');
  assert.equal(N.normalizeCode('１２\u3000３４'), '1234');
  assert.equal(N.sanitizeCode('０９８７'), '0987');
  for (const bad of ['ABC234', 'AB2345', '12345', '123', '12a4', '', null, 1234, 'yaniv-1234']) {
    assert.equal(N.sanitizeCode(bad), '', 'rejects ' + bad);
  }
  assert.equal(N.isValidCode('1234'), true);
  assert.equal(N.isValidCode('0000'), true);
  assert.equal(N.isValidCode('ABCDEF'), false);
  assert.equal(N.isValidCode('１２３４'), false, 'isValidCode expects the normalized form');
  // a client built with an old-style code never connects
  const hub = N.createMemoryHub();
  const host = N.createHost({ transport: hub.createTransport(), engine: E, hostName: 'H', codeGen: seqCodes(['2345']) });
  await host.open();
  const old = N.createClient({ transport: hub.createTransport(), roomCode: 'AB2345', name: 'X', connectTimeoutMs: 0, autoReconnect: false });
  await assert.rejects(old.connect());
  // full-width input reaches the right room
  const fw = await joinClient(hub, '２３４５', 'F');
  assert.equal(fw.info.roomCode, '2345');
  assert.equal(fw.info.seat, 1);
  fw.leave(); old.leave(); host.close();
});

test('create room -> two join -> lobby broadcast has seats, names, connection state', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['たろう', 'Hanako'] });
  assert.equal(clients[0].info.seat, 1);
  assert.equal(clients[1].info.seat, 2);
  assert.match(clients[0].info.seatToken, /^[A-Za-z0-9]{16}$/);
  const l = host.lobby();
  assert.equal(l.seats.length, 3);
  assert.deepEqual(l.seats.map((s) => s.type), ['human', 'human', 'human']);
  assert.deepEqual(l.seats.map((s) => s.name), ['ホスト', 'たろう', 'Hanako']);
  assert.ok(l.seats.every((s) => s.connected));
  assert.equal(l.seats[0].isHost, true);
  // both clients received the same lobby
  const cl = last(clients[0].lobbies);
  assert.deepEqual(cl.seats.map((s) => s.name), ['ホスト', 'たろう', 'Hanako']);
  assert.deepEqual(cl.seats.map((s) => s.connected), [true, true, true]);
  assert.equal(cl.config.limit, 101);
  assert.deepEqual(last(clients[1].lobbies).seats, cl.seats);
  // name is truncated to 12 chars
  const long = await joinClient(hub, host.roomCode, 'x'.repeat(30)).catch((e) => e);
  assert.match(String(long.message || long), /full/);
  host.setConfig({ seatCount: 4 });
  const ok = await joinClient(hub, host.roomCode, 'y'.repeat(30));
  assert.equal(host.lobby().seats[3].name.length, 12);
  ok.leave();
  host.close();
});

test('join rejected when full and when game is in progress', async () => {
  const { host, hub } = await setupRoom({ names: ['A'], config: { seatCount: 2 } });
  await assert.rejects(joinClient(hub, host.roomCode, 'B'), /full/);
  host.setConfig({ seatCount: 3 });
  host.start();
  await hub.settle();
  await assert.rejects(joinClient(hub, host.roomCode, 'C'), /in-progress/);
  // bad name / bad proto rejections
  await assert.rejects(joinClient(hub, host.roomCode, '   '), /in-progress|name/);
  host.close();
});

test('start fills empty seats with CPU; every player gets a view without other hands', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 5 } });
  host.start();
  await hub.settle();
  const st = host.state();
  assert.equal(st.phase, 'playing');
  assert.deepEqual(st.players.map((p) => p.type), ['human', 'human', 'human', 'cpu', 'cpu']);
  assert.deepEqual(st.players.slice(3).map((p) => p.name), ['CPU 4', 'CPU 5']);
  // lobby sees cpu seats
  assert.deepEqual(host.lobby().seats.map((s) => s.type), ['human', 'human', 'human', 'cpu', 'cpu']);
  clients.forEach((c, i) => {
    assert.ok(c.views.length >= 1, 'client got a view');
    const v = last(c.views);
    assertViewIsSafe(v, i + 1, st);
    assert.equal(v.deckCount, st.deck.length);
    assert.equal(v.discardPile.length, 1);
    assert.equal(v.players.length, 5);
    assert.deepEqual(v.players.map((p) => p.handCount), st.players.map((p) => p.hand.length));
    assert.deepEqual(v.players[i + 1].hand, st.players[i + 1].hand);
    if (v.currentPlayer === v.seat) assert.ok(v.legalMoves.length > 0); else assert.equal(v.legalMoves.length, 0);
  });
  // host's own view too
  assertViewIsSafe(host.view(), 0, st);
  host.close();
});

test('discardPile in view is only the top group even when the pile has several groups', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A'], config: { seatCount: 2 } });
  host.start();
  await hub.settle();
  // play some moves between the two humans
  for (let i = 0; i < 6 && host.state().phase === 'playing'; i++) {
    const st = host.state();
    const legal = E.legalMoves(st).filter((m) => m.type === 'play');
    const mv = legal[0];
    if (st.currentPlayer === 0) assert.equal(host.submitMove(mv).ok, true);
    else { clients[0].submitMove(mv); await hub.settle(); }
  }
  await hub.settle();
  const st = host.state();
  if (st.phase === 'playing') {
    assert.ok(st.discardPile.length > 1, 'host pile has history');
    const v = last(clients[0].views);
    assert.equal(v.discardPile.length, 1);
    assert.deepEqual(v.discardPile[0], st.discardPile[st.discardPile.length - 1]);
  }
  host.close();
});

test('move from a player who is not on turn -> error, state unchanged', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'] });
  host.start();
  await hub.settle();
  const st = host.state();
  const cur = st.currentPlayer;
  const other = clients.find((c) => c.info.seat !== cur);
  const before = JSON.stringify(st);
  // a move that would be legal for the current player
  const mv = E.legalMoves(st)[0];
  other.submitMove(mv);
  await hub.settle();
  assert.equal(JSON.stringify(host.state()), before);
  assert.ok(other.errors.some((e) => /番ではありません/.test(e.message)));
  // host submitting out of turn (if host is not current)
  if (cur !== 0) {
    const r = host.submitMove(mv);
    assert.equal(r.ok, false);
    assert.equal(JSON.stringify(host.state()), before);
  }
  host.close();
});

test('illegal move (not in legalMoves / malformed) -> error, state unchanged', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 3 } });
  host.start();
  await hub.settle();
  const st = host.state();
  const cur = st.currentPlayer;
  const before = JSON.stringify(st);
  const sender = cur === 0 ? null : clients[cur - 1];
  const send = async (mv) => {
    if (sender) { sender.submitMove(mv); await hub.settle(); return sender.errors.length; }
    const r = host.submitMove(mv); return r.ok ? 0 : 1;
  };
  const hand = st.players[cur].hand;
  const otherHand = st.players[(cur + 1) % 3].hand;
  const bad = [
    { type: 'play', discard: [otherHand[0].id], draw: 'deck' },           // not my card
    { type: 'play', discard: [hand[0].id], draw: 'ZZ' },                  // bad draw
    { type: 'play', discard: [hand[0].id, hand[1].id, hand[2].id, hand[3].id, hand[4].id], draw: 'deck' }, // probably invalid group
    { type: 'play', discard: [], draw: 'deck' },
    { type: 'play', discard: 'KD', draw: 'deck' },
    { type: 'nope' },
    null, 42, 'yaniv', [], { type: 'play', discard: [1, 2], draw: 'deck' }
  ];
  if (E.handValue(hand) > 7) bad.push({ type: 'yaniv' });
  let errCount = 0;
  for (const mv of bad) {
    const n = await send(mv);
    // the 5-card discard might by chance be a valid group; skip strictness on that one
    if (mv && Array.isArray(mv.discard) && mv.discard.length === 5 && E.isValidDiscard(hand)) continue;
    assert.ok(n > errCount || !sender, 'error reported for ' + JSON.stringify(mv));
    errCount = n;
    assert.equal(JSON.stringify(host.state()), before, 'state unchanged after ' + JSON.stringify(mv));
  }
  host.close();
});

test('legal move -> everyone receives a new view; host state advances', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'] });
  host.start();
  await hub.settle();
  const st = host.state();
  const cur = st.currentPlayer;
  const counts = clients.map((c) => c.views.length);
  const mv = E.legalMoves(st).filter((m) => m.type === 'play')[0];
  if (cur === 0) assert.equal(host.submitMove(mv).ok, true);
  else {
    const c = clients[cur - 1];
    const v = last(c.views);
    assert.ok(v.legalMoves.some((m) => JSON.stringify(m) === JSON.stringify(mv)), 'client view carried legalMoves');
    c.submitMove(mv);
  }
  await hub.settle();
  const st2 = host.state();
  assert.notEqual(JSON.stringify(st2), JSON.stringify(st));
  assert.equal(st2.lastMove.playerIndex, cur);
  clients.forEach((c, i) => {
    assert.ok(c.views.length > counts[i], 'client ' + i + ' got new view');
    const v = last(c.views);
    assertViewIsSafe(v, i + 1, st2);
    assert.equal(v.currentPlayer, st2.currentPlayer);
    assert.equal(v.lastMove.playerIndex, cur);
    assert.equal(v.deckCount, st2.deck.length);
  });
  host.close();
});

test('reconnect with seatToken returns to the same seat and gets the latest view', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'] });
  host.start();
  await hub.settle();
  const a = clients[0];
  const token = a.info.seatToken;
  assert.equal(a.info.seat, 1);
  a.leave(); // simulates a dropped connection (transport closed)
  await hub.settle();
  assert.equal(host.lobby().seats[1].connected, false);
  assert.equal(host.lobby().seats[1].type, 'human');
  // the other client sees the disconnect
  assert.equal(last(clients[1].lobbies).seats[1].connected, false);
  // reconnect from a fresh transport with the token (and a different name, which is ignored for seat selection)
  const a2 = await joinClient(hub, host.roomCode, 'A', { seatToken: token });
  await hub.settle();
  assert.equal(a2.info.seat, 1);
  assert.equal(a2.info.seatToken, token);
  assert.equal(host.lobby().seats[1].connected, true);
  assert.ok(a2.views.length >= 1, 'latest view delivered on reconnect');
  const v = last(a2.views);
  assertViewIsSafe(v, 1, host.state());
  assert.deepEqual(v.players[1].hand, host.state().players[1].hand);
  // a bogus token during the game is rejected (game in progress, no free seat for a new player)
  await assert.rejects(joinClient(hub, host.roomCode, 'Z', { seatToken: 'zzzzzzzzzzzzzzzz' }), /in-progress/);
  host.close();
});

test('client auto-reconnects with backoff after the connection drops', async () => {
  const hub = N.createMemoryHub();
  const host = N.createHost({ transport: hub.createTransport(), engine: E, hostName: 'H', cpuDelay: [0, 0], codeGen: seqCodes(['2222']) });
  await host.open();
  const ct = hub.createTransport();
  const a = N.createClient({ transport: ct, roomCode: '2222', name: 'A', connectTimeoutMs: 0, backoff: [5, 10] });
  const disconnects = [], joined = [];
  a.onDisconnect((d) => disconnects.push(d));
  a.onJoined((j) => joined.push(j));
  const info = await a.connect();
  assert.equal(info.seat, 1);
  host.start();
  await hub.settle();
  // network loss on the client side
  ct.dropConnections();
  await hub.settle();
  assert.equal(a.isConnected(), false);
  assert.equal(disconnects.length, 1);
  assert.equal(disconnects[0].nextDelayMs, 5);
  assert.equal(host.lobby().seats[1].connected, false);
  // wait for the automatic reconnect
  await new Promise((r) => setTimeout(r, 40));
  await hub.settle();
  assert.equal(a.isConnected(), true);
  assert.equal(joined.length, 2);
  assert.equal(joined[1].seat, 1);
  assert.equal(joined[1].seatToken, info.seatToken);
  assert.equal(host.lobby().seats[1].connected, true);
  // host closing stops reconnect attempts
  host.close();
  await hub.settle();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(a.isConnected(), false);
  assert.equal(joined.length, 2);
  a.leave();
});

test('replaceWithCpu: the seat becomes a CPU and the CPU plays that seat', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A'], config: { seatCount: 2 }, seed: 5 });
  host.start();
  await hub.settle();
  // make it seat 1's turn
  if (host.state().currentPlayer === 0) {
    const mv = E.legalMoves(host.state()).filter((m) => m.type === 'play')[0];
    assert.equal(host.submitMove(mv).ok, true);
    await hub.settle();
  }
  assert.equal(host.state().currentPlayer, 1);
  const before = JSON.stringify(host.state());
  host.replaceWithCpu(1);
  assert.equal(host.lobby().seats[1].type, 'cpu');
  assert.equal(host.state().players[1].type, 'cpu');
  await hub.settle();
  await new Promise((r) => setTimeout(r, 20));
  await hub.settle();
  const after = host.state();
  assert.notEqual(JSON.stringify(after), before, 'CPU moved for seat 1');
  assert.ok(after.phase !== 'playing' || after.currentPlayer === 0 || after.lastMove.playerIndex === 1);
  // the replaced client received 'closed'
  assert.ok(clients[0].closed.length >= 1);
  assert.equal(clients[0].closed[0].reason, 'cpu');
  // its token no longer works
  await assert.rejects(joinClient(hub, host.roomCode, 'A', { seatToken: clients[0].info.seatToken }), /in-progress/);
  host.close();
});

test('host survives unknown / malformed messages; client survives malformed host messages', async () => {
  const hub = N.createMemoryHub();
  const host = N.createHost({ transport: hub.createTransport(), engine: E, hostName: 'H', cpuDelay: [0, 0], codeGen: seqCodes(['3333']) });
  await host.open();
  const errors = [];
  host.onError((e) => errors.push(e));
  // raw connection speaking garbage
  const t = hub.createTransport();
  await t.open();
  const raw = t.connect(N.peerIdFor('3333'));
  const got = [];
  raw.onMessage((m) => got.push(m));
  // bad joins close the connection (reject), so send those last
  const junk = [null, undefined, 1, 'string', [], {}, { t: 42 }, { t: 'nope' }, { t: 'move' }, { t: 'move', move: 'x' },
    { t: 'ping' }, { t: 'joined', seat: 0 }, { t: 'view', view: { phase: 'playing' } },
    { t: 'join' }, { t: 'join', proto: 1 }, { t: 'join', name: { a: 1 }, proto: 1 }];
  for (const j of junk) { raw.send(j); await hub.settle(); }
  assert.ok(got.some((m) => m && m.t === 'error'), 'move without seat -> error');
  assert.equal(errors.length, 0, 'no internal errors: ' + JSON.stringify(errors));
  assert.ok(got.some((m) => m && m.t === 'pong'), 'ping answered');
  assert.ok(got.some((m) => m && m.t === 'reject'), 'bad join rejected');
  // host still works: a real client can join
  const c = await joinClient(hub, '3333', 'Real');
  assert.equal(c.info.seat, 1);
  // now feed the client garbage from a fake host
  const fakeHub = N.createMemoryHub();
  const fakeHostT = fakeHub.createTransport();
  await fakeHostT.open(N.peerIdFor('4422'));
  let hostConn = null;
  fakeHostT.onConnection((cn) => { hostConn = cn; cn.onMessage(() => {}); });
  const victim = N.createClient({ transport: fakeHub.createTransport(), roomCode: '4422', name: 'V', connectTimeoutMs: 0, backoff: [1] });
  const vViews = [], vLobbies = [], vErrors = [];
  victim.onView((v) => vViews.push(v)); victim.onLobby((l) => vLobbies.push(l)); victim.onError((e) => vErrors.push(e));
  victim.connect().catch(() => {});
  await fakeHub.settle();
  assert.ok(hostConn, 'fake host got connection');
  const bad = [null, 7, 'x', [], {}, { t: 1 }, { t: 'view' }, { t: 'view', view: null }, { t: 'view', view: { phase: 'playing', seat: 9, players: [] } },
    { t: 'view', view: { phase: 'playing', seat: 0, players: [{}, {}], currentPlayer: 0, round: 1, deckCount: 1, discardPile: [], legalMoves: [], takeable: [], config: {} } },
    { t: 'lobby' }, { t: 'lobby', seats: 'nope' }, { t: 'lobby', seats: [1, 2] }, { t: 'joined', seat: 'a' }, { t: 'joined', seat: 1, seatToken: 'short' },
    { t: 'error' }, { t: 'error', message: 5 }, { t: 'wat', x: 1 }];
  for (const b of bad) hostConn.send(b);
  await fakeHub.settle();
  assert.equal(vViews.length, 0, 'no invalid view accepted');
  assert.equal(vLobbies.length, 0, 'no invalid lobby accepted');
  // valid lobby still accepted afterwards -> client still alive
  hostConn.send({ t: 'lobby', seats: [{ name: 'H', type: 'human', connected: true, isHost: true }, { name: '<b>x</b>', type: 'human', connected: true }], config: { jokers: 9 } });
  hostConn.send({ t: 'joined', seat: 1, seatToken: 'abcdefghijklmnop', roomCode: '4422' });
  await fakeHub.settle();
  assert.equal(vLobbies.length, 1);
  assert.equal(vLobbies[0].config.jokers, 2, 'bad config value falls back');
  assert.equal(victim.seat, 1);
  victim.leave(); c.leave(); host.close(); t.close();
});

test('full game: 2 humans + 1 CPU runs to gameOver with humans sending legalMoves[0]', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A'], config: { seatCount: 3, limit: 31, cpuLevel: 'strong' }, seed: 99 });
  const stateChanges = [];
  host.onStateChange((s) => stateChanges.push(s ? s.phase : null));
  host.start();
  await hub.settle();
  const client = clients[0];
  let turns = 0;
  let rounds = 1;
  while (host.state().phase !== 'gameOver') {
    const st = host.state();
    if (st.phase === 'roundEnd') {
      // client sees roundResult with all hands
      const v = last(client.views);
      assert.equal(v.phase, 'roundEnd');
      assert.ok(v.roundResult && v.roundResult.entries.length === 3);
      assert.ok(v.roundResult.entries.every((en) => Array.isArray(en.hand)));
      assert.equal(v.legalMoves.length, 0);
      host.nextRound();
      rounds++;
      await hub.settle();
      continue;
    }
    assert.equal(st.phase, 'playing');
    const cur = st.currentPlayer;
    if (st.players[cur].type === 'cpu') {
      await hub.settle();
      await new Promise((r) => setTimeout(r, 2));
    } else if (cur === 0) {
      const legal = E.legalMoves(st);
      assert.equal(host.submitMove(legal[0]).ok, true);
    } else {
      const v = last(client.views);
      assert.equal(v.phase, 'playing');
      assert.equal(v.currentPlayer, 1, 'client view is on the client turn');
      assert.ok(v.legalMoves.length > 0);
      assertViewIsSafe(v, 1, st);
      client.submitMove(v.legalMoves[0]);
    }
    await hub.settle();
    turns++;
    if (turns > 5000) throw new Error('game did not finish');
  }
  const fin = host.state();
  assert.equal(fin.phase, 'gameOver');
  assert.ok(fin.winner != null);
  const v = last(client.views);
  assert.equal(v.phase, 'gameOver');
  assert.equal(v.winner, fin.winner);
  assert.ok(rounds >= 1 && turns > 3);
  assert.equal(client.errors.length, 0, 'no errors on client: ' + JSON.stringify(client.errors));
  // restart keeps same seats
  host.restart();
  await hub.settle();
  assert.equal(host.state().phase, 'playing');
  assert.equal(host.state().round, 1);
  assert.deepEqual(host.state().players.map((p) => p.type), fin.players.map((p) => p.type));
  assert.equal(last(client.views).phase, 'playing');
  host.close();
  await hub.settle();
  assert.ok(client.closed.length >= 1, 'client told the room closed');
});

test('host.close notifies clients with closed; setConfig refuses to shrink below seated players', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 4 } });
  assert.throws(() => host.setConfig({ seatCount: 2 }), /減らせません/);
  host.setConfig({ seatCount: 3, jokers: 0, limit: 51, cpuLevel: 'weak' });
  await hub.settle();
  assert.equal(last(clients[1].lobbies).config.limit, 51);
  assert.equal(last(clients[1].lobbies).seats.length, 3);
  assert.throws(() => host.setConfig({ seatCount: 9 }));
  host.kick(2);
  await hub.settle();
  assert.equal(host.lobby().seats[2].type, 'empty');
  assert.equal(clients[1].closed[0].reason, 'kicked');
  host.close('host-left');
  await hub.settle();
  assert.equal(clients[0].closed[0].reason, 'host-left');
});


test('setConfig: starter propagates to lobby broadcasts, createGame config and client views', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A'], config: { seatCount: 2 } });
  assert.equal(host.config().starter, 'zero', 'default is zero');
  assert.equal(last(clients[0].lobbies).config.starter, 'zero');
  assert.throws(() => host.setConfig({ starter: 'random' }), /starter/);
  host.setConfig({ starter: 'highest' });
  await hub.settle();
  assert.equal(host.config().starter, 'highest');
  assert.equal(last(clients[0].lobbies).config.starter, 'highest');
  host.start();
  await hub.settle();
  assert.equal(host.state().config.starter, 'highest');
  assert.equal(last(clients[0].views).config.starter, 'highest');
  assert.throws(() => host.setConfig({ starter: 'zero' }), /ゲーム中/);
  host.close();
});

test('client view validation: config.starter must be zero/highest when present', async () => {
  const hub = N.createMemoryHub();
  const ht = hub.createTransport();
  await ht.open(N.peerIdFor('5555'));
  let hc = null;
  ht.onConnection((cn) => { hc = cn; cn.onMessage(() => {}); });
  const v = N.createClient({ transport: hub.createTransport(), roomCode: '5555', name: 'V', connectTimeoutMs: 0, backoff: [1] });
  const views = [];
  v.onView((x) => views.push(x));
  v.connect().catch(() => {});
  await hub.settle();
  hc.send({ t: 'joined', seat: 0, seatToken: 'abcdefghijklmnop', roomCode: '5555' });
  const base = () => ({ phase: 'playing', seat: 0, players: [{ name: 'a', handCount: 1, score: 0, hand: [] }, { name: 'b', handCount: 1, score: 0 }], currentPlayer: 0, round: 1, deckCount: 1, discardPile: [], legalMoves: [], takeable: [], config: { limit: 101 } });
  let x = base(); x.config.starter = '<b>'; hc.send({ t: 'view', view: x });
  await hub.settle();
  assert.equal(views.length, 0);
  x = base(); x.config.starter = 'highest'; hc.send({ t: 'view', view: x });
  x = base(); hc.send({ t: 'view', view: x }); // absent is fine
  await hub.settle();
  assert.equal(views.length, 2);
  v.leave(); ht.close();
});

// ---------- review regressions ----------
test('#2 restart after replaceWithCpu keeps that seat as CPU (no human seat with nobody behind it)', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A'], config: { seatCount: 3, limit: 31 }, seed: 21 });
  host.start();
  await hub.settle();
  host.replaceWithCpu(1);
  await hub.settle();
  assert.equal(host.state().players[1].type, 'cpu');
  // run the game to the end (host plays legalMoves[0]; everyone else is CPU)
  let guard = 0;
  while (host.state().phase !== 'gameOver' && guard++ < 3000) {
    const st = host.state();
    if (st.phase === 'roundEnd') { host.nextRound(); await hub.settle(); continue; }
    if (st.currentPlayer === 0) host.submitMove(E.legalMoves(st)[0]);
    else { await new Promise((r) => setTimeout(r, 2)); }
    await hub.settle();
  }
  assert.equal(host.state().phase, 'gameOver', 'first game finished');
  host.restart();
  await hub.settle();
  const st = host.state();
  assert.deepEqual(st.players.map((p) => p.type), ['human', 'cpu', 'cpu'], 'replaced seat stays CPU after restart');
  assert.deepEqual(host.lobby().seats.map((s) => s.type), ['human', 'cpu', 'cpu']);
  // after restart, run the whole second game too; with the bug the replaced seat is 'human' with no
  // connection behind it and the loop below exhausts its guard instead of reaching gameOver
  guard = 0;
  while (host.state().phase !== 'gameOver' && guard++ < 3000) {
    const st2 = host.state();
    if (st2.phase === 'roundEnd') { host.nextRound(); await hub.settle(); continue; }
    if (st2.currentPlayer === 0) host.submitMove(E.legalMoves(st2)[0]);
    else { await new Promise((r) => setTimeout(r, 1)); }
    await hub.settle();
  }
  assert.equal(host.state().phase, 'gameOver', 'second game (after restart) also finishes');
  // kick during a game also sticks across restart
  const room2 = await setupRoom({ names: ['B', 'C'], config: { seatCount: 3 }, seed: 22 });
  room2.host.start();
  await room2.hub.settle();
  room2.host.kick(2);
  await room2.hub.settle();
  assert.equal(room2.host.state().players[2].type, 'cpu');
  // force game over quickly by mutating nothing: just check restart path once the game ends via roundEnd/gameOver is not reachable here,
  // so verify playersFromSeats through backToLobby + start instead
  room2.host.backToLobby();
  assert.deepEqual(room2.host.lobby().seats.map((s) => s.type), ['human', 'human', 'empty']);
  room2.host.close();
  host.close();
});

/** Transport wrapper that lets a test make connect()/open() fail on demand. */
function flakyTransport(inner) {
  const t = {
    failConnectUndefined: false,   // connect() returns undefined (PeerJS when peer.disconnected)
    failConnectThrow: false,       // connect() throws
    failOpen: false,               // open() rejects
    open(id) { return t.failOpen ? Promise.reject(Object.assign(new Error('open failed'), { type: 'network' })) : inner.open(id); },
    connect(id) {
      if (t.failConnectUndefined) return undefined;
      if (t.failConnectThrow) throw new Error('connect threw');
      return inner.connect(id);
    },
    onConnection(fn) { return inner.onConnection(fn); },
    close() { return inner.close(); },
    dropConnections() { return inner.dropConnections(); },
    get id() { return inner.id; }
  };
  return t;
}

test('#3 reconnect loop survives connect() returning undefined / throwing and keeps retrying with backoff', async () => {
  const hub = N.createMemoryHub();
  const host = N.createHost({ transport: hub.createTransport(), engine: E, hostName: 'H', cpuDelay: [0, 0], codeGen: seqCodes(['6060']) });
  await host.open();
  const ft = flakyTransport(hub.createTransport());
  const a = N.createClient({ transport: ft, roomCode: '6060', name: 'A', connectTimeoutMs: 0, backoff: [3, 3] });
  const disconnects = [], joined = [];
  a.onDisconnect((d) => disconnects.push(d));
  a.onJoined((j) => joined.push(j));
  await a.connect();
  assert.equal(joined.length, 1);
  // break the link while connect() is broken too
  ft.failConnectUndefined = true;
  ft.dropConnections();
  await hub.settle();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(disconnects.length >= 3, 'kept retrying while connect() returned undefined: ' + disconnects.length);
  assert.equal(a.isConnected(), false);
  // now connect() throws instead
  ft.failConnectUndefined = false;
  ft.failConnectThrow = true;
  const n1 = disconnects.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(disconnects.length > n1, 'kept retrying while connect() threw');
  // heal -> rejoins the same seat
  ft.failConnectThrow = false;
  await new Promise((r) => setTimeout(r, 30));
  await hub.settle();
  assert.equal(a.isConnected(), true);
  assert.equal(joined.length, 2);
  assert.equal(joined[1].seat, 1);
  assert.equal(host.lobby().seats[1].connected, true);
  a.leave(); host.close();
});

test('#3 reconnect loop survives transport.open() failing (open-failed path)', async () => {
  const hub = N.createMemoryHub();
  const host = N.createHost({ transport: hub.createTransport(), engine: E, hostName: 'H', cpuDelay: [0, 0], codeGen: seqCodes(['7070']) });
  await host.open();
  // first transport joins, then is closed entirely (so ensureOpen must re-open); the re-open fails for a while
  const innerT = hub.createTransport();
  const ft = flakyTransport(innerT);
  const a = N.createClient({ transport: ft, roomCode: '7070', name: 'A', connectTimeoutMs: 0, backoff: [3, 3] });
  const disconnects = [], joined = [];
  a.onDisconnect((d) => disconnects.push(d));
  a.onJoined((j) => joined.push(j));
  await a.connect();
  // simulate: open() now fails and the link drops. The client already has openPromise resolved, so force a path
  // through a *new* client whose first open fails after it has joined once is not possible; instead verify that
  // onAttemptFailed schedules another attempt when connect() rejects asynchronously via a dead conn.
  ft.failConnectUndefined = true;
  ft.dropConnections();
  await hub.settle();
  await new Promise((r) => setTimeout(r, 25));
  const n = disconnects.length;
  assert.ok(n >= 2, 'retrying');
  ft.failConnectUndefined = false;
  await new Promise((r) => setTimeout(r, 25));
  await hub.settle();
  assert.equal(a.isConnected(), true);
  assert.equal(joined.length, 2);
  // a brand-new client whose open() fails reports connect-failed and rejects (no infinite loop before first join)
  const ft2 = flakyTransport(hub.createTransport());
  ft2.failOpen = true;
  const b = N.createClient({ transport: ft2, roomCode: '7070', name: 'B', connectTimeoutMs: 0, backoff: [1] });
  const errs = [];
  b.onError((e) => errs.push(e));
  await assert.rejects(b.connect(), /open failed/);
  assert.ok(errs.some((e) => e.type === 'connect-failed' && e.reason === 'open-failed'));
  a.leave(); b.leave(); host.close();
});

test('#4 second tab with the same seatToken takes the seat; the old tab gets closed:replaced and stops reconnecting', async () => {
  const hub = N.createMemoryHub();
  const host = N.createHost({ transport: hub.createTransport(), engine: E, hostName: 'H', cpuDelay: [0, 0], codeGen: seqCodes(['8888']) });
  await host.open();
  const tab1 = await joinClient(hub, '8888', 'A', { backoff: [2, 2] });
  const token = tab1.info.seatToken;
  // without the fix the two tabs steal the seat from each other forever; bound the wait so that shows as a failure
  const tab2 = N.createClient({ transport: hub.createTransport(), roomCode: '8888', name: 'A', seatToken: token, connectTimeoutMs: 0, backoff: [2, 2] });
  tab2.views = []; tab2.closed = []; const tab2joined = [];
  tab2.onView((v) => tab2.views.push(v)); tab2.onClosed((x) => tab2.closed.push(x)); tab2.onJoined((j) => tab2joined.push(j));
  let tab1Joins = 1; tab1.onJoined(() => tab1Joins++); tab1.joinCount = () => tab1Joins;
  try {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('tab2 join did not settle (seat ping-pong)')), 500); });
    tab2.info = await Promise.race([tab2.connect(), timeout]);
    // hub.settle() would never resolve while the two tabs ping-pong, so bound it as well
    await Promise.race([hub.settle(), new Promise((r) => setTimeout(r, 300))]);
    const j1 = tab1.joinCount(), j2 = tab2joined.length;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(tab2joined.length, j2, 'tab2 is not re-joining repeatedly');
    assert.equal(tab1.joinCount(), j1, 'tab1 is not re-joining repeatedly');
    clearTimeout(timer);
    assert.equal(tab2.info.seat, 1, 'tab2 took over seat 1');
    assert.equal(tab1.closed.length, 1, 'tab1 told it was replaced');
    assert.equal(tab1.closed[0].reason, 'replaced');
    assert.equal(tab1.isConnected(), false);
    // tab1 must NOT come back and steal the seat again
    await new Promise((r) => setTimeout(r, 30));
    await hub.settle();
    assert.equal(tab1.isConnected(), false, 'tab1 stays disconnected');
    assert.equal(tab2.isConnected(), true, 'tab2 keeps the seat');
    assert.equal(tab2.closed.length, 0, 'tab2 never told it was replaced');
    assert.equal(host.lobby().seats.filter((s) => s.type === 'human').length, 2, 'no extra seat consumed');
    assert.equal(host.lobby().seats[1].connected, true);
    // a game can start and tab2 receives views; tab1 receives nothing
    host.setConfig({ seatCount: 2 });
    host.start();
    await hub.settle();
    assert.ok(tab2.views.length >= 1);
    assert.equal(tab1.views.length, 0);
  } finally {
    tab1.leave(); tab2.leave(); host.close();
  }
});

test('#5 client rejects views with malformed roundResult / config.limit', async () => {
  const hub = N.createMemoryHub();
  const ht = hub.createTransport();
  await ht.open(N.peerIdFor('9999'));
  let hc = null;
  ht.onConnection((cn) => { hc = cn; cn.onMessage(() => {}); });
  const v = N.createClient({ transport: hub.createTransport(), roomCode: '9999', name: 'V', connectTimeoutMs: 0, backoff: [1] });
  const views = [];
  v.onView((x) => views.push(x));
  v.connect().catch(() => {});
  await hub.settle();
  hc.send({ t: 'joined', seat: 0, seatToken: 'abcdefghijklmnop', roomCode: '9999' });
  const base = () => ({ phase: 'playing', seat: 0, players: [{ name: 'a', handCount: 1, score: 0, hand: [] }, { name: 'b', handCount: 1, score: 0 }], currentPlayer: 0, round: 1, deckCount: 1, discardPile: [], legalMoves: [], takeable: [], config: { limit: 101 } });
  const bad = [];
  let x = base(); x.config.limit = '<img>'; bad.push(x);
  x = base(); x.phase = 'roundEnd'; bad.push(x); // no roundResult
  x = base(); x.phase = 'roundEnd'; x.roundResult = { round: 1, declarer: 0, entries: 'nope' }; bad.push(x);
  x = base(); x.phase = 'roundEnd'; x.roundResult = { round: 1, declarer: 0, entries: [{ name: 'a', hand: [], added: '<b>', total: 0 }, { name: 'b', hand: [], added: 0, total: 0 }] }; bad.push(x);
  x = base(); x.phase = 'roundEnd'; x.roundResult = { round: 1, declarer: 7, entries: [{ name: 'a', hand: [], added: 0, total: 0 }, { name: 'b', hand: [], added: 0, total: 0 }] }; bad.push(x);
  x = base(); x.phase = 'gameOver'; x.winner = 'x'; x.roundResult = { round: 1, declarer: 0, entries: [{ name: 'a', hand: [], added: 0, total: 0 }, { name: 'b', hand: [], added: 0, total: 0 }] }; bad.push(x);
  for (const b of bad) hc.send({ t: 'view', view: b });
  await hub.settle();
  assert.equal(views.length, 0, 'all malformed views rejected');
  x = base(); x.phase = 'roundEnd'; x.roundResult = { round: 1, declarer: 0, declarerValue: 3, assaf: null, entries: [{ name: 'a', hand: [], value: 3, added: 0, total: 0 }, { name: 'b', hand: [], value: 9, added: 9, total: 9 }] };
  hc.send({ t: 'view', view: x });
  await hub.settle();
  assert.equal(views.length, 1, 'well-formed roundEnd accepted');
  v.leave(); ht.close();
});

test('#6 defaultRandom-based codes/tokens are well-formed and not constant', () => {
  const codes = new Set(), tokens = new Set();
  for (let i = 0; i < 50; i++) { codes.add(N.randomCode()); tokens.add(N.randomToken()); }
  assert.ok(codes.size > 40);
  assert.ok(tokens.size === 50);
  for (const t of tokens) assert.match(t, /^[A-Za-z0-9]{16}$/);
});

// ---------- stamps ----------
/** Room with an injectable clock for the stamp rate limit. */
async function stampRoom(opts = {}) {
  const hub = N.createMemoryHub();
  const clock = { t: 100000 };
  const host = N.createHost({
    transport: hub.createTransport(), engine: E, rng: E.createRng(7), random: E.createRng(8),
    hostName: 'H', cpuDelay: [0, 0], now: () => clock.t
  });
  const code = await host.open();
  host.setConfig(opts.config || { seatCount: 3 });
  host.stamps = [];
  host.onStamp((s) => host.stamps.push(s));
  const clients = [];
  for (const name of opts.names || ['A', 'B']) {
    const c = await joinClient(hub, code, name);
    c.stamps = [];
    c.onStamp((s) => c.stamps.push(s));
    clients.push(c);
  }
  await hub.settle();
  return { hub, host, code, clients, clock };
}

test('stamps: STAMPS has 8 fixed ids; isStampId', () => {
  assert.equal(N.STAMPS.length, 8);
  assert.deepEqual(N.STAMPS.map((s) => s.id), ['joy', 'angry', 'sad', 'smug', 'shock', 'think', 'clap', 'pray']);
  N.STAMPS.forEach((s) => { assert.ok(s.emoji && s.label); assert.ok(N.isStampId(s.id)); });
  assert.equal(N.isStampId('nope'), false);
  assert.equal(N.isStampId(null), false);
  assert.equal(N.isStampId(3), false);
  assert.equal(N.STAMP_INTERVAL_MS, 1500);
});

test('stamps: a valid stamp during play reaches everyone (host UI included) with the sender seat', async () => {
  const { host, clients, hub } = await stampRoom();
  host.start();
  await hub.settle();
  assert.equal(clients[0].sendStamp('clap'), true);
  await hub.settle();
  assert.deepEqual(host.stamps, [{ seat: 1, id: 'clap' }]);
  assert.deepEqual(clients[0].stamps, [{ seat: 1, id: 'clap' }], 'sender sees its own stamp echoed');
  assert.deepEqual(clients[1].stamps, [{ seat: 1, id: 'clap' }]);
  host.close();
});

test('stamps: host.sendStamp goes through the same path and is delivered', async () => {
  const { host, clients, hub, clock } = await stampRoom();
  // not playing yet -> ignored
  assert.equal(host.sendStamp('joy'), false);
  host.start();
  await hub.settle();
  assert.equal(host.sendStamp('joy'), true);
  await hub.settle();
  assert.deepEqual(host.stamps, [{ seat: 0, id: 'joy' }]);
  clients.forEach((c) => assert.deepEqual(c.stamps, [{ seat: 0, id: 'joy' }]));
  // host is rate limited too
  assert.equal(host.sendStamp('sad'), false);
  clock.t += 1500;
  assert.equal(host.sendStamp('sad'), true);
  assert.equal(host.sendStamp('bogus'), false);
  host.close();
});

test('stamps: unknown id over the wire is ignored silently (no error message)', async () => {
  const { host, clients, hub } = await stampRoom({ config: { seatCount: 3 }, names: ['A'] });
  // a raw connection that takes the last seat before the game starts, so it can speak the protocol directly
  const t = hub.createTransport();
  await t.open();
  const raw = t.connect(N.peerIdFor(host.roomCode));
  const got = [];
  raw.onMessage((m) => got.push(m));
  raw.send({ t: 'join', name: 'Raw', proto: N.PROTO });
  await hub.settle();
  assert.ok(got.some((m) => m && m.t === 'joined' && m.seat === 2), 'raw seated at 2');
  host.start();
  await hub.settle();
  // client-side guard refuses locally
  assert.equal(clients[0].sendStamp('bogus'), false);
  // wire-level bogus ids
  for (const id of ['bogus', 'JOY', '', 42, null, ['joy'], { id: 'joy' }]) { raw.send({ t: 'stamp', id }); await hub.settle(); }
  assert.equal(host.stamps.length, 0);
  assert.ok(!got.some((m) => m && m.t === 'error'), 'no error sent back');
  assert.equal(clients[0].stamps.length, 0);
  // a valid one from the same raw seat is delivered
  raw.send({ t: 'stamp', id: 'shock' });
  await hub.settle();
  assert.deepEqual(host.stamps, [{ seat: 2, id: 'shock' }]);
  assert.deepEqual(clients[0].stamps, [{ seat: 2, id: 'shock' }]);
  assert.ok(got.some((m) => m && m.t === 'stamp' && m.seat === 2 && m.id === 'shock'), 'echoed back to sender');
  t.close();
  host.close();
});

test('stamps: second stamp within 1500ms from the same seat is dropped; other seats unaffected', async () => {
  const { host, clients, hub, clock } = await stampRoom();
  host.start();
  await hub.settle();
  clients[0].sendStamp('joy');
  await hub.settle();
  clock.t += 1499;
  clients[0].sendStamp('angry');
  await hub.settle();
  assert.deepEqual(host.stamps.map((s) => s.id), ['joy'], 'second within window dropped');
  assert.equal(clients[1].stamps.length, 1);
  assert.equal(clients[0].errors.length, 0, 'dropped silently, no error');
  // another seat is on its own timer
  clients[1].sendStamp('pray');
  await hub.settle();
  assert.deepEqual(host.stamps.map((s) => s.id), ['joy', 'pray']);
  // exactly 1500ms after the first -> accepted
  clock.t += 1;
  clients[0].sendStamp('angry');
  await hub.settle();
  assert.deepEqual(host.stamps.map((s) => s.id), ['joy', 'pray', 'angry']);
  assert.deepEqual(clients[1].stamps.map((s) => s.seat + ':' + s.id), ['1:joy', '2:pray', '1:angry']);
  host.close();
});

test('stamps: ignored from CPU seats and disconnected seats', async () => {
  const { host, clients, hub } = await stampRoom({ config: { seatCount: 4 } });
  host.start();
  await hub.settle();
  assert.equal(host.state().players[3].type, 'cpu');
  // a client disconnects: its seat stays human but connected=false
  const a = clients[0];
  const token = a.info.seatToken;
  a.leave();
  await hub.settle();
  assert.equal(host.lobby().seats[1].connected, false);
  // the client has no conn -> sendStamp returns false locally
  assert.equal(a.sendStamp('joy'), false);
  // host-side: replaced-by-CPU seat can't stamp either. Simulate by replacing seat 2 and checking nothing arrives.
  host.replaceWithCpu(2);
  await hub.settle();
  assert.equal(clients[1].sendStamp('joy'), false, 'replaced client lost its connection');
  await hub.settle();
  assert.equal(host.stamps.length, 0);
  // reconnect seat 1 and stamp -> works again
  const a2 = await joinClient(hub, host.roomCode, 'A', { seatToken: token });
  a2.stamps = []; a2.onStamp((s) => a2.stamps.push(s));
  await hub.settle();
  if (host.state().phase === 'playing') {
    assert.equal(a2.sendStamp('smug'), true);
    await hub.settle();
    assert.deepEqual(host.stamps, [{ seat: 1, id: 'smug' }]);
    assert.deepEqual(a2.stamps, [{ seat: 1, id: 'smug' }]);
  }
  a2.leave();
  host.close();
});

test('stamps: ignored outside the playing phase (lobby, roundEnd, gameOver)', async () => {
  const { host, clients, hub, clock } = await stampRoom({ config: { seatCount: 2, limit: 31 }, names: ['A'] });
  // lobby
  clients[0].sendStamp('joy');
  await hub.settle();
  assert.equal(host.stamps.length, 0);
  host.start();
  await hub.settle();
  // run until a roundEnd or gameOver
  let guard = 0;
  while (host.state().phase === 'playing' && guard++ < 2000) {
    const st = host.state();
    const legal = E.legalMoves(st);
    if (st.currentPlayer === 0) host.submitMove(legal[0]);
    else clients[0].submitMove(legal[0]);
    await hub.settle();
  }
  assert.notEqual(host.state().phase, 'playing');
  clock.t += 10000;
  clients[0].sendStamp('joy');
  assert.equal(host.sendStamp('joy'), false);
  await hub.settle();
  assert.equal(host.stamps.length, 0, 'nothing delivered at ' + host.state().phase);
  assert.equal(clients[0].stamps.length, 0);
  assert.equal(clients[0].errors.length, 0);
  host.close();
});

test('stamps: malformed stamp messages do not break host or client', async () => {
  const { host, clients, hub } = await stampRoom();
  const errors = [];
  host.onError((e) => errors.push(e));
  host.start();
  await hub.settle();
  // raw unseated connection throwing junk stamps at the host
  const t = hub.createTransport();
  await t.open();
  const raw = t.connect(N.peerIdFor(host.roomCode));
  const got = [];
  raw.onMessage((m) => got.push(m));
  const junk = [{ t: 'stamp' }, { t: 'stamp', id: 1 }, { t: 'stamp', id: null }, { t: 'stamp', id: { a: 1 } }, { t: 'stamp', id: 'joy', seat: 0 }, { t: 'stamp', id: '<img>' }];
  for (const j of junk) { raw.send(j); await hub.settle(); }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(host.stamps.length, 0);
  assert.ok(!got.some((m) => m && m.t === 'error'), 'host never answers a stamp with error');
  // host still alive: a seated client stamps fine
  assert.equal(clients[1].sendStamp('think'), true);
  await hub.settle();
  assert.deepEqual(host.stamps, [{ seat: 2, id: 'think' }]);
  t.close();
  // fake host feeding garbage stamps to a client
  const fakeHub = N.createMemoryHub();
  const ft = fakeHub.createTransport();
  await ft.open(N.peerIdFor('0001'));
  let hc = null;
  ft.onConnection((cn) => { hc = cn; cn.onMessage(() => {}); });
  const v = N.createClient({ transport: fakeHub.createTransport(), roomCode: '0001', name: 'V', connectTimeoutMs: 0, backoff: [1] });
  const stamps = [];
  v.onStamp((s) => stamps.push(s));
  v.connect().catch(() => {});
  await fakeHub.settle();
  hc.send({ t: 'joined', seat: 0, seatToken: 'abcdefghijklmnop', roomCode: '0001' });
  const bad = [{ t: 'stamp' }, { t: 'stamp', seat: 1 }, { t: 'stamp', seat: 1, id: 'nope' }, { t: 'stamp', seat: 'x', id: 'joy' }, { t: 'stamp', seat: 8, id: 'joy' },
    { t: 'stamp', seat: -1, id: 'joy' }, { t: 'stamp', seat: 1.5, id: 'joy' }, { t: 'stamp', seat: 1, id: '<script>' }];
  for (const b of bad) hc.send(b);
  await fakeHub.settle();
  assert.equal(stamps.length, 0, 'all malformed stamps rejected');
  hc.send({ t: 'stamp', seat: 4, id: 'pray' });
  await fakeHub.settle();
  assert.deepEqual(stamps, [{ seat: 4, id: 'pray' }], 'client still alive and accepts a valid stamp');
  v.leave(); ft.close();
  host.close();
});

// ---------- up to 8 seats ----------
test('8 seats: 3 humans (host + 2 clients) + 5 CPU start and auto-run to gameOver', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 8, limit: 31, jokers: 0, cpuLevel: 'strong' }, seed: 808 });
  assert.equal(host.lobby().seats.length, 8);
  assert.equal(last(clients[0].lobbies).seats.length, 8);
  assert.equal(last(clients[1].lobbies).config.seatCount, 8);
  host.start();
  await hub.settle();
  const st0 = host.state();
  assert.deepEqual(st0.players.map((p) => p.type), ['human', 'human', 'human', 'cpu', 'cpu', 'cpu', 'cpu', 'cpu']);
  assert.deepEqual(st0.players.slice(3).map((p) => p.name), ['CPU 4', 'CPU 5', 'CPU 6', 'CPU 7', 'CPU 8']);
  assert.equal(st0.deck.length + st0.discardPile.reduce((n, g) => n + g.cards.length, 0) + st0.players.reduce((n, p) => n + p.hand.length, 0), 52);
  clients.forEach((c, i) => {
    const v = last(c.views);
    assert.equal(v.players.length, 8);
    assertViewIsSafe(v, i + 1, st0);
  });
  // humans play from their own views: yaniv when allowed, else the first legal discard + draw
  const pickMove = (legal) => legal.find((m) => m.type === 'yaniv') || legal[0];
  let turns = 0, rounds = 1, reshuffles = 0, prevDeck = st0.deck.length;
  while (host.state().phase !== 'gameOver') {
    const st = host.state();
    if (st.phase === 'roundEnd') {
      assert.equal(last(clients[0].views).roundResult.entries.length, 8);
      host.nextRound();
      rounds++;
      await hub.settle();
      prevDeck = host.state().deck.length;
      continue;
    }
    const cur = st.currentPlayer;
    if (st.players[cur].type === 'cpu') {
      await new Promise((r) => setTimeout(r, 1));
    } else if (cur === 0) {
      assert.equal(host.submitMove(pickMove(E.legalMoves(st))).ok, true);
    } else {
      const c = clients[cur - 1];
      const v = last(c.views);
      assert.equal(v.currentPlayer, cur);
      assertViewIsSafe(v, cur, st);
      c.submitMove(pickMove(v.legalMoves));
    }
    await hub.settle();
    const after = host.state();
    if (after.phase === 'playing' && after.deck.length > prevDeck) reshuffles++;
    prevDeck = after.deck.length;
    turns++;
    if (turns > 20000) throw new Error('8-seat game did not finish');
  }
  const fin = host.state();
  assert.equal(fin.players.filter((p) => !p.eliminated).length, 1);
  assert.ok(fin.winner >= 0 && fin.winner < 8);
  for (const c of clients) {
    assert.equal(last(c.views).phase, 'gameOver');
    assert.equal(last(c.views).winner, fin.winner);
    assert.equal(c.errors.length, 0, JSON.stringify(c.errors));
  }
  assert.ok(rounds >= 2, 'rounds ' + rounds);
  assert.ok(reshuffles >= 1, 'deck refilled at least once (' + reshuffles + ')');
  host.close();
});

test('seat range: MAX_SEATS = 8; seatCount 2-8; seats 0-7 accepted, 8+ rejected on the client', async () => {
  assert.equal(N.MAX_SEATS, 8);
  assert.equal(N.MIN_SEATS, 2);
  for (const x of [0, 1, 5, 7]) assert.equal(N.isSeatIndex(x), true, String(x));
  for (const x of [-1, 8, 9, 1.5, '1', null, NaN, Infinity]) assert.equal(N.isSeatIndex(x), false, String(x));
  // host side
  const { host, hub } = await setupRoom({});
  for (const n of [2, 3, 4, 5, 6, 7, 8]) { host.setConfig({ seatCount: n }); assert.equal(host.lobby().seats.length, n); }
  for (const n of [1, 9, 10, 0, 2.5, '8']) assert.throws(() => host.setConfig({ seatCount: n }), /seatCount must be 2-8/);
  assert.equal(host.lobby().seats.length, 8);
  host.close();
  // client side, fed by a fake host
  const fakeHub = N.createMemoryHub();
  const ft = fakeHub.createTransport();
  await ft.open(N.peerIdFor('0808'));
  let hc = null;
  ft.onConnection((cn) => { hc = cn; cn.onMessage(() => {}); });
  const mk = () => {
    const v = N.createClient({ transport: fakeHub.createTransport(), roomCode: '0808', name: 'V', connectTimeoutMs: 0, backoff: [1] });
    v.stamps = []; v.views = []; v.lobbies = [];
    v.onStamp((x) => v.stamps.push(x)); v.onView((x) => v.views.push(x)); v.onLobby((x) => v.lobbies.push(x));
    v.connect().catch(() => {});
    return v;
  };
  // joined: seat 8 ignored, seat 7 accepted
  const v = mk();
  await fakeHub.settle();
  hc.send({ t: 'joined', seat: 8, seatToken: 'abcdefghijklmnop', roomCode: '0808' });
  await fakeHub.settle();
  assert.notEqual(v.seat, 8);
  hc.send({ t: 'joined', seat: 7, seatToken: 'abcdefghijklmnop', roomCode: '0808' });
  await fakeHub.settle();
  assert.equal(v.seat, 7);
  // stamps: 0-7 ok, 8+ dropped
  for (const seat of [8, 9, 100, -1]) hc.send({ t: 'stamp', seat, id: 'joy' });
  for (const seat of [0, 7]) hc.send({ t: 'stamp', seat, id: 'joy' });
  await fakeHub.settle();
  assert.deepEqual(v.stamps, [{ seat: 0, id: 'joy' }, { seat: 7, id: 'joy' }]);
  // lobby with 9 seats is cut to 8
  const seat = (i) => ({ name: 'S' + i, type: i ? 'cpu' : 'human', connected: true, isHost: !i });
  hc.send({ t: 'lobby', seats: Array.from({ length: 9 }, (_, i) => seat(i)), config: { seatCount: 8 } });
  await fakeHub.settle();
  assert.equal(last(v.lobbies).seats.length, 8);
  // views: 8 players accepted, 9 rejected
  const view = (n, me) => ({ phase: 'playing', seat: me, players: Array.from({ length: n }, (_, i) => (i === me ? { name: 'p' + i, handCount: 1, score: 0, hand: [] } : { name: 'p' + i, handCount: 5, score: 0 })), currentPlayer: 0, round: 1, deckCount: 1, discardPile: [], legalMoves: [], takeable: [], config: { limit: 101 } });
  hc.send({ t: 'view', view: view(9, 7) });
  await fakeHub.settle();
  assert.equal(v.views.length, 0, '9-player view rejected');
  hc.send({ t: 'view', view: view(8, 7) });
  await fakeHub.settle();
  assert.equal(v.views.length, 1, '8-player view accepted');
  assert.equal(v.views[0].players.length, 8);
  v.leave(); ft.close();
});

test('cpuDelayFor: CPU wait shrinks step by step with the number of CPUs', () => {
  assert.deepEqual(N.cpuDelayFor(0), [600, 900]);
  assert.deepEqual(N.cpuDelayFor(1), [600, 900]);
  assert.deepEqual(N.cpuDelayFor(3), [600, 900]);
  assert.deepEqual(N.cpuDelayFor(4), [500, 750]);
  assert.deepEqual(N.cpuDelayFor(5), [450, 650]);
  assert.deepEqual(N.cpuDelayFor(6), [400, 600]);
  assert.deepEqual(N.cpuDelayFor(7), [400, 600]);
  for (let n = 1; n <= 7; n++) {
    const [a, b] = N.cpuDelayFor(n), [pa, pb] = N.cpuDelayFor(n - 1);
    assert.ok(a <= pa && b <= pb && a < b);
  }
  // 2-5 seat tables keep the original wait regardless of CPU count
  for (let players = 2; players <= 5; players++) {
    for (let cpus = 0; cpus < players; cpus++) assert.deepEqual(N.cpuDelayFor(cpus, players), [600, 900]);
  }
  assert.deepEqual(N.cpuDelayFor(7, 8), [400, 600]);
  assert.deepEqual(N.cpuDelayFor(4, 6), [500, 750]);
});

test('parseCodeInput (join field): share URLs, full-width, partial input, old codes', () => {
  const P = N.parseCodeInput;
  // typing: 0-3 digits are fine, 4 digits complete
  assert.deepEqual(P(''), { value: '', code: '', error: false, fromUrl: false });
  assert.deepEqual(P('12'), { value: '12', code: '', error: false, fromUrl: false });
  assert.deepEqual(P('0042'), { value: '0042', code: '0042', error: false, fromUrl: false });
  // paste with separators / full-width
  assert.equal(P('12-34').code, '1234');
  assert.equal(P(' 12 34 ').code, '1234');
  assert.equal(P('１２３４').code, '1234');
  assert.equal(P('１２３４').value, '1234');
  // share URL (any text containing room=dddd), full-width digits too
  const url = P('https://kazuma-masunaga.github.io/yaniv/?room=0427');
  assert.deepEqual(url, { value: '0427', code: '0427', error: false, fromUrl: true });
  assert.equal(P('参加してね https://x.example/?a=1&room=9876#top').code, '9876');
  assert.equal(P('?room=０４２７').code, '0427');
  // old / bad codes: error, digits are NOT extracted
  for (const bad of ['AB2345', 'ABC234', 'abcd', '12a4', '12345', '234567', 'https://x.example/?room=ABC234', '?room=12345']) {
    const r = P(bad);
    assert.equal(r.error, true, bad);
    assert.equal(r.code, '', bad);
    assert.equal(r.value, bad, 'raw text kept so the user sees it: ' + bad);
  }
  assert.equal(P(null).error, false);
});

test('normalizeMove / sanitizeName / normalizeCode', () => {
  assert.deepEqual(N.normalizeMove({ type: 'yaniv', junk: 1 }), { type: 'yaniv' });
  assert.deepEqual(N.normalizeMove({ type: 'play', discard: ['5S'], draw: 'deck' }), { type: 'play', discard: ['5S'], draw: 'deck' });
  assert.equal(N.normalizeMove({ type: 'play', discard: [5], draw: 'deck' }), null);
  assert.equal(N.normalizeMove({ type: 'play', discard: ['5S'], draw: 5 }), null);
  assert.equal(N.normalizeMove([]), null);
  assert.equal(N.normalizeMove(null), null);
  assert.equal(N.sanitizeName('  abcdefghijklmnop '), 'abcdefghijkl');
  assert.equal(N.sanitizeName(12), '');
  assert.equal(N.sanitizeName('a\u0000b'), 'ab');
  assert.equal(N.normalizeCode('12 34'), '1234');
  assert.equal(N.normalizeCode('abcdefgh'), 'abcdefgh', 'letters are kept so the code stays invalid');
  assert.equal(N.isValidCode('123'), false);
  assert.equal(N.peerIdFor('0123'), 'yaniv-kmz7-0123');
  assert.equal(N.PEER_PREFIX, 'yaniv-kmz7-');
});
