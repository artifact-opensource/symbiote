# 5.0 S5: Binary runtime stub — native IR emission + KV delta
export function emitIR(toolResult) { return {format:"wast",delta:JSON.stringify(toolResult)}; }
export function streamKVDelta(delta) { console.log("[KV-DELTA] stream delta:", delta.slice(0,30)); }
