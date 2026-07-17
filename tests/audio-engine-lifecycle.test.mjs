import test from "node:test";
import assert from "node:assert/strict";

import { AudioOperationCancelledError, AudioStreamer } from "../src/core/audio-engine.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class MemoryStore {
  constructor() {
    this.events = [];
  }

  add(event) {
    this.events.push(event);
  }
}

class FakeWsClient {
  constructor() {
    this.activeAttemptId = 1;
    this.isConnected = true;
    this.json = [];
    this.binary = [];
  }

  sendJson(payload, options = {}) {
    this.assertAttempt(options.attemptId);
    this.json.push({ payload, attemptId: options.attemptId });
  }

  sendBinary(payload, label, options = {}) {
    this.assertAttempt(options.attemptId);
    this.binary.push({ payload, label, attemptId: options.attemptId });
  }

  assertAttempt(attemptId) {
    if (attemptId !== this.activeAttemptId) {
      const error = new Error("stale attempt");
      error.code = "WS_ATTEMPT_CANCELLED";
      throw error;
    }
  }
}

function createTrack() {
  return {
    stopped: 0,
    stop() {
      this.stopped += 1;
    }
  };
}

function createStream(track = createTrack()) {
  return {
    track,
    getTracks() {
      return [track];
    }
  };
}

function createNode() {
  return {
    connected: [],
    disconnected: 0,
    connect(target) {
      this.connected.push(target);
    },
    disconnect() {
      this.disconnected += 1;
    }
  };
}

function createAudioContext(options = {}) {
  const source = createNode();
  const gain = createNode();
  gain.gain = { value: 1 };
  const processor = createNode();
  processor.onaudioprocess = null;
  return {
    state: options.state || "running",
    sampleRate: 16000,
    destination: {},
    audioWorklet: options.audioWorklet || null,
    source,
    gain,
    processor,
    resumed: 0,
    closed: 0,
    async resume() {
      this.resumed += 1;
      if (options.resumePromise) await options.resumePromise;
      this.state = "running";
    },
    createMediaStreamSource() {
      return source;
    },
    createGain() {
      return gain;
    },
    createScriptProcessor() {
      return processor;
    },
    async close() {
      this.closed += 1;
    }
  };
}

function createHarness(options = {}) {
  const wsClient = options.wsClient || new FakeWsClient();
  const store = new MemoryStore();
  const states = [];
  const profile = { format: "pcm", sampleRate: 16000, frameDuration: 20, frameSamples: 320 };
  const streamer = new AudioStreamer({
    wsClient,
    store,
    getProfile: () => profile,
    getSessionId: () => "session-1",
    getMicConstraints: () => ({}),
    onState: (state) => states.push(state),
    getUserMedia: options.getUserMedia,
    AudioContextClass: options.AudioContextClass,
    AudioWorkletNodeClass: options.AudioWorkletNodeClass,
    sleepFn: options.sleepFn,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn
  });
  return { streamer, wsClient, store, states, profile };
}

test("stop cancels pending getUserMedia and disposes the late stream", async () => {
  const permission = deferred();
  const stream = createStream();
  const context = createAudioContext();
  const { streamer, wsClient } = createHarness({
    getUserMedia: () => permission.promise,
    AudioContextClass: class {
      constructor() {
        return context;
      }
    }
  });

  const starting = streamer.startMic();
  assert.equal(streamer.mode, "mic_pending");
  streamer.stop();
  permission.resolve(stream);

  await assert.rejects(starting, AudioOperationCancelledError);
  assert.equal(stream.track.stopped, 1);
  assert.equal(context.closed, 0);
  assert.equal(wsClient.json.length, 0);
  assert.equal(streamer.mode, "idle");
});

test("stop during AudioContext.resume cleans stream and context without listen:start", async () => {
  const resumed = deferred();
  const stream = createStream();
  const context = createAudioContext({ state: "suspended", resumePromise: resumed.promise });
  const { streamer, wsClient } = createHarness({
    getUserMedia: async () => stream,
    AudioContextClass: class {
      constructor() {
        return context;
      }
    }
  });

  const starting = streamer.startMic();
  await tick();
  streamer.stop();
  resumed.resolve();

  await assert.rejects(starting, AudioOperationCancelledError);
  assert.equal(stream.track.stopped, 1);
  assert.equal(context.closed, 1);
  assert.equal(wsClient.json.length, 0);
  assert.equal(streamer.mode, "idle");
});

test("stop during audioWorklet loading never creates a processor or starts listening", async () => {
  const moduleLoaded = deferred();
  const stream = createStream();
  const context = createAudioContext({
    audioWorklet: {
      addModule() {
        return moduleLoaded.promise;
      }
    }
  });
  let workletNodes = 0;
  const { streamer, wsClient } = createHarness({
    getUserMedia: async () => stream,
    AudioContextClass: class {
      constructor() {
        return context;
      }
    },
    AudioWorkletNodeClass: class {
      constructor() {
        workletNodes += 1;
      }
    }
  });

  const starting = streamer.startMic();
  await tick();
  streamer.stop();
  moduleLoaded.resolve();

  await assert.rejects(starting, AudioOperationCancelledError);
  assert.equal(workletNodes, 0);
  assert.equal(stream.track.stopped, 1);
  assert.equal(context.closed, 1);
  assert.equal(wsClient.json.length, 0);
});

test("normal mic sends one start/stop pair and stale processor callbacks cannot reach a new attempt", async () => {
  const firstStream = createStream();
  const secondStream = createStream();
  const firstContext = createAudioContext();
  const secondContext = createAudioContext();
  const streams = [firstStream, secondStream];
  const contexts = [firstContext, secondContext];
  const { streamer, wsClient, profile } = createHarness({
    getUserMedia: async () => streams.shift(),
    AudioContextClass: class {
      constructor() {
        return contexts.shift();
      }
    }
  });

  await streamer.startMic();
  const staleProcessor = firstContext.processor;
  staleProcessor.onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array(profile.frameSamples) }
  });
  assert.equal(wsClient.binary.length, 1);
  streamer.stop();

  wsClient.activeAttemptId = 2;
  await streamer.startMic();
  staleProcessor.onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array(profile.frameSamples) }
  });
  assert.equal(wsClient.binary.length, 1);
  streamer.stop();

  assert.deepEqual(
    wsClient.json.map(({ payload, attemptId }) => [payload.state, attemptId]),
    [["start", 1], ["stop", 1], ["start", 2], ["stop", 2]]
  );
  assert.equal(firstStream.track.stopped, 1);
  assert.equal(secondStream.track.stopped, 1);
  assert.equal(streamer.mode, "idle");
});

test("an old file stream cannot send frames or finally listen:stop to a replacement socket", async () => {
  const sleeping = deferred();
  const { streamer, wsClient, store, profile } = createHarness({ sleepFn: () => sleeping.promise });
  const pcm = new Int16Array(profile.frameSamples);

  const streaming = streamer.streamPCM(pcm, profile, "test", { trailingSilenceMs: 0 });
  await tick();
  assert.deepEqual(wsClient.json.map(({ payload, attemptId }) => [payload.state, attemptId]), [["start", 1]]);
  assert.equal(wsClient.binary.length, 1);

  wsClient.activeAttemptId = 2;
  sleeping.resolve();
  await streaming;

  assert.equal(wsClient.json.length, 1);
  assert.equal(wsClient.binary.length, 1);
  assert.equal(store.events.some((event) => event.error?.includes("listen stop")), false);
  assert.equal(streamer.mode, "idle");
});
