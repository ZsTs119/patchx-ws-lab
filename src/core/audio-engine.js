const OPUS_SAMPLE_RATES = new Set([8000, 12000, 16000, 24000, 48000]);

export class AudioStreamer {
  constructor({ wsClient, store, getProfile, getSessionId, onState }) {
    this.wsClient = wsClient;
    this.store = store;
    this.getProfile = getProfile;
    this.getSessionId = getSessionId;
    this.onState = onState;
    this.mode = "idle";
    this.paused = false;
    this.stopRequested = false;
    this.timer = null;
    this.mic = null;
  }

  async streamFile(file) {
    this.assertIdle();
    const profile = this.getProfile();
    this.mode = "decoding";
    this.publishState("decoding");
    const pcm = await decodeAudioFileToPCM16(file, profile.sampleRate);
    await this.streamPCM(pcm, profile, "wav", { assumeBusy: true, trailingSilenceMs: 600 });
  }

  async streamBlob(blob, label = "generated") {
    this.assertIdle();
    const profile = this.getProfile();
    this.mode = "decoding";
    this.publishState("decoding");
    const file = new File([blob], `${label}.wav`, { type: blob.type || "audio/wav" });
    const pcm = await decodeAudioFileToPCM16(file, profile.sampleRate);
    await this.streamPCM(pcm, profile, label, { assumeBusy: true, trailingSilenceMs: 600 });
  }

  async streamPCM(pcm, profile, label, options = {}) {
    if (!options.assumeBusy) {
      this.assertIdle();
    }
    this.assertConnected();
    this.stopRequested = false;
    this.paused = false;
    this.mode = "streaming";
    this.publishState(`streaming ${label}`);
    this.sendListenState("start", label);

    const encoder = profile.format === "opus" ? createOpusEncoder(profile) : null;
    try {
      const frames = sliceFrames(pcm, profile);
      for (const frame of frames) {
        if (this.stopRequested) break;
        while (this.paused && !this.stopRequested) {
          await sleep(40);
        }
        if (this.stopRequested) break;
        this.sendFrame(frame, profile, encoder);
        await sleep(profile.frameDuration);
      }
      await this.streamTrailingSilence(profile, encoder, options.trailingSilenceMs);
    } finally {
      encoder?.destroy();
      this.sendListenState("stop", label);
      this.mode = "idle";
      this.publishState("idle");
      this.stopRequested = false;
      this.paused = false;
    }
  }

  async streamTrailingSilence(profile, encoder, trailingSilenceMs = 0) {
    const frames = Math.max(0, Math.ceil(Number(trailingSilenceMs || 0) / profile.frameDuration));
    if (!frames || this.stopRequested) return;
    const silence = new Int16Array(profile.frameSamples);
    for (let i = 0; i < frames; i++) {
      if (this.stopRequested) break;
      while (this.paused && !this.stopRequested) {
        await sleep(40);
      }
      if (this.stopRequested) break;
      this.sendFrame(silence, profile, encoder);
      await sleep(profile.frameDuration);
    }
  }

  reserve(label) {
    this.assertIdle();
    this.mode = "reserved";
    this.publishState(label);
  }

  releaseReservation() {
    if (this.mode === "reserved") {
      this.mode = "idle";
      this.publishState("idle");
    }
  }

  startSilence() {
    this.assertIdle();
    this.assertConnected();
    const profile = this.getProfile();
    const encoder = profile.format === "opus" ? createOpusEncoder(profile) : null;
    const frame = new Int16Array(profile.frameSamples);
    this.stopRequested = false;
    this.paused = false;
    this.mode = "silence";
    this.publishState("silence");
    this.sendListenState("start", "silence");
    this.timer = window.setInterval(() => {
      if (this.stopRequested) {
        encoder?.destroy();
        this.sendListenState("stop", "silence");
        this.clearTimer();
        this.publishState("idle");
        return;
      }
      if (!this.paused) {
        this.sendFrame(frame, profile, encoder);
      }
    }, profile.frameDuration);
  }

  pause() {
    if (this.mode !== "idle") {
      this.paused = true;
      this.publishState(`${this.mode} paused`);
    }
  }

  resume() {
    if (this.mode !== "idle") {
      this.paused = false;
      this.publishState(this.mode);
    }
  }

  stop() {
    this.stopRequested = true;
    if (this.mic) {
      this.stopMic();
    }
  }

  async startMic() {
    this.assertIdle();
    this.assertConnected();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持麦克风采集，请用 http://127.0.0.1:5177/ 或 HTTPS 打开 WS Lab");
    }

    const profile = this.getProfile();
    const encoder = profile.format === "opus" ? createOpusEncoder(profile) : null;
    let stream;
    let context;
    let source;
    let gain;
    let processor;
    let pending = new Int16Array(0);

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      context = new AudioContextClass();
      if (context.state === "suspended") {
        await context.resume();
      }
      source = context.createMediaStreamSource(stream);
      gain = context.createGain();
      gain.gain.value = 0;

      const handleInput = (input) => {
        if (this.mode !== "mic" || this.stopRequested || this.paused) return;
        const resampled = resampleFloat32(input, context.sampleRate, profile.sampleRate);
        pending = concatInt16(pending, floatToPCM16(resampled));
        while (pending.length >= profile.frameSamples) {
          const frame = pending.slice(0, profile.frameSamples);
          pending = pending.slice(profile.frameSamples);
          this.sendFrame(frame, profile, encoder);
        }
      };

      if (context.audioWorklet) {
        await context.audioWorklet.addModule(new URL("./mic-worklet.js", import.meta.url));
        processor = new AudioWorkletNode(context, "ws-lab-mic-processor");
        processor.port.onmessage = (event) => handleInput(event.data);
      } else {
        processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => handleInput(event.inputBuffer.getChannelData(0));
      }

      this.mode = "mic";
      this.stopRequested = false;
      this.paused = false;
      this.publishState("mic");
      this.sendListenState("start", "mic");
      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);
      this.mic = { stream, context, source, processor, gain, encoder };
    } catch (error) {
      encoder?.destroy();
      stream?.getTracks().forEach((track) => track.stop());
      if (context) {
        await context.close().catch(() => {});
      }
      this.mode = "idle";
      this.publishState("idle");
      throw error;
    }
  }

  stopMic() {
    if (!this.mic) return;
    this.mic.processor.disconnect();
    this.mic.source.disconnect();
    this.mic.gain.disconnect();
    this.mic.stream.getTracks().forEach((track) => track.stop());
    this.mic.encoder?.destroy();
    this.mic.context.close();
    this.mic = null;
    this.sendListenState("stop", "mic");
    this.mode = "idle";
    this.publishState("idle");
    this.stopRequested = false;
  }

  sendFrame(frame, profile, encoder) {
    if (profile.format === "pcm") {
      this.wsClient.sendBinary(int16ToArrayBuffer(frame), "pcm");
      return;
    }
    const encoded = encoder.encode(frame);
    this.wsClient.sendBinary(encoded, "opus");
  }

  sendListenState(state, source) {
    const payload = {
      type: "listen",
      state,
      mode: "manual",
      source
    };
    const sessionId = this.getSessionId();
    if (sessionId) payload.session_id = sessionId;
    this.wsClient.sendJson(payload);
  }

  clearTimer() {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.mode = "idle";
  }

  publishState(value) {
    this.onState?.(value);
    this.store.add({ direction: "system", type: "audio", label: value, payload: { state: value } });
  }

  assertIdle() {
    if (this.mode !== "idle") {
      throw new Error(`Audio streamer is busy: ${this.mode}`);
    }
  }

  assertConnected() {
    if (!this.wsClient.isConnected) {
      throw new Error("WebSocket is not connected");
    }
  }
}

export function getProfileFromInputs({ format, sampleRate, frameDuration }) {
  const normalized = {
    format,
    sampleRate: Number(sampleRate),
    frameDuration: Number(frameDuration)
  };
  if (!["opus", "pcm"].includes(normalized.format)) {
    throw new Error("audio format must be opus or pcm");
  }
  if (!Number.isFinite(normalized.sampleRate) || normalized.sampleRate <= 0) {
    throw new Error("sample rate must be a positive number");
  }
  if (![20, 40, 60].includes(normalized.frameDuration)) {
    throw new Error("frame duration must be 20, 40, or 60ms");
  }
  if (normalized.format === "opus" && !OPUS_SAMPLE_RATES.has(normalized.sampleRate)) {
    throw new Error("Opus supports 8000, 12000, 16000, 24000, or 48000Hz");
  }
  normalized.frameSamples = Math.round(normalized.sampleRate * normalized.frameDuration / 1000);
  return normalized;
}

export async function decodeAudioFileToPCM16(file, targetSampleRate) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("AudioContext is not available");
  }
  const context = new AudioContextClass();
  const bytes = await file.arrayBuffer();
  const decoded = await context.decodeAudioData(bytes.slice(0));
  const mono = mixToMono(decoded);
  const resampled = resampleFloat32(mono, decoded.sampleRate, targetSampleRate);
  await context.close();
  return floatToPCM16(resampled);
}

export function base64ToBlob(base64, mimeType) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function mixToMono(buffer) {
  const output = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      output[i] += data[i] / buffer.numberOfChannels;
    }
  }
  return output;
}

function resampleFloat32(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = sourceIndex - left;
    output[i] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

function floatToPCM16(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const value = Math.max(-1, Math.min(1, input[i]));
    output[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return output;
}

function sliceFrames(pcm, profile) {
  const frames = [];
  for (let offset = 0; offset < pcm.length; offset += profile.frameSamples) {
    const frame = new Int16Array(profile.frameSamples);
    frame.set(pcm.slice(offset, offset + profile.frameSamples));
    frames.push(frame);
  }
  return frames;
}

function createOpusEncoder(profile) {
  const mod = window.Module?.instance || window.ModuleInstance;
  if (!mod) {
    throw new Error("libopus is not loaded");
  }

  const channels = 1;
  const encoderSize = mod._opus_encoder_get_size(channels);
  const encoderPtr = mod._malloc(encoderSize);
  if (!encoderPtr) {
    throw new Error("cannot allocate opus encoder");
  }

  const err = mod._opus_encoder_init(encoderPtr, profile.sampleRate, channels, 2048);
  if (err < 0) {
    mod._free(encoderPtr);
    throw new Error(`opus encoder init failed: ${err}`);
  }
  mod._opus_encoder_ctl(encoderPtr, 4002, 16000);
  mod._opus_encoder_ctl(encoderPtr, 4010, 5);
  mod._opus_encoder_ctl(encoderPtr, 4016, 0);

  return {
    encode(frame) {
      const pcmPtr = mod._malloc(frame.length * 2);
      const outPtr = mod._malloc(4000);
      try {
        for (let i = 0; i < frame.length; i++) {
          mod.HEAP16[(pcmPtr >> 1) + i] = frame[i];
        }
        const encodedLen = mod._opus_encode(encoderPtr, pcmPtr, profile.frameSamples, outPtr, 4000);
        if (encodedLen < 0) {
          throw new Error(`opus encode failed: ${encodedLen}`);
        }
        const output = new Uint8Array(encodedLen);
        for (let i = 0; i < encodedLen; i++) {
          output[i] = mod.HEAPU8[outPtr + i];
        }
        return output;
      } finally {
        mod._free(pcmPtr);
        mod._free(outPtr);
      }
    },
    destroy() {
      if (encoderPtr) {
        mod._free(encoderPtr);
      }
    }
  };
}

function int16ToArrayBuffer(frame) {
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
}

function concatInt16(a, b) {
  const output = new Int16Array(a.length + b.length);
  output.set(a, 0);
  output.set(b, a.length);
  return output;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
