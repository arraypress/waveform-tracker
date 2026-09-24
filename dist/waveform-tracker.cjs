var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.js
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var WaveformTracker = class _WaveformTracker {
  constructor() {
    this.config = null;
    this.trackers = /* @__PURE__ */ new Map();
    this.debug = false;
    this.sessionId = null;
    this.listeners = null;
  }
  /**
   * Initialize tracker with configuration. Calling it again reconfigures
   * the tracker (players already tracked keep their state) rather than
   * adding a second set of listeners.
   * @param {Object} config - Tracker configuration
   */
  init(config = {}) {
    this.config = {
      endpoint: config.endpoint || null,
      handler: config.handler || null,
      events: config.events || { listen: 30 },
      headers: config.headers || {},
      metadata: config.metadata || {},
      session: config.session !== false,
      debug: config.debug || false
    };
    this.debug = this.config.debug;
    this.sessionId = this.config.session ? this.sessionId || this.generateSessionId() : null;
    if (!this.config.endpoint && !this.config.handler) {
      this.warn("No endpoint or handler configured; events will not be delivered");
    }
    if (!this.listeners) {
      this.listeners = {
        // Listen for waveform players being ready
        ready: (e) => {
          this.log("Player ready event caught:", e.detail.url);
          this.trackPlayer(e.detail.player);
        },
        // Tear down trackers when a player is destroyed. Without this
        // the trackers Map keeps a strong reference to every player
        // (and its DOM) forever, leaking them in SPAs that
        // create/destroy players (v1.8.0+).
        destroy: (e) => {
          this.log("Player destroy event caught:", e.detail?.url);
          if (e.detail?.player) {
            this.untrackPlayer(e.detail.player);
          }
        }
      };
      document.addEventListener("waveformplayer:ready", this.listeners.ready, true);
      document.addEventListener("waveformplayer:destroy", this.listeners.destroy, true);
    }
    this.trackAllPlayers();
    this.log("Tracker initialized", this.config);
  }
  /**
   * Track all existing WaveformPlayer instances
   */
  trackAllPlayers() {
    if (typeof WaveformPlayer !== "undefined" && WaveformPlayer.getAllInstances) {
      const players = WaveformPlayer.getAllInstances();
      players.forEach((player) => this.trackPlayer(player));
    }
  }
  /**
   * Track a specific player instance
   * @param {WaveformPlayer} player - Player instance to track
   */
  trackPlayer(player) {
    if (!this.config) {
      this.warn("Call init() before tracking players");
      return;
    }
    if (!player || !player.container || !player.options) {
      this.warn("Ignoring invalid player instance");
      return;
    }
    if (this.trackers.has(player)) {
      return;
    }
    const tracker2 = {
      player,
      // The URL this state belongs to. load()/loadTrack() swap tracks on
      // the same player without firing `ended`, so syncTrack() compares
      // against it and resets the per-track state on a change.
      url: player.options.url,
      // Engagement is accumulated from media-time (currentTime) deltas
      // rather than wall-clock, so faster playback (1.5x/2x) is credited
      // for the content actually consumed. lastTime is the previous
      // currentTime seen while tracking; null resets the delta baseline.
      lastTime: null,
      // Date.now() when lastTime was recorded, so a forward jump can be
      // compared against the real time that passed (see accumulate()).
      lastWall: null,
      elapsedTime: 0,
      // Last known position/duration, for the unthrottled checks run on
      // pause and untrack (whose events carry no time).
      lastPosition: null,
      lastDuration: null,
      sentEvents: /* @__PURE__ */ new Set(),
      isTracking: false,
      lastCheck: null
    };
    this.trackers.set(player, tracker2);
    this.log("Tracking player:", player.options.url);
    const container = player.container;
    tracker2.handlers = {
      play: () => {
        this.syncTrack(tracker2);
        tracker2.isTracking = true;
        tracker2.lastTime = null;
        this.log("Play started:", player.options.url);
      },
      pause: () => {
        if (tracker2.isTracking) {
          this.flush(tracker2);
          tracker2.isTracking = false;
          tracker2.lastTime = null;
          this.log("Paused. Total media time:", tracker2.elapsedTime);
        }
      },
      timeupdate: (e) => {
        if (!tracker2.isTracking || !this.config) return;
        this.syncTrack(tracker2);
        const { currentTime, duration } = e.detail;
        if (typeof currentTime === "number") {
          this.accumulate(tracker2, currentTime);
          tracker2.lastPosition = currentTime;
          tracker2.lastDuration = duration;
        }
        const now = Date.now();
        if (tracker2.lastCheck && now - tracker2.lastCheck < 1e3) return;
        tracker2.lastCheck = now;
        this.checkEvents(tracker2, currentTime, duration);
      },
      ended: (e) => {
        if (!this.config) return;
        this.syncTrack(tracker2);
        const detail = e.detail || {};
        const duration = typeof detail.duration === "number" ? detail.duration : 0;
        const currentTime = typeof detail.currentTime === "number" ? detail.currentTime : duration;
        if (tracker2.isTracking) {
          this.accumulate(tracker2, currentTime);
        }
        tracker2.isTracking = false;
        tracker2.lastTime = null;
        this.checkEvents(tracker2, currentTime, duration);
        tracker2.sentEvents.clear();
        tracker2.elapsedTime = 0;
        tracker2.lastPosition = null;
        tracker2.lastDuration = null;
        tracker2.lastCheck = null;
      }
    };
    container.addEventListener("waveformplayer:play", tracker2.handlers.play);
    container.addEventListener("waveformplayer:pause", tracker2.handlers.pause);
    container.addEventListener("waveformplayer:timeupdate", tracker2.handlers.timeupdate);
    container.addEventListener("waveformplayer:ended", tracker2.handlers.ended);
  }
  /**
   * Reset per-track state when the player has moved on to a different URL.
   *
   * Engagement and sent events are per track, but a player instance can
   * outlive many tracks. Without this, a track swapped in mid-play inherited
   * the previous track's elapsed time and never re-sent play/listen/complete.
   * @param {Object} tracker - Tracker state for a player
   */
  syncTrack(tracker2) {
    const url = tracker2.player.options?.url;
    if (url === tracker2.url) return;
    this.log("Track changed:", tracker2.url, "->", url);
    tracker2.url = url;
    tracker2.sentEvents.clear();
    tracker2.elapsedTime = 0;
    tracker2.lastTime = null;
    tracker2.lastPosition = null;
    tracker2.lastDuration = null;
    tracker2.lastCheck = null;
  }
  /**
   * Credit the media time played since the previous position.
   *
   * Non-advances (pauses/repeats) are ignored. Small forward deltas are
   * normal playback. A larger jump is only playback if it fits the wall-clock
   * time that passed: background tabs throttle the player's timeupdates, so
   * minutes of real listening can arrive as one jump. Anything clearly
   * beyond elapsed real time is a seek and isn't credited.
   * @param {Object} tracker - Tracker state for a player
   * @param {number} currentTime - Playhead position (seconds)
   */
  accumulate(tracker2, currentTime) {
    const now = Date.now();
    if (tracker2.lastTime !== null) {
      const delta = currentTime - tracker2.lastTime;
      if (delta > 0 && (delta < _WaveformTracker.SEEK_THRESHOLD || delta <= this.playableSince(tracker2, now))) {
        tracker2.elapsedTime += delta;
      }
    }
    tracker2.lastTime = currentTime;
    tracker2.lastWall = now;
  }
  /**
   * Most media time (seconds) that could have played since lastWall: the
   * wall time at the current rate, with 50% headroom for timer jitter plus
   * SEEK_SLACK. External mode has no audio element, so assumes 1x.
   * @param {Object} tracker - Tracker state for a player
   * @param {number} now - Current Date.now()
   */
  playableSince(tracker2, now) {
    const wall = (now - tracker2.lastWall) / 1e3;
    const rate = tracker2.player.audio?.playbackRate ?? 1;
    return wall * rate * 1.5 + _WaveformTracker.SEEK_SLACK;
  }
  /**
   * Fire any play/listen/complete events whose threshold has been reached.
   * @param {Object} tracker - Tracker state for a player
   * @param {number} currentTime - Playhead position (seconds)
   * @param {number} duration - Track duration (seconds)
   */
  checkEvents(tracker2, currentTime, duration) {
    if (!this.config) return;
    const totalElapsed = tracker2.elapsedTime;
    const percentComplete = currentTime / duration * 100;
    const play = this.threshold(this.config.events.play);
    const listen = this.threshold(this.config.events.listen);
    const complete = this.threshold(this.config.events.complete);
    if (play !== null && totalElapsed >= play && !tracker2.sentEvents.has("play")) {
      this.sendEvent(tracker2, "play", Math.floor(totalElapsed), duration);
      tracker2.sentEvents.add("play");
    }
    if (listen !== null && totalElapsed >= listen && !tracker2.sentEvents.has("listen")) {
      this.sendEvent(tracker2, "listen", Math.floor(totalElapsed), duration);
      tracker2.sentEvents.add("listen");
    }
    if (complete !== null && Number.isFinite(duration) && duration > 0 && percentComplete >= complete && totalElapsed >= duration * (complete / 100) * _WaveformTracker.COMPLETE_ENGAGEMENT && !tracker2.sentEvents.has("complete")) {
      this.sendEvent(tracker2, "complete", Math.floor(currentTime), duration);
      tracker2.sentEvents.add("complete");
    }
  }
  /**
   * Normalise an events threshold. A missing key, null or false disables
   * the event; 0 is a real threshold (fire on the first check after play).
   * Numeric strings are accepted, as the old truthy check did.
   * @param {*} value - Configured threshold
   * @returns {number|null} The threshold, or null when disabled
   */
  threshold(value) {
    if (value == null || value === false || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  /**
   * Run the event checks unthrottled at the last known position, so
   * thresholds crossed inside the 1s throttle window aren't lost when
   * playback stops (pause) or tracking ends (untrack/destroy).
   * @param {Object} tracker - Tracker state for a player
   */
  flush(tracker2) {
    if (!tracker2.isTracking) return;
    this.syncTrack(tracker2);
    if (tracker2.lastDuration === null) return;
    this.checkEvents(tracker2, tracker2.lastPosition, tracker2.lastDuration);
  }
  /**
   * Stop tracking a specific player
   * @param {WaveformPlayer} player - Player instance to stop tracking
   */
  untrackPlayer(player) {
    const tracker2 = this.trackers.get(player);
    if (!tracker2) return;
    this.flush(tracker2);
    const container = player.container;
    if (container && tracker2.handlers) {
      container.removeEventListener("waveformplayer:play", tracker2.handlers.play);
      container.removeEventListener("waveformplayer:pause", tracker2.handlers.pause);
      container.removeEventListener("waveformplayer:timeupdate", tracker2.handlers.timeupdate);
      container.removeEventListener("waveformplayer:ended", tracker2.handlers.ended);
    }
    this.trackers.delete(player);
    this.log("Stopped tracking player:", player.options?.url);
  }
  /**
   * Send tracking event
   */
  sendEvent(tracker2, eventType, time, duration) {
    if (!tracker2.player?.options?.url) {
      this.warn("Missing URL for event; skipping");
      return;
    }
    if (typeof time !== "number" || typeof duration !== "number") {
      this.warn("Invalid time or duration for event; skipping");
      return;
    }
    const payload = {
      event: eventType,
      url: tracker2.player.options.url,
      time,
      // Live streams report Infinity (NaN before metadata), which JSON
      // serialises as null; send 0 for "unknown" so it stays a number.
      duration: Number.isFinite(duration) ? Math.floor(duration) : 0,
      page: window.location.pathname,
      ...this.config.metadata
    };
    if (this.sessionId) {
      payload.session = this.sessionId;
    }
    if (tracker2.player.options.title) {
      payload.title = tracker2.player.options.title;
    }
    this.log("Sending event:", payload);
    if (this.config.handler) {
      try {
        this.config.handler(payload);
      } catch (error) {
        this.error("Custom handler threw:", error);
      }
      return;
    }
    if (this.config.endpoint) {
      const terminal = eventType === "complete" || eventType === "listen";
      this.send(this.config.endpoint, payload, terminal);
    }
  }
  /**
   * Deliver a payload to the configured endpoint.
   *
   * Terminal events (complete, listen) often fire as the page is navigating
   * away, where a normal fetch would be cancelled, so they are sent with
   * fetch keepalive, which survives unload. The body is always JSON with
   * Content-Type: application/json; the endpoint and payload shape are
   * unchanged.
   *
   * sendBeacon is used only for a same-origin endpoint (or when fetch is
   * missing). Cross-origin, a beacon's JSON content type isn't
   * CORS-safelisted and beacons always send credentials, so an endpoint
   * answering Access-Control-Allow-Origin: * never receives the event —
   * yet sendBeacon still returns true, leaving no chance to fall back.
   * fetch uses credentials only same-origin, so a wildcard endpoint that
   * answers the preflight for Content-Type works.
   *
   * @param {string} endpoint - Destination URL
   * @param {Object} payload - Event payload
   * @param {boolean} terminal - Whether this is a terminal/near-unload event
   */
  send(endpoint, payload, terminal = false) {
    const body = JSON.stringify(payload);
    const hasFetch = typeof fetch === "function";
    if (terminal && this.canBeacon(endpoint, hasFetch)) {
      try {
        const blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(endpoint, blob)) {
          return;
        }
        this.log("sendBeacon refused payload, falling back to fetch");
      } catch (error) {
        this.log("sendBeacon failed, falling back to fetch:", error);
      }
    }
    if (!hasFetch) {
      this.error("fetch is unavailable; event not delivered");
      return;
    }
    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.config.headers
      },
      body,
      keepalive: terminal
    }).catch((error) => {
      this.error("Failed to send event:", error);
    });
  }
  /**
   * Whether a terminal event may go by sendBeacon: the API exists, no
   * custom headers are configured (a beacon can't set them), and the
   * endpoint is same-origin or fetch is unavailable (see send()).
   * @param {string} endpoint - Destination URL
   * @param {boolean} hasFetch - Whether fetch is available
   */
  canBeacon(endpoint, hasFetch) {
    const hasCustomHeaders = this.config.headers && Object.keys(this.config.headers).length > 0;
    if (hasCustomHeaders || typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
      return false;
    }
    return !hasFetch || this.isSameOrigin(endpoint);
  }
  /**
   * Whether an endpoint (absolute or relative) is on the page's origin.
   * @param {string} endpoint - Destination URL
   */
  isSameOrigin(endpoint) {
    try {
      return new URL(endpoint, window.location.href).origin === window.location.origin;
    } catch (error) {
      return false;
    }
  }
  /**
   * Generate session ID
   */
  generateSessionId() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }
  /**
   * Debug logging - only emitted when debug mode is enabled.
   */
  log(...args) {
    if (this.debug) {
      console.log("[WaveformTracker]", ...args);
    }
  }
  /**
   * Recoverable / configuration warning - always emitted so integration
   * mistakes surface even when debug mode is off.
   */
  warn(...args) {
    console.warn("[WaveformTracker]", ...args);
  }
  /**
   * Genuine failure - always emitted so dropped events and thrown handlers
   * surface even when debug mode is off.
   */
  error(...args) {
    console.error("[WaveformTracker]", ...args);
  }
  /**
   * Reset tracker - removes all tracking, including the document
   * listeners, so players created afterwards are ignored until init()
   */
  reset() {
    this.trackers.forEach((tracker2, player) => {
      this.untrackPlayer(player);
    });
    if (this.listeners) {
      document.removeEventListener("waveformplayer:ready", this.listeners.ready, true);
      document.removeEventListener("waveformplayer:destroy", this.listeners.destroy, true);
      this.listeners = null;
    }
    this.trackers.clear();
    this.config = null;
    this.sessionId = null;
  }
  /**
   * Get tracking stats
   */
  getStats() {
    const stats = [];
    this.trackers.forEach((tracker2, player) => {
      stats.push({
        url: player.options?.url || "unknown",
        title: player.options?.title || null,
        elapsedTime: tracker2.elapsedTime,
        isTracking: tracker2.isTracking,
        sentEvents: Array.from(tracker2.sentEvents)
      });
    });
    return stats;
  }
  /**
   * Get number of tracked players
   */
  getTrackedCount() {
    return this.trackers.size;
  }
};
WaveformTracker.SEEK_THRESHOLD = 5;
WaveformTracker.SEEK_SLACK = 1;
WaveformTracker.COMPLETE_ENGAGEMENT = 0.5;
var tracker = new WaveformTracker();
if (typeof window !== "undefined") {
  window.WaveformTracker = tracker;
}
var index_default = tracker;
/**
 * WaveformTracker
 * Simple analytics tracking for WaveformPlayer
 *
 * @license MIT
 */
