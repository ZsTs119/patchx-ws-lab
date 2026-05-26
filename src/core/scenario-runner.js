export class ScenarioRunner {
  constructor({ store, wsClient, api, getHello, getText, getFilters, getWsUrl, getIdentity, getCapabilities, tools = {} }) {
    this.store = store;
    this.wsClient = wsClient;
    this.api = api;
    this.getHello = getHello;
    this.getText = getText;
    this.getFilters = getFilters;
    this.getWsUrl = getWsUrl;
    this.getIdentity = getIdentity;
    this.getCapabilities = getCapabilities;
    this.tools = tools;
  }

  async runRoleTextSmoke(wsUrl, identity) {
    const startedAt = performance.now();
    const steps = [];

    try {
      if (!this.wsClient.isConnected) {
        steps.push({ name: "connect", status: "running" });
        this.tools.validateConnection?.();
        await this.wsClient.connect(wsUrl, identity);
        this.markLastStep(steps, "pass");
      }

      steps.push({ name: "hello", status: "running" });
      this.wsClient.sendJson(this.getHello());
      await this.waitFor((event) => event.payload?.type === "hello" && event.payload?.session_id, 12000);
      this.markLastStep(steps, "pass");

      steps.push({ name: "text", status: "running" });
      this.wsClient.sendTextListen(this.getText(), this.wsClient.sessionId);
      const responseEvent = await this.waitFor((event) => isUsefulServerResponse(event), 12000);
      this.markLastStep(steps, "pass", responseEvent.type);

      const canReadLogs = this.hasCapability("logs");
      let evidencePayload = null;
      let degraded = false;
      if (canReadLogs) {
        steps.push({ name: "logs", status: "running" });
        const [logs, evidence] = await Promise.all([
          this.api.logs({ ...this.getFilters(), limit: 80 }),
          this.api.logsSummary({ ...this.getFilters(), limit: 500 })
        ]);
        const matched = logs.summary?.total_matched ?? logs.entries?.length ?? 0;
        this.markLastStep(steps, "pass", `${matched} matched`);
        evidencePayload = {
          log_file: logs.log_file,
          log_summary: logs.summary,
          log_findings: evidence.findings || [],
          milestones: evidence.milestones || {},
          role_evidence: evidence.role_evidence || {}
        };
      } else {
        degraded = true;
        steps.push({ name: "logs", status: "skipped", note: "日志证据不可用" });
      }

      return {
        ok: true,
        name: "role-text-smoke",
        status: degraded ? "degraded" : "pass",
        degraded,
        warnings: degraded ? ["目标环境缺少日志证据，已按仅协议冒烟降级验收。"] : [],
        durationMs: Math.round(performance.now() - startedAt),
        steps,
        evidence: evidencePayload
      };
    } catch (error) {
      this.markLastStep(steps, "fail", error.message);
      return {
        ok: false,
        name: "role-text-smoke",
        durationMs: Math.round(performance.now() - startedAt),
        steps,
        error: error.message
      };
    }
  }

  async runDslScenario(scenario) {
    const startedAt = performance.now();
    const steps = [];
    let degraded = false;
    const warnings = [];
    try {
      for (const step of scenario.steps || []) {
        steps.push({ name: step.action, status: "running" });
        if (step.action === "connect_ws") {
          this.tools.validateConnection?.();
          await this.wsClient.connect(this.getWsUrl(), this.getIdentity());
          this.markLastStep(steps, "pass");
        } else if (step.action === "connect_hello") {
          await this.tools.connectHello?.();
          if (step.wait_session !== false) {
            const event = await this.waitFor((candidate) => candidate.payload?.type === "hello" && candidate.payload?.session_id, step.timeout_ms || 12000);
            this.markLastStep(steps, "pass", event.payload.session_id);
          } else {
            this.markLastStep(steps, "pass");
          }
        } else if (step.action === "disconnect") {
          this.wsClient.disconnect();
          if (step.wait_ms) await sleep(step.wait_ms);
          this.markLastStep(steps, "pass");
        } else if (step.action === "wait") {
          await sleep(step.timeout_ms || step.ms || 500);
          this.markLastStep(steps, "pass");
        } else if (step.action === "set_audio_profile") {
          this.tools.setAudioProfile?.(step.profile || step);
          this.markLastStep(steps, "pass", profileNote(step.profile || step));
        } else if (step.action === "stream_silence") {
          const before = this.store.summary();
          await this.tools.streamSilence?.(step.duration_ms || 320);
          const after = this.store.summary();
          const delta = {
            outboundBinary: after.outboundBinary - before.outboundBinary,
            outboundBytes: after.outboundBytes - before.outboundBytes,
            inboundBinary: after.inboundBinary - before.inboundBinary,
            inboundBytes: after.inboundBytes - before.inboundBytes
          };
          if (step.min_outbound_binary && delta.outboundBinary < step.min_outbound_binary) {
            throw new Error(`outbound audio frames too low: ${delta.outboundBinary}`);
          }
          if (step.min_outbound_bytes && delta.outboundBytes < step.min_outbound_bytes) {
            throw new Error(`outbound audio bytes too low: ${delta.outboundBytes}`);
          }
          this.markLastStep(steps, "pass", `${delta.outboundBinary} frames/${delta.outboundBytes}B`);
        } else if (step.action === "stream_tts") {
          if (!this.tools.streamGeneratedTts) {
            throw new Error("stream_tts tool is unavailable");
          }
          const expectedEvents = normalizeExpectedEvents(step.expect_during || step.expectDuring);
          const eventWatchers = expectedEvents.map((expectation) => this.waitFor(
            (candidate) => matchesEvent(candidate, expectation),
            expectation.timeout_ms || step.timeout_ms || 12000
          ).then((event) => ({ event }), (error) => ({ error })));
          const before = this.store.summary();
          let data;
          let matchedEvents = [];
          try {
            data = await this.tools.streamGeneratedTts(this.resolveText(step.text || this.getText()), step);
            const watched = expectedEvents.length ? await Promise.all(eventWatchers) : [];
            const failed = watched.find((item) => item.error);
            if (failed) {
              throw failed.error;
            }
            matchedEvents = watched.map((item) => item.event);
          } catch (error) {
            throw error;
          }
          const after = this.store.summary();
          const delta = {
            outboundBinary: after.outboundBinary - before.outboundBinary,
            outboundBytes: after.outboundBytes - before.outboundBytes,
            inboundBinary: after.inboundBinary - before.inboundBinary,
            inboundBytes: after.inboundBytes - before.inboundBytes
          };
          if (step.min_outbound_binary && delta.outboundBinary < step.min_outbound_binary) {
            throw new Error(`outbound audio frames too low: ${delta.outboundBinary}`);
          }
          if (step.min_outbound_bytes && delta.outboundBytes < step.min_outbound_bytes) {
            throw new Error(`outbound audio bytes too low: ${delta.outboundBytes}`);
          }
          const eventNote = matchedEvents.length
            ? `; ${matchedEvents.map((event) => eventNoteFor(event)).join(", ")}`
            : "";
          this.markLastStep(steps, "pass", `${data?.speech ? "speech" : "tone"} ${delta.outboundBinary} frames/${delta.outboundBytes}B${eventNote}`);
        } else if (step.action === "send_json") {
          this.wsClient.sendJson(this.withSession(this.resolve(step.payload || {})));
          this.markLastStep(steps, "pass");
        } else if (step.action === "send_hello") {
          const set = JSON.parse(this.resolveText(JSON.stringify(step.set || {})));
          this.wsClient.sendJson(applyOverrides(this.getHello(), set, step.omit || []));
          this.tools.markHelloSent?.();
          this.markLastStep(steps, "pass");
        } else if (step.action === "send_raw") {
          this.wsClient.sendRaw(this.resolveText(step.text || ""), step.label || "raw");
          this.markLastStep(steps, "pass");
        } else if (step.action === "send_text") {
          this.wsClient.sendTextListen(this.resolveText(step.text || this.getText()), this.wsClient.sessionId);
          this.markLastStep(steps, "pass");
        } else if (step.action === "wait_ws") {
          const event = await this.waitFor((candidate) => matchesEvent(candidate, step), step.timeout_ms || 8000);
          this.markLastStep(steps, "pass", event.type);
        } else if (step.action === "expect_no_ws") {
          await this.expectNoEvent(step);
          this.markLastStep(steps, "pass");
        } else if (step.action === "expect_binary") {
          const event = await this.waitFor((candidate) => candidate.kind === "binary" && candidate.direction === "server", step.timeout_ms || 8000);
          this.markLastStep(steps, "pass", `${event.bytes || 0} bytes`);
        } else if (step.action === "log_summary") {
          if (!this.hasCapability("logs")) {
            degraded = true;
            warnings.push("日志证据不可用，log_summary 已跳过。");
            this.markLastStep(steps, "skipped", "日志证据不可用");
            continue;
          }
          const summary = await this.api.logsSummary({ ...this.getFilters(), limit: 500 });
          const milestone = step.min_milestone;
          if (milestone && (summary.milestones?.[milestone] || 0) <= 0) {
            throw new Error(`log milestone missing: ${milestone}`);
          }
          this.markLastStep(steps, "pass", `${summary.findings?.length || 0} findings`);
        } else if (step.action === "log_expect") {
          if (!this.hasCapability("logs")) {
            degraded = true;
            warnings.push("日志证据不可用，log_expect 已跳过。");
            this.markLastStep(steps, "skipped", "日志证据不可用");
            continue;
          }
          const keywords = normalizeKeywords(step);
          const anyKeywords = normalizeAnyKeywords(step);
          if (!keywords.length && !anyKeywords.length) {
            throw new Error("log_expect requires keyword, keywords, any_keyword or any_keywords");
          }
          const matches = [];
          for (const keyword of keywords) {
            const matched = await this.waitForLogKeyword(keyword, step);
            const minimum = step.min_matches || 1;
            if (matched < minimum) {
              throw new Error(`log keyword missing: ${keyword}`);
            }
            matches.push(`${keyword}:${matched}`);
          }
          if (anyKeywords.length) {
            const matched = await this.waitForAnyLogKeyword(anyKeywords, step);
            if (!matched) {
              throw new Error(`log keyword missing one of: ${anyKeywords.join(", ")}`);
            }
            matches.push(`${matched.keyword}:${matched.count}`);
          }
          this.markLastStep(steps, "pass", matches.join(", "));
        } else {
          throw new Error(`unsupported scenario action: ${step.action}`);
        }
      }
      return {
        ok: true,
        name: scenario.id,
        status: degraded ? "degraded" : "pass",
        degraded,
        warnings,
        durationMs: Math.round(performance.now() - startedAt),
        steps
      };
    } catch (error) {
      this.markLastStep(steps, "fail", error.message);
      return {
        ok: false,
        name: scenario.id,
        durationMs: Math.round(performance.now() - startedAt),
        steps,
        error: error.message
      };
    }
  }

  expectNoEvent(step) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        unsubscribe();
        resolve();
      }, step.timeout_ms || 1000);

      const unsubscribe = this.store.subscribe((event) => {
        if (!event) return;
        if (matchesEvent(event, step)) {
          window.clearTimeout(timer);
          unsubscribe();
          reject(new Error(`unexpected event: ${event.type}`));
        }
      });
    });
  }

  withSession(payload) {
    const next = { ...payload };
    if (this.wsClient.sessionId && !next.session_id && next.type !== "hello") {
      next.session_id = this.wsClient.sessionId;
    }
    return next;
  }

  resolve(payload) {
    return JSON.parse(this.resolveText(JSON.stringify(payload)));
  }

  resolveText(text) {
    return String(text)
      .replaceAll("{{session_id}}", this.wsClient.sessionId || "")
      .replaceAll("{{text}}", this.getText());
  }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        unsubscribe();
        reject(new Error(`wait timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsubscribe = this.store.subscribe((event) => {
        if (!event) return;
        if (predicate(event)) {
          window.clearTimeout(timer);
          unsubscribe();
          resolve(event);
        }
      });
    });
  }

  markLastStep(steps, status, note = "") {
    if (!steps.length) return;
    steps[steps.length - 1] = { ...steps[steps.length - 1], status, note };
  }

  hasCapability(key) {
    const snapshot = this.getCapabilities?.();
    return snapshot?.capabilities?.[key]?.status === "ok";
  }

  async waitForLogKeyword(keyword, step = {}) {
    const timeoutMs = step.timeout_ms || 5000;
    const intervalMs = step.interval_ms || 500;
    const minimum = step.min_matches || 1;
    const deadline = performance.now() + timeoutMs;
    let lastMatched = 0;
    do {
      const logs = await this.api.logs({ ...this.getFilters(), keyword, limit: step.limit || 500 });
      lastMatched = logs.summary?.total_matched ?? logs.entries?.length ?? 0;
      if (lastMatched >= minimum) {
        return lastMatched;
      }
      await sleep(intervalMs);
    } while (performance.now() < deadline);
    return lastMatched;
  }

  async waitForAnyLogKeyword(keywords, step = {}) {
    const timeoutMs = step.timeout_ms || 5000;
    const intervalMs = step.interval_ms || 500;
    const minimum = step.min_matches || 1;
    const deadline = performance.now() + timeoutMs;
    do {
      for (const keyword of keywords) {
        const logs = await this.api.logs({ ...this.getFilters(), keyword, limit: step.limit || 500 });
        const count = logs.summary?.total_matched ?? logs.entries?.length ?? 0;
        if (count >= minimum) {
          return { keyword, count };
        }
      }
      await sleep(intervalMs);
    } while (performance.now() < deadline);
    return null;
  }
}

function isUsefulServerResponse(event) {
  if (event.direction !== "server") return false;
  if (!event.payload || typeof event.payload !== "object") return event.kind === "binary";
  if (event.payload.type === "tts") {
    return ["sentence_start", "start", "sentence_end", "stop"].includes(event.payload.state);
  }
  return ["stt", "llm", "mcp", "service_status", "goodbye"].includes(event.payload.type);
}

function matchesEvent(event, step) {
  if (step.direction && event.direction !== step.direction) return false;
  if (step.kind && event.kind !== step.kind) return false;
  if (step.type && event.type !== step.type && event.payload?.type !== step.type) return false;
  if (step.state && event.payload?.state !== step.state) return false;
  if (step.reason && event.payload?.reason !== step.reason) return false;
  if (step.payload && typeof step.payload === "object") {
    for (const [key, value] of Object.entries(step.payload)) {
      if (event.payload?.[key] !== value) return false;
    }
  }
  return true;
}

function normalizeExpectedEvents(raw) {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function normalizeKeywords(step = {}) {
  const raw = step.keywords ?? step.keyword;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeAnyKeywords(step = {}) {
  const raw = step.any_keywords ?? step.any_keyword;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function eventNoteFor(event) {
  const payload = event.payload || {};
  return [payload.type || event.type || event.kind, payload.state, payload.reason].filter(Boolean).join("/");
}

function applyOverrides(payload, set = {}, omit = []) {
  const next = structuredClone(payload);
  for (const path of omit) {
    deletePath(next, path);
  }
  for (const [path, value] of Object.entries(set)) {
    setPath(next, path, value);
  }
  return next;
}

function deletePath(target, path) {
  const parts = path.split(".");
  let current = target;
  for (const key of parts.slice(0, -1)) {
    current = current?.[key];
    if (!current) return;
  }
  delete current[parts.at(-1)];
}

function setPath(target, path, value) {
  const parts = path.split(".");
  let current = target;
  for (const key of parts.slice(0, -1)) {
    current[key] ||= {};
    current = current[key];
  }
  current[parts.at(-1)] = value;
}

function profileNote(profile = {}) {
  return [profile.format, profile.sample_rate || profile.sampleRate, profile.frame_duration || profile.frameDuration].filter(Boolean).join("/");
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
