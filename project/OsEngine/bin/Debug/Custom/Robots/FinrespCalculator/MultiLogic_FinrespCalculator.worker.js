/* FINRESP calculation worker — keeps UI responsive during runMultiAsync */
importScripts("MultiLogic_FinrespCalculator.engine.js");

self.onmessage = async (e) => {
  const { id, packs, spec, startIdx, endIdx, params, volConfig, stopperConfig, randomPriceShift } = e.data || {};
  try {
    const E = self.MultiLogicFinrespEngine;
    if (!E?.runMultiAsync) throw new Error("engine not loaded in worker");
    const runOpts = {
      ...(randomPriceShift ? { signalPacks: E.applyRandomPriceShift(packs) } : {}),
      onProgress: (pct, text, detail) => {
        self.postMessage({ id, type: "progress", pct, text, detail: detail || null });
      }
    };
    const result = await E.runMultiAsync(packs, spec, startIdx, endIdx, params, volConfig, stopperConfig, runOpts);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
