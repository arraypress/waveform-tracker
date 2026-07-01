<div align="center">

# WaveformTracker

**Lightweight, privacy-first analytics for WaveformPlayer.**
Track meaningful audio engagement — real listens, not bounces — and send it anywhere.

[![npm version](https://img.shields.io/npm/v/@arraypress/waveform-tracker?style=flat-square&labelColor=09090b&color=3f3f46)](https://www.npmjs.com/package/@arraypress/waveform-tracker)
[![license](https://img.shields.io/npm/l/@arraypress/waveform-tracker?style=flat-square&labelColor=09090b&color=3f3f46)](https://github.com/arraypress/waveform-tracker/blob/main/LICENSE)

**[Documentation](https://docs.waveformplayer.com/)** · [npm](https://www.npmjs.com/package/@arraypress/waveform-tracker)

</div>

---

## Install

```bash
npm install @arraypress/waveform-tracker @arraypress/waveform-player
```

```js
import WaveformTracker from '@arraypress/waveform-tracker';

WaveformTracker.init({
  endpoint: '/api/listens',
  events: { play: 3, listen: 30, complete: 90 }
});
```

## Documentation

Full configuration, payload shape and privacy notes live in the docs.

### -> [docs.waveformplayer.com](https://docs.waveformplayer.com/)

[Configuration](https://docs.waveformplayer.com/extensions/tracker/configuration/) · [Payload](https://docs.waveformplayer.com/extensions/tracker/payload/) · [Privacy](https://docs.waveformplayer.com/extensions/tracker/privacy/)

## License

MIT © [ArrayPress](https://github.com/arraypress)
