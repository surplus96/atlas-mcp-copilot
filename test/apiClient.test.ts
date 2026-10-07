import axios from "axios";
import { ApiClient } from "../src/http/apiClient";
import { Config } from "../src/config";
import { Logger } from "../src/util/logger";
import { AuthManager } from "../src/auth/authManager";

jest.mock("axios");

it("does not retry work order creation after an ambiguous timeout", async () => {
  const request = jest.fn().mockRejectedValue({ isAxiosError: true, code: "ECONNABORTED" });
  (axios.create as jest.Mock).mockReturnValue({ request });
  (axios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
  const auth = { getToken: jest.fn(async () => "token") } as unknown as AuthManager;
  const api = new ApiClient({ apiBaseUrl: "http://localhost/api" } as Config, logger, auth);
  await expect(api.post("/work-orders", { title: "Check" })).rejects.toThrow("Atlas API request failed");
  expect(request).toHaveBeenCalledTimes(1);
});
