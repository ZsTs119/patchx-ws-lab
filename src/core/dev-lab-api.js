export class DevLabApi {
  constructor(getBaseUrl) {
    this.getBaseUrl = getBaseUrl;
  }

  async health() {
    return this.getJson("/health");
  }

  async probe(path) {
    return this.getJson(path);
  }

  async personalities() {
    return this.getJson("/personalities");
  }

  async logs(filters = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        params.set(key, String(value).trim());
      }
    }
    const suffix = params.toString() ? `/logs?${params.toString()}` : "/logs";
    return this.getJson(suffix);
  }

  async logsSummary(filters = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        params.set(key, String(value).trim());
      }
    }
    const suffix = params.toString() ? `/logs/summary?${params.toString()}` : "/logs/summary";
    return this.getJson(suffix);
  }

  async logInsights(filters = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        params.set(key, String(value).trim());
      }
    }
    const suffix = params.toString() ? `/logs/insights?${params.toString()}` : "/logs/insights";
    return this.getJson(suffix);
  }

  async logSessions(filters = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        params.set(key, String(value).trim());
      }
    }
    const suffix = params.toString() ? `/logs/sessions?${params.toString()}` : "/logs/sessions";
    return this.getJson(suffix);
  }

  async logSessionSummary(filters = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        params.set(key, String(value).trim());
      }
    }
    const suffix = params.toString() ? `/logs/session-summary?${params.toString()}` : "/logs/session-summary";
    return this.getJson(suffix);
  }

  async logRounds(filters = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        params.set(key, String(value).trim());
      }
    }
    const suffix = params.toString() ? `/logs/rounds?${params.toString()}` : "/logs/rounds";
    return this.getJson(suffix);
  }

  async logDetail(lineNo) {
    const params = new URLSearchParams();
    params.set("line_no", String(lineNo));
    return this.getJson(`/logs/detail?${params.toString()}`);
  }

  async tts(payload) {
    const base = this.getBaseUrl().replace(/\/$/, "");
    let response;
    try {
      response = await fetchWithTimeout(`${base}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      }, 20000);
    } catch (error) {
      throw buildApiError(error.message || "network error", { path: "/tts", cause: error });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code >= 400) {
      throw buildApiError(body.message || `HTTP ${response.status}`, {
        status: response.status,
        code: body.code,
        path: "/tts",
        body
      });
    }
    return body.data ?? body;
  }

  async getJson(path) {
    const base = this.getBaseUrl().replace(/\/$/, "");
    let response;
    try {
      response = await fetchWithTimeout(`${base}${path}`, {
        headers: { Accept: "application/json" }
      }, 4000);
    } catch (error) {
      throw buildApiError(error.message || "network error", { path, cause: error });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code >= 400) {
      throw buildApiError(body.message || `HTTP ${response.status}`, {
        status: response.status,
        code: body.code,
        path,
        body
      });
    }
    return body.data ?? body;
  }
}

function buildApiError(message, meta = {}) {
  const error = new Error(message);
  Object.assign(error, meta);
  return error;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw buildApiError(`request timeout after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
