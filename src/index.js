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
        // document-level ready/destroy listeners, added once by init() and
        // removed by reset()
        this.listeners = null;
    }

    /**
     * Initialize tracker with configuration. Calling it again reconfigures
     * the tracker (players already tracked keep their state) rather than
     * adding a second set of listeners.
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
        // A reconfigure is still the same page session, so keep its id
        this.sessionId = this.config.session
            ? (this.sessionId || this.generateSessionId())
            : null;

        // Validate config
        if (!this.config.endpoint && !this.config.handler) {
            this.warn('No endpoint or handler configured; events will not be delivered');
        }

        if (!this.listeners) {
            this.listeners = {
                // Listen for waveform players being ready
                ready: (e) => {
                    this.log('Player ready event caught:', e.detail.url);
                    this.trackPlayer(e.detail.player);
                },

                // Tear down trackers when a player is destroyed. Without this
                // the trackers Map keeps a strong reference to every player
                // (and its DOM) forever, leaking them in SPAs that
                // create/destroy players (v1.8.0+).
                destroy: (e) => {
                    this.log('Player destroy event caught:', e.detail?.url);
                    if (e.detail?.player) {
                        this.untrackPlayer(e.detail.player);
                    }
                }
            };

            // TRUE enables capturing phase
            document.addEventListener('waveformplayer:ready', this.listeners.ready, true);
            document.addEventListener('waveformplayer:destroy', this.listeners.destroy, true);
        }

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
        // Nothing to report to before init() or after reset()
        if (!this.config) {
            this.warn('Call init() before tracking players');
            return;
        }

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
            // Date.now() when lastTime was recorded, so a forward jump can be
            // compared against the real time that passed (see accumulate()).
            lastWall: null,
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
                if (!tracker.isTracking || !this.config) return;
                this.syncTrack(tracker);

                const {currentTime, duration} = e.detail;

                // Accumulate engagement from media-time deltas (every event,
                // not throttled) so 1.5x/2x playback isn't under-credited.
                if (typeof currentTime === 'number') {
                    this.accumulate(tracker, currentTime);
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
                if (!this.config) return;
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

                // Credit the stretch since the last timeupdate: in a hidden
                // tab updates can stall long before the track ends.
                if (tracker.isTracking) {
                    this.accumulate(tracker, currentTime);
                }

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
    accumulate(tracker, currentTime) {
        const now = Date.now();
        if (tracker.lastTime !== null) {
            const delta = currentTime - tracker.lastTime;
            if (delta > 0 && (delta < WaveformTracker.SEEK_THRESHOLD
                || delta <= this.playableSince(tracker, now))) {
                tracker.elapsedTime += delta;
            }
        }
        tracker.lastTime = currentTime;
        tracker.lastWall = now;
    }

    /**
     * Most media time (seconds) that could have played since lastWall: the
     * wall time at the current rate, with 50% headroom for timer jitter plus
     * SEEK_SLACK. External mode has no audio element, so assumes 1x.
     * @param {Object} tracker - Tracker state for a player
     * @param {number} now - Current Date.now()
     */
    playableSince(tracker, now) {
        const wall = (now - tracker.lastWall) / 1000;
        const rate = tracker.player.audio?.playbackRate ?? 1;
        return wall * rate * 1.5 + WaveformTracker.SEEK_SLACK;
    }

    /**
     * Fire any play/listen/complete events whose threshold has been reached.
     * @param {Object} tracker - Tracker state for a player
     * @param {number} currentTime - Playhead position (seconds)
     * @param {number} duration - Track duration (seconds)
     */
    checkEvents(tracker, currentTime, duration) {
        if (!this.config) return;

        const totalElapsed = tracker.elapsedTime;
        const percentComplete = (currentTime / duration) * 100;
        const play = this.threshold(this.config.events.play);
        const listen = this.threshold(this.config.events.listen);
        const complete = this.threshold(this.config.events.complete);

        // Play event (time-based)
        if (play !== null && totalElapsed >= play && !tracker.sentEvents.has('play')) {
            this.sendEvent(tracker, 'play', Math.floor(totalElapsed), duration);
            tracker.sentEvents.add('play');
        }

        // Listen event (time-based)
        if (listen !== null && totalElapsed >= listen && !tracker.sentEvents.has('listen')) {
            this.sendEvent(tracker, 'listen', Math.floor(totalElapsed), duration);
            tracker.sentEvents.add('listen');
        }

        // Complete event (percent-based; needs a finite, known duration, so
        // never for live streams whose duration is Infinity). Position
        // alone would let a scrub to the end count, so the listener must also
        // have heard COMPLETE_ENGAGEMENT of the audio up to the threshold:
        // at complete: 90 on a 100s track, 45s of media time.
        if (complete !== null && Number.isFinite(duration) && duration > 0 && percentComplete >= complete
            && totalElapsed >= duration * (complete / 100) * WaveformTracker.COMPLETE_ENGAGEMENT
            && !tracker.sentEvents.has('complete')) {
            this.sendEvent(tracker, 'complete', Math.floor(currentTime), duration);
            tracker.sentEvents.add('complete');
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
        if (value == null || value === false || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
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
            // Live streams report Infinity (NaN before metadata), which JSON
            // serialises as null; send 0 for "unknown" so it stays a number.
            duration: Number.isFinite(duration) ? Math.floor(duration) : 0,
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
     * Reset tracker - removes all tracking, including the document
     * listeners, so players created afterwards are ignored until init()
     */
    reset() {
        // Untrack all players
        this.trackers.forEach((tracker, player) => {
            this.untrackPlayer(player);
        });

        if (this.listeners) {
            document.removeEventListener('waveformplayer:ready', this.listeners.ready, true);
            document.removeEventListener('waveformplayer:destroy', this.listeners.destroy, true);
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

// Forward currentTime jumps (seconds) below this are always credited as normal
// playback. Larger jumps are credited only when they fit the wall-clock time
// that passed (a throttled background tab); otherwise they are seeks.
WaveformTracker.SEEK_THRESHOLD = 5;

// Seconds of headroom added to the wall-clock allowance for large jumps.
WaveformTracker.SEEK_SLACK = 1;

// Share of the audio up to the complete threshold that must have been heard
// (media time) before complete fires, so seeking to the end doesn't count.
WaveformTracker.COMPLETE_ENGAGEMENT = 0.5;

// Create singleton instance
const tracker = new WaveformTracker();

// Export for browser
if (typeof window !== 'undefined') {
    window.WaveformTracker = tracker;
}

// ES6 export
export default tracker;