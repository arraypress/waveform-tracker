import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import tracker from '../src/index.js';

/**
 * WaveformTracker is a singleton that listens to a player's
 * `waveformplayer:*` CustomEvents and turns media-time engagement into
 * delivered analytics events. These tests drive it with fake players and
 * synthetic events, asserting the engagement maths, event thresholds, and
 * delivery path — never real audio or network.
 *
 * The event-firing checks are throttled to once per second via Date.now(), so
 * the clock is mocked and advanced explicitly to make firing deterministic.
 */

let now;

function fakePlayer(url = '/audio/a.mp3', title = 'Track A') {
	const container = document.createElement('div');
	document.body.appendChild(container);
	return { container, options: { url, title } };
}

function fire(player, type, detail) {
	player.container.dispatchEvent(new CustomEvent(`waveformplayer:${type}`, { detail }));
}

/** Feed a timeupdate at an optional clock offset (ms) from the current `now`. */
function timeupdate(player, currentTime, duration = 100, advanceMs = 0) {
	now += advanceMs;
	fire(player, 'timeupdate', { currentTime, duration });
}

beforeEach(() => {
	now = 1_000_000;
	vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
	tracker.reset();
	vi.restoreAllMocks();
	delete navigator.sendBeacon;
	delete globalThis.fetch;
	document.body.innerHTML = '';
});

describe('init', () => {
	it('warns when neither an endpoint nor a handler is configured', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		tracker.init({ session: false });
		expect(warn).toHaveBeenCalledWith('[WaveformTracker]', expect.stringContaining('No endpoint'));
	});

	it('tracks players announced via the waveformplayer:ready event', () => {
		tracker.init({ handler: () => {}, session: false });
		const p = fakePlayer();
		document.dispatchEvent(new CustomEvent('waveformplayer:ready', { detail: { player: p, url: p.options.url } }));
		expect(tracker.getTrackedCount()).toBe(1);
	});

	it('untracks players announced via the waveformplayer:destroy event', () => {
		tracker.init({ handler: () => {}, session: false });
		const p = fakePlayer();
		document.dispatchEvent(new CustomEvent('waveformplayer:ready', { detail: { player: p, url: p.options.url } }));
		document.dispatchEvent(new CustomEvent('waveformplayer:destroy', { detail: { player: p, url: p.options.url } }));
		expect(tracker.getTrackedCount()).toBe(0);
	});
});

describe('trackPlayer validation', () => {
	it('ignores invalid player instances and stays idempotent', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		tracker.init({ handler: () => {}, session: false });

		tracker.trackPlayer(null);
		tracker.trackPlayer({});               // missing container/options
		expect(tracker.getTrackedCount()).toBe(0);
		expect(warn).toHaveBeenCalled();

		const p = fakePlayer();
		tracker.trackPlayer(p);
		tracker.trackPlayer(p);                // already tracked -> no-op
		expect(tracker.getTrackedCount()).toBe(1);
	});
});

describe('engagement accounting', () => {
	it('credits media-time deltas and fires the listen event past the threshold', () => {
		const events = [];
		tracker.init({ handler: (e) => events.push(e), events: { listen: 5 }, session: false });
		const p = fakePlayer();
		tracker.trackPlayer(p);

		fire(p, 'play');
		timeupdate(p, 1);                      // baseline (no delta credited)
		for (let t = 2; t <= 6; t++) timeupdate(p, t); // +5s media-time, checks throttled
		timeupdate(p, 7, 100, 1000);           // clock advances -> throttle passes, listen fires

		const listen = events.find((e) => e.event === 'listen');
		expect(listen).toBeTruthy();
		expect(listen.url).toBe('/audio/a.mp3');
		expect(listen.time).toBe(6);
	});

	it('does not credit large forward jumps (seeks)', () => {
		const events = [];
		tracker.init({ handler: (e) => events.push(e), events: { listen: 5 }, session: false });
		const p = fakePlayer();
		tracker.trackPlayer(p);

		fire(p, 'play');
		timeupdate(p, 10);                     // baseline
		timeupdate(p, 40);                     // +30s jump -> treated as seek, ignored
		timeupdate(p, 41, 100, 2000);          // +1s real playback

		expect(events.some((e) => e.event === 'listen')).toBe(false);
		expect(tracker.getStats()[0].elapsedTime).toBeCloseTo(1, 5);
	});

	it('fires complete on the ended event using detail time', () => {
		const events = [];
		tracker.init({ handler: (e) => events.push(e), events: { complete: 95 }, session: false });
		const p = fakePlayer();
		tracker.trackPlayer(p);

		fire(p, 'play');
		fire(p, 'ended', { currentTime: 100, duration: 100 });

		const complete = events.find((e) => e.event === 'complete');
		expect(complete).toMatchObject({ event: 'complete', time: 100, duration: 100 });
	});
});

describe('delivery', () => {
	it('uses sendBeacon for terminal events when no custom headers are set', () => {
		const beacon = vi.fn(() => true);
		Object.defineProperty(navigator, 'sendBeacon', { configurable: true, writable: true, value: beacon });
		globalThis.fetch = vi.fn(() => Promise.resolve());

		tracker.init({ endpoint: '/collect', events: { complete: 95 }, session: false });
		const p = fakePlayer();
		tracker.trackPlayer(p);
		fire(p, 'play');
		fire(p, 'ended', { currentTime: 100, duration: 100 });

		expect(beacon).toHaveBeenCalledTimes(1);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('POSTs non-terminal events via fetch', () => {
		globalThis.fetch = vi.fn(() => Promise.resolve());
		tracker.init({ endpoint: '/collect', events: { play: 2 }, session: false });
		const p = fakePlayer();
		tracker.trackPlayer(p);

		fire(p, 'play');
		timeupdate(p, 1);                      // baseline
		timeupdate(p, 2);                      // +1
		timeupdate(p, 3, 100, 1000);           // +1 -> elapsed 2 -> play fires

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		const [url, opts] = globalThis.fetch.mock.calls[0];
		expect(url).toBe('/collect');
		expect(JSON.parse(opts.body)).toMatchObject({ event: 'play', url: '/audio/a.mp3' });
	});

	it('routes events to a custom handler and isolates handler errors', () => {
		const onErr = vi.spyOn(console, 'error').mockImplementation(() => {});
		const handler = vi.fn(() => { throw new Error('boom'); });
		tracker.init({ handler, events: { complete: 95 }, session: false });
		const p = fakePlayer();
		tracker.trackPlayer(p);

		fire(p, 'play');
		fire(p, 'ended', { currentTime: 100, duration: 100 });

		expect(handler).toHaveBeenCalledTimes(1);
		expect(onErr).toHaveBeenCalled();      // thrown handler is caught, not propagated
	});
});

describe('teardown', () => {
	it('stops tracking and detaches listeners on untrack', () => {
		const events = [];
		tracker.init({ handler: (e) => events.push(e), events: { listen: 1 }, session: false });
		const p = fakePlayer();
		tracker.trackPlayer(p);
		expect(tracker.getTrackedCount()).toBe(1);

		tracker.untrackPlayer(p);
		expect(tracker.getTrackedCount()).toBe(0);

		// Events fired after untracking must not produce analytics.
		fire(p, 'play');
		timeupdate(p, 5, 100, 2000);
		expect(events).toHaveLength(0);
	});

	it('reset() untracks every player', () => {
		tracker.init({ handler: () => {}, session: false });
		tracker.trackPlayer(fakePlayer('/a.mp3'));
		tracker.trackPlayer(fakePlayer('/b.mp3'));
		expect(tracker.getTrackedCount()).toBe(2);

		tracker.reset();
		expect(tracker.getTrackedCount()).toBe(0);
	});
});
