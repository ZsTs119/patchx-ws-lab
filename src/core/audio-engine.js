const OPUS_SAMPLE_RATES = new Set([8000, 12000, 16000, 24000, 48000]);

export class AudioOperationCancelledError extends Error {
  constructor(reason = "cancelled") {
    super(`音频操作已取消：${reason}`);
    this.name = "AudioOperationCancelledError";
    this.code = "AUDIO_OPERATION_CANCELLED";
    this.reason = reason;
  }
}

export class AudioStreamer {
  constructor({
    wsClient,
    store,
    getProfile,
    getSessionId,
    getMicConstraints,
    onState,
    getUserMedia,
    AudioContextClass,
    AudioWorkletNodeClass,
    sleepFn,
    setIntervalFn,
    clearIntervalFn
  }) {
    this.wsClient = wsClient;
    this.store = store;
    this.getProfile = getProfile;
    this.getSessionId = getSessionId;
    this.getMicConstraints = getMicConstraints;
    this.onState = onState;
    this.getUserMediaFn = getUserMedia
      || globalThis.navigator?.mediaDevices?.getUserMedia?.bind(globalThis.navigator.mediaDevices)
      || null;
    this.AudioContextClass = AudioContextClass;
    this.AudioWorkletNodeClass = AudioWorkletNodeClass;
    this.sleepFn = sleepFn || sleep;
    this.setIntervalFn = setIntervalFn || globalThis.setInterval.bind(globalThis);
    this.clearIntervalFn = clearIntervalFn || globalThis.clearInterval.bind(globalThis);
    this.mode = "idle";
    this.paused = false;
    this.stopRequested = false;
    this.timer = null;
    this.mic = null;
    this.silence = null;
    this.captureGeneration = 0;
    this.operationGeneration = 0;
    this.activeOperation = null;
  }

  async streamFile(file) {
    this.assertIdle();
    this.assertConnected();
    const operation = this.beginOperation("file");
    const profile = this.getProfile();
    this.mode = "decoding";
    this.publishState("decoding");
    try {
      const pcm = await decodeAudioFileToPCM16(file, profile.sampleRate);
      this.assertCurrentOperation(operation);
      await this.streamPCM(pcm, profile, "wav", {
        assumeBusy: true,
        operation,
        trailingSilenceMs: 600
      });
    } catch (error) {
      if (this.ownsOperation(operation)) this.finishOperation(operation);
      if (isAudioCancellation(error)) return;
      throw error;
    }
  }

  async streamBlob(blob, label = "generated", options = {}) {
    this.assertIdle();
    this.assertConnected();
    const operation = this.beginOperation("blob");
    const profile = this.getProfile();
    this.mode = "decoding";
    this.publishState("decoding");
    try {
      const file = new File([blob], `${label}.wav`, { type: blob.type || "audio/wav" });
      const pcm = await decodeAudioFileToPCM16(file, profile.sampleRate);
      this.assertCurrentOperation(operation);
      await this.streamPCM(pcm, profile, label, {
        assumeBusy: true,
        operation,
        trailingSilenceMs: options.trailingSilenceMs ?? options.trailing_silence_ms ?? 600,
        sendListenStop: options.sendListenStop ?? options.send_listen_stop ?? true
      });
    } catch (error) {
      if (this.ownsOperation(operation)) this.finishOperation(operation);
      if (isAudioCancellation(error)) return;
      throw error;
    }
  }

  async streamPCM(pcm, profile, label, options = {}) {
    let operation = options.operation;
    if (!options.assumeBusy) {
      this.assertIdle();
      this.assertConnected();
      operation = this.beginOperation("stream");
    }
    if (!operation) {
      throw new Error("Audio stream operation is missing");
    }
    this.assertCurrentOperation(operation);
    this.stopRequested = false;
    this.paused = false;
    this.mode = "streaming";
    this.publishState(`streaming ${label}`);

    const encoder = profile.format === "opus" ? createOpusEncoder(profile) : null;
    let listenStarted = false;
    try {
      this.sendListenState("start", label, operation);
      listenStarted = true;
      const frames = sliceFrames(pcm, profile);
      for (const frame of frames) {
        if (this.stopRequested || !this.ownsOperation(operation)) break;
        while (this.paused && !this.stopRequested && this.ownsOperation(operation)) {
          await this.sleepFn(40);
        }
        if (this.stopRequested || !this.ownsOperation(operation)) break;
        this.assertCurrentOperation(operation);
        this.sendFrame(frame, profile, encoder, operation);
        await this.sleepFn(profile.frameDuration);
        this.assertCurrentOperation(operation);
      }
      await this.streamTrailingSilence(profile, encoder, options.trailingSilenceMs, operation);
    } catch (error) {
      if (!isAudioCancellation(error)) throw error;
    } finally {
      encoder?.destroy();
      try {
        if (listenStarted && options.sendListenStop !== false) {
          this.sendListenState("stop", label, operation);
        }
      } catch (error) {
        if (!isAudioCancellation(error)) {
          this.store.add({ direction: "system", type: "audio", error: `listen stop 发送失败: ${error.message}` });
        }
      }
      if (this.ownsOperation(operation)) this.finishOperation(operation);
    }
  }

  async streamTrailingSilence(profile, encoder, trailingSilenceMs = 0, operation) {
    const frames = Math.max(0, Math.ceil(Number(trailingSilenceMs || 0) / profile.frameDuration));
    if (!frames || this.stopRequested || !this.ownsOperation(operation)) return;
    const silence = new Int16Array(profile.frameSamples);
    for (let i = 0; i < frames; i++) {
      if (this.stopRequested || !this.ownsOperation(operation)) break;
      while (this.paused && !this.stopRequested && this.ownsOperation(operation)) {
        await this.sleepFn(40);
      }
      if (this.stopRequested || !this.ownsOperation(operation)) break;
      this.assertCurrentOperation(operation);
      this.sendFrame(silence, profile, encoder, operation);
      await this.sleepFn(profile.frameDuration);
      this.assertCurrentOperation(operation);
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
    const operation = this.beginOperation("silence");
    const profile = this.getProfile();
    const encoder = profile.format === "opus" ? createOpusEncoder(profile) : null;
    const frame = new Int16Array(profile.frameSamples);
    this.stopRequested = false;
    this.paused = false;
    this.mode = "silence";
    this.publishState("silence");
    this.sendListenState("start", "silence", operation);
    this.silence = { encoder, operation };
    this.timer = this.setIntervalFn(() => {
      try {
        if (this.stopRequested || !this.ownsOperation(operation)) {
          this.stopSilence(operation);
          return;
        }
        if (!this.paused) {
          this.assertCurrentOperation(operation);
          this.sendFrame(frame, profile, encoder, operation);
        }
      } catch (error) {
        if (!isAudioCancellation(error)) {
          this.store.add({ direction: "system", type: "audio", error: `静音推流失败: ${error.message}` });
        }
        this.stopSilence(operation);
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
    const previousMode = this.mode;
    const mic = this.mic;
    const silence = this.silence;
    this.stopRequested = true;
    this.captureGeneration += 1;
    this.operationGeneration += 1;
    this.activeOperation = null;

    if (mic) {
      this.mic = null;
      this.cleanupMicResources(mic);
      try {
        this.sendListenState("stop", "mic", mic.operation);
      } catch (error) {
        if (!isAudioCancellation(error)) {
          this.store.add({ direction: "system", type: "audio", error: `listen stop 发送失败: ${error.message}` });
        }
      }
    }
    if (silence) {
      this.silence = null;
      this.clearTimer();
      silence.encoder?.destroy();
      try {
        this.sendListenState("stop", "silence", silence.operation);
      } catch (error) {
        if (!isAudioCancellation(error)) {
          this.store.add({ direction: "system", type: "audio", error: `listen stop 发送失败: ${error.message}` });
        }
      }
    }

    this.paused = false;
    this.stopRequested = false;
    if (previousMode !== "idle") {
      this.mode = "idle";
      this.publishState("idle");
    }
  }

  async startMic() {
    this.assertIdle();
    this.assertConnected();
    if (!this.getUserMediaFn) {
      throw new Error("当前浏览器不支持麦克风采集，请用 http://127.0.0.1:5177/ 或 HTTPS 打开 WS Lab");
    }

    const operation = this.beginOperation("mic");
    const captureGeneration = ++this.captureGeneration;
    const profile = this.getProfile();
    const encoder = profile.format === "opus" ? createOpusEncoder(profile) : null;
    let stream;
    let context;
    let source;
    let gain;
    let processor;
    let pending = new Int16Array(0);
    this.mode = "mic_pending";
    this.publishState("mic_pending");

    try {
      stream = await this.getUserMediaFn({
        audio: normalizeMicConstraints(this.getMicConstraints?.())
      });
      this.assertCurrentCapture(operation, captureGeneration);
      const AudioContextClass = this.AudioContextClass || globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext;
      if (!AudioContextClass) throw new Error("AudioContext is not available");
      context = new AudioContextClass();
      if (context.state === "suspended") {
        await context.resume();
        this.assertCurrentCapture(operation, captureGeneration);
      }
      source = context.createMediaStreamSource(stream);
      gain = context.createGain();
      gain.gain.value = 0;

      const handleInput = (input) => {
        if (!this.isCurrentCapture(operation, captureGeneration) || this.mode !== "mic" || this.stopRequested || this.paused) return;
        try {
          const resampled = resampleFloat32(input, context.sampleRate, profile.sampleRate);
          pending = concatInt16(pending, floatToPCM16(resampled));
          while (pending.length >= profile.frameSamples) {
            const frame = pending.slice(0, profile.frameSamples);
            pending = pending.slice(profile.frameSamples);
            this.sendFrame(frame, profile, encoder, operation);
          }
        } catch (error) {
          if (!isAudioCancellation(error)) {
            this.store.add({ direction: "system", type: "audio", error: `麦克风推流失败: ${error.message}` });
          }
        }
      };

      if (context.audioWorklet) {
        await context.audioWorklet.addModule(new URL("./mic-worklet.js", import.meta.url));
        this.assertCurrentCapture(operation, captureGeneration);
        const AudioWorkletNodeClass = this.AudioWorkletNodeClass || globalThis.AudioWorkletNode;
        processor = new AudioWorkletNodeClass(context, "ws-lab-mic-processor");
        processor.port.onmessage = (event) => handleInput(event.data);
      } else {
        processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => handleInput(event.inputBuffer.getChannelData(0));
      }

      this.assertCurrentCapture(operation, captureGeneration);
      this.mic = { stream, context, source, processor, gain, encoder, operation, captureGeneration };
      this.mode = "mic";
      this.stopRequested = false;
      this.paused = false;
      this.publishState("mic");
      this.sendListenState("start", "mic", operation);
      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);
    } catch (error) {
      await this.cleanupMicResources({ stream, context, source, processor, gain, encoder });
      if (this.mic?.operation === operation) this.mic = null;
      const cancelled = isAudioCancellation(error) || !this.isCurrentCapture(operation, captureGeneration);
      if (this.ownsOperation(operation)) this.finishOperation(operation);
      if (cancelled) throw new AudioOperationCancelledError("stale_capture");
      throw error;
    }
  }

  stopMic() {
    if (this.mode === "mic" || this.mode === "mic_pending") this.stop();
  }

  sendFrame(frame, profile, encoder, operation) {
    if (profile.format === "pcm") {
      this.wsClient.sendBinary(int16ToArrayBuffer(frame), "pcm", { attemptId: operation.attemptId });
      return;
    }
    const encoded = encoder.encode(frame);
    this.wsClient.sendBinary(encoded, "opus", { attemptId: operation.attemptId });
  }

  sendListenState(state, source, operation) {
    const payload = {
      type: "listen",
      state,
      mode: "manual",
      source
    };
    const sessionId = operation.sessionId;
    if (sessionId) payload.session_id = sessionId;
    this.wsClient.sendJson(payload, { attemptId: operation.attemptId });
  }

  clearTimer() {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
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
    if (!this.wsClient.isConnected || !this.wsClient.activeAttemptId) {
      throw new Error("WebSocket is not connected");
    }
  }

  beginOperation(kind) {
    this.assertConnected();
    const operation = Object.freeze({
      generation: ++this.operationGeneration,
      attemptId: this.wsClient.activeAttemptId,
      sessionId: this.getSessionId?.() || "",
      kind
    });
    this.activeOperation = operation;
    this.stopRequested = false;
    this.paused = false;
    return operation;
  }

  ownsOperation(operation) {
    return Boolean(
      operation
      && this.activeOperation
      && this.activeOperation.generation === operation.generation
      && this.operationGeneration === operation.generation
    );
  }

  assertCurrentOperation(operation) {
    if (!this.ownsOperation(operation) || this.wsClient.activeAttemptId !== operation.attemptId) {
      throw new AudioOperationCancelledError("stale_operation");
    }
  }

  isCurrentCapture(operation, captureGeneration) {
    return this.captureGeneration === captureGeneration
      && this.ownsOperation(operation)
      && this.wsClient.activeAttemptId === operation.attemptId;
  }

  assertCurrentCapture(operation, captureGeneration) {
    if (!this.isCurrentCapture(operation, captureGeneration)) {
      throw new AudioOperationCancelledError("stale_capture");
    }
  }

  finishOperation(operation) {
    if (!this.ownsOperation(operation)) return;
    this.activeOperation = null;
    this.mode = "idle";
    this.stopRequested = false;
    this.paused = false;
    this.publishState("idle");
  }

  stopSilence(operation) {
    const silence = this.silence;
    if (!silence || silence.operation !== operation) return;
    this.silence = null;
    this.clearTimer();
    silence.encoder?.destroy();
    try {
      this.sendListenState("stop", "silence", operation);
    } catch (error) {
      if (!isAudioCancellation(error)) {
        this.store.add({ direction: "system", type: "audio", error: `listen stop 发送失败: ${error.message}` });
      }
    }
    if (this.ownsOperation(operation)) this.finishOperation(operation);
  }

  async cleanupMicResources(resources = {}) {
    safeDisconnect(resources.processor);
    safeDisconnect(resources.source);
    safeDisconnect(resources.gain);
    resources.stream?.getTracks?.().forEach((track) => track.stop());
    resources.encoder?.destroy?.();
    if (resources.context?.close) {
      await resources.context.close().catch(() => {});
    }
  }
}

function isAudioCancellation(error) {
  return error instanceof AudioOperationCancelledError
    || error?.code === "AUDIO_OPERATION_CANCELLED"
    || error?.code === "WS_ATTEMPT_CANCELLED";
}

function safeDisconnect(node) {
  try {
    node?.disconnect?.();
  } catch {
    // Audio nodes may already be disconnected during an idempotent reset.
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

function normalizeMicConstraints(raw = {}) {
  return {
    channelCount: 1,
    echoCancellation: raw.echoCancellation !== false,
    noiseSuppression: Boolean(raw.noiseSuppression),
    autoGainControl: Boolean(raw.autoGainControl)
  };
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
