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
    this.lastRestResponse = null;
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
          const wsUrl = connectionUrlForStep(this.getWsUrl(), step, step.query ? this.resolve(step.query) : {});
          await this.wsClient.connect(wsUrl, this.getIdentity());
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
          this.wsClient.disconnect({ userInitiated: true, reason: "scenario_disconnect" });
          if (step.wait_ms) await sleep(step.wait_ms);
          this.markLastStep(steps, "pass");
        } else if (step.action === "wait") {
          await sleep(step.timeout_ms || step.ms || 500);
          this.markLastStep(steps, "pass");
        } else if (step.action === "set_audio_profile") {
          this.tools.setAudioProfile?.(step.profile || step);
          this.markLastStep(steps, "pass", profileNote(step.profile || step));
        } else if (step.action === "set_playback_profile") {
          if (!this.tools.setPlaybackProfile) throw new Error("set_playback_profile tool is unavailable");
          this.tools.setPlaybackProfile(step.profile || step);
          this.markLastStep(steps, "pass", profileNote(step.profile || step));
        } else if (step.action === "set_mic_constraints") {
          if (!this.tools.setMicConstraints) throw new Error("set_mic_constraints tool is unavailable");
          this.tools.setMicConstraints(step.constraints || step);
          this.markLastStep(steps, "pass", micConstraintsNote(step.constraints || step));
        } else if (step.action === "set_playback_tuning") {
          if (!this.tools.setPlaybackTuning) throw new Error("set_playback_tuning tool is unavailable");
          this.tools.setPlaybackTuning(step.tuning || step);
          this.markLastStep(steps, "pass", playbackTuningNote(step.tuning || step));
        } else if (step.action === "unlock_playback") {
          if (!this.tools.unlockPlayback) throw new Error("unlock_playback tool is unavailable");
          await this.tools.unlockPlayback();
          this.markLastStep(steps, "pass");
        } else if (step.action === "start_mic") {
          if (!this.tools.startMic) throw new Error("start_mic tool is unavailable");
          await this.tools.startMic();
          this.markLastStep(steps, "pass");
        } else if (step.action === "stop_mic") {
          if (!this.tools.stopMic) throw new Error("stop_mic tool is unavailable");
          this.tools.stopMic();
          if (step.wait_ms) await sleep(step.wait_ms);
          this.markLastStep(steps, "pass");
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
          await this.tools.ensureWsReadyForScenarioSend?.();
          this.wsClient.sendTextListen(this.resolveText(step.text || this.getText()), this.wsClient.sessionId);
          this.markLastStep(steps, "pass");
        } else if (step.action === "wait_ws") {
          const event = await this.waitFor((candidate) => matchesEvent(candidate, step), step.timeout_ms || 8000);
          this.markLastStep(steps, "pass", event.type);
        } else if (step.action === "expect_no_ws") {
          await this.expectNoEvent(step);
          this.markLastStep(steps, "pass");
        } else if (step.action === "expect_conversation_contains") {
          const matched = await this.waitForUiText(step);
          this.markLastStep(steps, "pass", matched);
        } else if (step.action === "expect_connection_state") {
          const matched = await this.waitForConnectionState(step);
          this.markLastStep(steps, "pass", matched);
        } else if (step.action === "expect_binary") {
          const event = await this.waitFor((candidate) => candidate.kind === "binary" && candidate.direction === "server", step.timeout_ms || 8000);
          this.markLastStep(steps, "pass", `${event.bytes || 0} bytes`);
        } else if (step.action === "mark_binary_cadence") {
          if (!this.store.markBinaryMetricsStart) throw new Error("binary cadence marker is unavailable");
          this.store.markBinaryMetricsStart();
          this.markLastStep(steps, "pass");
        } else if (step.action === "expect_binary_cadence") {
          const stats = await this.expectBinaryCadence(step);
          this.markLastStep(steps, "pass", binaryCadenceNote(stats));
        } else if (step.action === "expect_playback_stats") {
          const stats = await this.expectPlaybackStats(step);
          this.markLastStep(steps, "pass", playbackStatsNote(stats));
        } else if (step.action === "expect_playback_quality") {
          const stats = await this.expectPlaybackQuality(step);
          this.markLastStep(steps, "pass", playbackQualityNote(stats));
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
        } else if (step.action === "rest_request") {
          const resolvedStep = this.resolve(step);
          const response = await this.api.request(resolvedStep.path, {
            method: resolvedStep.method,
            headers: resolvedStep.headers,
            body: resolvedStep.body,
            timeoutMs: resolvedStep.timeout_ms
          });
          this.lastRestResponse = response;
          const mismatch = restResponseMismatch(response, resolvedStep);
          if (mismatch) {
            throw new Error(mismatch);
          }
          this.markLastStep(steps, "pass", restResponseNote(response));
        } else if (step.action === "expect_rest") {
          if (!this.lastRestResponse) {
            throw new Error("expect_rest requires a previous rest_request step");
          }
          const resolvedStep = this.resolve(step);
          const mismatch = restResponseMismatch(this.lastRestResponse, resolvedStep);
          if (mismatch) {
            throw new Error(mismatch);
          }
          this.markLastStep(steps, "pass", restResponseNote(this.lastRestResponse));
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
    const identity = this.getIdentity?.() || {};
    return String(text)
      .replaceAll("{{session_id}}", this.wsClient.sessionId || "")
      .replaceAll("{{device_id}}", identity.deviceId || identity.device_id || "")
      .replaceAll("{{user_id}}", identity.userId || identity.user_id || "")
      .replaceAll("{{trace_id}}", identity.traceId || identity.trace_id || "")
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

  async waitForUiText(step = {}) {
    const timeoutMs = step.timeout_ms || 5000;
    const intervalMs = step.interval_ms || 120;
    const needles = [
      ...normalizeStringList(step.text),
      ...normalizeStringList(step.any_text),
      ...normalizeStringList(step.any_texts)
    ];
    if (!needles.length) {
      throw new Error("expect_conversation_contains requires text, any_text or any_texts");
    }
    const deadline = performance.now() + timeoutMs;
    do {
      const text = this.tools.getConversationText?.() || "";
      const matched = needles.find((needle) => text.includes(needle));
      if (matched) return matched;
      await sleep(intervalMs);
    } while (performance.now() < deadline);
    throw new Error(`conversation text missing one of: ${needles.join(", ")}`);
  }

  async waitForConnectionState(step = {}) {
    const timeoutMs = step.timeout_ms || 5000;
    const intervalMs = step.interval_ms || 120;
    const expected = normalizeStringList(step.one_of || step.states || step.state);
    if (!expected.length) {
      throw new Error("expect_connection_state requires state or one_of");
    }
    const deadline = performance.now() + timeoutMs;
    do {
      const state = this.tools.getConnectionState?.() || "";
      if (expected.includes(state)) return state;
      await sleep(intervalMs);
    } while (performance.now() < deadline);
    throw new Error(`connection state mismatch: expected ${expected.join(", ")}, got ${this.tools.getConnectionState?.() || ""}`);
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
    const filters = this.logFiltersForStep(step);
    let lastMatched = 0;
    do {
      const logs = await this.api.logs({ ...filters, keyword, limit: step.limit || 500 });
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
    const filters = this.logFiltersForStep(step);
    do {
      for (const keyword of keywords) {
        const logs = await this.api.logs({ ...filters, keyword, limit: step.limit || 500 });
        const count = logs.summary?.total_matched ?? logs.entries?.length ?? 0;
        if (count >= minimum) {
          return { keyword, count };
        }
      }
      await sleep(intervalMs);
    } while (performance.now() < deadline);
    return null;
  }

  logFiltersForStep(step = {}) {
    const filters = { ...this.getFilters() };
    const scope = String(step.log_scope || step.scope || "").trim().toLowerCase();
    if (scope === "trace") {
      delete filters.session_id;
    } else if (scope === "identity") {
      delete filters.session_id;
      delete filters.trace_id;
    } else if (scope === "global") {
      delete filters.device_id;
      delete filters.user_id;
      delete filters.session_id;
      delete filters.trace_id;
    }
    return filters;
  }

  async expectPlaybackStats(step = {}) {
    if (!this.tools.getPlaybackStats) {
      throw new Error("expect_playback_stats tool is unavailable");
    }
    const timeoutMs = step.timeout_ms || 5000;
    const intervalMs = step.interval_ms || 120;
    const deadline = performance.now() + timeoutMs;
    let lastError = "";
    let lastStats = null;
    do {
      lastStats = this.tools.getPlaybackStats() || {};
      lastError = playbackStatsMismatch(lastStats, step);
      if (!lastError) return lastStats;
      await sleep(intervalMs);
    } while (performance.now() < deadline);
    throw new Error(lastError || "playback stats expectation failed");
  }

  async expectBinaryCadence(step = {}) {
    if (!this.store.binaryCadence) {
      throw new Error("binary cadence stats are unavailable");
    }
    const timeoutMs = step.timeout_ms || 5000;
    const intervalMs = step.interval_ms || 120;
    const deadline = performance.now() + timeoutMs;
    let lastError = "";
    let lastStats = null;
    do {
      lastStats = this.store.binaryCadence({
        targetFrameMs: step.frame_duration_ms || step.target_frame_ms,
        burstThresholdMs: step.burst_threshold_ms
      });
      lastError = binaryCadenceMismatch(lastStats, step);
      if (!lastError) return lastStats;
      await sleep(intervalMs);
    } while (performance.now() < deadline);
    throw new Error(lastError || "binary cadence expectation failed");
  }

  async expectPlaybackQuality(step = {}) {
    if (!this.tools.getPlaybackStats) {
      throw new Error("expect_playback_quality tool is unavailable");
    }
    const timeoutMs = step.timeout_ms || 5000;
    const intervalMs = step.interval_ms || 120;
    const deadline = performance.now() + timeoutMs;
    let lastError = "";
    let lastStats = null;
    do {
      lastStats = this.tools.getPlaybackStats() || {};
      lastError = playbackStatsMismatch(lastStats, step) || playbackQualityMismatch(lastStats, step);
      if (!lastError) return lastStats;
      await sleep(intervalMs);
    } while (performance.now() < deadline);
    throw new Error(lastError || "playback quality expectation failed");
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
  const payloadText = String(event.payload?.text || event.payload?.content || event.payload?.sentence || event.payload?.message || "");
  if (step.payload_text_non_empty && !payloadText.trim()) return false;
  if (step.payload_text_contains && !payloadText.includes(String(step.payload_text_contains))) return false;
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

function restResponseMismatch(response = {}, step = {}) {
  const expectedStatus = step.expect_status ?? step.status;
  if (expectedStatus !== undefined) {
    const allowed = Array.isArray(expectedStatus) ? expectedStatus.map(Number) : [Number(expectedStatus)];
    if (!allowed.includes(Number(response.status))) {
      return `REST status mismatch: ${response.status} not in ${allowed.join(",")}`;
    }
  }
  if (step.expect_ok !== undefined && Boolean(response.ok) !== Boolean(step.expect_ok)) {
    return `REST ok mismatch: ${Boolean(response.ok)} != ${Boolean(step.expect_ok)}`;
  }

  const body = response.body;
  for (const field of normalizeStringList(step.expect_fields)) {
    const value = getPath(body, field);
    if (value === undefined || value === null || value === "") {
      return `REST field missing: ${field}`;
    }
  }
  for (const [path, expected] of Object.entries(step.expect_json || {})) {
    const actual = getPath(body, path);
    if (!sameJsonValue(actual, expected)) {
      return `REST field mismatch: ${path}=${JSON.stringify(actual)} != ${JSON.stringify(expected)}`;
    }
  }
  for (const [path, minimum] of Object.entries(step.expect_number_min || {})) {
    const actual = Number(getPath(body, path));
    if (!Number.isFinite(actual) || actual < Number(minimum)) {
      return `REST numeric field too low: ${path}=${actual} < ${minimum}`;
    }
  }
  for (const [path, needle] of Object.entries(step.expect_string_contains || {})) {
    const actual = String(getPath(body, path) ?? "");
    if (!actual.includes(String(needle))) {
      return `REST string field mismatch: ${path} does not contain ${needle}`;
    }
  }
  for (const needle of normalizeStringList(step.expect_body_contains)) {
    const haystack = typeof body === "string" ? body : JSON.stringify(body);
    if (!haystack.includes(needle)) {
      return `REST body does not contain: ${needle}`;
    }
  }
  return "";
}

function restResponseNote(response = {}) {
  const body = response.body;
  const bits = [`HTTP ${response.status}`];
  if (body && typeof body === "object") {
    if (body.generation !== undefined) bits.push(`generation ${body.generation}`);
    if (body.redis?.deleted_keys !== undefined) bits.push(`redis ${body.redis.deleted_keys}`);
    if (body.postgres?.chat_messages !== undefined) bits.push(`chat ${body.postgres.chat_messages}`);
    if (body.error) bits.push(String(body.error).slice(0, 80));
  }
  return bits.join(" · ");
}

function normalizeStringList(raw) {
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function getPath(target, path) {
  if (!path) return target;
  const parts = String(path).split(".");
  let current = target;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function sameJsonValue(actual, expected) {
  if (typeof expected === "number") return Number(actual) === expected;
  if (typeof expected === "boolean") return actual === expected;
  return actual === expected;
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

function micConstraintsNote(constraints = {}) {
  return [
    `aec=${constraints.echo_cancellation ?? constraints.echoCancellation ?? true}`,
    `ns=${constraints.noise_suppression ?? constraints.noiseSuppression ?? false}`,
    `agc=${constraints.auto_gain_control ?? constraints.autoGainControl ?? false}`
  ].join(" ");
}

function playbackTuningNote(tuning = {}) {
  return [
    tuning.initial_buffer_ms ?? tuning.initialBufferMs,
    tuning.full_duplex_initial_buffer_ms ?? tuning.fullDuplexInitialBufferMs,
    tuning.resume_lead_ms ?? tuning.resumeLeadMs,
    tuning.low_watermark_ms ?? tuning.lowWatermarkMs,
    tuning.max_buffer_ms ?? tuning.maxBufferMs,
    tuning.output_gain ?? tuning.outputGain,
    tuning.artifact_guard_enabled ?? tuning.artifactGuardEnabled
  ].filter((value) => value !== undefined && value !== "").join("/");
}

function playbackStatsNote(stats = {}) {
  return `recv ${stats.receivedFrames || 0}, play ${stats.playedFrames || 0}, drop ${stats.droppedFrames || 0}, midUF ${stats.midSentenceUnderflowCount || 0}`;
}

function binaryCadenceNote(stats = {}) {
  return `frames ${stats.receivedFrames || 0}, p50 ${stats.binaryFrameIntervalP50Ms ?? "-"}ms, burst ${stats.binaryBurstCount || 0}, tail ${stats.tailToSentenceEndMs ?? "-"}ms`;
}

function connectionUrlForStep(baseUrl, step = {}, params = {}) {
  if (!step.path && !Object.keys(params || {}).length) return baseUrl;
  const url = new URL(baseUrl);
  if (step.path) {
    url.pathname = String(step.path);
  }
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function playbackQualityNote(stats = {}) {
  const platform = stats.platform || {};
  return [
    `UF ${stats.midSentenceUnderflowCount || 0}`,
    `clip ${formatPercent(stats.clippingSampleRatio || 0)}`,
    `jump ${stats.boundaryJumpCount || 0}/${stats.boundaryJumpMax || 0}`,
    `late ${stats.lateFrameDroppedCount || 0}`,
    `profile ${stats.profileMismatchCount || 0}`,
    `guard ${stats.artifactGuardEnabled ? "on" : "off"}`,
    stats.codec || "-",
    platform.isWeChat ? "WeChat" : platform.isMobile ? "Mobile" : "Desktop"
  ].filter(Boolean).join(", ");
}

function playbackStatsMismatch(stats = {}, step = {}) {
  const expectedCodec = step.expected_codec || step.codec;
  if (expectedCodec && stats.codec !== expectedCodec) {
    return `playback codec mismatch: ${stats.codec || "-"} != ${expectedCodec}`;
  }
  const expectedStatus = step.expected_status || step.status;
  if (expectedStatus && stats.status !== expectedStatus) {
    return `playback status mismatch: ${stats.status || "-"} != ${expectedStatus}`;
  }
  if (step.mic_active !== undefined && Boolean(stats.micActive) !== Boolean(step.mic_active)) {
    return `playback mic state mismatch: ${Boolean(stats.micActive)} != ${Boolean(step.mic_active)}`;
  }
  const minimums = [
    ["receivedFrames", "min_received_frames"],
    ["playedFrames", "min_played_frames"],
    ["scheduledFrames", "min_scheduled_frames"]
  ];
  for (const [statKey, stepKey] of minimums) {
    const expected = numericStepValue(step, stepKey);
    if (expected !== null && Number(stats[statKey] || 0) < expected) {
      return `${statKey} too low: ${stats[statKey] || 0} < ${expected}`;
    }
  }
  const maximums = [
    ["droppedFrames", "max_dropped_frames"],
    ["underflowCount", "max_underflow"],
    ["midSentenceUnderflowCount", "max_mid_sentence_underflow"],
    ["decodeMaxMs", "max_decode_ms"],
    ["queueDelayMs", "max_queue_ms"]
  ];
  for (const [statKey, stepKey] of maximums) {
    const expected = numericStepValue(step, stepKey);
    if (expected !== null && Number(stats[statKey] || 0) > expected) {
      return `${statKey} too high: ${stats[statKey] || 0} > ${expected}`;
    }
  }
  return "";
}

function binaryCadenceMismatch(stats = {}, step = {}) {
  const minimumFrames = numericStepValue(step, "min_frames");
  if (minimumFrames !== null && Number(stats.receivedFrames || 0) < minimumFrames) {
    return `binary frames too low: ${stats.receivedFrames || 0} < ${minimumFrames}`;
  }
  const minP50 = numericStepValue(step, "min_p50_ms");
  if (minP50 !== null && stats.binaryFrameIntervalP50Ms !== null && Number(stats.binaryFrameIntervalP50Ms) < minP50) {
    return `binary p50 too low: ${stats.binaryFrameIntervalP50Ms} < ${minP50}`;
  }
  const maxP50 = numericStepValue(step, "max_p50_ms");
  if (maxP50 !== null && stats.binaryFrameIntervalP50Ms !== null && Number(stats.binaryFrameIntervalP50Ms) > maxP50) {
    return `binary p50 too high: ${stats.binaryFrameIntervalP50Ms} > ${maxP50}`;
  }
  const maxBurst = numericStepValue(step, "max_burst_count");
  if (maxBurst !== null && Number(stats.binaryBurstCount || 0) > maxBurst) {
    return `binary burst count too high: ${stats.binaryBurstCount || 0} > ${maxBurst}`;
  }
  const maxTail = numericStepValue(step, "max_tail_to_sentence_end_ms");
  if (maxTail !== null) {
    if (stats.tailToSentenceEndMs === null || stats.tailToSentenceEndMs === undefined) {
      return "tail_to_sentence_end_ms is unavailable";
    }
    if (Number(stats.tailToSentenceEndMs) > maxTail) {
      return `tail_to_sentence_end_ms too high: ${stats.tailToSentenceEndMs} > ${maxTail}`;
    }
  }
  return "";
}

function playbackQualityMismatch(stats = {}, step = {}) {
  const expectations = [
    ["clippingSampleRatio", "max_clipping_ratio"],
    ["boundaryJumpMax", "max_boundary_jump"],
    ["lateFrameDroppedCount", "max_late_frames"],
    ["profileMismatchCount", "max_profile_mismatch"],
    ["clippingFrameCount", "max_clipping_frames"],
    ["boundaryJumpCount", "max_boundary_jumps"]
  ];
  for (const [statKey, stepKey] of expectations) {
    const expected = numericStepValue(step, stepKey);
    if (expected !== null && Number(stats[statKey] || 0) > expected) {
      return `${statKey} too high: ${stats[statKey] || 0} > ${expected}`;
    }
  }
  if (step.expect_artifact_guard !== undefined && Boolean(stats.artifactGuardEnabled) !== Boolean(step.expect_artifact_guard)) {
    return `artifact guard mismatch: ${Boolean(stats.artifactGuardEnabled)} != ${Boolean(step.expect_artifact_guard)}`;
  }
  return "";
}

function numericStepValue(step, key) {
  if (!Object.prototype.hasOwnProperty.call(step, key)) return null;
  const value = Number(step[key]);
  return Number.isFinite(value) ? value : null;
}

function formatPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "0.00%";
  return `${(num * 100).toFixed(2)}%`;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
