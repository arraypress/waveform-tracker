# WaveformTracker

Lightweight analytics tracking for [WaveformPlayer](https://github.com/arraypress/waveform-player). Track meaningful audio engagement with minimal overhead.

## Features

- 🎯 **Smart Tracking** - Only tracks meaningful events (real listens, not bounces)
- 🪶 **Lightweight** - ~2KB minified, <1KB gzipped
- 🔌 **Zero Config** - Works out of the box with sensible defaults
- 📊 **Flexible** - Send to any endpoint or handle events yourself
- 🔒 **Privacy-First** - No user tracking, just content metrics

## Installation

### NPM
```bash
npm install @arraypress/waveform-tracker
```

### CDN
```html
<script src="https://unpkg.com/@arraypress/waveform-tracker@latest/dist/waveform-tracker.min.js"></script>
```

## Quick Start

```javascript
// Just track 30-second listens
WaveformTracker.init({
  endpoint: 'https://api.example.com/track',
  events: { listen: 30 }
});
```

That's it! The tracker automatically finds all WaveformPlayer instances and tracks them.

## Configuration

### Basic Options

```javascript
WaveformTracker.init({
  // Where to send events (required unless using handler)
  endpoint: '/api/track',
  
  // What events to track
  events: {
    play: 3,        // Track play after 3 seconds
    listen: 30,     // Track listen after 30 seconds  
    complete: 90    // Track complete at 90%
  },
  
  // Optional: Add headers for authentication
  headers: {
    'Authorization': 'Bearer token123'
  },
  
  // Optional: Add metadata to all events
  metadata: {
    user_id: 123,
    post_id: 456
  }
});
```

### WordPress Integration

```javascript
// In your theme/plugin PHP:
wp_localize_script('my-script', 'tracker_config', [
    'endpoint' => admin_url('admin-ajax.php'),
    'nonce' => wp_create_nonce('track_audio')
]);

// In your JavaScript:
WaveformTracker.init({
  handler: (payload) => {
    jQuery.post(tracker_config.endpoint, {
      action: 'track_audio',
      nonce: tracker_config.nonce,
      ...payload
    });
  },
  events: { listen: 30 }
});
```

### Custom Handler

```javascript
WaveformTracker.init({
  handler: (payload) => {
    // Send to Google Analytics
    gtag('event', 'audio_' + payload.event, {
      event_label: payload.url,
      value: payload.time
    });
  },
  events: { listen: 30, complete: 90 }
});
```

## Event Payload

Each event sends this data:

```json
{
  "event": "listen",
  "url": "audio/episode-42.mp3",
  "time": 30,
  "duration": 180,
  "page": "/podcast/episode-42",
  "session": "abc123def456"
}
```

## Events Explained

- **play**: User started playback (filters out accidental clicks)
- **listen**: User engaged meaningfully (e.g., 30+ seconds)
- **complete**: User finished (or reached threshold like 90%)

## Debug Mode

See what's being tracked without sending events:

```javascript
WaveformTracker.init({
  endpoint: '/track',
  events: { listen: 30 },
  debug: true  // Logs to console instead of sending
});
```

## License

MIT © [ArrayPress](https://github.com/arraypress)

## Related

- [WaveformPlayer](https://github.com/arraypress/waveform-player) - The audio player being tracked
- [WaveformPlaylist](https://github.com/arraypress/waveform-playlist) - Playlist support for WaveformPlayer