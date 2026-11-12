'use strict';
// 席順（手番の順）のランダム化: config.seatOrder = 'join' | 'random'（オンラインのみ、既定 'random'）
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');
const N = require('../net.js');

const last = (arr) => arr[arr.length - 1];

/** seatRandom の差し替え: queue の値を順に返し、尽きたら fallback。呼ばれた回数も数える。 */
function seqRandom(queue = [], fallback = 0) {
  const f = () => { f.calls++; return queue.length ? queue.shift() : fallback; };
  f.calls = 0;
  return f;
}

async function joinClient(hub, code, name, extra = {}) {
  const transport = extra.transport || hub.createTransport();
  const c = N.createClient(Object.assign({ roomCode: code, name, connectTimeoutMs: 0, backoff: [1, 1] }, extra, { transport }));
  c.transport = transport;
  c.lobbies = []; c.views = []; c.errors = []; c.closed = []; c.joinedMsgs = []; c.stamps = [];
  c.onLobby((l) => c.lobbies.push(l));
  c.onView((v) => c.views.push(v));
  c.onError((e) => c.errors.push(e));
  c.onClosed((x) => c.closed.push(x));
  c.onJoined((j) => c.joinedMsgs.push(j));
  c.onStamp((s) => c.stamps.push(s));
  c.info = await c.connect();
  return c;
}

/** seatOrder は既定（'random'）のまま。seatRandom を注入。 */
async function setupRoom(opts = {}) {
  const hub = N.createMemoryHub();
  const seatRandom = opts.seatRandom || seqRandom();
  const host = N.createHost({
    transport: hub.createTransport(),
    engine: E,
    rng: E.createRng(opts.seed || 21),
    random: E.createRng((opts.seed || 21) + 1),
    seatRandom,
    hostName: 'ホスト',
    cpuDelay: [0, 0],
    now: opts.now
  });
  const code = await host.open();
  if (opts.config) host.setConfig(opts.config);
  host.stamps = [];
  host.onStamp((s) => host.stamps.push(s));
  const clients = [];
  for (const name of opts.names || []) clients.push(await joinClient(hub, code, name));
  await hub.settle();
  return { hub, host, code, clients, seatRandom };
}

function assertViewIsSafe(view, seat, hostState) {
  assert.equal(view.seat, seat);
  view.players.forEach((p, i) => {
    if (i === seat) {
      assert.ok(Array.isArray(p.hand), 'own hand present');
      assert.deepEqual(p.hand.map((c) => c.id), hostState.players[i].hand.map((c) => c.id), 'own hand = host state hand of that seat');
    } else {
      assert.ok(!('hand' in p), `player ${i} hand leaked to seat ${seat}`);
    }
  });
  if (view.phase === 'playing') {
    const json = JSON.stringify(Object.assign({}, view, { roundResult: null, players: view.players.map((p, i) => (i === seat ? {} : p)), discardPile: [], legalMoves: [], takeable: [], lastMove: null }));
    hostState.players.forEach((p, i) => {
      if (i === seat) return;
      p.hand.forEach((c) => assert.ok(!json.includes('"' + c.id + '"'), `card ${c.id} of player ${i} leaked`));
    });
  }
}

/** 誰の番でも、その人の端末（ホスト / client.seat が一致する参加者）から手を打って gameOver まで進める。 */
async function playToGameOver(room, maxTurns = 20000) {
  const { host, hub, clients } = room;
  const pick = (legal) => legal.find((m) => m.type === 'yaniv') || legal[0];
  let turns = 0;
  while (host.state().phase !== 'gameOver') {
    const st = host.state();
    if (st.phase === 'roundEnd') { host.nextRound(); await hub.settle(); continue; }
    const cur = st.currentPlayer;
    if (st.players[cur].type === 'cpu') {
      await new Promise((r) => setTimeout(r, 1));
    } else if (cur === host.seat) {
      assert.equal(host.view().legalMoves.length > 0, true);
      assert.equal(host.submitMove(pick(E.legalMoves(st))).ok, true);
    } else {
      const c = clients.find((x) => x.seat === cur);
      assert.ok(c, 'a client owns seat ' + cur);
      const v = last(c.views);
      assert.equal(v.seat, cur);
      assert.equal(v.currentPlayer, cur);
      assertViewIsSafe(v, cur, st);
      c.submitMove(pick(v.legalMoves));
    }
    await hub.settle();
    if (++turns > maxTurns) throw new Error('game did not finish');
  }
}

// ---------------------------------------------------------------------
test('shufflePerm / permuteSeatData: pure helpers', () => {
  // rnd() -> 0 always: Fisher-Yates becomes a left rotation (host at seat 0 -> last seat)
  assert.deepEqual(N.shufflePerm(4, () => 0), [1, 2, 3, 0]);
  assert.deepEqual(N.shufflePerm(3, () => 0), [1, 2, 0]);
  // rnd() just under 1: identity
  assert.deepEqual(N.shufflePerm(5, () => 0.999999), [0, 1, 2, 3, 4]);
  // always a permutation, all 24 orders reachable for 4 seats
  const seen = new Set();
  const r = E.createRng(5);
  for (let i = 0; i < 2000; i++) {
    const p = N.shufflePerm(4, r);
    assert.deepEqual(p.slice().sort(), [0, 1, 2, 3]);
    seen.add(p.join(''));
  }
  assert.equal(seen.size, 24);
  // seat contents, wins and lasts move together; hostSeat follows isHost
  const seats = [{ name: 'H', isHost: true }, { name: 'A' }, { name: 'B' }, { name: 'C' }];
  const out = N.permuteSeatData({ seats, wins: [5, 1, 0, 3], lasts: [0, 2, 4, 1] }, [2, 0, 3, 1]);
  assert.deepEqual(out.seats.map((s) => s.name), ['B', 'H', 'C', 'A']);
  assert.equal(out.seats[1], seats[0], 'the same seat object moves (conn, token, connected, lastStamp come along)');
  assert.deepEqual(out.wins, [0, 5, 3, 1]);
  assert.deepEqual(out.lasts, [4, 0, 1, 2]);
  assert.equal(out.hostSeat, 1);
  for (const bad of [[0, 1, 2], [0, 0, 1, 2], [0, 1, 2, 4], null, [0, 1, 2, 1.5]]) {
    assert.throws(() => N.permuteSeatData({ seats, wins: [0, 0, 0, 0], lasts: [0, 0, 0, 0] }, bad), /bad perm/);
  }
});

test('setConfig seatOrder: default random, validated, locked in game, carried in lobby; client sanitizes', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A'] });
  assert.equal(host.config().seatOrder, 'random');
  assert.equal(last(clients[0].lobbies).config.seatOrder, 'random');
  for (const bad of ['shuffle', 'RANDOM', 1, true, {}, []]) assert.throws(() => host.setConfig({ seatOrder: bad }), /seatOrder/);
  assert.equal(host.setConfig({ seatOrder: 'join' }).seatOrder, 'join');
  await hub.settle();
  assert.equal(last(clients[0].lobbies).config.seatOrder, 'join');
  assert.equal(host.setConfig({ jokers: 1 }).seatOrder, 'join', 'other patches keep it');
  host.setConfig({ seatOrder: 'random' });
  host.start();
  assert.throws(() => host.setConfig({ seatOrder: 'join' }), /ゲーム中/);
  host.close();

  // a fake host sending odd seatOrder values
  const fakeHub = N.createMemoryHub();
  const ft = fakeHub.createTransport();
  await ft.open(N.peerIdFor('0002'));
  let hc = null;
  ft.onConnection((cn) => { hc = cn; cn.onMessage(() => {}); });
  const v = N.createClient({ transport: fakeHub.createTransport(), roomCode: '0002', name: 'V', connectTimeoutMs: 0, backoff: [1] });
  const lobbies = [];
  v.onLobby((l) => lobbies.push(l));
  const p = v.connect();
  await fakeHub.settle();
  hc.send({ t: 'joined', seat: 1, seatToken: 'abcdefghijklmnop', roomCode: '0002' });
  await p;
  const base = { t: 'lobby', seats: [{ name: 'H', type: 'human', isHost: true, connected: true }, { name: 'V', type: 'human', connected: true }], roomCode: '0002' };
  const cfgs = [{ seatOrder: 'bogus' }, { seatOrder: 1 }, { seatOrder: null }, {}, { seatOrder: 'join' }, { seatOrder: 'random' }];
  for (const cfg of cfgs) hc.send(Object.assign({}, base, { config: cfg }));
  await fakeHub.settle();
  assert.deepEqual(lobbies.map((l) => l.config.seatOrder), ['random', 'random', 'random', 'join', 'join', 'random'],
    'invalid -> random; missing (old host, never shuffles) -> join');
  v.leave(); ft.close();
});

test("random start: seats shuffled by the injected seatRandom; hands, views, client seats and host seat agree", async () => {
  // 4 seats: host + A + B + 1 CPU; rnd -> 0 => perm [1,2,3,0]: A=0, B=1, CPU=2, host=3
  const room = await setupRoom({ names: ['A', 'B'], config: { seatCount: 4, limit: 0 } });
  const { host, clients, hub, seatRandom } = room;
  const [a, b] = clients;
  assert.equal(a.info.seat, 1); assert.equal(b.info.seat, 2); assert.equal(host.seat, 0);
  host.start();
  await hub.settle();
  assert.equal(seatRandom.calls, 3, 'n-1 draws for n seats');
  const st = host.state();
  assert.deepEqual(st.players.map((p) => p.name), ['A', 'B', 'CPU 4', 'ホスト']);
  assert.deepEqual(st.players.map((p) => p.type), ['human', 'human', 'cpu', 'human']);
  assert.equal(host.seat, 3);
  // lobby: same order, isHost follows the host
  const lob = host.lobby();
  assert.deepEqual(lob.seats.map((s) => s.name), ['A', 'B', 'CPU 4', 'ホスト']);
  assert.deepEqual(lob.seats.map((s) => !!s.isHost), [false, false, false, true]);
  assert.deepEqual(last(a.lobbies).seats.map((s) => s.name), ['A', 'B', 'CPU 4', 'ホスト']);
  // clients were told their new seat (joined re-sent with the same token)
  assert.equal(a.seat, 0); assert.equal(b.seat, 1);
  assert.deepEqual(last(a.joinedMsgs), { seat: 0, seatToken: a.info.seatToken, roomCode: room.code });
  assert.deepEqual(last(b.joinedMsgs), { seat: 1, seatToken: b.info.seatToken, roomCode: room.code });
  // every view (first one included) is from the new seat; no other hand leaks
  assert.equal(a.views.length >= 1, true);
  a.views.forEach((v) => assert.equal(v.seat, 0));
  b.views.forEach((v) => assert.equal(v.seat, 1));
  assertViewIsSafe(last(a.views), 0, st);
  assertViewIsSafe(last(b.views), 1, st);
  assertViewIsSafe(host.view(), 3, st);
  // whose turn: only that seat gets legal moves
  const cur = st.currentPlayer;
  assert.equal(host.view().legalMoves.length > 0, cur === 3);
  assert.equal(last(a.views).legalMoves.length > 0, cur === 0);
  assert.equal(last(b.views).legalMoves.length > 0, cur === 1);
  // host may only move on seat 3's turn
  if (cur !== 3) assert.deepEqual(host.submitMove({ type: 'yaniv' }), { ok: false, message: 'あなたの番ではありません' });
  // stamps: host's goes out as seat 3; A's arrives as seat 0
  assert.equal(host.sendStamp('joy'), true);
  assert.equal(a.sendStamp('clap'), true);
  await hub.settle();
  assert.deepEqual(host.stamps, [{ seat: 3, id: 'joy' }, { seat: 0, id: 'clap' }]);
  assert.deepEqual(b.stamps, [{ seat: 3, id: 'joy' }, { seat: 0, id: 'clap' }]);
  // play to the end from each owner's device
  await playToGameOver(room);
  assert.equal(host.state().phase, 'gameOver');
  // single mode: wins / lasts were counted on the moved seats (by engine index = seat index)
  const fin = host.state();
  const wins = host.wins();
  assert.equal(wins[fin.winner], 1);
  assert.equal(host.lasts()[fin.ranking[fin.ranking.length - 1]], 1);
  assert.equal(last(a.views).wins[fin.winner], 1);
  assert.equal(a.errors.filter((e) => e.type === 'error').length, 0, JSON.stringify(a.errors));
  assert.equal(b.errors.filter((e) => e.type === 'error').length, 0, JSON.stringify(b.errors));
  host.close();
});

test('restart keeps the order (no shuffle, wins kept per person); back to lobby -> start shuffles again', async () => {
  const room = await setupRoom({ names: ['A', 'B'], config: { seatCount: 3, limit: 0 } });
  const { host, clients, hub, seatRandom } = room;
  const [a, b] = clients;
  host.start();
  await hub.settle();
  // perm [1,2,0]: A=0, B=1, host=2
  assert.deepEqual(host.state().players.map((p) => p.name), ['A', 'B', 'ホスト']);
  const calls1 = seatRandom.calls;
  await playToGameOver(room);
  const w1 = host.wins();
  const joinedBefore = a.joinedMsgs.length + b.joinedMsgs.length;
  host.restart();
  await hub.settle();
  assert.equal(seatRandom.calls, calls1, 'restart does not draw');
  assert.deepEqual(host.state().players.map((p) => p.name), ['A', 'B', 'ホスト']);
  assert.equal(host.seat, 2);
  assert.deepEqual(host.wins(), w1, 'wins stay with the same seats/people');
  assert.equal(a.joinedMsgs.length + b.joinedMsgs.length, joinedBefore, 'no seat re-notification on restart');
  assert.equal(last(a.views).seat, 0);
  await playToGameOver(room);
  // back to the lobby: order stays as it was (holes / names), wins reset; start shuffles again
  host.backToLobby();
  await hub.settle();
  assert.deepEqual(host.lobby().seats.map((s) => s.name), ['A', 'B', 'ホスト']);
  assert.deepEqual(host.wins(), [0, 0, 0]);
  host.start();
  await hub.settle();
  assert.ok(seatRandom.calls > calls1, 'start after backToLobby draws again');
  // [A,B,H] rotated again -> [B,H,A]
  assert.deepEqual(host.state().players.map((p) => p.name), ['B', 'ホスト', 'A']);
  assert.equal(host.seat, 1);
  assert.equal(a.seat, 2); assert.equal(b.seat, 0);
  assert.equal(last(a.views).seat, 2); assert.equal(last(b.views).seat, 0);
  assertViewIsSafe(last(a.views), 2, host.state());
  await playToGameOver(room);
  host.close();
});

test("'join': start never draws from seatRandom and nobody moves", async () => {
  const room = await setupRoom({ names: ['A', 'B'], config: { seatCount: 4, seatOrder: 'join' } });
  const { host, clients, hub, seatRandom } = room;
  host.start();
  await hub.settle();
  assert.equal(seatRandom.calls, 0);
  assert.deepEqual(host.state().players.map((p) => p.name), ['ホスト', 'A', 'B', 'CPU 4']);
  assert.equal(host.seat, 0);
  assert.equal(clients[0].seat, 1); assert.equal(clients[1].seat, 2);
  assert.equal(clients[0].joinedMsgs.length, 1, 'no extra joined');
  assert.equal(last(clients[1].views).seat, 2);
  host.close();
});

test('after a shuffle: seatToken reconnect (auto and reload) returns to the new seat', async () => {
  const room = await setupRoom({ names: ['A', 'B'], config: { seatCount: 3 } });
  const { host, clients, hub } = room;
  const [a, b] = clients;
  host.start();
  await hub.settle();
  assert.equal(b.seat, 1);
  // auto reconnect after a network drop
  const joinedN = b.joinedMsgs.length;
  b.transport.dropConnections();
  await new Promise((r) => setTimeout(r, 20));
  await hub.settle();
  assert.equal(b.isConnected(), true);
  assert.ok(b.joinedMsgs.length > joinedN, 'reconnected');
  assert.equal(last(b.joinedMsgs).seat, 1);
  assert.equal(b.seat, 1);
  assert.equal(last(b.views).seat, 1);
  assertViewIsSafe(last(b.views), 1, host.state());
  // page reload: a brand-new client with the saved token
  const token = a.info.seatToken;
  a.leave();
  await hub.settle();
  assert.equal(host.lobby().seats[0].connected, false);
  const a2 = await joinClient(hub, room.code, 'A', { seatToken: token });
  await hub.settle();
  assert.equal(a2.info.seat, 0, 'back to the new seat, not the join-order seat 1');
  assert.equal(last(a2.views).seat, 0);
  assertViewIsSafe(last(a2.views), 0, host.state());
  assert.equal(host.lobby().seats[0].connected, true);
  room.clients[0] = a2;
  await playToGameOver(room);
  host.close();
});

test('after a shuffle: kick / replaceWithCpu act on the new seats; the host seat cannot be kicked', async () => {
  const room = await setupRoom({ names: ['A', 'B'], config: { seatCount: 3 } });
  const { host, clients, hub } = room;
  const [a, b] = clients;
  host.start();
  await hub.settle();
  assert.equal(host.seat, 2);
  assert.throws(() => host.kick(2), /bad seat/);
  assert.throws(() => host.replaceWithCpu(2), /bad seat/);
  host.replaceWithCpu(1); // B
  await hub.settle();
  assert.equal(b.closed[0].reason, 'cpu');
  assert.deepEqual(host.state().players.map((p) => p.type), ['human', 'cpu', 'human']);
  assert.equal(host.state().players[1].name, 'B');
  host.kick(0); // A (seat 0 is no longer the host)
  await hub.settle();
  assert.equal(a.closed[0].reason, 'kicked');
  assert.deepEqual(host.state().players.map((p) => p.type), ['cpu', 'cpu', 'human']);
  await playToGameOver(room);
  // lobby kick after the shuffle: host still on seat 2
  host.backToLobby();
  await hub.settle();
  assert.equal(host.seat, 2);
  const c = await joinClient(hub, room.code, 'C');
  assert.equal(c.info.seat, 0);
  assert.throws(() => host.kick(2), /bad seat/);
  host.kick(0);
  await hub.settle();
  assert.equal(c.closed[0].reason, 'kicked');
  assert.equal(host.lobby().seats[0].type, 'empty');
  host.close();
});

test('8 seats random (host + 2 clients + 5 CPU) auto-run to gameOver with no errors', async () => {
  const seatRandom = seqRandom([], 0);
  const r = E.createRng(4242);
  const room = await setupRoom({ names: ['A', 'B'], config: { seatCount: 8, limit: 31, jokers: 0, cpuLevel: 'strong' }, seed: 808, seatRandom: () => { seatRandom.calls++; return r(); } });
  const { host, clients, hub } = room;
  const errors = [];
  host.onError((e) => errors.push(e));
  host.start();
  await hub.settle();
  const st0 = host.state();
  assert.equal(st0.players.length, 8);
  assert.equal(st0.players.filter((p) => p.type === 'cpu').length, 5);
  assert.equal(st0.players[host.seat].name, 'ホスト');
  clients.forEach((c) => {
    assert.equal(st0.players[c.seat].name, c === clients[0] ? 'A' : 'B');
    assertViewIsSafe(last(c.views), c.seat, st0);
  });
  await playToGameOver(room);
  assert.equal(host.state().players.filter((p) => !p.eliminated).length, 1);
  assert.deepEqual(errors, []);
  clients.forEach((c) => assert.equal(c.errors.length, 0, JSON.stringify(c.errors)));
  host.close();
});
