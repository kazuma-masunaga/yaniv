'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

const C = (rank, suit) => ({ id: rank + suit, rank, suit });
const J1 = { id: 'JOKER1', rank: 'JOKER', suit: 'J1' };
const J2 = { id: 'JOKER2', rank: 'JOKER', suit: 'J2' };

function baseConfig(n = 3, extra = {}) {
  const players = [];
  for (let i = 0; i < n; i++) players.push({ name: 'P' + i, type: 'cpu' });
  return Object.assign({ players, jokers: 2, limit: 101, cpuLevel: 'normal' }, extra);
}

/** Build a playing state with explicit hands/deck/discard for deterministic tests. */
function fixture({ hands, deck, discardTop, currentPlayer = 0, scores, limit = 101, eliminated }) {
  const n = hands.length;
  let s = E.createGame(baseConfig(n, { limit }), E.createRng(1));
  s = E.startRound(s, E.createRng(1));
  s.players.forEach((p, i) => {
    p.hand = hands[i].slice();
    if (scores) p.score = scores[i];
    if (eliminated) p.eliminated = !!eliminated[i];
  });
  s.deck = deck.slice();
  s.discardPile = [Object.assign({ by: null }, discardTop)];
  s.currentPlayer = currentPlayer;
  return s;
}

// ---------- handValue ----------
test('handValue: A=1, faces=10, joker=0, numbers=face', () => {
  assert.equal(E.handValue([C('A', 'S')]), 1);
  assert.equal(E.handValue([C('J', 'S'), C('Q', 'H'), C('K', 'D')]), 30);
  assert.equal(E.handValue([J1, J2]), 0);
  assert.equal(E.handValue([C('7', 'C'), C('10', 'D')]), 17);
  assert.equal(E.handValue([]), 0);
});

test('handValue: same rank counts once', () => {
  assert.equal(E.handValue([C('3', 'H'), C('3', 'C'), C('3', 'S')]), 3);
  assert.equal(E.handValue([C('3', 'H'), C('3', 'C'), C('5', 'S')]), 8);
  assert.equal(E.handValue([C('K', 'H'), C('K', 'C'), C('Q', 'S')]), 20);
  assert.equal(E.handValue([C('A', 'H'), C('A', 'C'), J1, J2]), 1);
});

// ---------- isValidDiscard ----------
test('isValidDiscard: valid groups', () => {
  assert.equal(E.isValidDiscard([C('5', 'S')]), true, 'single');
  assert.equal(E.isValidDiscard([J1]), true, 'single joker');
  assert.equal(E.isValidDiscard([C('5', 'S'), C('5', 'H')]), true, 'pair');
  assert.equal(E.isValidDiscard([C('5', 'S'), C('5', 'H'), C('5', 'D')]), true, 'triple');
  assert.equal(E.isValidDiscard([C('5', 'S'), C('6', 'S'), C('7', 'S')]), true, 'run 3');
  assert.equal(E.isValidDiscard([C('7', 'S'), C('5', 'S'), C('6', 'S')]), true, 'run unordered');
  assert.equal(E.isValidDiscard([C('5', 'S'), J1, C('7', 'S')]), true, 'joker gap');
  assert.equal(E.isValidDiscard([C('5', 'S'), C('6', 'S'), J1]), true, 'joker end');
  assert.equal(E.isValidDiscard([J1, J2]), true, 'joker pair');
  assert.equal(E.isValidDiscard([C('5', 'S'), J1, J2, C('8', 'S')]), true, 'two jokers fill 2 gaps');
  assert.equal(E.isValidDiscard([C('Q', 'S'), C('K', 'S'), J1]), true, 'joker at low end when K is top');
  assert.equal(E.isValidDiscard([C('A', 'S'), C('2', 'S'), C('3', 'S')]), true, 'A low');
});

test('isValidDiscard: invalid groups', () => {
  assert.equal(E.isValidDiscard([]), false, 'empty');
  assert.equal(E.isValidDiscard([C('5', 'S'), C('6', 'H'), C('7', 'S')]), false, 'mixed suit run');
  assert.equal(E.isValidDiscard([C('5', 'S'), C('6', 'S')]), false, 'run of 2');
  assert.equal(E.isValidDiscard([J1, J2, C('5', 'S')]), false, 'two jokers + one real');
  assert.equal(E.isValidDiscard([C('A', 'S'), C('K', 'S'), C('Q', 'S')]), false, 'A-K-Q wrap');
  assert.equal(E.isValidDiscard([C('K', 'S'), C('A', 'S'), C('2', 'S')]), false, 'K-A-2 wrap');
  assert.equal(E.isValidDiscard([C('5', 'S'), C('7', 'S'), C('8', 'S')]), false, 'gap without joker');
  assert.equal(E.isValidDiscard([C('5', 'S'), C('5', 'H'), C('6', 'S')]), false, 'pair + other');
  assert.equal(E.isValidDiscard([C('5', 'S'), J1, C('5', 'S')]), false, 'duplicate id');
  assert.equal(E.isValidDiscard([C('5', 'S'), C('5', 'S'), C('6', 'S'), J1]), false, 'duplicate rank in run');
});

// ---------- takeableFromDiscard ----------
test('takeableFromDiscard: single, set, run ends (incl. joker end)', () => {
  let s = fixture({ hands: [[C('2', 'S')], [C('3', 'S')]], deck: [C('9', 'D')], discardTop: { kind: 'single', cards: [C('K', 'H')] } });
  assert.deepEqual(E.takeableFromDiscard(s).map((c) => c.id), ['KH']);

  s.discardPile = [{ kind: 'set', cards: [C('4', 'S'), C('4', 'H'), C('4', 'D')], by: 1 }];
  assert.deepEqual(E.takeableFromDiscard(s).map((c) => c.id).sort(), ['4D', '4H', '4S']);

  s.discardPile = [{ kind: 'run', cards: [C('5', 'S'), C('6', 'S'), C('7', 'S'), C('8', 'S')], by: 1 }];
  assert.deepEqual(E.takeableFromDiscard(s).map((c) => c.id), ['5S', '8S']);

  // arranged run with joker on the end -> joker takeable
  const g = E.analyzeGroup([C('6', 'S'), J1, C('5', 'S')]);
  assert.equal(g.kind, 'run');
  assert.deepEqual(g.cards.map((c) => c.id), ['5S', '6S', 'JOKER1']);
  s.discardPile = [Object.assign({ by: 1 }, g)];
  assert.deepEqual(E.takeableFromDiscard(s).map((c) => c.id), ['5S', 'JOKER1']);

  // joker in the middle is not takeable
  const g2 = E.analyzeGroup([C('5', 'S'), J1, C('7', 'S')]);
  s.discardPile = [Object.assign({ by: 1 }, g2)];
  assert.deepEqual(E.takeableFromDiscard(s).map((c) => c.id), ['5S', '7S']);
});

test('takeableFromDiscard: nothing from own discard', () => {
  const s = fixture({ hands: [[C('2', 'S')], [C('3', 'S')]], deck: [C('9', 'D')], discardTop: { kind: 'single', cards: [C('K', 'H')] } });
  s.discardPile[0].by = 0;
  assert.deepEqual(E.takeableFromDiscard(s), []);
});

// ---------- applyMove ----------
test('applyMove: discard then draw from deck', () => {
  const s = fixture({
    hands: [[C('9', 'S'), C('9', 'H'), C('K', 'D')], [C('3', 'S'), C('4', 'S')]],
    deck: [C('2', 'C'), C('A', 'C')],
    discardTop: { kind: 'single', cards: [C('K', 'H')] }
  });
  const before = JSON.stringify(s);
  const s2 = E.applyMove(s, { type: 'play', discard: ['9S', '9H'], draw: 'deck' }, E.createRng(3));
  assert.equal(JSON.stringify(s), before, 'original state not mutated');
  assert.deepEqual(s2.players[0].hand.map((c) => c.id), ['KD', 'AC']);
  assert.equal(s2.deck.length, 1);
  const top = s2.discardPile[s2.discardPile.length - 1];
  assert.equal(top.kind, 'set');
  assert.deepEqual(top.cards.map((c) => c.id).sort(), ['9H', '9S']);
  assert.equal(top.by, 0);
  assert.equal(s2.currentPlayer, 1);
  assert.equal(s2.lastMove.drawSource, 'deck');
});

test('applyMove: discard then draw from discard (previous player group)', () => {
  const s = fixture({
    hands: [[C('9', 'S'), C('K', 'D')], [C('3', 'S'), C('4', 'S')]],
    deck: [C('2', 'C')],
    discardTop: { kind: 'run', cards: [C('5', 'H'), C('6', 'H'), C('7', 'H')] }
  });
  s.discardPile[0].by = 1;
  const s2 = E.applyMove(s, { type: 'play', discard: ['KD'], draw: '7H' }, E.createRng(3));
  assert.deepEqual(s2.players[0].hand.map((c) => c.id), ['9S', '7H']);
  assert.equal(s2.deck.length, 1, 'deck untouched');
  assert.equal(s2.discardPile.length, 2);
  assert.deepEqual(s2.discardPile[0].cards.map((c) => c.id), ['5H', '6H']);
  assert.deepEqual(s2.discardPile[1].cards.map((c) => c.id), ['KD']);
  assert.equal(s2.lastMove.drawnCard.id, '7H');
  // middle card not takeable
  assert.throws(() => E.applyMove(s, { type: 'play', discard: ['KD'], draw: '6H' }, E.createRng(3)));
});

test('applyMove: cannot take from own discard; legalMoves excludes it', () => {
  const s = fixture({
    hands: [[C('9', 'S'), C('K', 'D')], [C('3', 'S'), C('4', 'S')]],
    deck: [C('2', 'C')],
    discardTop: { kind: 'single', cards: [C('5', 'H')] }
  });
  s.discardPile[0].by = 0; // discarded by current player
  assert.throws(() => E.applyMove(s, { type: 'play', discard: ['KD'], draw: '5H' }, E.createRng(3)), /takeable/);
  assert.ok(E.legalMoves(s).every((m) => m.type === 'yaniv' || m.draw === 'deck'));
});

test('applyMove: reshuffles discard pile (except top group) when deck is empty', () => {
  const s = fixture({
    hands: [[C('9', 'S'), C('K', 'D')], [C('3', 'S'), C('4', 'S')]],
    deck: [],
    discardTop: { kind: 'single', cards: [C('5', 'H')] }
  });
  s.discardPile = [
    { kind: 'set', cards: [C('8', 'S'), C('8', 'H')], by: 0 },
    { kind: 'single', cards: [C('2', 'D')], by: 1 },
    { kind: 'single', cards: [C('5', 'H')], by: 1 }
  ];
  const s2 = E.applyMove(s, { type: 'play', discard: ['KD'], draw: 'deck' }, E.createRng(7));
  const drawn = s2.players[0].hand[1].id;
  assert.ok(['8S', '8H', '2D'].includes(drawn), 'drew from reshuffled cards: ' + drawn);
  // deck now has the other 2 reshuffled cards; discard pile = [5H group, KD group]
  assert.equal(s2.deck.length, 2);
  assert.equal(s2.discardPile.length, 2);
  assert.equal(s2.discardPile[0].cards[0].id, '5H');
  assert.equal(s2.discardPile[1].cards[0].id, 'KD');
});

test('applyMove: deck empties after draw -> reshuffle happens so next player can draw', () => {
  const s = fixture({
    hands: [[C('9', 'S'), C('K', 'D')], [C('3', 'S'), C('4', 'S')]],
    deck: [C('A', 'C')],
    discardTop: { kind: 'single', cards: [C('5', 'H')] }
  });
  s.discardPile = [
    { kind: 'single', cards: [C('2', 'D')], by: 1 },
    { kind: 'single', cards: [C('5', 'H')], by: 1 }
  ];
  const s2 = E.applyMove(s, { type: 'play', discard: ['KD'], draw: 'deck' }, E.createRng(7));
  assert.ok(s2.deck.length >= 1);
  assert.ok(E.legalMoves(s2).some((m) => m.draw === 'deck'));
});

test('applyMove: invalid moves throw', () => {
  const s = fixture({
    hands: [[C('9', 'S'), C('K', 'D'), C('5', 'C')], [C('3', 'S'), C('4', 'S')]],
    deck: [C('2', 'C')],
    discardTop: { kind: 'single', cards: [C('5', 'H')] }
  });
  s.discardPile[0].by = 1;
  const rng = E.createRng(1);
  assert.throws(() => E.applyMove(s, { type: 'yaniv' }, rng), /exceeds/);
  assert.throws(() => E.applyMove(s, { type: 'play', discard: ['9S', 'KD'], draw: 'deck' }, rng), /invalid discard/);
  assert.throws(() => E.applyMove(s, { type: 'play', discard: ['3S'], draw: 'deck' }, rng), /not in hand/);
  assert.throws(() => E.applyMove(s, { type: 'play', discard: [], draw: 'deck' }, rng));
  assert.throws(() => E.applyMove(s, { type: 'play', discard: ['9S'], draw: 'ZZ' }, rng), /takeable/);
  assert.throws(() => E.applyMove(s, { type: 'play', discard: ['9S', '9S'], draw: 'deck' }, rng));
  assert.throws(() => E.applyMove(s, { type: 'nope' }, rng));
  assert.throws(() => E.applyMove(s, null, rng));
  const lobby = E.createGame(baseConfig(2), rng);
  assert.throws(() => E.applyMove(lobby, { type: 'yaniv' }, rng), /phase/);
});

// ---------- round end ----------
test('yaniv success: declarer 0, others add hand value', () => {
  const s = fixture({
    hands: [[C('3', 'S'), C('4', 'D')], [C('9', 'S'), C('K', 'D')], [C('2', 'C'), C('8', 'C')]],
    deck: [C('A', 'C')],
    discardTop: { kind: 'single', cards: [C('5', 'H')] }
  });
  const s2 = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.equal(s2.phase, 'roundEnd');
  assert.equal(s2.roundResult.assaf, null);
  assert.deepEqual(s2.players.map((p) => p.score), [0, 19, 10]);
  assert.equal(s2.roundResult.entries[0].role, 'yaniv');
  assert.equal(s2.roundResult.entries[1].added, 19);
  assert.equal(s2.nextStarter, 0);
  assert.deepEqual(s2.roundResult.entries[1].hand.map((c) => c.id), ['9S', 'KD']);
});

test('assaf: equal value counts; declarer gets value + 30', () => {
  const s = fixture({
    hands: [[C('3', 'S'), C('4', 'D')], [C('9', 'S'), C('K', 'D')], [C('2', 'C'), C('5', 'C')]],
    deck: [C('A', 'C')],
    discardTop: { kind: 'single', cards: [C('5', 'H')] }
  });
  const s2 = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.equal(s2.roundResult.assaf, 2);
  assert.deepEqual(s2.players.map((p) => p.score), [37, 19, 0]);
  assert.equal(s2.roundResult.entries[0].role, 'caught');
  assert.equal(s2.roundResult.entries[2].role, 'assaf');
  assert.equal(s2.nextStarter, 2);
});

test('assaf: lowest wins; ties resolved in turn order from declarer', () => {
  // declarer is player 1 (value 6). players 2 and 0 both have 5 -> player 2 is first in turn order.
  const s = fixture({
    hands: [[C('2', 'S'), C('3', 'D')], [C('6', 'S')], [C('A', 'C'), C('4', 'C')], [C('4', 'H')]],
    deck: [C('A', 'S')],
    discardTop: { kind: 'single', cards: [C('5', 'H')] },
    currentPlayer: 1
  });
  const s2 = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.equal(s2.roundResult.assaf, 3, 'player 3 has 4 which is lowest');
  // Now make 3 not lower: tie between 2 and 0 at 5, player 3 has 6
  const t = fixture({
    hands: [[C('2', 'S'), C('3', 'D')], [C('6', 'S')], [C('A', 'C'), C('4', 'C')], [C('6', 'H')]],
    deck: [C('A', 'S')],
    discardTop: { kind: 'single', cards: [C('5', 'H')] },
    currentPlayer: 1
  });
  const t2 = E.applyMove(t, { type: 'yaniv' }, E.createRng(1));
  assert.equal(t2.roundResult.assaf, 2);
  assert.deepEqual(t2.players.map((p) => p.score), [5, 36, 0, 6]);
  assert.equal(t2.nextStarter, 2);
  // next round starts with player 2
  const t3 = E.startRound(t2, E.createRng(5));
  assert.equal(t3.currentPlayer, 2);
  assert.equal(t3.round, t2.round + 1);
  assert.ok(t3.players.every((p) => p.hand.length === 5));
});

test('elimination at/above limit, game over when one remains, starter is zero scorer', () => {
  const s = fixture({
    hands: [[C('3', 'S')], [C('9', 'S'), C('K', 'D')], [C('K', 'C'), C('Q', 'C')]],
    deck: [C('A', 'C')],
    discardTop: { kind: 'single', cards: [C('5', 'H')] },
    scores: [10, 82, 70],
    limit: 101
  });
  // P1: 82+19 = 101 -> eliminated (>= limit). P2: 70+20 = 90 stays.
  const s2 = E.applyMove(s, { type: 'yaniv' }, E.createRng(1));
  assert.equal(s2.phase, 'roundEnd');
  assert.equal(s2.players[1].eliminated, true);
  assert.equal(s2.roundResult.entries[1].newlyEliminated, true);
  assert.equal(s2.players[2].eliminated, false);
  // Next round deals only to active players
  const s3 = E.startRound(s2, E.createRng(2));
  assert.equal(s3.currentPlayer, 0);
  assert.equal(s3.players[1].hand.length, 0);
  assert.equal(s3.players[0].hand.length, 5);
  assert.equal(s3.players[2].hand.length, 5);
  // Now P2 also busts -> game over, winner 0
  s3.players[0].hand = [C('2', 'S')];
  s3.players[2].hand = [C('K', 'C'), C('Q', 'C')];
  s3.discardPile = [{ kind: 'single', cards: [C('5', 'H')], by: null }];
  s3.currentPlayer = 0;
  const s4 = E.applyMove(s3, { type: 'yaniv' }, E.createRng(1));
  assert.equal(s4.phase, 'gameOver');
  assert.equal(s4.winner, 0);
  assert.equal(s4.players[2].score, 110);
  assert.equal(s4.players[2].eliminated, true);
});

test('eliminated players are skipped in turn order', () => {
  const s = fixture({
    hands: [[C('9', 'S'), C('K', 'D')], [], [C('3', 'S'), C('4', 'S')]],
    deck: [C('2', 'C')],
    discardTop: { kind: 'single', cards: [C('5', 'H')] },
    eliminated: [false, true, false]
  });
  const s2 = E.applyMove(s, { type: 'play', discard: ['KD'], draw: 'deck' }, E.createRng(1));
  assert.equal(s2.currentPlayer, 2);
});

test('startRound: 5 cards each, one face-up discard, deck size correct', () => {
  const g = E.createGame(baseConfig(4, { jokers: 1 }), E.createRng(9));
  assert.equal(g.phase, 'lobby');
  const s = E.startRound(g, E.createRng(9));
  assert.equal(s.phase, 'playing');
  assert.ok(s.players.every((p) => p.hand.length === 5));
  assert.equal(s.discardPile.length, 1);
  assert.equal(s.discardPile[0].cards.length, 1);
  assert.equal(s.deck.length, 53 - 20 - 1);
  const ids = new Set([...s.deck, ...s.discardPile[0].cards, ...s.players.flatMap((p) => p.hand)].map((c) => c.id));
  assert.equal(ids.size, 53);
});

test('createGame validates config', () => {
  assert.throws(() => E.createGame({ players: [{ name: 'a' }] }, E.createRng(1)));
  assert.throws(() => E.createGame(baseConfig(6), E.createRng(1)));
  assert.throws(() => E.createGame(baseConfig(2, { jokers: 3 }), E.createRng(1)));
  assert.throws(() => E.createGame(baseConfig(2, { limit: 50 }), E.createRng(1)));
});

// ---------- determinism ----------
function playGame(seed, level, maxTurns = 20000) {
  const rng = E.createRng(seed);
  const n = 2 + Math.floor(rng() * 4);
  const cfg = baseConfig(n, {
    jokers: [0, 1, 2][Math.floor(rng() * 3)],
    limit: [31, 51, 71, 101][Math.floor(rng() * 4)],
    cpuLevel: level === 'mixed' ? 'normal' : level
  });
  let s = E.createGame(cfg, rng);
  const moves = [];
  let turns = 0;
  while (s.phase !== 'gameOver') {
    if (s.phase === 'lobby' || s.phase === 'roundEnd') {
      s = E.startRound(s, rng);
      continue;
    }
    const lvl = level === 'mixed' ? ['weak', 'normal', 'strong'][s.currentPlayer % 3] : level;
    const legal = E.legalMoves(s);
    const mv = E.chooseMove(s, s.currentPlayer, lvl, rng);
    const key = (m) => (m.type === 'yaniv' ? 'yaniv' : 'play|' + m.discard.slice().sort().join(',') + '|' + m.draw);
    assert.ok(legal.some((m) => key(m) === key(mv)), `move not legal (seed ${seed}, level ${lvl}): ${JSON.stringify(mv)}`);
    moves.push(mv);
    s = E.applyMove(s, mv, rng);
    turns++;
    if (turns > maxTurns) throw new Error('game did not finish (seed ' + seed + ')');
  }
  return { state: s, moves, turns };
}

test('determinism: same seed + same moves -> identical JSON', () => {
  const a = playGame(12345, 'normal');
  const b = playGame(12345, 'normal');
  assert.equal(JSON.stringify(a.state), JSON.stringify(b.state));
  assert.deepEqual(a.moves, b.moves);

  // replaying the recorded moves with a fresh rng also matches
  const rng1 = E.createRng(777);
  const rng2 = E.createRng(777);
  let s1 = E.startRound(E.createGame(baseConfig(3), rng1), rng1);
  let s2 = E.startRound(E.createGame(baseConfig(3), rng2), rng2);
  for (let i = 0; i < 30 && s1.phase === 'playing'; i++) {
    const m = E.chooseMove(s1, s1.currentPlayer, 'strong', E.createRng(i));
    s1 = E.applyMove(s1, m, rng1);
    s2 = E.applyMove(s2, m, rng2);
    assert.equal(JSON.stringify(s1), JSON.stringify(s2));
  }
});

test('createRng is deterministic and in [0,1)', () => {
  const a = E.createRng(42), b = E.createRng(42);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

// ---------- CPU simulation ----------
test('CPU simulation: 240 full games across levels finish without error', () => {
  const levels = ['weak', 'normal', 'strong', 'mixed'];
  let totalTurns = 0;
  for (let i = 0; i < 240; i++) {
    const r = playGame(1000 + i, levels[i % levels.length]);
    assert.equal(r.state.phase, 'gameOver');
    assert.ok(r.state.winner != null);
    assert.equal(r.state.players.filter((p) => !p.eliminated).length, 1);
    assert.equal(r.state.players[r.state.winner].eliminated, false);
    totalTurns += r.turns;
  }
  assert.ok(totalTurns > 240);
});

test('CPU levels always return a legal move on random mid-game states', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rng = E.createRng(seed * 31);
    let s = E.startRound(E.createGame(baseConfig(2 + (seed % 4)), rng), rng);
    for (let t = 0; t < 12 && s.phase === 'playing'; t++) {
      const legal = E.legalMoves(s);
      for (const lvl of ['weak', 'normal', 'strong']) {
        const mv = E.chooseMove(s, s.currentPlayer, lvl, E.createRng(t));
        const key = (m) => (m.type === 'yaniv' ? 'yaniv' : 'play|' + m.discard.slice().sort().join(',') + '|' + m.draw);
        assert.ok(legal.some((m) => key(m) === key(mv)), lvl + ' returned illegal move');
      }
      s = E.applyMove(s, E.chooseMove(s, s.currentPlayer, 'weak', rng), rng);
    }
  }
});

test('weak CPU declares yaniv immediately when <= 7', () => {
  const s = fixture({
    hands: [[C('3', 'S'), C('4', 'D')], [C('9', 'S'), C('K', 'D')]],
    deck: [C('A', 'C')],
    discardTop: { kind: 'single', cards: [C('5', 'H')] }
  });
  assert.deepEqual(E.chooseMove(s, 0, 'weak', E.createRng(1)), { type: 'yaniv' });
  assert.deepEqual(E.chooseMove(s, 0, 'normal', E.createRng(1)), { type: 'yaniv' });
});

test('normal CPU discards the group that minimizes remaining value and takes a useful low discard', () => {
  const s = fixture({
    hands: [[C('K', 'S'), C('K', 'D'), C('2', 'C'), C('9', 'H')], [C('9', 'S'), C('K', 'H')]],
    deck: [C('A', 'C')],
    discardTop: { kind: 'single', cards: [C('2', 'H')] }
  });
  s.discardPile[0].by = 1;
  const mv = E.chooseMove(s, 0, 'normal', E.createRng(1));
  assert.equal(mv.type, 'play');
  assert.deepEqual(mv.discard.slice().sort(), ['KD', 'KS']);
  assert.equal(mv.draw, '2H', 'takes the 2 (pairs with 2C and is below deck expectation)');
});

test('validateConfig truncates names to 20 chars and stringifies', () => {
  const g = E.createGame({ players: [{ name: 'a'.repeat(40), type: 'human' }, { name: 12345, type: 'cpu' }], jokers: 0, limit: 31, cpuLevel: 'weak' }, E.createRng(1));
  assert.equal(g.players[0].name.length, 20);
  assert.equal(g.players[1].name, '12345');
});

test('discardError returns a string for every invalid group, null for valid', () => {
  assert.equal(E.discardError([C('5', 'S'), C('5', 'H')]), null);
  assert.equal(typeof E.discardError([C('5', 'S'), C('5', 'S')]), 'string');
  assert.match(E.discardError([C('5', 'S'), C('5', 'S')]), /重複/);
  assert.equal(typeof E.discardError([C('5', 'S'), C('6', 'S')]), 'string');
  assert.equal(typeof E.discardError([C('A', 'S'), C('K', 'S'), C('Q', 'S')]), 'string');
  assert.equal(typeof E.discardError([J1, J2, C('5', 'S')]), 'string');
  assert.equal(typeof E.discardError([]), 'string');
});
