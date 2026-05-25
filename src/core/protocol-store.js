export class ProtocolStore {
  constructor() {
    this.events = [];
    this.listeners = new Set();
    this.lastTtsStopAt = "";
    this.postTtsStopBinary = 0;
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
    for (const listener of this.listeners) {
      listener(null, this.events);
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  summary() {
    return this.events.reduce(
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
  }
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
