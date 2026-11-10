'use strict';
// 「1周目のヤニブ禁止」（config.firstLapYaniv: false）のテスト（engine + net）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const E = require('../engine.js');
const N = require('../net.js');

const C = (rank, suit) => ({ id: rank + suit, rank, suit });
const last = (arr) => arr[arr.length - 1];
const hasYaniv = (s) => E.legalMoves(s).some((m) => m.type === 'yaniv');

function cfg(n, extra = {}) {
  const players = [];
  for (let i = 0; i < n; i++) players.push({ name: 'P' + i, type: 'cpu' });
  return Object.assign({ players, jokers: 2, limit: 101, cpuLevel: 'normal' }, extra);
}

/**
 * ラウンド開始直後の state。全員の手札を低い札（ヤニブ可能）にし、山札は高い札で満たす
 * （引いても 7 点を超えない程度に、打つ札は手札で一番高い1枚を捨てて山札から引く）。
 */
function lowHandsRound(n, extra = {}, eliminated) {
  let s = E.createGame(cfg(n, extra), E.createRng(3));
  if (eliminated) s.players.forEach((p, i) => { p.eliminated = !!eliminated[i]; });
  s = E.startRound(s, E.createRng(3));
  const suits = ['S', 'H', 'D', 'C'];
  s.players.forEach((p, i) => {
    if (p.eliminated) return;
    p.hand = [C('A', suits[i % 4] + i), C('2', suits[i % 4] + i)];
  });
  s.deck = [];
  for (let k = 0; k < 60; k++) s.deck.push(C('A', 'X' + k));
  return s;
}
/** 現在の手番の人が「手札の最初の1枚を捨てて山札から引く」 */
function playOne(s) {
  const p = s.players[s.currentPlayer];
  return E.applyMove(s, { type: 'play', discard: [p.hand[0].id], draw: 'deck' }, E.createRng(9));
}

// =====================================================================
// engine
// =====================================================================
test('firstLapYaniv: validateConfig defaults to true, accepts booleans, rejects others', () => {
  assert.equal(E.createGame(cfg(3)).config.firstLapYaniv, true);
  assert.equal(E.createGame(cfg(3, { firstLapYaniv: null })).config.firstLapYaniv, true);
  assert.equal(E.createGame(cfg(3, { firstLapYaniv: true })).config.firstLapYaniv, true);
  assert.equal(E.createGame(cfg(3, { firstLapYaniv: false })).config.firstLapYaniv, false);
  for (const bad of [0, 1, 'false', 'true', {}, []]) {
    assert.throws(() => E.createGame(cfg(3, { firstLapYaniv: bad })), /firstLapYaniv/, JSON.stringify(bad));
  }
});

test('firstLapYaniv default (true): yaniv is legal from the very first move', () => {
  const s = lowHandsRound(4);
  assert.equal(s.roundMoves, 0);
  assert.equal(E.firstLapRemaining(s), 0);
  assert.ok(hasYaniv(s));
  const r = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.equal(r.phase, 'roundEnd');
});

test('firstLapYaniv false: no yaniv until every active player has played once, then allowed', () => {
  for (let n = 2; n <= 8; n++) {
    let s = lowHandsRound(n, { firstLapYaniv: false });
    for (let k = 0; k < n; k++) {
      assert.equal(s.roundMoves, k);
      assert.equal(E.firstLapRemaining(s), n - k, `n=${n} k=${k}`);
      assert.ok(!hasYaniv(s), `n=${n}: yaniv must not be legal after ${k} plays`);
      assert.ok(E.legalMoves(s).length > 0, 'play moves remain');
      const before = JSON.stringify(s);
      assert.throws(() => E.applyMove(s, { type: 'yaniv' }, E.createRng(1)), /first lap/);
      assert.equal(JSON.stringify(s), before, 'state is not mutated');
      s = playOne(s);
    }
    assert.equal(s.roundMoves, n);
    assert.equal(E.firstLapRemaining(s), 0);
    assert.ok(hasYaniv(s), `n=${n}: yaniv legal once everyone has played`);
    const r = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
    assert.equal(r.roundResult.declarer, s.currentPlayer);
  }
});

test('firstLapYaniv false: hand value over 7 still throws the old error (checked first)', () => {
  const s = lowHandsRound(3, { firstLapYaniv: false });
  s.players[s.currentPlayer].hand = [C('K', 'S'), C('Q', 'S')];
  assert.throws(() => E.applyMove(s, { type: 'yaniv' }, E.createRng(1)), /exceeds 7/);
});

test('firstLapYaniv false: eliminated players are not counted', () => {
  // 5 seats, 2 eliminated -> 3 active players
  let s = lowHandsRound(5, { firstLapYaniv: false }, [false, true, false, true, false]);
  assert.equal(E.firstLapRemaining(s), 3);
  for (let k = 0; k < 3; k++) {
    assert.ok(!hasYaniv(s));
    s = playOne(s);
  }
  assert.equal(E.firstLapRemaining(s), 0);
  assert.ok(hasYaniv(s));
});

test('firstLapYaniv false: the restriction resets every round (roundMoves back to 0)', () => {
  let s = lowHandsRound(3, { firstLapYaniv: false });
  for (let k = 0; k < 3; k++) s = playOne(s);
  s = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.equal(s.phase, 'roundEnd');
  s = E.startRound(s, E.createRng(4));
  assert.equal(E.firstLapRemaining(s), 3);
  assert.ok(!E.legalMoves(s).some((m) => m.type === 'yaniv'));
});

test('firstLapYaniv false: also applies in single mode (limit 0)', () => {
  let s = lowHandsRound(4, { firstLapYaniv: false, limit: E.SINGLE });
  for (let k = 0; k < 4; k++) {
    assert.ok(!hasYaniv(s));
    assert.throws(() => E.applyMove(s, { type: 'yaniv' }, E.createRng(1)), /first lap/);
    s = playOne(s);
  }
  assert.ok(hasYaniv(s));
  const r = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.equal(r.phase, 'gameOver');
});

test('firstLapYaniv false: CPU never declares while blocked (every level, low hands)', () => {
  for (const level of ['weak', 'normal', 'strong']) {
    let s = lowHandsRound(4, { firstLapYaniv: false });
    const rng = E.createRng(77);
    for (let k = 0; k < 4; k++) {
      const mv = E.chooseMove(s, s.currentPlayer, level, rng);
      assert.equal(mv.type, 'play', `${level} k=${k}`);
      s = E.applyMove(s, mv, rng);
    }
    // weak declares as soon as it is allowed
    if (level === 'weak') assert.equal(E.chooseMove(s, s.currentPlayer, level, rng).type, 'yaniv');
  }
});

test('firstLapYaniv false: firstLapRemaining works on view-shaped objects; non-integer roundMoves -> 0', () => {
  const v = { config: { firstLapYaniv: false }, players: [{}, {}, { eliminated: true }], roundMoves: 1 };
  assert.equal(E.firstLapRemaining(v), 1);
  assert.equal(E.firstLapRemaining(Object.assign({}, v, { roundMoves: undefined })), 0);
  assert.equal(E.firstLapRemaining(Object.assign({}, v, { roundMoves: 1.5 })), 0);
  assert.equal(E.firstLapRemaining(Object.assign({}, v, { config: {} })), 0, 'absent = allowed');
  assert.equal(E.firstLapRemaining(Object.assign({}, v, { roundMoves: 9 })), 0);
});

test('firstLapYaniv false: CPU-only games (2-8 players, 3 levels) always reach gameOver', () => {
  for (let n = 2; n <= 8; n++) {
    for (const level of ['weak', 'normal', 'strong']) {
      for (let seed = 1; seed <= 6; seed++) {
        for (const limit of [101, E.SINGLE]) {
          const rng = E.createRng(seed * 31 + n);
          let s = E.createGame(cfg(n, { jokers: seed % 3, limit, cpuLevel: level, firstLapYaniv: false }), rng);
          let t = 0;
          while (s.phase !== 'gameOver') {
            if (s.phase !== 'playing') { t = 0; s = E.startRound(s, rng); continue; }
            const blocked = E.firstLapRemaining(s) > 0;
            const mv = E.chooseMove(s, s.currentPlayer, level, rng);
            if (blocked) assert.equal(mv.type, 'play');
            if (mv.type === 'yaniv') assert.ok(s.roundMoves >= s.players.filter((p) => !p.eliminated).length);
            s = E.applyMove(s, mv, rng);
            assert.ok(++t < 3000, `round did not end: n=${n} ${level} seed=${seed} limit=${limit}`);
          }
        }
      }
    }
  }
});

// 変更前の engine（この機能を入れる前のコミット）と、既定 true で挙動・rng 消費が完全に同じか。
// git が使えない環境（配布物だけ等）ではスキップする。
const BASE_COMMIT = 'bdafeed';
function loadOldEngine() {
  try {
    const src = execFileSync('git', ['show', BASE_COMMIT + ':engine.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const mod = { exports: {} };
    new Function('module', 'self', src)(mod, {});
    return mod.exports;
  } catch (e) {
    return null;
  }
}

test('firstLapYaniv default: identical games to the pre-feature engine (same seed, 2-8 players)', (t) => {
  const OLD = loadOldEngine();
  if (!OLD || typeof OLD.createGame !== 'function') { t.skip('pre-feature engine not available via git'); return; }
  const levels = ['weak', 'normal', 'strong'];
  let games = 0;
  for (let n = 2; n <= 8; n++) {
    for (let seed = 1; seed <= 50; seed++) {
      const level = levels[seed % 3];
      const limit = [E.SINGLE, 31, 51, 71, 101, 201, 301][seed % 7];
      const run = (Eng, extra) => {
        const rng = Eng.createRng(seed * 101 + n);
        let s = Eng.createGame(cfg(n, Object.assign({ jokers: seed % 3, limit, cpuLevel: level, starter: seed % 2 ? 'zero' : 'highest' }, extra)), rng);
        let guard = 0;
        while (s.phase !== 'gameOver') {
          if (s.phase !== 'playing') { s = Eng.startRound(s, rng); continue; }
          s = Eng.applyMove(s, Eng.chooseMove(s, s.currentPlayer, level, rng), rng);
          if (++guard > 200000) throw new Error('runaway');
        }
        const out = JSON.parse(JSON.stringify(s));
        delete out.config.firstLapYaniv;
        out.tail = rng(); // rng を同じだけ消費したか
        return out;
      };
      const a = run(OLD, {});
      assert.deepEqual(run(E, {}), a, `n=${n} seed=${seed} (unspecified)`);
      assert.deepEqual(run(E, { firstLapYaniv: true }), a, `n=${n} seed=${seed} (true)`);
      games++;
    }
  }
  assert.equal(games, 350);
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
  for (const name of opts.names || []) {
    const c = N.createClient({ transport: hub.createTransport(), roomCode: code, name, connectTimeoutMs: 0, backoff: [1, 1] });
    c.lobbies = []; c.views = []; c.errors = [];
    c.onLobby((l) => c.lobbies.push(l));
    c.onView((v) => c.views.push(v));
    c.onError((e) => c.errors.push(e));
    c.info = await c.connect();
    clients.push(c);
  }
  await hub.settle();
  return { hub, host, code, clients };
}

test('net: setConfig firstLapYaniv accepted (boolean) / rejected (others) / locked during the game; lobby + view carry it', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A'], config: { seatCount: 2 } });
  assert.equal(host.config().firstLapYaniv, true, 'default true');
  assert.equal(last(clients[0].lobbies).config.firstLapYaniv, true);
  for (const bad of [0, 1, 'false', {}, []]) assert.throws(() => host.setConfig({ firstLapYaniv: bad }), /firstLapYaniv/);
  assert.equal(host.config().firstLapYaniv, true, 'unchanged after rejects');
  host.setConfig({ firstLapYaniv: false });
  await hub.settle();
  assert.equal(host.config().firstLapYaniv, false);
  assert.equal(last(clients[0].lobbies).config.firstLapYaniv, false);
  host.setConfig({ jokers: 1 }); // other patches keep it
  assert.equal(host.config().firstLapYaniv, false);
  host.start();
  await hub.settle();
  assert.equal(host.state().config.firstLapYaniv, false);
  const v = last(clients[0].views);
  assert.equal(v.config.firstLapYaniv, false);
  assert.equal(v.roundMoves, host.state().roundMoves);
  assert.throws(() => host.setConfig({ firstLapYaniv: true }), /ゲーム中/);
  host.close();
});

test('net: a yaniv sent while blocked -> error, host state unchanged; allowed after the first lap', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['A', 'B'], config: { seatCount: 3, firstLapYaniv: false } });
  host.start();
  await hub.settle();
  // 全員の手札を低くし、山札を A で埋める（直接 state を差し替え）
  const st = host.state();
  st.players.forEach((p, i) => { p.hand = [C('A', 'S' + i), C('2', 'S' + i)]; });
  st.deck = [];
  for (let k = 0; k < 40; k++) st.deck.push(C('A', 'X' + k));
  const sendAs = async (seat, mv) => {
    if (seat === 0) { const r = host.submitMove(mv); await hub.settle(); return r.ok ? null : r.message; }
    const c = clients[seat - 1];
    const n = c.errors.length;
    c.submitMove(mv);
    await hub.settle();
    return c.errors.length > n ? last(c.errors).message : null;
  };
  for (let k = 0; k < 3; k++) {
    const cur = host.state().currentPlayer;
    const before = JSON.stringify(host.state());
    const err = await sendAs(cur, { type: 'yaniv' });
    assert.match(err, /1周目はヤニブできません/);
    assert.equal(JSON.stringify(host.state()), before, 'state unchanged');
    if (cur !== 0) {
      const v = last(clients[cur - 1].views);
      assert.ok(!v.legalMoves.some((m) => m.type === 'yaniv'), 'view legalMoves has no yaniv while blocked');
      assert.equal(v.roundMoves, k);
    }
    const hand = host.state().players[cur].hand;
    assert.equal(await sendAs(cur, { type: 'play', discard: [hand[0].id], draw: 'deck' }), null);
  }
  await hub.settle();
  const cur = host.state().currentPlayer;
  assert.equal(host.state().roundMoves, 3);
  if (cur !== 0) assert.ok(last(clients[cur - 1].views).legalMoves.some((m) => m.type === 'yaniv'));
  assert.equal(await sendAs(cur, { type: 'yaniv' }), null);
  assert.equal(host.state().phase, 'roundEnd');
  host.close();
});

test('net: an old client (ignores firstLapYaniv) sending yaniv while blocked just gets an error and can keep playing', async () => {
  const { host, clients, hub } = await setupRoom({ names: ['Old'], config: { seatCount: 2, firstLapYaniv: false } });
  host.start();
  await hub.settle();
  const st = host.state();
  st.players.forEach((p, i) => { p.hand = [C('A', 'S' + i), C('3', 'S' + i)]; });
  if (st.currentPlayer === 0) {
    const h = st.players[0].hand;
    assert.equal(host.submitMove({ type: 'play', discard: [h[0].id], draw: 'deck' }).ok, true);
    await hub.settle();
  }
  assert.equal(host.state().currentPlayer, 1);
  const c = clients[0];
  const before = JSON.stringify(host.state());
  // 旧クライアントは view.legalMoves を見ずに手札点だけでヤニブを送る想定
  if (host.state().roundMoves < 2) {
    c.submitMove({ type: 'yaniv' });
    await hub.settle();
    assert.match(last(c.errors).message, /1周目/);
    assert.equal(JSON.stringify(host.state()), before);
  }
  // そのまま普通の手は打てる（固まらない）
  const h1 = host.state().players[1].hand;
  c.submitMove({ type: 'play', discard: [h1[0].id], draw: 'deck' });
  await hub.settle();
  assert.notEqual(JSON.stringify(host.state()), before);
  host.close();
});

test('net: client validation of config.firstLapYaniv / roundMoves (lobby + view)', async () => {
  const hub = N.createMemoryHub();
  const ht = hub.createTransport();
  await ht.open(N.peerIdFor('6666'));
  let hc = null;
  ht.onConnection((cn) => { hc = cn; cn.onMessage(() => {}); });
  const v = N.createClient({ transport: hub.createTransport(), roomCode: '6666', name: 'V', connectTimeoutMs: 0, backoff: [1] });
  const views = []; const lobbies = [];
  v.onView((x) => views.push(x));
  v.onLobby((x) => lobbies.push(x));
  v.connect().catch(() => {});
  await hub.settle();
  hc.send({ t: 'joined', seat: 0, seatToken: 'abcdefghijklmnop', roomCode: '6666' });
  const base = () => ({ phase: 'playing', seat: 0, players: [{ name: 'a', handCount: 1, score: 0, hand: [] }, { name: 'b', handCount: 1, score: 0 }], currentPlayer: 0, round: 1, deckCount: 1, discardPile: [], legalMoves: [], takeable: [], config: { limit: 101 } });
  for (const bad of ['false', 0, 1, {}]) { const x = base(); x.config.firstLapYaniv = bad; hc.send({ t: 'view', view: x }); }
  for (const bad of [-1, 1.5, '2', {}]) { const x = base(); x.roundMoves = bad; hc.send({ t: 'view', view: x }); }
  await hub.settle();
  assert.equal(views.length, 0, 'bad firstLapYaniv / roundMoves rejected');
  let x = base(); x.config.firstLapYaniv = false; x.roundMoves = 1; hc.send({ t: 'view', view: x });
  x = base(); hc.send({ t: 'view', view: x }); // absent (old host) is fine
  await hub.settle();
  assert.equal(views.length, 2);
  assert.equal(E.firstLapRemaining(views[0]), 1);
  assert.equal(E.firstLapRemaining(views[1]), 0, 'absent = allowed');

  const seats = [{ name: 'h', type: 'human', connected: true, isHost: true }, { name: 'V', type: 'human', connected: true }];
  hc.send({ t: 'lobby', seats, config: { limit: 101, seatCount: 2, firstLapYaniv: false }, roomCode: '6666' });
  await hub.settle();
  assert.equal(last(lobbies).config.firstLapYaniv, false);
  hc.send({ t: 'lobby', seats, config: { limit: 101, seatCount: 2 }, roomCode: '6666' });
  await hub.settle();
  assert.equal(last(lobbies).config.firstLapYaniv, true, 'absent -> true');
  hc.send({ t: 'lobby', seats, config: { limit: 101, seatCount: 2, firstLapYaniv: 'no' }, roomCode: '6666' });
  await hub.settle();
  assert.equal(last(lobbies).config.firstLapYaniv, true, 'non-boolean -> true');
  v.leave(); ht.close();
});
