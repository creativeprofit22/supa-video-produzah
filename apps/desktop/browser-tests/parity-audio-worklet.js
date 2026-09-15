// Same-origin module: no blob URL or CSP exception. Timestamp every PCM block
// in the AudioContext clock; the test maps it to performance time at the output.
class ParityCapture extends globalThis.AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    for (let channel = 0; channel < outputs[0].length; channel++) {
      if (input[channel]) outputs[0][channel].set(input[channel]);
    }
    if (input[0])
      this.port.postMessage({ time: globalThis.currentTime, samples: Array.from(input[0]) });
    return true;
  }
}
globalThis.registerProcessor("parity-capture", ParityCapture);
