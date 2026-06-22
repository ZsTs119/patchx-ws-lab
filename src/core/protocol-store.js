export class ProtocolStore {
  constructor() {
    this.events = [];
    this.listeners = new Set();
    this.lastTtsStopAt = "";
    this.postTtsStopBinary = 0;
    this.binaryMetricStartAt = 0;
  }

  add(event) {
    const normalized = normalizeEvent(event);
    if (normalized.direction === "server" && normalized.payload?.type === "tts" && normalized.payload?.state === "stop") {
      this.lastTtsStopAt = normalized.at;
    }
    if (normalized.direction === "server" && normalized.kind === "binary" && this.lastTtsStopAt) {
      normalized.afterTtsStop = true;
      this.postTtsStopBinary += 1;
    }
    this.events.unshift(normalized);
    if (this.events.length > 500) {
      this.events.length = 500;
    }
    for (const listener of this.listeners) {
      listener(normalized, this.events);
    }
    if (normalized.binaryPayload) {
      normalized.binaryPayload = null;
    }
    return normalized;
  }

  clear() {
    this.events = [];
    this.lastTtsStopAt = "";
    this.postTtsStopBinary = 0;
    this.binaryMetricStartAt = 0;
    for (const listener of this.listeners) {
      listener(null, this.events);
    }
  }

  markBinaryMetricsStart() {
    this.binaryMetricStartAt = Date.now();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  summary() {
    const summary = this.events.reduce(
      (acc, event) => {
        acc.total += 1;
        if (event.direction === "server") acc.server += 1;
        if (event.kind === "binary") {
          acc.binary += 1;
          if (event.direction === "server") {
            acc.inboundBinary += 1;
            acc.inboundBytes += event.bytes || 0;
          }
          if (event.direction === "client") {
            acc.outboundBinary += 1;
            acc.outboundBytes += event.bytes || 0;
          }
        }
        return acc;
      },
      { total: 0, server: 0, binary: 0, inboundBinary: 0, outboundBinary: 0, inboundBytes: 0, outboundBytes: 0, postTtsStopBinary: this.postTtsStopBinary }
    );
    summary.binary_cadence = this.binaryCadence();
    return summary;
  }

  binaryCadence(options = {}) {
    const direction = options.direction || "server";
    const targetFrameMs = Number(options.targetFrameMs || options.target_frame_ms || 0);
    const sinceMs = Number(options.sinceMs || options.since_ms || this.binaryMetricStartAt || 0);
    const burstThresholdMs = Number(options.burstThresholdMs || options.burst_threshold_ms || Math.max(8, targetFrameMs ? targetFrameMs / 3 : 0));

    const inWindow = (event) => {
      const timestamp = Date.parse(event.at || "");
      return Number.isFinite(timestamp) && (!sinceMs || timestamp >= sinceMs);
    };

    const binaryEvents = this.events
      .filter((event) => event.direction === direction && event.kind === "binary" && inWindow(event))
      .slice()
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    const intervals = [];
    for (let i = 1; i < binaryEvents.length; i++) {
      intervals.push(Date.parse(binaryEvents[i].at) - Date.parse(binaryEvents[i - 1].at));
    }

    const sorted = intervals.slice().sort((a, b) => a - b);
    const burstCount = burstThresholdMs > 0 ? intervals.filter((value) => value < burstThresholdMs).length : 0;

    const sentenceEnds = this.events
      .filter((event) => event.direction === "server" && event.payload?.type === "tts" && event.payload?.state === "sentence_end" && inWindow(event))
      .slice()
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const lastSentenceEnd = sentenceEnds[sentenceEnds.length - 1];
    let tailToSentenceEndMs = null;
    if (lastSentenceEnd && binaryEvents.length) {
      const sentenceEndAt = Date.parse(lastSentenceEnd.at);
      const previousBinary = binaryEvents.filter((event) => Date.parse(event.at) <= sentenceEndAt).at(-1);
      if (previousBinary) {
        tailToSentenceEndMs = sentenceEndAt - Date.parse(previousBinary.at);
      }
    }

    return {
      direction,
      sinceMs,
      targetFrameMs,
      burstThresholdMs,
      receivedFrames: binaryEvents.length,
      binaryFrameIntervalsMs: intervals,
      binaryFrameIntervalCount: intervals.length,
      binaryFrameIntervalMinMs: sorted.length ? sorted[0] : null,
      binaryFrameIntervalP50Ms: percentile(sorted, 0.5),
      binaryFrameIntervalP90Ms: percentile(sorted, 0.9),
      binaryFrameIntervalMaxMs: sorted.length ? sorted[sorted.length - 1] : null,
      binaryBurstCount: burstCount,
      tailToSentenceEndMs
    };
  }
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * ratio)));
  return sortedValues[index];
}

export function normalizeEvent(event) {
  const now = new Date();
  const originalPayload = event.payload ?? null;
  const binaryPayload = originalPayload instanceof ArrayBuffer || originalPayload instanceof Blob ? originalPayload : null;
  const payload = binaryPayload ? null : originalPayload;
  const kind = event.kind ?? (binaryPayload ? "binary" : inferKind(payload));
  const normalized = {
    id: `${now.getTime()}-${Math.random().toString(16).slice(2)}`,
    at: now.toISOString(),
    direction: event.direction ?? "system",
    kind,
    type: event.type ?? inferType(payload, kind),
    label: event.label ?? "",
    payload,
    bytes: event.bytes ?? 0,
    error: event.error ?? ""
  };
  if (binaryPayload) {
    Object.defineProperty(normalized, "binaryPayload", {
      value: binaryPayload,
      enumerable: false,
      writable: true
    });
  }
  return normalized;
}

export function eventText(event) {
  if (!event) return "";
  if (event.error) return event.error;
  if (event.kind === "binary") return `${event.bytes} bytes`;
  if (typeof event.payload === "string") return event.payload;
  if (!event.payload) return event.label || event.type;
  if (event.payload.text) return event.payload.text;
  if (event.payload.message) return event.payload.message;
  if (event.payload.state) return `${event.payload.type || event.type}:${event.payload.state}`;
  try {
    return JSON.stringify(event.payload);
  } catch {
    return String(event.payload);
  }
}

function inferKind(payload) {
  if (payload instanceof ArrayBuffer || payload instanceof Blob) return "binary";
  if (payload && typeof payload === "object") return "json";
  return "text";
}

function inferType(payload, kind) {
  if (kind === "binary") return "audio";
  if (payload && typeof payload === "object" && payload.type) return payload.type;
  return kind;
}
