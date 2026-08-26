# TriTetris

Competitive real-time **3-player** Tetris over WebSockets. Three players battle on separate boards; clearing lines sends garbage to a random living opponent; last player standing wins. Server-authoritative, with client-side prediction for zero-latency controls.

**▶ Play it live:** https://tritetris-jwsst6awpa-ew.a.run.app (create a lobby, share the code — or add bots and play solo)

## Quick start

```bash
npm install
npm run build     # build the client bundle
npm start         # serve client + WebSocket server on http://localhost:8177
```

Open http://localhost:8177 in three browser windows (or one window plus bots), create a lobby, share the 6-character code, ready up.

### Development

```bash
npm run dev:server    # server with hot reload (tsx watch) on :8177
npm run dev:client    # Vite dev server on :5173 (proxies /ws to :8177)
```

### Tests

```bash
npm run test:engine   # 35 deterministic-engine unit tests (SRS, T-spins, attack tables, garbage fold)
npm run test:e2e      # 60+ assertions: full protocol via 3 headless WS clients + bot scenario
npm run typecheck
```

## Features

- **Lobby flow**: create/join by 6-char code, exactly 3 slots, ready-check, synchronized 3-second countdown, host star, latency display, copy-code button.
- **Bots** 🤖: the host can fill empty slots with bots in three tiers — **Easy** (slow, sloppy placements), **Medium** (solid greedy stacking), **Hard** (fast, near-optimal, uses hold). Bots are always ready and auto-accept rematches.
- **Match rules**: the host can toggle **hard drop off** in the lobby. The rule is enforced server-side (HARD_DROP inputs are rejected), the client's Space key goes inert with a "HARD DROP OFF" HUD indicator, and bots adapt by soft-dropping to the floor and waiting out the lock delay. Rules persist across rematches.
- **Guideline Tetris**: SRS rotation with wall kicks, 7-bag randomizer (same piece sequence for all players), hold, 5-piece preview, ghost piece, lock delay (500 ms, 15 move-resets), DAS/ARR handling, soft/hard drop, gravity speed-up every 30 s.
- **Attack system** (competitive mode): singles/doubles/triples/tetris → 1/2/3/4, T-spin mini/single/double/triple → 1/2/4/6, back-to-back +1, combo table, perfect clear +10. Garbage targets a random living opponent, arrives after 700 ms, and **cancels** against pending incoming garbage first.
- **Elimination & spectating**: top-out (blocked spawn) eliminates; eliminated players spectate; pending attacks aimed at a dead player are cancelled, not redirected.
- **Results & rematch**: podium, full per-player statistics (PPS, garbage sent/received/blocked, T-spins, combos, survival time…), 3-vote rematch that reuses the lobby with a fresh seed.
- **Reconnect tolerance**: 10 s grace on disconnect (board frozen, still targetable), session-token reconnect with full state restoration — surviving even a page reload mid-match.
- **Anti-cheat**: the server never trusts the client for board state, clears, attacks, or eliminations. Inputs are validated (monotonic sequence, plausible tick window, action whitelist, 120 msg/s token bucket) and replayed through the server's own engine.

## Architecture

```
src/shared/    deterministic game engine + protocol types (runs on BOTH sides)
src/server/    authoritative Node server: lobbies, matches, bots, validation
src/client/    React + canvas client: prediction, rendering, input, netcode
scripts/       engine unit tests and end-to-end protocol tests
```

### Synchronization model

Each player's board is a **pure function** of `(seed, their inputs at ticks, announced garbage)`. The client simulates instantly (prediction); the server runs the *same engine* on a ~400 ms jitter buffer, applying each input at its exact claimed tick — so both simulations are bit-identical, verified by **board hashes at every piece lock**. On mismatch (heavy lag, tampering) the client requests a `state_correction` snapshot and snaps.

Garbage stays deterministic through an **event-sourced cancellation fold**: attacks (with server-chosen hole columns) are announced ≥700 ms before insertion, cancellation is a pure function of `(announced attacks, own clear events)` ordered by tick, and garbage physically enters at the first non-clearing piece lock after arrival. Announcement/clear races converge on both sides before any insertion executes.

Time base: clients sync clocks via ping (min-RTT offset sampling); inputs are stamped with match ticks (60 Hz) relative to the server's `start_at`. Disconnected players accumulate "tick lag" so a reconnecting client resumes its own frozen timeline.

### Protocol

JSON envelopes `{type, message_id, timestamp, payload}` over a single WebSocket (`/ws`), messages per the spec: `create_lobby`, `join_lobby`, `set_ready`, `player_input`, `match_countdown`, `match_start`, `player_state` (10 Hz snapshots), `attack_created`, `garbage_cancelled`, `garbage_applied`, `player_eliminated`, `match_end`, `state_correction`, plus `add_bot` / `remove_bot`.

## Controls

| Key | Action |
|---|---|
| ← → | move (DAS 133 ms / ARR 33 ms) |
| ↓ | soft drop |
| Space | hard drop |
| ↑ / X | rotate CW |
| Z / Ctrl | rotate CCW |
| C / Shift | hold |

## Deploying (Cloud Run)

The included `Dockerfile` builds the client and runs the server on `$PORT`. Deploy with:

```bash
gcloud run deploy tritetris --source . --region europe-west1 \
  --allow-unauthenticated --max-instances 1 --min-instances 0 \
  --timeout 3600 --session-affinity --memory 512Mi
```

Notes:
- `--max-instances 1` is required — lobbies and matches are in-memory, so all traffic must hit one instance.
- `--timeout 3600` keeps WebSockets alive up to an hour; when Cloud Run recycles a socket, the client's automatic reconnect restores the match.
- Google Frontend swallows `/healthz` on `run.app` domains; use `/api/health` instead.
- Scale-to-zero means an idle service cold-starts in a few seconds on the first visit; active matches keep the instance warm.

## Design decisions (where the spec left room)

- `ws` over uWebSockets.js for portability (single process, in-memory lobbies — per MVP scope).
- Garbage inserts on the next **non-clearing lock** after its arrival delay (standard competitive behavior) rather than mid-fall.
- Each garbage line gets an independent random hole column (server-generated, broadcast so clients can predict insertion).
- T-spin detection: 3-corner rule with front-corner full/mini distinction and the SRS kick-5 upgrade.
- Scoring is display-only (guideline-ish table); attack lines are the competitive currency.
- Ties on simultaneous top-outs resolve by server event order; if all players die, the last eliminated wins.
