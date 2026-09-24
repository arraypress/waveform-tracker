(() => {
  // src/index.js
  var WaveformTracker = class _WaveformTracker {
    constructor() {
      this.config = null;
      this.trackers = /* @__PURE__ */ new Map();
      this.debug = false;
      this.sessionId = null;
    }
    /**
     * Initialize tracker with configuration
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
      this.sessionId = this.config.session ? this.generateSessionId() : null;
      if (!this.config.endpoint && !this.config.handler) {
        this.warn("No endpoint or handler configured; events will not be delivered");
      }
      document.addEventListener("waveformplayer:ready", (e) => {
        this.log("Player ready event caught:", e.detail.url);
        this.trackPlayer(e.detail.player);
      }, true);
      document.addEventListener("waveformplayer:destroy", (e) => {
        this.log("Player destroy event caught:", e.detail?.url);
        if (e.detail?.player) {
          this.untrackPlayer(e.detail.player);
        }
      }, true);
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
        elapsedTime: 0,
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
            tracker2.isTracking = false;
            tracker2.lastTime = null;
            this.log("Paused. Total media time:", tracker2.elapsedTime);
          }
        },
        timeupdate: (e) => {
          if (!tracker2.isTracking) return;
          this.syncTrack(tracker2);
          const { currentTime, duration } = e.detail;
          if (typeof currentTime === "number") {
            if (tracker2.lastTime !== null) {
              const delta = currentTime - tracker2.lastTime;
              if (delta > 0 && delta < _WaveformTracker.SEEK_THRESHOLD) {
                tracker2.elapsedTime += delta;
              }
            }
            tracker2.lastTime = currentTime;
          }
          const now = Date.now();
          if (tracker2.lastCheck && now - tracker2.lastCheck < 1e3) return;
          tracker2.lastCheck = now;
          const totalElapsed = tracker2.elapsedTime;
          const percentComplete = currentTime / duration * 100;
          const events = this.config.events;
          if (events.play && totalElapsed >= events.play && !tracker2.sentEvents.has("play")) {
            this.sendEvent(tracker2, "play", Math.floor(totalElapsed), duration);
            tracker2.sentEvents.add("play");
          }
          if (events.listen && totalElapsed >= events.listen && !tracker2.sentEvents.has("listen")) {
            this.sendEvent(tracker2, "listen", Math.floor(totalElapsed), duration);
            tracker2.sentEvents.add("listen");
          }
          if (events.complete && percentComplete >= events.complete && !tracker2.sentEvents.has("complete")) {
            this.sendEvent(tracker2, "complete", Math.floor(currentTime), duration);
            tracker2.sentEvents.add("complete");
          }
        },
        ended: (e) => {
          const detail = e.detail || {};
          const duration = typeof detail.duration === "number" ? detail.duration : 0;
          const currentTime = typeof detail.currentTime === "number" ? detail.currentTime : duration;
          tracker2.isTracking = false;
          tracker2.lastTime = null;
          const events = this.config.events;
          if (events.complete && !tracker2.sentEvents.has("complete")) {
            if (duration > 0) {
              this.sendEvent(tracker2, "complete", Math.floor(currentTime), duration);
              tracker2.sentEvents.add("complete");
            }
          }
          tracker2.sentEvents.clear();
          tracker2.elapsedTime = 0;
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
      tracker2.lastCheck = null;
    }
    /**
     * Stop tracking a specific player
     * @param {WaveformPlayer} player - Player instance to stop tracking
     */
    untrackPlayer(player) {
      const tracker2 = this.trackers.get(player);
      if (!tracker2) return;
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
        duration: Math.floor(duration),
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
     * away, where a normal fetch would be cancelled. For those we prefer
     * navigator.sendBeacon and fall back to fetch with keepalive so the
     * request survives unload. The endpoint and payload shape are unchanged.
     *
     * @param {string} endpoint - Destination URL
     * @param {Object} payload - Event payload
     * @param {boolean} terminal - Whether this is a terminal/near-unload event
     */
    send(endpoint, payload, terminal = false) {
      const body = JSON.stringify(payload);
      const hasCustomHeaders = this.config.headers && Object.keys(this.config.headers).length > 0;
      if (terminal && !hasCustomHeaders && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
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
     * Reset tracker - removes all tracking
     */
    reset() {
      this.trackers.forEach((tracker2, player) => {
        this.untrackPlayer(player);
      });
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
  var tracker = new WaveformTracker();
  if (typeof window !== "undefined") {
    window.WaveformTracker = tracker;
  }
  var index_default = tracker;
})();
/**
 * WaveformTracker
 * Simple analytics tracking for WaveformPlayer
 *
 * @version 1.0.0
 * @license MIT
 */
