/**
 * WaveformTracker
 * Simple analytics tracking for WaveformPlayer
 *
 * @version 1.0.0
 * @license MIT
 */

class WaveformTracker {
    constructor() {
        this.config = null;
        this.trackers = new Map();
        this.debug = false;
        this.sessionId = null;
    }

    /**
     * Initialize tracker with configuration
     * @param {Object} config - Tracker configuration
     */
    init(config = {}) {
        // Default configuration
        this.config = {
            endpoint: config.endpoint || null,
            handler: config.handler || null,
            events: config.events || {listen: 30},
            headers: config.headers || {},
            metadata: config.metadata || {},
            session: config.session !== false,
            debug: config.debug || false
        };

        this.debug = this.config.debug;
        this.sessionId = this.config.session ? this.generateSessionId() : null;

        // Validate config
        if (!this.config.endpoint && !this.config.handler) {
            this.warn('No endpoint or handler configured; events will not be delivered');
        }

        // Listen for waveform players being ready using event capturing
        document.addEventListener('waveformplayer:ready', (e) => {
            this.log('Player ready event caught:', e.detail.url);
            this.trackPlayer(e.detail.player);
        }, true); // TRUE enables capturing phase

        // Tear down trackers when a player is destroyed. Without this the
        // trackers Map keeps a strong reference to every player (and its DOM)
        // forever, leaking them in SPAs that create/destroy players (v1.8.0+).
        document.addEventListener('waveformplayer:destroy', (e) => {
            this.log('Player destroy event caught:', e.detail?.url);
            if (e.detail?.player) {
                this.untrackPlayer(e.detail.player);
            }
        }, true);

        // Track any existing players that might already be initialized
        this.trackAllPlayers();

        this.log('Tracker initialized', this.config);
    }

    /**
     * Track all existing WaveformPlayer instances
     */
    trackAllPlayers() {
        if (typeof WaveformPlayer !== 'undefined' && WaveformPlayer.getAllInstances) {
            const players = WaveformPlayer.getAllInstances();
            players.forEach(player => this.trackPlayer(player));
        }
    }

    /**
     * Track a specific player instance
     * @param {WaveformPlayer} player - Player instance to track
     */
    trackPlayer(player) {
        // Validate player
        if (!player || !player.container || !player.options) {
            this.warn('Ignoring invalid player instance');
            return;
        }

        // Skip if already tracking
        if (this.trackers.has(player)) {
            return;
        }

        const tracker = {
            player: player,
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
            // Last known position/duration, for the unthrottled checks run on
            // pause and untrack (whose events carry no time).
            lastPosition: null,
            lastDuration: null,
            sentEvents: new Set(),
            isTracking: false,
            lastCheck: null
        };

        this.trackers.set(player, tracker);
        this.log('Tracking player:', player.options.url);

        // Listen to player events on the container element
        const container = player.container;

        // Store event handlers so we can remove them later
        tracker.handlers = {
            play: () => {
                this.syncTrack(tracker);
                tracker.isTracking = true;
                // Reset the media-time baseline; the next timeupdate just
                // records the position without crediting a delta.
                tracker.lastTime = null;
                this.log('Play started:', player.options.url);
            },

            pause: () => {
                if (tracker.isTracking) {
                    this.flush(tracker);
                    tracker.isTracking = false;
                    tracker.lastTime = null;
                    this.log('Paused. Total media time:', tracker.elapsedTime);
                }
            },

            timeupdate: (e) => {
                if (!tracker.isTracking) return;
                this.syncTrack(tracker);

                const {currentTime, duration} = e.detail;

                // Accumulate engagement from media-time deltas (every event,
                // not throttled) so 1.5x/2x playback isn't under-credited.
                // Ignore non-advances (pauses/repeats) and large jumps (seeks).
                if (typeof currentTime === 'number') {
                    if (tracker.lastTime !== null) {
                        const delta = currentTime - tracker.lastTime;
                        if (delta > 0 && delta < WaveformTracker.SEEK_THRESHOLD) {
                            tracker.elapsedTime += delta;
                        }
                    }
                    tracker.lastTime = currentTime;
                    tracker.lastPosition = currentTime;
                    tracker.lastDuration = duration;
                }

                // Throttle the event-firing checks to once per second
                const now = Date.now();
                if (tracker.lastCheck && now - tracker.lastCheck < 1000) return;
                tracker.lastCheck = now;

                this.checkEvents(tracker, currentTime, duration);
            },

            ended: (e) => {
                this.syncTrack(tracker);

                // Read time from the event detail so this works in BOTH self and
                // external audio modes (in external mode player.audio is null).
                // v1.8.0+ dispatches ended with { currentTime, duration } and
                // also fires it in external mode.
                const detail = e.detail || {};
                const duration = typeof detail.duration === 'number' ? detail.duration : 0;
                const currentTime = typeof detail.currentTime === 'number'
                    ? detail.currentTime
                    : duration;

                tracker.isTracking = false;
                tracker.lastTime = null;

                // Unthrottled: thresholds crossed since the last throttled
                // check would otherwise be wiped by the reset below. The
                // position is the end, so complete is checked here too.
                this.checkEvents(tracker, currentTime, duration);

                // Reset for replay
                tracker.sentEvents.clear();
                tracker.elapsedTime = 0;
                tracker.lastPosition = null;
                tracker.lastDuration = null;
                tracker.lastCheck = null;
            }
        };

        // Add event listeners
        container.addEventListener('waveformplayer:play', tracker.handlers.play);
        container.addEventListener('waveformplayer:pause', tracker.handlers.pause);
        container.addEventListener('waveformplayer:timeupdate', tracker.handlers.timeupdate);
        container.addEventListener('waveformplayer:ended', tracker.handlers.ended);
    }

    /**
     * Reset per-track state when the player has moved on to a different URL.
     *
     * Engagement and sent events are per track, but a player instance can
     * outlive many tracks. Without this, a track swapped in mid-play inherited
     * the previous track's elapsed time and never re-sent play/listen/complete.
     * @param {Object} tracker - Tracker state for a player
     */
    syncTrack(tracker) {
        const url = tracker.player.options?.url;
        if (url === tracker.url) return;

        this.log('Track changed:', tracker.url, '->', url);
        tracker.url = url;
        tracker.sentEvents.clear();
        tracker.elapsedTime = 0;
        tracker.lastTime = null;
        tracker.lastPosition = null;
        tracker.lastDuration = null;
        tracker.lastCheck = null;
    }

    /**
     * Fire any play/listen/complete events whose threshold has been reached.
     * @param {Object} tracker - Tracker state for a player
     * @param {number} currentTime - Playhead position (seconds)
     * @param {number} duration - Track duration (seconds)
     */
    checkEvents(tracker, currentTime, duration) {
        const totalElapsed = tracker.elapsedTime;
        const percentComplete = (currentTime / duration) * 100;
        const events = this.config.events;

        // Play event (time-based)
        if (events.play && totalElapsed >= events.play && !tracker.sentEvents.has('play')) {
            this.sendEvent(tracker, 'play', Math.floor(totalElapsed), duration);
            tracker.sentEvents.add('play');
        }

        // Listen event (time-based)
        if (events.listen && totalElapsed >= events.listen && !tracker.sentEvents.has('listen')) {
            this.sendEvent(tracker, 'listen', Math.floor(totalElapsed), duration);
            tracker.sentEvents.add('listen');
        }

        // Complete event (percent-based; needs a known duration)
        if (events.complete && duration > 0 && percentComplete >= events.complete && !tracker.sentEvents.has('complete')) {
            this.sendEvent(tracker, 'complete', Math.floor(currentTime), duration);
            tracker.sentEvents.add('complete');
        }
    }

    /**
     * Run the event checks unthrottled at the last known position, so
     * thresholds crossed inside the 1s throttle window aren't lost when
     * playback stops (pause) or tracking ends (untrack/destroy).
     * @param {Object} tracker - Tracker state for a player
     */
    flush(tracker) {
        if (!tracker.isTracking) return;
        // A track swapped in since the last timeupdate owns nothing yet.
        this.syncTrack(tracker);
        if (tracker.lastDuration === null) return;
        this.checkEvents(tracker, tracker.lastPosition, tracker.lastDuration);
    }

    /**
     * Stop tracking a specific player
     * @param {WaveformPlayer} player - Player instance to stop tracking
     */
    untrackPlayer(player) {
        const tracker = this.trackers.get(player);
        if (!tracker) return;

        // Deliver anything pending before the state is dropped
        this.flush(tracker);

        // Remove event listeners
        const container = player.container;
        if (container && tracker.handlers) {
            container.removeEventListener('waveformplayer:play', tracker.handlers.play);
            container.removeEventListener('waveformplayer:pause', tracker.handlers.pause);
            container.removeEventListener('waveformplayer:timeupdate', tracker.handlers.timeupdate);
            container.removeEventListener('waveformplayer:ended', tracker.handlers.ended);
        }

        // Remove from trackers
        this.trackers.delete(player);
        this.log('Stopped tracking player:', player.options?.url);
    }

    /**
     * Send tracking event
     */
    sendEvent(tracker, eventType, time, duration) {
        // Validate required fields
        if (!tracker.player?.options?.url) {
            this.warn('Missing URL for event; skipping');
            return;
        }

        if (typeof time !== 'number' || typeof duration !== 'number') {
            this.warn('Invalid time or duration for event; skipping');
            return;
        }

        const payload = {
            event: eventType,
            url: tracker.player.options.url,
            time: time,
            duration: Math.floor(duration),
            page: window.location.pathname,
            ...this.config.metadata
        };

        if (this.sessionId) {
            payload.session = this.sessionId;
        }

        // Add title if available
        if (tracker.player.options.title) {
            payload.title = tracker.player.options.title;
        }

        this.log('Sending event:', payload);

        // Use custom handler if provided
        if (this.config.handler) {
            try {
                this.config.handler(payload);
            } catch (error) {
                this.error('Custom handler threw:', error);
            }
            return;
        }

        // Otherwise POST to endpoint. 'complete' and 'listen' are terminal /
        // near-unload events, so deliver them with sendBeacon/keepalive.
        if (this.config.endpoint) {
            const terminal = eventType === 'complete' || eventType === 'listen';
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
        const hasCustomHeaders = this.config.headers
            && Object.keys(this.config.headers).length > 0;

        // sendBeacon cannot set custom headers, so only use it when none are
        // configured; otherwise fall through to fetch (which preserves them).
        if (terminal && !hasCustomHeaders
            && typeof navigator !== 'undefined'
            && typeof navigator.sendBeacon === 'function') {
            try {
                const blob = new Blob([body], {type: 'application/json'});
                if (navigator.sendBeacon(endpoint, blob)) {
                    return;
                }
                this.log('sendBeacon refused payload, falling back to fetch');
            } catch (error) {
                this.log('sendBeacon failed, falling back to fetch:', error);
            }
        }

        fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.config.headers
            },
            body: body,
            keepalive: terminal
        }).catch(error => {
            this.error('Failed to send event:', error);
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
            console.log('[WaveformTracker]', ...args);
        }
    }

    /**
     * Recoverable / configuration warning - always emitted so integration
     * mistakes surface even when debug mode is off.
     */
    warn(...args) {
        console.warn('[WaveformTracker]', ...args);
    }

    /**
     * Genuine failure - always emitted so dropped events and thrown handlers
     * surface even when debug mode is off.
     */
    error(...args) {
        console.error('[WaveformTracker]', ...args);
    }

    /**
     * Reset tracker - removes all tracking
     */
    reset() {
        // Untrack all players
        this.trackers.forEach((tracker, player) => {
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
        this.trackers.forEach((tracker, player) => {
            stats.push({
                url: player.options?.url || 'unknown',
                title: player.options?.title || null,
                elapsedTime: tracker.elapsedTime,
                isTracking: tracker.isTracking,
                sentEvents: Array.from(tracker.sentEvents)
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
}

// Maximum forward currentTime jump (seconds) still treated as normal playback
// when accumulating media-time engagement. Larger jumps are treated as seeks
// and not credited.
WaveformTracker.SEEK_THRESHOLD = 5;

// Create singleton instance
const tracker = new WaveformTracker();

// Export for browser
if (typeof window !== 'undefined') {
    window.WaveformTracker = tracker;
}

// ES6 export
export default tracker;