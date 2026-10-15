# ヤニブ Phase 2 指示書（P2P オンライン対戦）

## 目的
Phase 1（1端末版）に、PeerJS を使った P2P オンライン対戦を追加する。
ホストが部屋を作り URL を共有、参加者はログイン不要で参加。人間と CPU を混ぜて 2〜5 人。
配置先は GitHub Pages（通常の静的ホスティング。claude.ai Artifact の制約はもう無い）。

## 前提
- 既存: `/home/claude/yaniv/index.html`（UI）、`engine.js`（ゲームロジック・決定論・plain object）、`tests/engine.test.js`（27 pass）。SPEC.md が Phase 1 の仕様。**Phase 1 の機能・ルールは一切変えない**。
- engine.js の API: `createGame(config, rng)`, `startRound(state, rng)`, `legalMoves(state)`, `applyMove(state, move, rng)`, `chooseMove(state, playerIndex, level, rng)`, `createRng(seed)`, `handValue`, `discardError`, `takeableFromDiscard`, `analyzeGroup` など。state は `phase/config/players[{name,type,hand,score,out}]/deck/discardPile/round/currentPlayer/nextStarter/roundResult/lastMove/winner`。
- PeerJS: `<script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"></script>`（グローバル `Peer`）。
- 外部ライブラリは PeerJS のみ。ビルド工程なし。
- テストは Node（`node --test tests/`）。通信層は Node で動くこと（PeerJS に依存しない偽トランスポートで）。

## 変更してよい範囲
- `/home/claude/yaniv/index.html`（変更可。Phase 1 の画面は壊さない）
- `/home/claude/yaniv/net.js`（新規: 通信・部屋・ホスト権限ロジック）
- `/home/claude/yaniv/tests/net.test.js`（新規）
- `/home/claude/yaniv/README.md`（新規: 遊び方と公開手順を日本語で簡潔に）
- `engine.js` は**原則変更しない**。どうしても必要なら追加のみ（既存 API の挙動変更禁止）で、報告に明記。
- SPEC.md / SPEC2.md は編集しない。他ディレクトリには書かない。

---

## 設計

### 構成
- ロビーに 3 つの入口を追加: **「この端末で遊ぶ」**（Phase 1 のまま）／**「部屋を作る」**／**「部屋に参加」**。
- URL に `?room=XXXXXX` が付いていたら「部屋に参加」画面を開き、部屋コードを入力済みにする。
- 状態の持ち主は**ホストだけ**（ホスト権限方式）。参加者はホストに「手」を送り、ホストが `engine.applyMove` で検証して進め、各参加者に「その人から見える状態」を配信する。

### net.js の構造（Node でテスト可能にするため、通信を抽象化）
```
// トランスポート抽象: PeerJS 実装と、テスト用のインメモリ実装の 2 種
Transport { open(id) -> Promise<ownId>, connect(remoteId) -> Conn, onConnection(fn), close() }
Conn { send(obj), onMessage(fn), onClose(fn), close(), remoteId }

// ホスト側ロジック（純粋に近い）
createHost({transport, engine, rng, hostName}) -> host
  host.roomCode              // 6 文字（紛らわしい文字 0/O/1/I/L を除いた英大文字+数字）
  host.setConfig({...})      // jokers, limit, cpuLevel, seatCount(2..5)
  host.lobby()               // 参加者一覧（席順、接続状態）
  host.start()               // 空席を CPU で埋めてゲーム開始
  host.kick(seat) / host.replaceWithCpu(seat)
  host.onLobbyChange(fn) / host.onStateChange(fn)   // ホスト自身の UI 更新用
  host.submitMove(move)      // ホスト自身の手
  host.nextRound()

// 参加者側ロジック
createClient({transport, roomCode, name, seatToken?}) -> client
  client.onLobby(fn), client.onView(fn), client.onError(fn), client.onDisconnect(fn)
  client.submitMove(move)
  client.reconnect()
```
- PeerJS の peer id は `yaniv-<roomCode>`（ホスト）。参加者は `transport.connect('yaniv-'+roomCode)`。
- ホストは部屋コード生成時に `peer.open` が `unavailable-id` で失敗したら別コードで再試行（最大 5 回）。

### メッセージプロトコル（JSON）
参加者→ホスト:
- `{t:'join', name, seatToken?, proto:1}`（seatToken があれば再接続として同じ席に戻す）
- `{t:'move', move}`
- `{t:'ping'}`
ホスト→参加者:
- `{t:'joined', seat, seatToken, roomCode}` / `{t:'reject', reason}`（満席・ゲーム中・名前不正・proto 不一致）
- `{t:'lobby', seats:[{name,type:'human'|'cpu'|'empty',connected,isHost}], config}`
- `{t:'view', view}`（後述の「見える状態」）
- `{t:'error', message}`（不正な手など。状態は変えない）
- `{t:'pong'}` / `{t:'closed', reason}`
- 受信は必ず検証する（`t` が既知、`move` が object、`name` は文字列を 12 文字に切り詰め、HTML は UI 側で textContent/esc）。不明メッセージは無視。

### 「見える状態」(view) の作り方
ホストの state から参加者 seat 向けに生成:
- 自分の `hand` はそのまま。他プレイヤーは `hand` を削除し `handCount` を付ける。
- `deck` は削除し `deckCount` を付ける。`discardPile` は**一番上の組だけ**（取れるカード判定に必要）。
- `roundResult`（ラウンド終了時）は全員の手札込みでそのまま。`phase/round/currentPlayer/config/scores/winner/lastMove` は含める。
- `legalMoves` はクライアントで計算できないので、ホストが `view.legalMoves` を同梱（自分の手番のときのみ）。`takeable` も同梱。
- クライアントは view をそのまま描画する。**クライアントは engine を「判定表示用」にのみ使う**（`discardError`, `handValue`, `analyzeGroup`）。

### ゲーム進行
- ホストが `start()`: 席順に players を組み、空席は CPU（名前 "CPU n"、強さは config）。`createGame` → `startRound`。
- CPU の手番はホスト側で 600〜900ms のウェイト後に `chooseMove` → `applyMove`。
- 人間の手は `submitMove`: 手番確認 → `legalMoves` に同一の手（discard の id 集合と draw が一致）があるか確認 → `applyMove`。失敗は `error` を返す。
- 毎 applyMove 後、全参加者に view を再配信。
- ラウンド終了: ホストの「次のラウンド」で `startRound`。ゲーム終了: ホストの「もう一度」で同じ席構成で `createGame`。

### 切断対策
- 参加者は `seatToken`（ランダム 16 文字）を localStorage に `yaniv.seat.<roomCode>` で保存。切断したら 2 秒→4 秒→8 秒…（最大 30 秒間隔、無制限）で `reconnect()`。再接続時 `join` に seatToken を付け、ホストは同じ席に戻し最新 view を送る。
- ホストは切断中の席を `connected:false` でロビー/対局画面に表示。切断中の人の手番なら「再接続待ち」を表示し、ホストに「CPU に交代」ボタンを出す（`replaceWithCpu`: その席の type を 'cpu' に変えて以降は CPU が打つ）。
- ホスト切断: 参加者には「ホストとの接続が切れました」を表示し、30 秒再接続を試みてダメなら「部屋は終了しました。ロビーへ」。
- ホスト画面には「このタブを閉じると部屋が終了します」の注意を常時小さく表示。
- `beforeunload` でホストは全参加者に `closed` を送る。

### UI 要件（index.html）
- ロビー: 入口 3 つ。「部屋を作る」→ 名前入力 → 部屋コードと共有 URL（`location.origin + location.pathname + '?room=' + code`）を大きく表示、コピーボタン（clipboard 失敗時は選択状態にする）、人数枠（3〜5）、ジョーカー/脱落ライン/CPU強さ、参加者一覧（接続中/切断）、「開始」（人間が 1 人以上いれば可。ホストは必ず人間）。
- 「部屋に参加」→ 部屋コード（6 文字、自動大文字化）と名前 → 「参加」。待機中はホストのロビーをミラー表示。
- 対局画面は Phase 1 のものを共用。オンライン時は: 他プレイヤーに接続状態バッジ、自分の手番以外はボタン無効、送信中は二重送信防止、`error` を msg に表示。
- ラウンド結果/ゲーム終了は Phase 1 と同じ。ホストだけ「次のラウンド」「もう一度」が押せ、参加者は「ホストを待っています」。
- パス＆プレイのカバーはオンラインでは出さない。
- 既存のライト/ダークのトークン設計、スマホ幅、`[hidden]` 切替、`alert/confirm/prompt` 不使用の方針は維持。
- `<!DOCTYPE html><html lang="ja"><head>...` を**今回は付ける**（通常の静的サイトになるため）。`<meta charset>`, `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` を入れる。`<meta name="claude:viewport-fit-sides">` は削除してよい。

---

## 受け入れ基準
1. `cd /home/claude/yaniv && node --test tests/` 全 pass。既存 27 件 + net.test.js（インメモリトランスポートで）:
   - 部屋作成 → 2 名参加 → ロビー配信の内容（席・名前・接続状態）
   - 満席/ゲーム中の join が reject される
   - start で空席が CPU になり、全員に view が届く。view に他人の hand が含まれず handCount/deckCount がある。discardPile は 1 組のみ
   - 手番でない参加者の move → error、状態不変
   - 不正な move（legalMoves に無い）→ error、状態不変
   - 合法な move → 全員に新 view。
   - seatToken で再接続すると同じ席に戻り、最新 view が届く
   - replaceWithCpu 後、その席の手を CPU が打つ
   - 不明メッセージ/壊れた JSON 相当のオブジェクトを受けても例外で落ちない
   - 人間 2 名 + CPU 1 名で、ゲーム終了までホスト側で自動進行（人間の手は legalMoves[0] を送る）し、例外なく gameOver に到達
2. inline script の構文チェック（SPEC.md 基準 2 と同じコマンド）がエラーなし。`net.js` も `node -e "require('./net.js')"` が通る。
3. `alert(` / `confirm(` / `prompt(` が index.html / net.js に無い。
4. CSS の生の色は :root トークン内のみ（SPEC.md 基準 5 と同じ確認）。
5. index.html が `<!DOCTYPE html>` で始まり、`<script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js">` → `engine.js` → `net.js` → inline script の順で読み込む。
6. README.md に: 遊び方（3 モード）、部屋の仕組みと制約（ホストがタブを閉じると終了、PeerJS 公開サーバー依存）、ローカルでの開き方（`npx serve` 等）を記載。

## 完了報告に含めること
変更ファイル一覧、テスト件数と結果、受け入れ基準 2〜6 の確認結果、engine.js を変更したか、未解決事項・設計で迷った点。実ブラウザでの WebRTC 接続確認はこの環境ではできないので「未実施」と明記し、ユーザーが確認すべき手順を 5 行以内で書く。
