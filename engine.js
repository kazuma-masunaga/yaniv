/*
 * Yaniv game engine (Phase 1)
 * Pure, UI-independent, deterministic (rng injected), plain-object state.
 * UMD-ish: browser -> window.YanivEngine, Node -> module.exports
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.YanivEngine = api;
  } else if (root) {
    root.YanivEngine = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUITS = ['S', 'H', 'D', 'C'];
  var JOKER = 'JOKER';
  var HAND_SIZE = 5;
  var MIN_PLAYERS = 2;
  var MAX_PLAYERS = 8; // 8 x 5 = 40 cards dealt; the deck refills from the discard pile as needed
  var BIG_TABLE = 6; // CPU tweaks for tables with 6+ seats at game start (see chooseMove)
  var BIG_TABLE_SHAKE = 0.2;
  var YANIV_MAX = 7;
  var ASSAF_PENALTY = 30;
  var DECK_EXPECTED = 5.6;

  // ---------- RNG ----------
  function createRng(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    // xorshift32
    return function rng() {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return (s >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ---------- Cards ----------
  function makeCard(rank, suit) {
    return { id: rank + suit, rank: rank, suit: suit };
  }

  function buildDeck(jokers) {
    var cards = [];
    for (var s = 0; s < SUITS.length; s++) {
      for (var r = 0; r < RANKS.length; r++) {
        cards.push(makeCard(RANKS[r], SUITS[s]));
      }
    }
    for (var j = 1; j <= (jokers || 0); j++) {
      cards.push({ id: JOKER + j, rank: JOKER, suit: 'J' + j });
    }
    return cards;
  }

  function isJoker(card) {
    return !!card && card.rank === JOKER;
  }

  function rankIndex(card) {
    return RANKS.indexOf(card.rank);
  }

  function cardValue(card) {
    if (!card) return 0;
    if (card.rank === JOKER) return 0;
    if (card.rank === 'A') return 1;
    if (card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 10;
    return parseInt(card.rank, 10);
  }

  // 同じランクが複数枚あっても、そのランクは1回だけ数える（3♥3♣3♠ = 3点）。
  // J/Q/K は別ランクなので各10点。ジョーカーは0点。
  function handValue(cards) {
    var sum = 0;
    var seen = {};
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c || seen[c.rank]) continue;
      seen[c.rank] = true;
      sum += cardValue(c);
    }
    return sum;
  }

  // ---------- Discard validation ----------
  /**
   * Analyze a group of cards. Returns null if invalid, otherwise
   * { kind: 'single'|'set'|'run', cards: arranged array }.
   * For runs the arranged array is sorted low->high with jokers placed in
   * gaps and leftover jokers at an end.
   */
  function analyzeGroup(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return null;
    // unique ids
    var seen = {};
    for (var i = 0; i < cards.length; i++) {
      if (!cards[i] || typeof cards[i].id !== 'string') return null;
      if (seen[cards[i].id]) return null;
      seen[cards[i].id] = true;
    }
    if (cards.length === 1) return { kind: 'single', cards: cards.slice() };

    // set: same rank (JOKER counts as its own rank)
    var allSameRank = true;
    for (i = 1; i < cards.length; i++) {
      if (cards[i].rank !== cards[0].rank) { allSameRank = false; break; }
    }
    if (allSameRank) return { kind: 'set', cards: cards.slice() };

    // run: >=3 cards, >=2 real cards, same suit, jokers fill gaps/ends
    if (cards.length < 3) return null;
    var reals = [];
    var jokers = [];
    for (i = 0; i < cards.length; i++) {
      if (isJoker(cards[i])) jokers.push(cards[i]); else reals.push(cards[i]);
    }
    if (reals.length < 2) return null;
    var suit = reals[0].suit;
    for (i = 1; i < reals.length; i++) {
      if (reals[i].suit !== suit) return null;
    }
    reals.sort(function (a, b) { return rankIndex(a) - rankIndex(b); });
    for (i = 1; i < reals.length; i++) {
      if (rankIndex(reals[i]) === rankIndex(reals[i - 1])) return null;
    }
    var lo = rankIndex(reals[0]);
    var hi = rankIndex(reals[reals.length - 1]);
    var span = hi - lo + 1;
    var gaps = span - reals.length;
    if (gaps > jokers.length) return null;
    var extra = jokers.length - gaps;
    if (span + extra > RANKS.length) return null; // cannot fit within A..K

    // arrange
    var arranged = [];
    var jk = 0;
    var ri = 0;
    for (var r = lo; r <= hi; r++) {
      if (ri < reals.length && rankIndex(reals[ri]) === r) {
        arranged.push(reals[ri++]);
      } else {
        arranged.push(jokers[jk++]);
      }
    }
    // leftover jokers: prefer the high end, otherwise the low end
    var roomHigh = RANKS.length - 1 - hi;
    var toHigh = Math.min(extra, roomHigh);
    var toLow = extra - toHigh;
    for (i = 0; i < toHigh; i++) arranged.push(jokers[jk++]);
    for (i = 0; i < toLow; i++) arranged.unshift(jokers[jk++]);
    return { kind: 'run', cards: arranged };
  }

  function isValidDiscard(cards) {
    return analyzeGroup(cards) !== null;
  }

  // ---------- State helpers ----------
  function cloneState(state) {
    var s = {};
    for (var k in state) if (Object.prototype.hasOwnProperty.call(state, k)) s[k] = state[k];
    s.config = JSON.parse(JSON.stringify(state.config));
    s.players = state.players.map(function (p) {
      var q = {};
      for (var kk in p) if (Object.prototype.hasOwnProperty.call(p, kk)) q[kk] = p[kk];
      q.hand = p.hand.slice();
      return q;
    });
    s.deck = state.deck.slice();
    s.discardPile = state.discardPile.map(function (g) {
      return { kind: g.kind, cards: g.cards.slice(), by: g.by };
    });
    s.roundResult = state.roundResult ? JSON.parse(JSON.stringify(state.roundResult)) : null;
    s.lastMove = state.lastMove ? JSON.parse(JSON.stringify(state.lastMove)) : null;
    return s;
  }

  function activeIndices(state) {
    var out = [];
    for (var i = 0; i < state.players.length; i++) {
      if (!state.players[i].eliminated) out.push(i);
    }
    return out;
  }

  function nextActive(state, from) {
    var n = state.players.length;
    for (var step = 1; step <= n; step++) {
      var idx = (from + step) % n;
      if (!state.players[idx].eliminated) return idx;
    }
    return from;
  }

  function topGroup(state) {
    return state.discardPile.length ? state.discardPile[state.discardPile.length - 1] : null;
  }

  function findCard(cards, id) {
    for (var i = 0; i < cards.length; i++) if (cards[i].id === id) return cards[i];
    return null;
  }

  // ---------- Game lifecycle ----------
  function validateConfig(config) {
    if (!config || !Array.isArray(config.players)) throw new Error('config.players required');
    if (config.players.length < MIN_PLAYERS || config.players.length > MAX_PLAYERS) throw new Error('players must be ' + MIN_PLAYERS + '-' + MAX_PLAYERS);
    var jokers = config.jokers == null ? 2 : config.jokers;
    if ([0, 1, 2].indexOf(jokers) < 0) throw new Error('jokers must be 0,1,2');
    var limit = config.limit == null ? 101 : config.limit;
    if ([31, 51, 71, 101].indexOf(limit) < 0) throw new Error('limit must be 31/51/71/101');
    var cpuLevel = config.cpuLevel || 'normal';
    if (['weak', 'normal', 'strong'].indexOf(cpuLevel) < 0) throw new Error('bad cpuLevel');
    // starter: who opens the next round.
    //   'zero'    - the player who scored 0 this round (yaniv / assaf winner)  [default]
    //   'highest' - the player who was charged the most points this round
    var starter = config.starter == null ? 'zero' : config.starter;
    if (['zero', 'highest'].indexOf(starter) < 0) throw new Error('bad starter');
    var players = config.players.map(function (p, i) {
      var type = p.type === 'cpu' ? 'cpu' : 'human';
      var name = (p.name != null && String(p.name).trim()) || (type === 'cpu' ? 'CPU ' + (i + 1) : 'Player ' + (i + 1));
      return { name: String(name).slice(0, 20), type: type };
    });
    return { players: players, jokers: jokers, limit: limit, cpuLevel: cpuLevel, starter: starter };
  }

  function createGame(config, rng) {
    var cfg = validateConfig(config);
    return {
      phase: 'lobby',
      config: cfg,
      players: cfg.players.map(function (p) {
        return { name: p.name, type: p.type, score: 0, eliminated: false, hand: [] };
      }),
      deck: [],
      discardPile: [],
      round: 0,
      currentPlayer: -1,
      nextStarter: null,
      roundResult: null,
      lastMove: null,
      winner: null
    };
  }

  function startRound(state, rng) {
    if (state.phase !== 'lobby' && state.phase !== 'roundEnd') {
      throw new Error('startRound not allowed in phase ' + state.phase);
    }
    if (typeof rng !== 'function') throw new Error('rng required');
    var s = cloneState(state);
    var active = activeIndices(s);
    if (active.length < 2) throw new Error('need at least 2 active players');
    var deck = shuffle(buildDeck(s.config.jokers), rng);
    for (var i = 0; i < s.players.length; i++) s.players[i].hand = [];
    for (var c = 0; c < HAND_SIZE; c++) {
      for (var a = 0; a < active.length; a++) {
        s.players[active[a]].hand.push(deck.pop());
      }
    }
    var flip = deck.pop();
    s.deck = deck;
    s.discardPile = [{ kind: 'single', cards: [flip], by: null }];
    s.round = state.round + 1;
    if (s.nextStarter != null && !s.players[s.nextStarter].eliminated) {
      s.currentPlayer = s.nextStarter;
    } else {
      s.currentPlayer = active[Math.floor(rng() * active.length)];
    }
    s.phase = 'playing';
    s.roundResult = null;
    s.lastMove = null;
    return s;
  }

  // ---------- Moves ----------
  function takeableFromDiscard(state) {
    if (state.phase !== 'playing') return [];
    var top = topGroup(state);
    if (!top) return [];
    if (top.by === state.currentPlayer) return [];
    if (top.cards.length === 1) return [top.cards[0]];
    if (top.kind === 'set') return top.cards.slice();
    // run: both ends
    var first = top.cards[0];
    var last = top.cards[top.cards.length - 1];
    return first.id === last.id ? [first] : [first, last];
  }

  function canDrawFromDeck(state) {
    return state.deck.length > 0 || state.discardPile.length > 1;
  }

  function validDiscards(hand) {
    var out = [];
    var n = hand.length;
    var total = 1 << n;
    for (var mask = 1; mask < total; mask++) {
      var cards = [];
      for (var i = 0; i < n; i++) if (mask & (1 << i)) cards.push(hand[i]);
      if (analyzeGroup(cards)) out.push(cards);
    }
    return out;
  }

  function legalMoves(state) {
    if (state.phase !== 'playing') return [];
    var p = state.players[state.currentPlayer];
    var moves = [];
    if (handValue(p.hand) <= YANIV_MAX) moves.push({ type: 'yaniv' });
    var draws = [];
    if (canDrawFromDeck(state)) draws.push('deck');
    var takeable = takeableFromDiscard(state);
    for (var t = 0; t < takeable.length; t++) draws.push(takeable[t].id);
    var discards = validDiscards(p.hand);
    for (var d = 0; d < discards.length; d++) {
      var ids = discards[d].map(function (c) { return c.id; });
      for (var k = 0; k < draws.length; k++) {
        moves.push({ type: 'play', discard: ids.slice(), draw: draws[k] });
      }
    }
    return moves;
  }

  function reshuffleIfNeeded(s, rng) {
    if (s.deck.length > 0) return;
    if (s.discardPile.length <= 1) return;
    var top = s.discardPile[s.discardPile.length - 1];
    var rest = [];
    for (var i = 0; i < s.discardPile.length - 1; i++) {
      rest = rest.concat(s.discardPile[i].cards);
    }
    s.deck = shuffle(rest, rng);
    s.discardPile = [top];
  }

  function applyMove(state, move, rng) {
    if (!state || state.phase !== 'playing') throw new Error('game is not in playing phase');
    if (!move || typeof move !== 'object') throw new Error('invalid move');
    if (typeof rng !== 'function') rng = function () { return 0.5; };
    var s = cloneState(state);
    var pi = s.currentPlayer;
    var player = s.players[pi];

    if (move.type === 'yaniv') {
      if (handValue(player.hand) > YANIV_MAX) throw new Error('hand value exceeds 7');
      return endRound(s, pi);
    }
    if (move.type !== 'play') throw new Error('unknown move type');
    if (!Array.isArray(move.discard) || move.discard.length === 0) throw new Error('discard required');

    var discardCards = [];
    var used = {};
    for (var i = 0; i < move.discard.length; i++) {
      var id = move.discard[i];
      if (used[id]) throw new Error('duplicate card in discard');
      used[id] = true;
      var c = findCard(player.hand, id);
      if (!c) throw new Error('card not in hand: ' + id);
      discardCards.push(c);
    }
    var group = analyzeGroup(discardCards);
    if (!group) throw new Error('invalid discard combination');

    // draw
    var drawn;
    var drawSource;
    if (move.draw === 'deck') {
      reshuffleIfNeeded(s, rng);
      if (s.deck.length === 0) throw new Error('deck is empty');
      drawn = s.deck.pop();
      drawSource = 'deck';
    } else if (typeof move.draw === 'string') {
      var takeable = takeableFromDiscard(s);
      var tk = findCard(takeable, move.draw);
      if (!tk) throw new Error('card not takeable from discard: ' + move.draw);
      var top = s.discardPile[s.discardPile.length - 1];
      top.cards = top.cards.filter(function (x) { return x.id !== tk.id; });
      if (top.cards.length === 0) s.discardPile.pop();
      drawn = tk;
      drawSource = 'discard';
    } else {
      throw new Error('invalid draw');
    }

    // apply discard
    player.hand = player.hand.filter(function (x) { return !used[x.id]; });
    player.hand.push(drawn);
    s.discardPile.push({ kind: group.kind, cards: group.cards, by: pi });

    s.lastMove = {
      playerIndex: pi,
      discard: group.cards.slice(),
      drawSource: drawSource,
      drawnCard: drawSource === 'discard' ? drawn : null
    };

    reshuffleIfNeeded(s, rng);
    s.currentPlayer = nextActive(s, pi);
    return s;
  }

  function endRound(s, declarer) {
    var active = activeIndices(s);
    var values = {};
    for (var i = 0; i < active.length; i++) {
      values[active[i]] = handValue(s.players[active[i]].hand);
    }
    var dv = values[declarer];
    // find assaf (ヤニブ返し): lowest value strictly below dv among others
    // (equal to the declarer's value is NOT a counter); ties -> turn order from declarer
    var assaf = null;
    var best = Infinity;
    var n = s.players.length;
    for (var step = 1; step < n; step++) {
      var idx = (declarer + step) % n;
      if (s.players[idx].eliminated) continue;
      if (values[idx] < dv && values[idx] < best) {
        best = values[idx];
        assaf = idx;
      }
    }
    var entries = [];
    for (i = 0; i < s.players.length; i++) {
      var p = s.players[i];
      var entry = {
        playerIndex: i,
        name: p.name,
        hand: p.hand.slice(),
        value: p.eliminated ? null : values[i],
        added: 0,
        role: 'normal',
        before: p.score,
        total: p.score,
        eliminated: p.eliminated,
        newlyEliminated: false,
        wasActive: !p.eliminated
      };
      if (!p.eliminated) {
        if (i === declarer) {
          if (assaf != null) { entry.added = values[i] + ASSAF_PENALTY; entry.role = 'caught'; }
          else { entry.added = 0; entry.role = 'yaniv'; }
        } else if (i === assaf) {
          entry.added = 0; entry.role = 'assaf';
        } else {
          entry.added = values[i];
        }
        p.score += entry.added;
        entry.total = p.score;
        if (p.score >= s.config.limit) {
          p.eliminated = true;
          entry.eliminated = true;
          entry.newlyEliminated = true;
        }
      }
      entries.push(entry);
    }
    var zeroPlayer = assaf != null ? assaf : declarer;
    var starter = zeroPlayer;
    if (s.config.starter === 'highest') {
      // Highest `added` this round opens the next one. Ties go to whoever
      // comes first in turn order seen from the declarer (declarer itself
      // first). Players eliminated this round are skipped; if nobody
      // qualifies fall back to the zero scorer.
      var bestIdx = null;
      var bestAdded = -Infinity;
      for (var st = 0; st < n; st++) {
        var ci = (declarer + st) % n;
        var ce = entries[ci];
        if (!ce.wasActive || ce.eliminated) continue;
        if (ce.added > bestAdded) { bestAdded = ce.added; bestIdx = ci; }
      }
      if (bestIdx != null) starter = bestIdx;
    }
    s.roundResult = {
      round: s.round,
      declarer: declarer,
      declarerValue: dv,
      assaf: assaf,
      entries: entries,
      nextStarter: starter
    };
    s.nextStarter = starter;
    var remaining = activeIndices(s);
    if (remaining.length <= 1) {
      s.phase = 'gameOver';
      s.winner = remaining.length === 1 ? remaining[0] : zeroPlayer;
    } else {
      s.phase = 'roundEnd';
    }
    return s;
  }

  // ---------- CPU ----------
  function pick(arr, rng) {
    return arr[Math.floor(rng() * arr.length)];
  }

  function hasPlayMove(moves) {
    for (var i = 0; i < moves.length; i++) if (moves[i].type === 'play') return true;
    return false;
  }

  function hasYaniv(moves) {
    for (var i = 0; i < moves.length; i++) if (moves[i].type === 'yaniv') return true;
    return false;
  }

  /** Does card c combine with any cards in `hand` into a pair or (potential) run? */
  function synergy(c, hand) {
    var score = 0;
    for (var i = 0; i < hand.length; i++) {
      var h = hand[i];
      if (isJoker(c) || isJoker(h)) {
        if (isJoker(c) && isJoker(h)) score += 2; // joker pair
        else score += 1; // joker helps anything
        continue;
      }
      if (h.rank === c.rank) score += 3;
      else if (h.suit === c.suit) {
        var d = Math.abs(rankIndex(h) - rankIndex(c));
        if (d === 1) score += 2;
        else if (d === 2) score += 1;
      }
    }
    return score;
  }

  function bestDiscards(hand, scoreFn) {
    var opts = validDiscards(hand);
    var best = [];
    var bestScore = -Infinity;
    for (var i = 0; i < opts.length; i++) {
      var sc = scoreFn(opts[i]);
      if (sc > bestScore + 1e-9) { bestScore = sc; best = [opts[i]]; }
      else if (Math.abs(sc - bestScore) < 1e-9) best.push(opts[i]);
    }
    return best;
  }

  function remainingAfter(hand, discard) {
    var ids = {};
    for (var i = 0; i < discard.length; i++) ids[discard[i].id] = true;
    return hand.filter(function (c) { return !ids[c.id]; });
  }

  function chooseDraw(state, remaining, discardValue, takeable, strong, rng) {
    var deckOk = canDrawFromDeck(state);
    var bestId = deckOk ? 'deck' : null;
    var bestGain = deckOk ? 0 : -Infinity;
    // Occasionally prefer the deck even when a discard looks good. This breaks
    // the "two players swap the same low cards forever" cycle and keeps CPU
    // play from being perfectly predictable.
    var explore = deckOk && rng() < (strong ? 0.1 : 0.15);
    for (var i = 0; i < takeable.length; i++) {
      var c = takeable[i];
      var v = cardValue(c);
      var syn = synergy(c, remaining);
      // taking must make real progress: hand total goes down vs. what we discard,
      // or the card immediately pairs / extends a run.
      if (v >= discardValue && syn < 2) continue;
      var gain = DECK_EXPECTED - v; // positive if lower than expected deck card
      gain += syn * 1.5;
      if (strong && v <= 2) gain += 1; // low cards enable yaniv
      if (explore && syn < 2) continue;
      if (gain > bestGain + 1e-9) { bestGain = gain; bestId = c.id; }
    }
    if (bestId == null) bestId = takeable.length ? takeable[0].id : 'deck';
    return bestId;
  }

  function chooseMove(state, playerIndex, level, rng) {
    if (typeof rng !== 'function') rng = Math.random;
    if (state.phase !== 'playing') throw new Error('not playing');
    if (playerIndex !== state.currentPlayer) throw new Error('not this player\'s turn');
    var moves = legalMoves(state);
    if (moves.length === 0) throw new Error('no legal moves');
    var hand = state.players[playerIndex].hand;
    var hv = handValue(hand);
    var takeable = takeableFromDiscard(state);
    level = level || 'normal';

    if (level === 'weak') {
      if (hasYaniv(moves)) return { type: 'yaniv' };
      var opts = validDiscards(hand);
      var d = pick(opts, rng);
      var draw = canDrawFromDeck(state) ? 'deck' : (takeable.length ? takeable[0].id : null);
      if (draw == null) return pick(moves, rng);
      return { type: 'play', discard: d.map(function (c) { return c.id; }), draw: draw };
    }

    var strong = level === 'strong';
    // Big tables (6-8 players): 30-40 cards sit in hands, so the low cards can all end up
    // held while the deck holds only high ones. Purely greedy CPUs then swap high cards forever
    // and nobody reaches 7. Two adjustments apply ONLY to games of 6+ players (2-5 players play
    // exactly as before, rng consumption included):
    //   - strong declares as soon as it can (no "wait one turn", someone is always short-handed);
    //   - now and then the CPU discards a random group instead of the greedy one, which puts low
    //     cards back into circulation and breaks the stalemate.
    // Judged on the seats at the table (not who is still in), so a game that started with 6+ keeps
    // the same CPU style after eliminations.
    var bigTable = state.players.length >= BIG_TABLE;

    // Yaniv decision
    if (hasYaniv(moves)) {
      if (!strong || !hasPlayMove(moves) || bigTable) return { type: 'yaniv' };
      var othersAllBig = true;
      for (var i = 0; i < state.players.length; i++) {
        if (i === playerIndex || state.players[i].eliminated) continue;
        if (state.players[i].hand.length < 4) othersAllBig = false;
      }
      // Spec: with hv <= 7, wait one turn if some opponent holds <= 2 cards
      // and our hv >= 4 (they are likely close to yaniv themselves and may
      // assaf us); declare if hv <= 3 or every opponent holds >= 4 cards.
      // Hand sizes shrink whenever a player discards a set or run (discard
      // N, draw 1), so opponents with 1-2 cards do occur.
      var someoneShort = false;
      for (i = 0; i < state.players.length; i++) {
        if (i === playerIndex || state.players[i].eliminated) continue;
        if (state.players[i].hand.length <= 2) someoneShort = true;
      }
      if (hv <= 3 || othersAllBig) return { type: 'yaniv' };
      if (someoneShort && hv >= 4) {
        // wait one turn (fall through to play)
      } else {
        return { type: 'yaniv' };
      }
    }

    // Discard choice: maximize removed value (minimize remaining)
    var seenRanks = {};
    if (strong) {
      for (var g = 0; g < state.discardPile.length; g++) {
        var grp = state.discardPile[g];
        for (var k = 0; k < grp.cards.length; k++) {
          seenRanks[grp.cards[k].rank] = (seenRanks[grp.cards[k].rank] || 0) + 1;
        }
      }
    }
    var hvNow = handValue(hand);
    var scoreFn = function (discard) {
      // 「同じランクは1回だけ数える」ルールのため、捨てる組の点数ではなく
      // 捨てた後に手札点がどれだけ下がるかで評価する。
      var removed = hvNow - handValue(remainingAfter(hand, discard));
      var score = removed;
      if (strong) {
        // risk: leaving low cards for the next player
        for (var i = 0; i < discard.length; i++) {
          var v = cardValue(discard[i]);
          if (v <= 3) score -= 1.5;
          else if (v <= 5) score -= 0.5;
        }
        // keep cards whose partners are likely still unseen
        var rem = remainingAfter(hand, discard);
        var potential = 0;
        for (i = 0; i < rem.length; i++) {
          if (isJoker(rem[i])) continue;
          var unseen = 3 - (seenRanks[rem[i].rank] || 0);
          if (unseen > 0) potential += 0.2 * unseen;
        }
        score += potential;
        // prefer multi-card discards slightly (hand gets thinner in value)
        score += discard.length * 0.3;
      } else {
        score += discard.length * 0.01;
      }
      return score;
    };
    var cands = bestDiscards(hand, scoreFn);
    if (bigTable && rng() < BIG_TABLE_SHAKE) cands = validDiscards(hand);
    var discard = cands.length === 1 ? cands[0] : pick(cands, rng);
    var remaining = remainingAfter(hand, discard);
    var drawId = chooseDraw(state, remaining, hvNow - handValue(remaining), takeable, strong, rng);
    var move = { type: 'play', discard: discard.map(function (c) { return c.id; }), draw: drawId };
    // safety: ensure legality
    if (!isLegal(moves, move)) return pick(moves, rng);
    return move;
  }

  function moveKey(m) {
    if (m.type === 'yaniv') return 'yaniv';
    return 'play|' + m.discard.slice().sort().join(',') + '|' + m.draw;
  }

  function isLegal(moves, move) {
    var key = moveKey(move);
    for (var i = 0; i < moves.length; i++) if (moveKey(moves[i]) === key) return true;
    return false;
  }

  /** Human-readable reason why a discard selection is invalid (Japanese). */
  function discardError(cards) {
    if (!cards || cards.length === 0) return 'カードを選んでください';
    if (analyzeGroup(cards)) return null;
    // analyzeGroup rejected the group. Same-rank groups only fail on
    // malformed input (duplicate ids / missing cards).
    var seen = {};
    for (var d = 0; d < cards.length; d++) {
      if (!cards[d] || typeof cards[d].id !== 'string') return '不正なカードが含まれています';
      if (seen[cards[d].id]) return '同じカードが重複しています';
      seen[cards[d].id] = true;
    }
    var allSame = cards.every(function (c) { return c.rank === cards[0].rank; });
    if (allSame) return '不正な組み合わせです';
    if (cards.length === 2) return '2枚は同じランクのみ可（連番は3枚以上）';
    var reals = cards.filter(function (c) { return !isJoker(c); });
    if (reals.length < 2) return '連番にはジョーカー以外のカードが2枚以上必要';
    var suit = reals[0].suit;
    if (!reals.every(function (c) { return c.suit === suit; })) return '同じランクの組、または同じスートの連番3枚以上が必要';
    var sorted = reals.slice().sort(function (a, b) { return rankIndex(a) - rankIndex(b); });
    for (var i = 1; i < sorted.length; i++) {
      if (rankIndex(sorted[i]) === rankIndex(sorted[i - 1])) return '連番に同じランクは含められません';
    }
    return '連番がつながっていません（AとKはつながりません）';
  }

  return {
    RANKS: RANKS,
    SUITS: SUITS,
    JOKER: JOKER,
    HAND_SIZE: HAND_SIZE,
    MIN_PLAYERS: MIN_PLAYERS,
    MAX_PLAYERS: MAX_PLAYERS,
    YANIV_MAX: YANIV_MAX,
    createRng: createRng,
    buildDeck: buildDeck,
    cardValue: cardValue,
    handValue: handValue,
    isJoker: isJoker,
    analyzeGroup: analyzeGroup,
    isValidDiscard: isValidDiscard,
    discardError: discardError,
    createGame: createGame,
    startRound: startRound,
    takeableFromDiscard: takeableFromDiscard,
    legalMoves: legalMoves,
    applyMove: applyMove,
    chooseMove: chooseMove,
    activeIndices: activeIndices
  };
});
