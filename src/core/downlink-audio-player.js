const OPUS_SAMPLE_RATES = new Set([8000, 12000, 16000, 24000, 48000]);

const DEFAULT_PROFILE = {
  format: "opus",
  sampleRate: 24000,
  frameDuration: 60,
  channels: 1,
  frameSamples: 1440
};

export class DownlinkAudioPlayer {
  constructor({ store, getProfile, onState }) {
    this.store = store;
    this.getProfile = getProfile;
    this.onState = onState;
    this.context = null;
    this.unlocked = false;
    this.muted = false;
    this.status = "locked";
    this.ttsActive = false;
    this.codec = "";
    this.profile = { ...DEFAULT_PROFILE };
    this.decoder = null;
    this.decoderKey = "";
    this.pendingBuffers = [];
    this.pendingMs = 0;
    this.nextPlayTime = 0;
    this.sources = new Set();
    this.cancelledSources = new WeakSet();
    this.statsData = createStats();
    this.initialBufferMs = 180;
    this.fullDuplexInitialBufferMs = 300;
    this.resumeLeadMs = 80;
    this.lowWatermarkMs = 120;
    this.maxBufferMs = 1200;
    this.micActive = false;
    this.sentenceScheduledFrames = 0;
    this.outputGain = null;
    this.limiter = null;
    this.outputChainConnected = false;
    this.outputGainValue = 1;
    this.limiterEnabled = false;
    this.limiterThresholdDb = -6;
    this.limiterRatio = 8;
    this.boundarySmoothingMs = 0;
    this.boundaryJumpThreshold = 0.35;
    this.lastBoundaryTailSample = 0;
    this.hasLastBoundaryTailSample = false;
    this.forceNextFadeIn = false;
    this.acceptBinaryUntilMs = 0;
    this.dropBinaryUntilNextStart = false;
    this.playbackGeneration = 0;
    this.lastTtsStopAtMs = 0;
    this.lastTtsStartAtMs = 0;
    this.artifactGuardEnabled = false;
    this.platformSnapshot = null;
  }

  async unlock() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("当前浏览器不支持 AudioContext");
    }
    if (!this.context) {
      this.context = new AudioContextClass();
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
    this.ensureOutputChain();
    this.updatePlatformSnapshot();
    this.playSilentUnlockFrame();
    this.unlocked = true;
    this.setStatus(this.muted ? "muted" : "ready");
    return this.stats();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.muted) {
      this.clear("muted", { keepUnlocked: true, keepStats: true });
      this.setStatus("muted");
    } else {
      this.setStatus(this.unlocked ? "ready" : "locked");
    }
    return this.muted;
  }

  handleTtsEvent(payload = {}) {
    if (!payload || payload.type !== "tts") return;
    const state = payload.state || "";
    if (payload.audio_codec) {
      this.codec = normalizeCodec(payload.audio_codec);
      this.recordCodecMarker(payload.audio_codec);
    }
    if (state === "start") {
      this.clear("tts_start", { keepUnlocked: true, keepStats: true });
      this.ttsActive = true;
      this.sentenceScheduledFrames = 0;
      this.playbackGeneration += 1;
      this.lastTtsStartAtMs = nowMs();
      this.acceptBinaryUntilMs = 0;
      this.dropBinaryUntilNextStart = false;
      this.hasLastBoundaryTailSample = false;
      this.forceNextFadeIn = true;
      this.codec = normalizeCodec(payload.audio_codec || this.codec || this.profile.format);
      if (!payload.audio_codec) this.statsData.codecSource = "profile";
      this.setStatus(this.unlocked && !this.muted ? "buffering" : this.statusForIdle());
      return;
    }
    if (state === "sentence_start") {
      this.ttsActive = true;
      this.sentenceScheduledFrames = 0;
      this.dropBinaryUntilNextStart = false;
      this.acceptBinaryUntilMs = 0;
      if (payload.audio_codec) this.codec = normalizeCodec(payload.audio_codec);
      if (this.unlocked && !this.muted && !this.sources.size) {
        this.setStatus("buffering");
      }
      return;
    }
    if (state === "stop") {
      this.ttsActive = false;
      const reason = payload.reason || "";
      this.lastTtsStopAtMs = nowMs();
      if (reason === "interrupt" || reason === "abort") {
        this.dropBinaryUntilNextStart = true;
        this.acceptBinaryUntilMs = 0;
        this.clear(reason, { keepUnlocked: true, keepStats: true });
        return;
      }
      this.acceptBinaryUntilMs = nowMs() + 300;
      this.flushPending();
      this.updateStatusAfterQueue();
    }
  }

  async enqueueFrame(arrayBuffer) {
    this.statsData.receivedFrames += 1;
    this.statsData.receivedBytes += arrayBuffer?.byteLength || 0;
    if (!arrayBuffer?.byteLength) return this.stats();
    this.refreshProfile();
    if (!this.canAcceptBinaryFrame()) {
      this.statsData.droppedFrames += 1;
      this.statsData.lateFrameDroppedCount += 1;
      this.statsData.lastDropReason = this.dropBinaryUntilNextStart ? "late_after_interrupt" : "late_after_stop";
      this.statsData.lastLateFrameAt = new Date().toISOString();
      this.statsData.lastLateFrameGeneration = this.playbackGeneration;
      return this.stats();
    }
    this.validateFrameProfile(arrayBuffer);
    if (!this.unlocked || !this.context) {
      this.statsData.droppedFrames += 1;
      this.statsData.lastDropReason = "locked";
      this.setStatus("locked");
      return this.stats();
    }
    if (this.muted) {
      this.statsData.droppedFrames += 1;
      this.statsData.lastDropReason = "muted";
      this.setStatus("muted");
      return this.stats();
    }
    try {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
      const decodeStartMs = nowMs();
      const buffer = this.decodeToAudioBuffer(arrayBuffer);
      const decodeMs = Math.max(0, nowMs() - decodeStartMs);
      this.statsData.decodedFrames += 1;
      this.statsData.decodeTotalMs += decodeMs;
      this.statsData.decodeMaxMs = Math.max(this.statsData.decodeMaxMs, decodeMs);
      const prepared = this.prepareDecodedBuffer(buffer);
      this.pendingBuffers.push(prepared);
      this.pendingMs += prepared.duration * 1000;
      if (this.pendingMs >= this.effectiveInitialBufferMs() || !this.ttsActive) {
        this.flushPending();
      } else {
        this.setStatus("buffering");
      }
    } catch (error) {
      this.statsData.decodeErrors += 1;
      this.statsData.lastError = error.message;
      this.setStatus("error");
      this.store?.add({ direction: "system", type: "audio_playback", error: `下行音频解码失败: ${error.message}` });
    }
    return this.stats();
  }

  clear(reason = "clear", options = {}) {
    for (const source of this.sources) {
      try {
        this.cancelledSources.add(source);
        source.stop();
      } catch {
        // Source may already have ended.
      }
    }
    this.sources.clear();
    this.pendingBuffers = [];
    this.pendingMs = 0;
    this.nextPlayTime = 0;
    this.ttsActive = false;
    this.sentenceScheduledFrames = 0;
    this.hasLastBoundaryTailSample = false;
    this.forceNextFadeIn = true;
    if (!options.keepStats) {
      this.statsData = createStats();
    }
    this.statsData.lastClearReason = reason;
    if (!options.keepUnlocked) {
      this.unlocked = false;
      this.muted = false;
    }
    this.setStatus(this.statusForIdle());
  }

  stats() {
    if (this.limiter && Number.isFinite(this.limiter.reduction)) {
      this.statsData.limiterReductionMaxDb = Math.max(this.statsData.limiterReductionMaxDb, Math.abs(this.limiter.reduction));
    }
    const queueDelayMs = this.context
      ? Math.max(0, Math.round((this.nextPlayTime - this.context.currentTime) * 1000 + this.pendingMs))
      : Math.round(this.pendingMs);
    const decodeAvgMs = this.statsData.decodedFrames
      ? Math.round(this.statsData.decodeTotalMs / this.statsData.decodedFrames)
      : 0;
    return {
      ...this.statsData,
      status: this.status,
      unlocked: this.unlocked,
      muted: this.muted,
      codec: this.currentCodec(),
      sampleRate: this.profile.sampleRate,
      frameDuration: this.profile.frameDuration,
      decodeAvgMs,
      decodeMaxMs: Math.round(this.statsData.decodeMaxMs),
      micActive: this.micActive,
      initialBufferMs: this.effectiveInitialBufferMs(),
      resumeLeadMs: this.resumeLeadMs,
      lowWatermarkMs: this.lowWatermarkMs,
      maxBufferMs: this.maxBufferMs,
      outputGain: this.outputGainValue,
      limiterEnabled: this.limiterEnabled,
      limiterThresholdDb: this.limiterThresholdDb,
      limiterRatio: this.limiterRatio,
      boundarySmoothingMs: this.boundarySmoothingMs,
      artifactGuardEnabled: this.artifactGuardEnabled,
      playbackGeneration: this.playbackGeneration,
      platform: this.platformSnapshot || this.updatePlatformSnapshot(),
      queueDelayMs
    };
  }

  setPlaybackTuning(options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, "micActive")) {
      this.micActive = Boolean(options.micActive);
    }
    if (Object.prototype.hasOwnProperty.call(options, "initialBufferMs")) {
      this.initialBufferMs = clampNumber(options.initialBufferMs, 60, 800, 180);
    }
    if (Object.prototype.hasOwnProperty.call(options, "fullDuplexInitialBufferMs")) {
      this.fullDuplexInitialBufferMs = clampNumber(options.fullDuplexInitialBufferMs, 120, 1200, 300);
    }
    if (Object.prototype.hasOwnProperty.call(options, "resumeLeadMs")) {
      this.resumeLeadMs = clampNumber(options.resumeLeadMs, 20, 300, 80);
    }
    if (Object.prototype.hasOwnProperty.call(options, "lowWatermarkMs")) {
      this.lowWatermarkMs = clampNumber(options.lowWatermarkMs, 20, 600, 120);
    }
    if (Object.prototype.hasOwnProperty.call(options, "maxBufferMs")) {
      this.maxBufferMs = clampNumber(options.maxBufferMs, 300, 5000, 1200);
    }
    if (Object.prototype.hasOwnProperty.call(options, "outputGain")) {
      this.setOutputGain(clampNumber(options.outputGain, 0.2, 1.2, 1));
    }
    if (Object.prototype.hasOwnProperty.call(options, "limiterEnabled")) {
      const next = Boolean(options.limiterEnabled);
      if (this.limiterEnabled !== next) {
        this.limiterEnabled = next;
        this.rebuildOutputChain();
      }
    }
    if (Object.prototype.hasOwnProperty.call(options, "limiterThresholdDb")) {
      this.limiterThresholdDb = clampNumber(options.limiterThresholdDb, -36, 0, -6);
      if (this.limiter) this.limiter.threshold.value = this.limiterThresholdDb;
    }
    if (Object.prototype.hasOwnProperty.call(options, "limiterRatio")) {
      this.limiterRatio = clampNumber(options.limiterRatio, 1, 20, 8);
      if (this.limiter) this.limiter.ratio.value = this.limiterRatio;
    }
    if (Object.prototype.hasOwnProperty.call(options, "boundarySmoothingMs")) {
      this.boundarySmoothingMs = clampNumber(options.boundarySmoothingMs, 0, 12, 0);
    }
    if (Object.prototype.hasOwnProperty.call(options, "boundaryJumpThreshold")) {
      this.boundaryJumpThreshold = clampNumber(options.boundaryJumpThreshold, 0.05, 1.8, 0.35);
    }
    if (Object.prototype.hasOwnProperty.call(options, "artifactGuardEnabled")) {
      this.artifactGuardEnabled = Boolean(options.artifactGuardEnabled);
    }
    this.updatePlatformSnapshot();
    this.onState?.(this.stats());
  }

  effectiveInitialBufferMs() {
    return this.micActive
      ? Math.max(this.initialBufferMs, this.fullDuplexInitialBufferMs)
      : this.initialBufferMs;
  }

  refreshProfile() {
    const draft = normalizeProfile(this.getProfile?.() || DEFAULT_PROFILE);
    const codec = this.currentCodec(draft.format);
    this.profile = { ...draft, format: codec };
    if (codec !== "opus") {
      this.destroyDecoder();
    }
  }

  currentCodec(fallback = "") {
    return normalizeCodec(this.codec || fallback || this.profile.format || DEFAULT_PROFILE.format);
  }

  recordCodecMarker(value) {
    const marker = normalizeCodec(value);
    const active = normalizeProfile(this.getProfile?.() || DEFAULT_PROFILE).format;
    this.statsData.codecSource = "tts_event";
    if (marker !== active) {
      this.statsData.profileMismatchCount += 1;
      this.statsData.lastProfileMismatch = `tts codec ${marker}, playback profile ${active}`;
    }
  }

  canAcceptBinaryFrame() {
    if (this.dropBinaryUntilNextStart) return false;
    if (this.ttsActive) return true;
    if (this.acceptBinaryUntilMs && nowMs() <= this.acceptBinaryUntilMs) return true;
    return !this.lastTtsStartAtMs;
  }

  validateFrameProfile(arrayBuffer) {
    if (this.currentCodec() !== "pcm") return;
    const expectedBytes = this.profile.frameSamples * 2;
    if (!expectedBytes) return;
    const bytes = arrayBuffer?.byteLength || 0;
    if (bytes === expectedBytes) return;
    if (bytes > expectedBytes && bytes % expectedBytes === 0) {
      this.statsData.batchedFrameCount += Math.floor(bytes / expectedBytes);
      return;
    }
    this.statsData.profileMismatchCount += 1;
    this.statsData.lastProfileMismatch = `pcm bytes ${bytes}, expected ${expectedBytes}`;
  }

  decodeToAudioBuffer(arrayBuffer) {
    const codec = this.currentCodec();
    if (codec === "pcm") {
      return this.pcmToAudioBuffer(arrayBuffer);
    }
    if (codec === "opus") {
      return this.opusToAudioBuffer(arrayBuffer);
    }
    throw new Error(`不支持的下行音频编码: ${codec}`);
  }

  pcmToAudioBuffer(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const samples = Math.floor(view.byteLength / 2);
    const output = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const value = view.getInt16(i * 2, true);
      output[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
    }
    return this.floatToAudioBuffer(output, this.profile.sampleRate);
  }

  opusToAudioBuffer(arrayBuffer) {
    const decoder = this.getOpusDecoder();
    const pcm = decoder.decode(new Uint8Array(arrayBuffer));
    const output = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      output[i] = pcm[i] < 0 ? pcm[i] / 0x8000 : pcm[i] / 0x7fff;
    }
    return this.floatToAudioBuffer(output, this.profile.sampleRate);
  }

  floatToAudioBuffer(samples, sampleRate) {
    if (!samples.length) {
      throw new Error("空音频帧");
    }
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  flushPending() {
    if (!this.pendingBuffers.length || !this.context || !this.unlocked || this.muted) return;
    const buffers = this.pendingBuffers;
    this.pendingBuffers = [];
    this.pendingMs = 0;
    for (const buffer of buffers) {
      this.scheduleBuffer(buffer);
    }
    this.updateStatusAfterQueue();
  }

  scheduleBuffer(buffer) {
    const now = this.context.currentTime;
    const queueLeadMs = this.nextPlayTime ? (this.nextPlayTime - now) * 1000 : 0;
    this.statsData.lastQueueLeadMs = Math.round(queueLeadMs);
    if (!this.nextPlayTime || queueLeadMs < this.lowWatermarkMs) {
      this.statsData.lowWatermarkCount += 1;
    }
    if (!this.nextPlayTime || queueLeadMs < 20) {
      this.statsData.underflowCount += 1;
      this.statsData.lastUnderflowAt = new Date().toISOString();
      if (this.sentenceScheduledFrames === 0) {
        this.statsData.startupUnderflowCount += 1;
      } else {
        this.statsData.midSentenceUnderflowCount += 1;
      }
      this.nextPlayTime = now + this.resumeLeadMs / 1000;
      this.forceNextFadeIn = true;
    }
    if ((this.nextPlayTime - now) * 1000 > this.maxBufferMs) {
      const dropped = this.stopScheduledSources("queue_overflow");
      this.statsData.droppedFrames += Math.max(1, dropped);
      this.statsData.lastDropReason = "queue_overflow";
      this.nextPlayTime = now + this.resumeLeadMs / 1000;
      this.forceNextFadeIn = true;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ensureOutputChain() || this.context.destination);
    source.onended = () => {
      this.sources.delete(source);
      if (this.cancelledSources.delete(source)) {
        this.updateStatusAfterQueue();
        return;
      }
      this.statsData.playedFrames += 1;
      this.updateStatusAfterQueue();
    };
    source.start(this.nextPlayTime);
    this.sources.add(source);
    this.statsData.activeSourceCountMax = Math.max(this.statsData.activeSourceCountMax, this.sources.size);
    this.statsData.scheduledFrames += 1;
    this.sentenceScheduledFrames += 1;
    this.nextPlayTime += buffer.duration;
    this.setStatus("playing");
  }

  prepareDecodedBuffer(buffer) {
    this.recordBufferQuality(buffer);
    const prepared = this.smoothBoundaryIfNeeded(buffer);
    this.captureTailSample(prepared);
    return prepared;
  }

  recordBufferQuality(buffer) {
    const samples = readFirstChannel(buffer);
    if (!samples.length) return;
    let peak = 0;
    let sumSquares = 0;
    let clipping = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      peak = Math.max(peak, abs);
      sumSquares += samples[i] * samples[i];
      if (abs >= 0.985) clipping += 1;
    }
    const rms = Math.sqrt(sumSquares / samples.length);
    const peakDb = amplitudeToDb(peak);
    const rmsDb = amplitudeToDb(rms);
    this.statsData.analyzedSampleCount += samples.length;
    this.statsData.clippingSampleCount += clipping;
    if (clipping) this.statsData.clippingFrameCount += 1;
    this.statsData.peakDbMax = Math.max(this.statsData.peakDbMax, peakDb);
    this.statsData.rmsDbLast = rmsDb;
    this.statsData.clippingSampleRatio = this.statsData.analyzedSampleCount
      ? this.statsData.clippingSampleCount / this.statsData.analyzedSampleCount
      : 0;
    if (this.hasLastBoundaryTailSample) {
      const jump = Math.abs(samples[0] - this.lastBoundaryTailSample);
      this.statsData.boundaryJumpMax = Math.max(this.statsData.boundaryJumpMax, roundTo(jump, 4));
      if (jump >= this.boundaryJumpThreshold) {
        this.statsData.boundaryJumpCount += 1;
      }
    }
  }

  smoothBoundaryIfNeeded(buffer) {
    if (!this.artifactGuardEnabled || !this.boundarySmoothingMs || !buffer?.length) return buffer;
    const samples = readFirstChannel(buffer);
    if (!samples.length) return buffer;
    const firstSample = samples[0] || 0;
    const jump = this.hasLastBoundaryTailSample
      ? Math.abs(firstSample - this.lastBoundaryTailSample)
      : 0;
    const shouldSmooth = this.forceNextFadeIn || (this.hasLastBoundaryTailSample && jump >= this.boundaryJumpThreshold);
    if (!shouldSmooth) return buffer;
    const next = cloneAudioBuffer(this.context, buffer);
    const channel = next.getChannelData(0);
    const smoothingSamples = Math.min(channel.length, Math.max(1, Math.round(next.sampleRate * this.boundarySmoothingMs / 1000)));
    const startValue = this.forceNextFadeIn
      ? 0
      : this.lastBoundaryTailSample;
    for (let i = 0; i < smoothingSamples; i++) {
      const t = (i + 1) / smoothingSamples;
      channel[i] = startValue * (1 - t) + channel[i] * t;
    }
    this.statsData.smoothedBoundaryCount += 1;
    this.forceNextFadeIn = false;
    return next;
  }

  captureTailSample(buffer) {
    const samples = readFirstChannel(buffer);
    if (!samples.length) return;
    this.lastBoundaryTailSample = samples[samples.length - 1] || 0;
    this.hasLastBoundaryTailSample = true;
  }

  ensureOutputChain() {
    if (!this.context) return null;
    if (!this.outputGain) {
      this.outputGain = this.context.createGain();
      this.outputGain.gain.value = this.outputGainValue;
    }
    if (!this.limiter && this.context.createDynamicsCompressor) {
      this.limiter = this.context.createDynamicsCompressor();
      this.limiter.threshold.value = this.limiterThresholdDb;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = this.limiterRatio;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.08;
      this.rebuildOutputChain();
    } else if (!this.outputChainConnected) {
      this.rebuildOutputChain();
    }
    return this.outputGain;
  }

  rebuildOutputChain() {
    if (!this.context || !this.outputGain) return;
    try {
      this.outputGain.disconnect();
    } catch {
      // Ignore disconnected nodes.
    }
    try {
      this.limiter?.disconnect();
    } catch {
      // Ignore disconnected nodes.
    }
    if (this.limiterEnabled && this.limiter) {
      this.outputGain.connect(this.limiter);
      this.limiter.connect(this.context.destination);
    } else {
      this.outputGain.connect(this.context.destination);
    }
    this.outputChainConnected = true;
  }

  setOutputGain(value) {
    this.outputGainValue = value;
    if (!this.outputGain || !this.context) return;
    const now = this.context.currentTime;
    this.outputGain.gain.cancelScheduledValues(now);
    this.outputGain.gain.setTargetAtTime(value, now, 0.015);
  }

  updatePlatformSnapshot() {
    const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
    this.platformSnapshot = {
      userAgent,
      isMobile: /android|iphone|ipad|ipod|mobile/i.test(userAgent),
      isWeChat: /micromessenger/i.test(userAgent),
      audioContextSampleRate: this.context?.sampleRate || null,
      audioContextBaseLatency: this.context?.baseLatency ?? null,
      audioContextOutputLatency: this.context?.outputLatency ?? null,
      micActive: this.micActive,
      playbackCodec: this.currentCodec(),
      artifactGuardEnabled: this.artifactGuardEnabled
    };
    return this.platformSnapshot;
  }

  stopScheduledSources(reason) {
    let stopped = 0;
    for (const source of this.sources) {
      try {
        this.cancelledSources.add(source);
        source.stop();
        stopped += 1;
      } catch {
        // Ignore ended sources.
      }
    }
    this.sources.clear();
    this.statsData.lastClearReason = reason;
    return stopped;
  }

  getOpusDecoder() {
    if (!OPUS_SAMPLE_RATES.has(this.profile.sampleRate)) {
      throw new Error("Opus 下行采样率必须是 8000/12000/16000/24000/48000Hz");
    }
    const key = `${this.profile.sampleRate}:1`;
    if (this.decoder && this.decoderKey === key) return this.decoder;
    this.destroyDecoder();
    this.decoder = createOpusDecoder(this.profile.sampleRate);
    this.decoderKey = key;
    return this.decoder;
  }

  destroyDecoder() {
    this.decoder?.destroy();
    this.decoder = null;
    this.decoderKey = "";
  }

  playSilentUnlockFrame() {
    if (!this.context) return;
    const buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ensureOutputChain() || this.context.destination);
    source.start(0);
  }

  updateStatusAfterQueue() {
    if (!this.unlocked) {
      this.setStatus("locked");
      return;
    }
    if (this.muted) {
      this.setStatus("muted");
      return;
    }
    if (this.pendingBuffers.length) {
      this.setStatus("buffering");
      return;
    }
    if (this.sources.size) {
      this.setStatus("playing");
      return;
    }
    this.setStatus("ready");
  }

  statusForIdle() {
    if (!this.unlocked) return "locked";
    if (this.muted) return "muted";
    return "ready";
  }

  setStatus(status) {
    if (this.status === status) {
      this.onState?.(this.stats());
      return;
    }
    this.status = status;
    this.onState?.(this.stats());
  }
}

function createStats() {
  return {
    receivedFrames: 0,
    receivedBytes: 0,
    scheduledFrames: 0,
    playedFrames: 0,
    droppedFrames: 0,
    underflowCount: 0,
    startupUnderflowCount: 0,
    midSentenceUnderflowCount: 0,
    lowWatermarkCount: 0,
    decodedFrames: 0,
    decodeTotalMs: 0,
    decodeMaxMs: 0,
    analyzedSampleCount: 0,
    clippingSampleCount: 0,
    clippingSampleRatio: 0,
    clippingFrameCount: 0,
    peakDbMax: -120,
    rmsDbLast: -120,
    boundaryJumpCount: 0,
    boundaryJumpMax: 0,
    smoothedBoundaryCount: 0,
    lateFrameDroppedCount: 0,
    activeSourceCountMax: 0,
    limiterReductionMaxDb: 0,
    profileMismatchCount: 0,
    batchedFrameCount: 0,
    decodeErrors: 0,
    lastError: "",
    lastDropReason: "",
    lastClearReason: "",
    lastUnderflowAt: "",
    lastQueueLeadMs: 0,
    lastLateFrameAt: "",
    lastLateFrameGeneration: 0,
    lastProfileMismatch: "",
    codecSource: "profile"
  };
}

function normalizeProfile(profile) {
  const sampleRate = Number(profile.sampleRate || profile.sample_rate || DEFAULT_PROFILE.sampleRate);
  const frameDuration = Number(profile.frameDuration || profile.frame_duration || DEFAULT_PROFILE.frameDuration);
  return {
    format: normalizeCodec(profile.format || DEFAULT_PROFILE.format),
    sampleRate,
    frameDuration,
    channels: 1,
    frameSamples: Math.round(sampleRate * frameDuration / 1000)
  };
}

function normalizeCodec(value) {
  const codec = String(value || "").toLowerCase();
  return codec === "pcm" ? "pcm" : "opus";
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function nowMs() {
  return window.performance?.now ? window.performance.now() : Date.now();
}

function readFirstChannel(buffer) {
  if (!buffer?.numberOfChannels || !buffer.length) return new Float32Array(0);
  return buffer.getChannelData(0);
}

function cloneAudioBuffer(context, buffer) {
  const next = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    next.copyToChannel(buffer.getChannelData(channel), channel);
  }
  return next;
}

function amplitudeToDb(value) {
  const safe = Math.max(0, Number(value) || 0);
  if (safe <= 0.000001) return -120;
  return Math.max(-120, roundTo(20 * Math.log10(safe), 1));
}

function roundTo(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function createOpusDecoder(sampleRate) {
  const mod = window.Module?.instance || window.ModuleInstance;
  if (!mod) {
    throw new Error("libopus is not loaded");
  }
  const channels = 1;
  const decoderSize = mod._opus_decoder_get_size(channels);
  const decoderPtr = mod._malloc(decoderSize);
  if (!decoderPtr) {
    throw new Error("cannot allocate opus decoder");
  }
  const err = mod._opus_decoder_init(decoderPtr, sampleRate, channels);
  if (err < 0) {
    mod._free(decoderPtr);
    throw new Error(`opus decoder init failed: ${err}`);
  }

  return {
    decode(packet) {
      const dataPtr = mod._malloc(packet.byteLength);
      if (!dataPtr) throw new Error("cannot allocate opus packet");
      try {
        mod.HEAPU8.set(packet, dataPtr);
        const packetSamples = mod._opus_packet_get_nb_samples(dataPtr, packet.byteLength, sampleRate);
        const frameSamples = Math.max(packetSamples > 0 ? packetSamples : 0, Math.ceil(sampleRate * 0.12));
        const pcmPtr = mod._malloc(frameSamples * channels * 2);
        if (!pcmPtr) throw new Error("cannot allocate opus pcm buffer");
        try {
          const decoded = mod._opus_decode(decoderPtr, dataPtr, packet.byteLength, pcmPtr, frameSamples, 0);
          if (decoded < 0) {
            throw new Error(`opus decode failed: ${decoded}`);
          }
          const output = new Int16Array(decoded * channels);
          for (let i = 0; i < output.length; i++) {
            output[i] = mod.HEAP16[(pcmPtr >> 1) + i];
          }
          return output;
        } finally {
          mod._free(pcmPtr);
        }
      } finally {
        mod._free(dataPtr);
      }
    },
    destroy() {
      if (decoderPtr) {
        mod._free(decoderPtr);
      }
    }
  };
}
