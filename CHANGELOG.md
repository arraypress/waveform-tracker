# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.0.2] — 2026-09-24

### Fixed

- **Per-track state resets when the player's URL changes.** A player outlives
  many tracks, and `load()`/`loadTrack()` swap the URL mid-play without an
  `ended` in between, so the new track inherited the previous one's elapsed
  time (firing `listen` early) and its sent events (never firing `play` or
  `listen` at all). Direct `load(url)` swaps also need
  `@arraypress/waveform-player` 1.27.1, where `load()` records the new URL.
- **Destroyed players are released.** The tracker listens for
  `waveformplayer:destroy` and untracks the player, so SPAs that create and
  destroy players no longer leak them.
- **`complete` on `ended` works in external audio mode**, reading the final
  time from the event detail instead of `player.audio`.

### Changed

- **Engagement is counted in media time**, from `currentTime` deltas, so
  1.5x/2x playback is credited for the content actually heard. Forward jumps
  over 5s are treated as seeks and not credited.
- **`listen` and `complete` are delivered with `sendBeacon`** (falling back to
  `fetch` with `keepalive`) so they survive page navigation.
- **Configuration problems and delivery failures always log**, via
  `console.warn`/`console.error` with a `[WaveformTracker]` prefix; tracing
  stays behind `debug`.
- Peer dependency raised to `@arraypress/waveform-player` `^1.8.0`.

## [1.0.1] — 2026-06-27

### Changed

- Peer dependency raised to `@arraypress/waveform-player` `^1.7.2`. No source
  changes.

## [1.0.0] — 2025-09-16

- Initial release: `play`, `listen` and `complete` events for every
  WaveformPlayer on the page, delivered to an endpoint or a custom handler.
