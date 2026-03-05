import { ApiError } from "./errors.js";
import { sleep } from "./utils.js";

export class OutlineClient {
  #tokenState = null;

  constructor(profile) {
    this.profile = profile;
    this.baseApiUrl = `${profile.baseUrl.replace(/\/+$/, "")}/api`;
    this.timeoutMs = profile.timeoutMs || 30000;
  }

  async call(method, body = {}, options = {}) {
    const apiMethod = method.startsWith("/") ? method.slice(1) : method;
    const url = `${this.baseApiUrl}/${apiMethod}`;
    const maxAttempts = Math.max(1, options.maxAttempts || 1);

    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.#callOnce(url, body, options);
      } catch (err) {
        lastErr = err;
        const shouldRetry =
          err instanceof ApiError &&
          (err.details.status === 429 || err.details.status >= 500) &&
          attempt < maxAttempts;

        if (!shouldRetry) {
          throw err;
        }

        const retryAfter = Number(err.details.retryAfter || 0);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : attempt * 400;
        await sleep(waitMs);
      }
    }

    throw lastErr;
  }

  async #callOnce(url, body, options) {
    const bodyType = options.bodyType === "multipart" ? "multipart" : "json";
    const requestBody = this.#buildRequestBody(bodyType, body);
    const headers = await this.#buildHeaders(options.headers || {}, { bodyType });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: requestBody,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new ApiError(`Request timeout after ${this.timeoutMs}ms`, {
          status: 408,
          url,
        });
      }
      throw new ApiError(`Network error: ${err.message}`, {
        status: 503,
        url,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { ok: false, message: text || "Non-JSON response" };
    }

    if (!res.ok || parsed?.ok === false) {
      const status = parsed?.status || res.status;
      const retryAfter = res.headers.get("retry-after");
      throw new ApiError(parsed?.message || parsed?.error || res.statusText, {
        status,
        retryAfter,
        body: parsed,
        url,
      });
    }

    return {
      ok: true,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: parsed,
    };
  }

  #buildRequestBody(bodyType, body) {
    if (bodyType === "multipart") {
      if (body instanceof FormData) {
        return body;
      }

      const form = new FormData();
      if (body && typeof body === "object") {
        const keys = Object.keys(body).sort((a, b) => a.localeCompare(b));
        for (const key of keys) {
          const value = body[key];
          if (value === undefined) {
            continue;
          }
          if (value instanceof Blob) {
            form.append(key, value);
            continue;
          }
          if (value && typeof value === "object") {
            form.append(key, JSON.stringify(value));
            continue;
          }
          form.append(key, String(value));
        }
      }

      return form;
    }

    return JSON.stringify(body || {});
  }

  async #buildHeaders(extraHeaders, { bodyType = "json" } = {}) {
    const headers = {
      Accept: "application/json",
      ...this.profile.headers,
      ...extraHeaders,
    };
    const existingContentTypeKey = Object.keys(headers).find((key) => key.toLowerCase() === "content-type");

    if (bodyType === "multipart") {
      if (existingContentTypeKey) {
        delete headers[existingContentTypeKey];
      }
    } else if (!existingContentTypeKey) {
      headers["Content-Type"] = "application/json";
    }

    const auth = this.profile.auth || {};
    if (auth.type === "apiKey") {
      headers.Authorization = `Bearer ${auth.apiKey}`;
      return headers;
    }

    if (auth.type === "basic") {
      headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
      return headers;
    }

    if (auth.type === "password") {
      if (!auth.tokenEndpoint) {
        headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
        return headers;
      }

      const token = await this.#getPasswordToken();
      headers.Authorization = `Bearer ${token}`;
      return headers;
    }

    throw new ApiError(`Unsupported auth type: ${auth.type}`, { status: 400 });
  }

  async #getPasswordToken() {
    if (this.#tokenState && this.#tokenState.expiresAt > Date.now() + 15_000) {
      return this.#tokenState.token;
    }

    const auth = this.profile.auth;
    const endpoint = auth.tokenEndpoint;
    const body = {
      username: auth.username,
      password: auth.password,
      ...(auth.tokenRequestBody || {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new ApiError(`Token request timeout after ${this.timeoutMs}ms`, {
          status: 408,
          endpoint,
        });
      }
      throw new ApiError(`Token request failed: ${err.message}`, {
        status: 503,
        endpoint,
      });
    } finally {
      clearTimeout(timeout);
    }

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(payload?.message || payload?.error || "Failed token exchange", {
        status: res.status,
        body: payload,
      });
    }

    const token = payload?.[auth.tokenField || "access_token"];
    if (!token) {
      throw new ApiError(`Token field not found: ${auth.tokenField || "access_token"}`, {
        status: 500,
        body: payload,
      });
    }

    const expiresIn = Number(payload?.expires_in || 3600);
    this.#tokenState = {
      token,
      expiresAt: Date.now() + Math.max(30, expiresIn) * 1000,
    };

    return token;
  }
}
