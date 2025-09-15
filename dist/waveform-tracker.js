(() => {
  // src/index.js
  var WaveformTracker = class {
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
        session: config.session === false ? false : true,
        debug: config.debug || false
      };
      this.debug = this.config.debug;
      this.sessionId = this.config.session ? this.generateSessionId() : null;
      if (!this.config.endpoint && !this.config.handler) {
        this.log("Warning: No endpoint or handler configured");
      }
      document.addEventListener("waveformplayer:ready", (e) => {
        this.log("Player ready event caught:", e.detail.url);
        this.trackPlayer(e.detail.player);
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
        this.log("Invalid player instance");
        return;
      }
      if (this.trackers.has(player)) {
        return;
      }
      const tracker2 = {
        player,
        startTime: null,
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
          tracker2.isTracking = true;
          tracker2.startTime = Date.now();
          this.log("Play started:", player.options.url);
        },
        pause: () => {
          if (tracker2.isTracking && tracker2.startTime) {
            const sessionTime = (Date.now() - tracker2.startTime) / 1e3;
            tracker2.elapsedTime += sessionTime;
            tracker2.startTime = null;
            tracker2.isTracking = false;
            this.log("Paused. Session time:", sessionTime, "Total:", tracker2.elapsedTime);
          }
        },
        timeupdate: (e) => {
          if (!tracker2.isTracking) return;
          const now = Date.now();
          if (tracker2.lastCheck && now - tracker2.lastCheck < 1e3) return;
          tracker2.lastCheck = now;
          const { currentTime, duration } = e.detail;
          const sessionTime = tracker2.startTime ? (now - tracker2.startTime) / 1e3 : 0;
          const totalElapsed = tracker2.elapsedTime + sessionTime;
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
        ended: () => {
          if (tracker2.isTracking && tracker2.startTime) {
            const sessionTime = (Date.now() - tracker2.startTime) / 1e3;
            tracker2.elapsedTime += sessionTime;
            tracker2.startTime = null;
            tracker2.isTracking = false;
          }
          const events = this.config.events;
          if (events.complete && !tracker2.sentEvents.has("complete")) {
            const duration = player.audio ? player.audio.duration : 0;
            if (duration > 0) {
              this.sendEvent(tracker2, "complete", Math.floor(duration), duration);
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
        this.log("Warning: Missing URL for event");
        return;
      }
      if (typeof time !== "number" || typeof duration !== "number") {
        this.log("Warning: Invalid time or duration for event");
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
          this.log("Error in custom handler:", error);
        }
        return;
      }
      if (this.config.endpoint) {
        fetch(this.config.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.config.headers
          },
          body: JSON.stringify(payload)
        }).catch((error) => {
          this.log("Error sending event:", error);
        });
      }
    }
    /**
     * Generate session ID
     */
    generateSessionId() {
      return Math.random().toString(36).substring(2) + Date.now().toString(36);
    }
    /**
     * Debug logging
     */
    log(...args) {
      if (this.debug) {
        console.log("[WaveformTracker]", ...args);
      }
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
