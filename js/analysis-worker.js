// Runs the analysis off the main thread so the page stays responsive.
importScripts('dsp.js');

self.onmessage = (e) => {
  const { samples, opts } = e.data;
  try {
    const result = self.ACDSP.analyze(samples, opts, (stage, frac) => {
      self.postMessage({ type: 'progress', stage, frac });
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
