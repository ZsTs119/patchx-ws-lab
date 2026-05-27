export class WsLabAuthApi {
  constructor(getBaseUrl) {
    this.getBaseUrl = getBaseUrl;
  }

  async me() {
    return this.request("/me");
  }

  async login(username, password) {
    return this.request("/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
  }

  async logout() {
    return this.request("/logout", {
      method: "POST",
      body: "{}"
    });
  }

  async request(path, options = {}) {
    const base = this.getBaseUrl();
    if (!base) {
      throw new Error("WS Lab 登录服务地址不可用");
    }
    const response = await fetch(`${base}${path}`, {
      method: options.method || "GET",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      body: options.body
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.message || `WS Lab 登录服务异常 ${response.status}`);
    }
    return body.data || {};
  }
}
