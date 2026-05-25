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
    this.maxBufferMs = 900;
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
    }
    if (state === "start") {
      this.clear("tts_start", { keepUnlocked: true, keepStats: true });
      this.ttsActive = true;
      this.codec = normalizeCodec(payload.audio_codec || this.codec || this.profile.format);
      this.setStatus(this.unlocked && !this.muted ? "buffering" : this.statusForIdle());
      return;
    }
    if (state === "sentence_start") {
      this.ttsActive = true;
      if (payload.audio_codec) this.codec = normalizeCodec(payload.audio_codec);
      if (this.unlocked && !this.muted && !this.sources.size) {
        this.setStatus("buffering");
      }
      return;
    }
    if (state === "stop") {
      this.ttsActive = false;
      const reason = payload.reason || "";
      if (reason === "interrupt" || reason === "abort") {
        this.clear(reason, { keepUnlocked: true, keepStats: true });
        return;
      }
      this.flushPending();
      this.updateStatusAfterQueue();
    }
  }

  async enqueueFrame(arrayBuffer) {
    this.statsData.receivedFrames += 1;
    this.statsData.receivedBytes += arrayBuffer?.byteLength || 0;
    if (!arrayBuffer?.byteLength) return this.stats();
    this.refreshProfile();
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
      const buffer = this.decodeToAudioBuffer(arrayBuffer);
      this.pendingBuffers.push(buffer);
      this.pendingMs += buffer.duration * 1000;
      if (this.pendingMs >= this.initialBufferMs || !this.ttsActive) {
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
    const queueDelayMs = this.context
      ? Math.max(0, Math.round((this.nextPlayTime - this.context.currentTime) * 1000 + this.pendingMs))
      : Math.round(this.pendingMs);
    return {
      ...this.statsData,
      status: this.status,
      unlocked: this.unlocked,
      muted: this.muted,
      codec: this.currentCodec(),
      sampleRate: this.profile.sampleRate,
      frameDuration: this.profile.frameDuration,
      queueDelayMs
    };
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
    if (!this.nextPlayTime || this.nextPlayTime < now + 0.02) {
      this.nextPlayTime = now + 0.06;
    }
    if ((this.nextPlayTime - now) * 1000 > this.maxBufferMs) {
      const dropped = this.stopScheduledSources("queue_overflow");
      this.statsData.droppedFrames += Math.max(1, dropped);
      this.statsData.lastDropReason = "queue_overflow";
      this.nextPlayTime = now + 0.06;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
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
    this.statsData.scheduledFrames += 1;
    this.nextPlayTime += buffer.duration;
    this.setStatus("playing");
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
    source.connect(this.context.destination);
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
    decodeErrors: 0,
    lastError: "",
    lastDropReason: "",
    lastClearReason: ""
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
