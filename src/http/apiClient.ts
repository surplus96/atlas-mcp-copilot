import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, Method } from "axios";
import { Config } from "../config";
import { Logger } from "../util/logger";
import { AuthManager } from "../auth/authManager";

const RETRY_DELAYS_MS = [100, 500, 1000];
const MAX_TRANSIENT_RETRIES = RETRY_DELAYS_MS.length;

/** Field names only, never values — the values are CMMS work-order content
 * (titles, descriptions, evidence text), not secrets, but they don't belong
 * in container logs any more than the credentials do. */
function shapeOf(value: unknown): string[] | string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as object);
  }
  return typeof value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransient(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" || !err.response) {
    return true;
  }
  return err.response.status >= 500;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Thin wrapper around axios that:
 *  - attaches the current JWT to every request
 *  - re-authenticates once and retries on 401
 *  - retries transient network/5xx errors with exponential backoff
 */
export class ApiClient {
  private readonly http: AxiosInstance;

  constructor(
    config: Config,
    private readonly logger: Logger,
    private readonly authManager: AuthManager,
  ) {
    this.http = axios.create({
      baseURL: config.apiBaseUrl,
      timeout: 15000,
    });
  }

  async request<T>(method: Method, path: string, options: { data?: unknown; params?: unknown } = {}): Promise<T> {
    let attempt = 0;
    let usedFreshToken = false;

    for (;;) {
      const token = await this.authManager.getToken();
      const reqConfig: AxiosRequestConfig = {
        method,
        url: path,
        data: options.data,
        params: options.params,
        headers: { Authorization: `Bearer ${token}` },
      };

      this.logger.debug("API request", { method, path });
      try {
        const response = await this.http.request<T>(reqConfig);
        this.logger.debug("API response", { method, path, status: response.status });
        return response.data;
      } catch (err) {
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;

        if (status === 401 && !usedFreshToken) {
          this.logger.info("Received 401, re-authenticating and retrying once", { method, path });
          usedFreshToken = true;
          await this.authManager.refresh();
          continue;
        }

        if (isTransient(err) && attempt < MAX_TRANSIENT_RETRIES) {
          const delay = RETRY_DELAYS_MS[attempt];
          attempt += 1;
          this.logger.warn("Transient API error, retrying", {
            method,
            path,
            attempt,
            delayMs: delay,
            status,
          });
          await sleep(delay);
          continue;
        }

        this.logger.error("API request failed", {
          method,
          path,
          status,
          requestFields: shapeOf(options.data),
          responseFields: shapeOf(axiosErr.response?.data),
        });
        throw new ApiError(
          `Atlas API request failed: ${method} ${path}${status ? ` (${status})` : ""}`,
          status,
          axiosErr.response?.data,
        );
      }
    }
  }

  get<T>(path: string, params?: unknown): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  post<T>(path: string, data?: unknown): Promise<T> {
    return this.request<T>("POST", path, { data });
  }

  patch<T>(path: string, data?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { data });
  }
}
