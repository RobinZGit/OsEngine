/* FINRESP calculation worker — keeps UI responsive during runMulti */
importScripts("MultiLogic_FinrespCalculator.engine.js");

self.onmessage = (e) => {
  const { id, packs, spec, startIdx, endIdx, params, volConfig, stopperConfig, randomPriceShift } = e.data || {};
  try {
    const E = self.MultiLogicFinrespEngine;
    if (!E?.runMulti) throw new Error("engine not loaded in worker");
    const runOpts = randomPriceShift ? { signalPacks: E.applyRandomPriceShift(packs) } : undefined;
    const result = E.runMulti(packs, spec, startIdx, endIdx, params, volConfig, stopperConfig, runOpts);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
