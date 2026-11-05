'use strict';
// 脱落ライン 201 / 301 と「単発」モード（limit: 0 = 1ラウンド勝負）のテスト（engine + net）。
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');
const N = require('../net.js');

const C = (rank, suit) => ({ id: rank + suit, rank, suit });
const J1 = { id: 'JOKER1', rank: 'JOKER', suit: 'J1' };
const J2 = { id: 'JOKER2', rank: 'JOKER', suit: 'J2' };
const last = (arr) => arr[arr.length - 1];

function cfg(n, extra = {}) {
  const players = [];
  for (let i = 0; i < n; i++) players.push({ name: 'P' + i, type: 'cpu' });
  return Object.assign({ players, jokers: 2, limit: E.SINGLE, cpuLevel: 'normal' }, extra);
}

/** Playing state with explicit hands (limit defaults to single). */
function fixture({ hands, currentPlayer = 0, limit = E.SINGLE }) {
  let s = E.createGame(cfg(hands.length, { limit }), E.createRng(1));
  s = E.startRound(s, E.createRng(1));
  s.players.forEach((p, i) => { p.hand = hands[i].slice(); });
  s.deck = [C('A', 'C')];
  s.discardPile = [{ kind: 'single', cards: [C('5', 'H')], by: null }];
  s.currentPlayer = currentPlayer;
  return s;
}

// =====================================================================
// engine
// =====================================================================
test('limits: SINGLE = 0, LIMITS = 0/31/51/71/101/201/301, default stays 101', () => {
  assert.equal(E.SINGLE, 0);
  assert.deepEqual(E.LIMITS, [0, 31, 51, 71, 101, 201, 301]);
  for (const limit of [0, 31, 51, 71, 101, 201, 301]) {
    assert.equal(E.createGame(cfg(2, { limit }), E.createRng(1)).config.limit, limit);
  }
  assert.equal(E.createGame(cfg(2, { limit: undefined }), E.createRng(1)).config.limit, 101);
  assert.equal(E.createGame(cfg(2, { limit: null }), E.createRng(1)).config.limit, 101);
  for (const limit of [72, 200, 302, -1, '0', '201', 0.5, 1, NaN, false]) {
    assert.throws(() => E.createGame(cfg(2, { limit }), E.createRng(1)), /limit/, String(limit));
  }
  assert.equal(E.isSingle({ limit: 0 }), true);
  assert.equal(E.isSingle({ limit: 101 }), false);
});

test('single: yaniv success -> gameOver directly (no roundEnd), ranking by added, nobody eliminated', () => {
  // P0 declares 3. P1 = 19, P2 = 10.
  const s = fixture({ hands: [[C('3', 'S')], [C('9', 'S'), C('K', 'D')], [C('2', 'C'), C('8', 'C')]] });
  const t = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.equal(t.phase, 'gameOver');
  assert.deepEqual(t.ranking, [0, 2, 1]);
  assert.equal(t.winner, 0);
  assert.ok(t.players.every((p) => !p.eliminated));
  assert.deepEqual(t.players.map((p) => p.score), [0, 19, 10], 'score = added of the single round');
  const r = t.roundResult;
  assert.equal(r.declarer, 0);
  assert.equal(r.assaf, null);
  assert.deepEqual(r.entries.map((e) => e.added), [0, 19, 10]);
  assert.deepEqual(r.entries.map((e) => e.role), ['yaniv', 'normal', 'normal']);
  assert.ok(r.entries.every((e) => !e.eliminated && !e.newlyEliminated && e.wasActive));
  assert.ok(r.entries.every((e) => Array.isArray(e.hand) && e.hand.length > 0));
  assert.throws(() => E.startRound(t, E.createRng(2)), /phase gameOver/);
  // the ranking survives cloning (next applyMove is not possible, but cloneState is used by startRound etc.)
  assert.deepEqual(JSON.parse(JSON.stringify(t)).ranking, [0, 2, 1]);
});

test('single: assaf -> the counter wins, the caught declarer gets value + 30 and ranks by it', () => {
  // P1 declares 7, P2 has 3 (assaf), P0 has 20, P3 has 40.
  const s = fixture({
    hands: [[C('K', 'S'), C('Q', 'H')], [C('3', 'S'), C('4', 'D')], [C('A', 'C'), C('2', 'C')], [C('K', 'H'), C('Q', 'S'), C('J', 'D'), C('10', 'C')]],
    currentPlayer: 1
  });
  const t = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.equal(t.phase, 'gameOver');
  assert.equal(t.roundResult.assaf, 2);
  assert.deepEqual(t.roundResult.entries.map((e) => e.added), [20, 37, 0, 40]);
  assert.deepEqual(t.ranking, [2, 0, 1, 3]);
  assert.equal(t.winner, 2);
  assert.ok(t.players.every((p) => !p.eliminated));
});

test('single: ties are broken by turn order seen from the declarer (declarer first, then clockwise)', () => {
  // declarer P1 (value 5, success). P2, P3, P0 all add 10 -> 1, 2, 3, 0.
  let s = fixture({
    hands: [[C('10', 'S')], [C('5', 'S')], [C('10', 'H')], [C('10', 'D')]],
    currentPlayer: 1
  });
  let t = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.deepEqual(t.roundResult.entries.map((e) => e.added), [10, 0, 10, 10]);
  assert.deepEqual(t.ranking, [1, 2, 3, 0]);
  // declarer P2 at 0 points ties a non-assaf 0 (equal value is not a counter): declarer ranks first.
  s = fixture({
    hands: [[J1], [C('K', 'S')], [J2], [C('4', 'S')]],
    currentPlayer: 2
  });
  t = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.equal(t.roundResult.assaf, null);
  assert.deepEqual(t.roundResult.entries.map((e) => e.added), [0, 10, 0, 4]);
  assert.deepEqual(t.ranking, [2, 0, 3, 1]);
  assert.equal(t.winner, 2);
  // two hands at the same lowest value: the first in turn order from the declarer is the assaf (0),
  // the other one adds its value.
  s = fixture({
    hands: [[C('2', 'S')], [C('6', 'S')], [C('2', 'H')], [C('8', 'S')]],
    currentPlayer: 1
  });
  t = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.equal(t.roundResult.assaf, 2, 'first lower hand in turn order from the declarer');
  assert.deepEqual(t.roundResult.entries.map((e) => e.added), [2, 36, 0, 8]);
  assert.deepEqual(t.ranking, [2, 0, 3, 1]);
});

test('singleRanking: pure helper (ties from the declarer, wrap-around)', () => {
  const en = (added) => ({ added, wasActive: true });
  assert.deepEqual(E.singleRanking([en(5), en(5), en(5)], 2), [2, 0, 1]);
  assert.deepEqual(E.singleRanking([en(3), en(0), en(3), en(1)], 3), [1, 3, 0, 2]);
  assert.deepEqual(E.singleRanking([en(3), { added: 0, wasActive: false }, en(1)], 0), [2, 0, 1]);
});

test('normal mode is unchanged: limit 201/301 go through roundEnd and eliminate at the limit', () => {
  for (const limit of [201, 301]) {
    const s = fixture({ hands: [[C('3', 'S')], [C('9', 'S'), C('K', 'D')], [C('2', 'C'), C('8', 'C')]], limit });
    s.players[1].score = limit - 19; // 19 more -> exactly the limit
    const t = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
    assert.equal(t.phase, 'roundEnd');
    assert.equal(t.ranking, null);
    assert.equal(t.players[1].eliminated, true);
    assert.equal(t.players[2].eliminated, false);
    assert.equal(t.players[1].score, limit);
  }
});

test('single: CPU-only games of 2-8 players always finish in exactly one round', () => {
  let games = 0;
  for (let n = 2; n <= 8; n++) {
    for (const level of ['weak', 'normal', 'strong']) {
      for (let seed = 1; seed <= 15; seed++) {
        const rng = E.createRng(seed * 31 + n * 7);
        let s = E.createGame(cfg(n, { jokers: seed % 3, cpuLevel: level }), rng);
        s = E.startRound(s, rng);
        let t = 0;
        while (s.phase === 'playing') {
          s = E.applyMove(s, E.chooseMove(s, s.currentPlayer, level, rng), rng);
          assert.ok(++t < 3000, `single game did not end: n=${n} ${level} seed=${seed}`);
        }
        assert.equal(s.phase, 'gameOver');
        assert.equal(s.round, 1);
        assert.ok(s.players.every((p) => !p.eliminated));
        assert.equal(s.ranking.length, n);
        assert.deepEqual(s.ranking.slice().sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
        assert.equal(s.winner, s.ranking[0]);
        const added = s.roundResult.entries.map((e) => e.added);
        assert.deepEqual(s.players.map((p) => p.score), added);
        for (let k = 1; k < n; k++) assert.ok(added[s.ranking[k - 1]] <= added[s.ranking[k]]);
        games++;
      }
    }
  }
  assert.equal(games, 7 * 3 * 15);
});

test('single: deterministic (same seed -> identical JSON)', () => {
  const run = () => {
    const rng = E.createRng(2024);
    let s = E.startRound(E.createGame(cfg(5), rng), rng);
    while (s.phase === 'playing') s = E.applyMove(s, E.chooseMove(s, s.currentPlayer, 'strong', rng), rng);
    return JSON.stringify(s);
  };
  assert.equal(run(), run());
});

// =====================================================================
// net
// =====================================================================
async function setupRoom(opts = {}) {
  const hub = N.createMemoryHub();
  const host = N.createHost({
    transport: hub.createTransport(),
    engine: E,
    rng: E.createRng(opts.seed || 11),
    random: E.createRng((opts.seed || 11) + 1),
    hostName: 'ホスト',
    cpuDelay: [0, 0]
  });
  const code = await host.open();
  if (opts.config) host.setConfig(opts.config);
  const clients = [];
  for (const name of opts.names || []) clients.push(await joinClient(hub, code, name));
  await hub.settle();
  return { hub, host, code, clients };
}

async function joinClient(hub, code, name, extra = {}) {
  const c = N.createClient(Object.assign({ transport: hub.createTransport(), roomCode: code, name, connectTimeoutMs: 0, backoff: [1, 1] }, extra));
  c.lobbies = []; c.views = []; c.errors = []; c.closed = [];
  c.onLobby((l) => c.lobbies.push(l));
  c.onView((v) => c.views.push(v));
  c.onError((e) => c.errors.push(e));
  c.onClosed((x) => c.closed.push(x));
  c.info = await c.connect();
  return c;
}

/** Drive the current game to gameOver: humans play CPU-chosen moves (host directly, clients over the wire). */
async function finishGame(hub, host, clients, seed = 1) {
  const rng = E.createRng(seed);
  let guard = 0;
  let sawRoundEnd = false;
  while (host.state().phase !== 'gameOver') {
    const st = host.state();
    if (st.phase === 'roundEnd') { sawRoundEnd = true; host.nextRound(); await hub.settle(); continue; }
    const cur = st.currentPlayer;
    if (st.players[cur].type === 'cpu') {
      await new Promise((r) => setTimeout(r, 1));
    } else if (cur === 0) {
      assert.equal(host.submitMove(E.chooseMove(st, 0, 'normal', rng)).ok, true);
    } else {
      const c = clients.find((x) => x.info.seat === cur);
      c.submitMove(E.chooseMove(st, cur, 'normal', rng));
    }
    await hub.settle();
    if (++guard > 5000) throw new Error('game did not finish');
  }
  return { sawRoundEnd };
}

test('net: setConfig accepts limit 0/201/301 and rejects others; LIMITS exported', async () => {
  assert.deepEqual(N.LIMITS, [0, 31, 51, 71, 101, 201, 301]);
  assert.equal(N.SINGLE, 0);
  const { host, clients, hub } = await setupRoom({ names: ['A'] });
  for (const limit of [0, 201, 301, 31, 101]) {
    assert.equal(host.setConfig({ limit }).limit, limit);
    await hub.settle();
    assert.equal(last(clients[0].lobbies).config.limit, limit, 'client lobby keeps limit ' + limit);
  }
  for (const limit of [72, '0', -1, 0.5, 1000]) assert.throws(() => host.setConfig({ limit }), /limit/);
  assert.equal(host.config().limit, 101);
  host.close();
});

test('net: single room ends after one round; wins are counted, broadcast and kept across restart', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 4, limit: 0 }, seed: 7 });
  assert.deepEqual(host.lobby().wins, [0, 0, 0, 0]);
  host.start();
  await hub.settle();
  assert.deepEqual(last(clients[0].views).wins, [0, 0, 0, 0]);
  const r1 = await finishGame(hub, host, clients, 1);
  assert.equal(r1.sawRoundEnd, false, 'single never stops at roundEnd');
  const st = host.state();
  assert.equal(st.phase, 'gameOver');
  assert.equal(st.round, 1);
  assert.ok(st.players.every((p) => !p.eliminated));
  const w1 = host.wins();
  assert.equal(w1.reduce((a, b) => a + b, 0), 1);
  assert.equal(w1[st.winner], 1);
  // clients see the gameOver view with wins + ranking; the lobby carries wins too
  for (const c of clients) {
    const v = last(c.views);
    assert.equal(v.phase, 'gameOver');
    assert.deepEqual(v.wins, w1);
    assert.deepEqual(v.ranking, st.ranking);
    assert.equal(v.winner, st.winner);
    assert.deepEqual(last(c.lobbies).wins, w1);
  }
  // restart: wins carried over, second game adds one more
  host.restart();
  await hub.settle();
  assert.deepEqual(host.wins(), w1);
  assert.deepEqual(last(clients[1].views).wins, w1);
  await finishGame(hub, host, clients, 2);
  const w2 = host.wins();
  assert.equal(w2.reduce((a, b) => a + b, 0), 2);
  assert.equal(w2[host.state().winner], w1[host.state().winner] + 1);
  // back to the lobby: everyone's wins reset to 0 (same as local "設定に戻る")
  host.backToLobby();
  await hub.settle();
  const w3 = host.wins();
  assert.deepEqual(w3, [0, 0, 0, 0]);
  assert.deepEqual(last(clients[0].lobbies).wins, w3);
  clients.forEach((c) => assert.equal(c.errors.length, 0, JSON.stringify(c.errors)));
  host.close();
});

test('net: normal mode never counts wins', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A'], config: { seatCount: 2, limit: 31 }, seed: 3 });
  host.start();
  await hub.settle();
  await finishGame(hub, host, clients, 3);
  assert.equal(host.state().phase, 'gameOver');
  assert.deepEqual(host.wins(), [0, 0]);
  assert.equal(host.state().ranking, null);
  assert.equal(last(clients[0].views).ranking, null);
  host.close();
});

/** Play single games until `seat` has at least one win (restart between games). */
async function winFor(hub, host, clients, seat) {
  for (let g = 0; g < 40; g++) {
    if (host.state() && host.state().phase === 'gameOver') host.restart();
    else if (!host.state()) host.start();
    await hub.settle();
    await finishGame(hub, host, clients, 100 + g);
    if (host.wins()[seat] > 0) return;
  }
  throw new Error('seat ' + seat + ' never won');
}

test('net: kick (lobby) and replaceWithCpu (in game) reset that seat; others keep their wins', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 3, limit: 0 }, seed: 17 });
  await winFor(hub, host, clients, 1);
  await winFor(hub, host, clients, 2);
  const before = host.wins();
  assert.ok(before[1] > 0 && before[2] > 0);
  // replaceWithCpu during a game
  host.restart();
  await hub.settle();
  host.replaceWithCpu(2);
  await hub.settle();
  assert.equal(host.wins()[2], 0);
  assert.equal(host.wins()[1], before[1]);
  assert.equal(host.wins()[0], before[0]);
  assert.equal(last(clients[0].views).wins[2], 0, 'broadcast to the remaining client');
  // kick in the lobby
  host.backToLobby();
  await hub.settle();
  assert.equal(host.lobby().seats[2].type, 'empty');
  host.kick(1);
  await hub.settle();
  assert.deepEqual(host.wins(), [0, 0, 0]);
  // a different person joins the freed seat -> starts from 0
  const c = await joinClient(hub, host.roomCode, 'New');
  assert.equal(c.info.seat, 1);
  await hub.settle();
  assert.equal(host.wins()[1], 0);
  assert.deepEqual(last(c.lobbies).wins, host.wins());
  host.close();
});

test('net: kick during a game resets the seat; reconnect with the same seatToken keeps the wins', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 3, limit: 0 }, seed: 23 });
  await winFor(hub, host, clients, 1);
  await winFor(hub, host, clients, 2);
  const before = host.wins();
  // seat 1 drops and comes back with its token (game over screen)
  const a = clients[0];
  const token = a.info.seatToken;
  a.leave();
  await hub.settle();
  const a2 = await joinClient(hub, host.roomCode, 'A', { seatToken: token });
  await hub.settle();
  assert.equal(a2.info.seat, 1);
  assert.deepEqual(host.wins(), before, 'same seatToken: wins kept');
  assert.deepEqual(last(a2.views).wins, before);
  // restart and kick seat 2 mid-game -> CPU, 0
  host.restart();
  await hub.settle();
  host.kick(2);
  await hub.settle();
  assert.equal(host.wins()[2], 0);
  assert.equal(host.wins()[1], before[1]);
  host.close();
});

test('net: seatCount changes resize wins', async () => {
  const { host, hub } = await setupRoom({ config: { seatCount: 3, limit: 0 } });
  host.setConfig({ seatCount: 6 });
  assert.deepEqual(host.lobby().wins, [0, 0, 0, 0, 0, 0]);
  host.setConfig({ seatCount: 2 });
  assert.deepEqual(host.lobby().wins, [0, 0]);
  await hub.settle();
  host.close();
});

test('net: client validates wins / ranking / limit in views and lobbies', async () => {
  const hub = N.createMemoryHub();
  const ht = hub.createTransport();
  await ht.open(N.peerIdFor('7070'));
  let hc = null;
  ht.onConnection((cn) => { hc = cn; cn.onMessage(() => {}); });
  const v = N.createClient({ transport: hub.createTransport(), roomCode: '7070', name: 'V', connectTimeoutMs: 0, backoff: [1] });
  const views = [], lobbies = [];
  v.onView((x) => views.push(x));
  v.onLobby((x) => lobbies.push(x));
  v.connect().catch(() => {});
  await hub.settle();
  hc.send({ t: 'joined', seat: 0, seatToken: 'abcdefghijklmnop', roomCode: '7070' });
  const base = () => ({ phase: 'playing', seat: 0, players: [{ name: 'a', handCount: 1, score: 0, hand: [] }, { name: 'b', handCount: 1, score: 0 }], currentPlayer: 0, round: 1, deckCount: 1, discardPile: [], legalMoves: [], takeable: [], config: { limit: 0 } });
  const over = () => Object.assign(base(), { phase: 'gameOver', winner: 1, ranking: [1, 0], roundResult: { round: 1, declarer: 0, declarerValue: 7, assaf: 1, entries: [{ name: 'a', hand: [], value: 7, added: 37, total: 37 }, { name: 'b', hand: [], value: 3, added: 0, total: 0 }] } });
  const bad = [];
  for (const w of [[0], [0, 0, 0], [0, -1], [0, 1.5], [0, '1'], [0, null], 'x', { 0: 1, 1: 0 }]) { const x = base(); x.wins = w; bad.push(x); }
  for (const limit of [72, 1, '0', null, -1, 200]) { const x = base(); x.config.limit = limit; bad.push(x); }
  for (const rk of [[0], [0, 0], [0, 2], [1, -1], 'x', [0, 1.5]]) { const x = over(); x.ranking = rk; bad.push(x); }
  for (const b of bad) hc.send({ t: 'view', view: b });
  await hub.settle();
  assert.equal(views.length, 0, 'all malformed views rejected');
  // well-formed: limits 0/201/301, wins present or absent, ranking on gameOver
  for (const limit of [0, 201, 301]) { const x = base(); x.config.limit = limit; x.wins = [0, 3]; hc.send({ t: 'view', view: x }); }
  hc.send({ t: 'view', view: base() });
  const o = over(); o.wins = [2, 5]; hc.send({ t: 'view', view: o });
  await hub.settle();
  assert.equal(views.length, 5);
  assert.deepEqual(last(views).wins, [2, 5]);
  assert.deepEqual(last(views).ranking, [1, 0]);
  // lobbies
  const seats = [{ name: 'H', type: 'human', connected: true, isHost: true }, { name: 'X', type: 'cpu', connected: false }];
  for (const w of [[0], [0, -2], [0, 'a'], [0, 0.5], 'zz', [0, 0, 0]]) hc.send({ t: 'lobby', seats, wins: w, config: { limit: 0, seatCount: 2 } });
  await hub.settle();
  assert.equal(lobbies.length, 0, 'lobbies with bad wins rejected');
  hc.send({ t: 'lobby', seats, wins: [4, 1], config: { limit: 0, seatCount: 2 } });
  hc.send({ t: 'lobby', seats, wins: [4, 1], config: { limit: 201, seatCount: 2 } });
  hc.send({ t: 'lobby', seats, wins: [4, 1], config: { limit: 301, seatCount: 2 } });
  hc.send({ t: 'lobby', seats, config: { limit: 72, seatCount: 2 } });
  await hub.settle();
  assert.equal(lobbies.length, 4);
  assert.deepEqual(lobbies.map((l) => l.config.limit), [0, 201, 301, 101], 'unknown limit (72) is not taken over');
  assert.deepEqual(lobbies[0].wins, [4, 1]);
  assert.deepEqual(lobbies[3].wins, [0, 0], 'absent wins -> zeros');
  v.leave(); ht.close();
});

// =====================================================================
// lasts（単発の通算最下位数）: wins と同じ扱い
// =====================================================================
const sum = (a) => a.reduce((x, y) => x + y, 0);

test('net: single lasts: ranking last +1 per game, total = games, carried across restart, broadcast, no double count', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 4, limit: 0 }, seed: 9 });
  assert.deepEqual(host.lobby().lasts, [0, 0, 0, 0]);
  host.start();
  await hub.settle();
  assert.deepEqual(last(clients[0].views).lasts, [0, 0, 0, 0]);
  let prev = host.lasts();
  for (let g = 1; g <= 5; g++) {
    if (g > 1) {
      host.restart();
      await hub.settle();
      assert.deepEqual(host.lasts(), prev, 'restart carries lasts over');
      assert.deepEqual(last(clients[1].views).lasts, prev);
    }
    await finishGame(hub, host, clients, 40 + g);
    const st = host.state();
    const lo = last(st.ranking);
    const now = host.lasts();
    const expect = prev.slice(); expect[lo]++;
    assert.deepEqual(now, expect, 'exactly the last-ranked seat +1 (game ' + g + ')');
    assert.equal(sum(now), g, 'total lasts = games played');
    assert.equal(sum(host.wins()), g);
    for (const c of clients) {
      assert.deepEqual(last(c.views).lasts, now);
      assert.deepEqual(last(c.lobbies).lasts, now);
    }
    // more state changes at gameOver must not count again (reconnect re-sends the view)
    const a = clients[0];
    const token = a.info.seatToken;
    a.leave();
    await hub.settle();
    const a2 = await joinClient(hub, host.roomCode, 'A', { seatToken: token });
    await hub.settle();
    clients[0] = a2;
    assert.deepEqual(host.lasts(), now, 'reconnect: kept and not double-counted');
    assert.deepEqual(last(a2.views).lasts, now);
    prev = now;
  }
  clients.forEach((c) => assert.equal(c.errors.length, 0, JSON.stringify(c.errors)));
  host.close();
});

test('net: lasts are not double-counted by afterChange at gameOver (replaceWithCpu of another seat)', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 3, limit: 0 }, seed: 5 });
  host.start();
  await hub.settle();
  await finishGame(hub, host, clients, 5);
  const before = host.lasts();
  const winsBefore = host.wins();
  assert.equal(sum(before), 1);
  host.replaceWithCpu(2); // afterChange() runs again at gameOver
  await hub.settle();
  const after = host.lasts();
  assert.equal(after[2], 0);
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.equal(host.wins()[1], winsBefore[1]);
  host.close();
});

test('net: normal mode never counts lasts', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A'], config: { seatCount: 3, limit: 31 }, seed: 4 });
  host.start();
  await hub.settle();
  await finishGame(hub, host, clients, 4);
  assert.equal(host.state().phase, 'gameOver');
  assert.deepEqual(host.lasts(), [0, 0, 0]);
  assert.deepEqual(last(clients[0].views).lasts, [0, 0, 0]);
  host.close();
});

/** Play single games until `seat` has at least one last place (restart between games). */
async function lastFor(hub, host, clients, seat) {
  for (let g = 0; g < 60; g++) {
    if (host.state() && host.state().phase === 'gameOver') host.restart();
    else if (!host.state()) host.start();
    await hub.settle();
    await finishGame(hub, host, clients, 300 + g);
    if (host.lasts()[seat] > 0) return;
  }
  throw new Error('seat ' + seat + ' never ranked last');
}

test('net: lasts reset like wins (replaceWithCpu / kick / new person / back to lobby); same seatToken keeps them', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 4, limit: 0 }, seed: 31 });
  await lastFor(hub, host, clients, 1);
  await lastFor(hub, host, clients, 2);
  let before = host.lasts();
  assert.ok(before[1] > 0 && before[2] > 0);
  // reconnect with the same seatToken: kept
  const a = clients[0];
  const token = a.info.seatToken;
  a.leave();
  await hub.settle();
  const a2 = await joinClient(hub, host.roomCode, 'A', { seatToken: token });
  await hub.settle();
  assert.equal(a2.info.seat, 1);
  assert.deepEqual(host.lasts(), before, 'same seatToken: lasts kept');
  assert.deepEqual(last(a2.views).lasts, before);
  assert.deepEqual(last(a2.lobbies).lasts, before);
  // replaceWithCpu in a game -> that seat 0, others kept
  host.restart();
  await hub.settle();
  host.replaceWithCpu(2);
  await hub.settle();
  assert.equal(host.lasts()[2], 0);
  assert.equal(host.wins()[2], 0);
  assert.equal(host.lasts()[1], before[1]);
  assert.equal(host.lasts()[0], before[0]);
  assert.equal(last(a2.views).lasts[2], 0, 'broadcast');
  // play on so others still have lasts, then kick seat 1 mid-game
  await finishGame(hub, host, [a2], 77);
  before = host.lasts();
  host.restart();
  await hub.settle();
  host.kick(1);
  await hub.settle();
  assert.equal(host.lasts()[1], 0);
  assert.equal(host.wins()[1], 0);
  for (const i of [0, 2, 3]) assert.equal(host.lasts()[i], before[i]);
  // back to the lobby: everyone 0
  await finishGame(hub, host, [], 78);
  assert.ok(sum(host.lasts()) > 0);
  host.backToLobby();
  await hub.settle();
  assert.deepEqual(host.lasts(), [0, 0, 0, 0]);
  assert.deepEqual(host.lobby().lasts, [0, 0, 0, 0]);
  host.close();
});

test('net: lasts — back to lobby resets all; kick in the lobby + a different person joining starts that seat from 0', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 3, limit: 0 }, seed: 41 });
  await lastFor(hub, host, clients, 1);
  // 「部屋のロビーへ」で全員 0。そのあとロビーで外して別の人が座っても 0 のまま
  host.backToLobby();
  await hub.settle();
  assert.deepEqual(host.lasts(), [0, 0, 0]);
  // a different person joins a freed seat -> 0 (and the lobby shows 0)
  host.kick(2);
  await hub.settle();
  const c = await joinClient(hub, host.roomCode, 'New');
  assert.equal(c.info.seat, 2);
  await hub.settle();
  assert.deepEqual(last(c.lobbies).lasts, host.lasts());
  assert.equal(host.lasts()[2], 0);
  host.close();
});

test('net: seatCount changes resize lasts', async () => {
  const { host, hub } = await setupRoom({ config: { seatCount: 3, limit: 0 } });
  host.setConfig({ seatCount: 7 });
  assert.deepEqual(host.lobby().lasts, [0, 0, 0, 0, 0, 0, 0]);
  host.setConfig({ seatCount: 2 });
  assert.deepEqual(host.lobby().lasts, [0, 0]);
  await hub.settle();
  host.close();
});

test('net: client validates lasts in views and lobbies (bad -> rejected, absent -> accepted / zeros)', async () => {
  const hub = N.createMemoryHub();
  const ht = hub.createTransport();
  await ht.open(N.peerIdFor('7171'));
  let hc = null;
  ht.onConnection((cn) => { hc = cn; cn.onMessage(() => {}); });
  const v = N.createClient({ transport: hub.createTransport(), roomCode: '7171', name: 'V', connectTimeoutMs: 0, backoff: [1] });
  const views = [], lobbies = [];
  v.onView((x) => views.push(x));
  v.onLobby((x) => lobbies.push(x));
  v.connect().catch(() => {});
  await hub.settle();
  hc.send({ t: 'joined', seat: 0, seatToken: 'abcdefghijklmnop', roomCode: '7171' });
  const base = () => ({ phase: 'gameOver', seat: 0, winner: 1, ranking: [1, 0], players: [{ name: 'a', handCount: 1, score: 0, hand: [] }, { name: 'b', handCount: 1, score: 0 }], currentPlayer: 0, round: 1, deckCount: 1, discardPile: [], legalMoves: [], takeable: [], config: { limit: 0 }, wins: [0, 1], roundResult: { round: 1, declarer: 0, declarerValue: 7, assaf: 1, entries: [{ name: 'a', hand: [], value: 7, added: 37, total: 37 }, { name: 'b', hand: [], value: 3, added: 0, total: 0 }] } });
  for (const l of [[0], [0, 0, 0], [0, -1], [0, 1.5], [0, '1'], [0, null], 'x', { 0: 1, 1: 0 }, [NaN, 0], [Infinity, 0]]) {
    const x = base(); x.lasts = l; hc.send({ t: 'view', view: x });
  }
  await hub.settle();
  assert.equal(views.length, 0, 'malformed lasts rejected');
  const ok = base(); ok.lasts = [1, 0]; hc.send({ t: 'view', view: ok });
  hc.send({ t: 'view', view: base() }); // no lasts (old host)
  await hub.settle();
  assert.equal(views.length, 2);
  assert.deepEqual(views[0].lasts, [1, 0]);
  assert.equal(views[1].lasts, undefined, 'absent lasts accepted (the UI treats it as all 0)');
  const seats = [{ name: 'H', type: 'human', connected: true, isHost: true }, { name: 'X', type: 'cpu', connected: false }];
  for (const l of [[0], [0, -2], [0, 'a'], [0, 0.5], 'zz', [0, 0, 0]]) hc.send({ t: 'lobby', seats, wins: [0, 0], lasts: l, config: { limit: 0, seatCount: 2 } });
  await hub.settle();
  assert.equal(lobbies.length, 0, 'lobbies with bad lasts rejected');
  hc.send({ t: 'lobby', seats, wins: [1, 0], lasts: [0, 3], config: { limit: 0, seatCount: 2 } });
  hc.send({ t: 'lobby', seats, wins: [1, 0], config: { limit: 0, seatCount: 2 } });
  await hub.settle();
  assert.equal(lobbies.length, 2);
  assert.deepEqual(lobbies[0].lasts, [0, 3]);
  assert.deepEqual(lobbies[1].lasts, [0, 0], 'absent lasts -> zeros');
  v.leave(); ht.close();
});
