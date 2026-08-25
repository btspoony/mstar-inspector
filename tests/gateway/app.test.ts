import { describe, expect, mock, test } from "bun:test";
import { createGatewayApp } from "../../src/gateway/app";

describe("createGatewayApp", () => {
  test("returns a Probot app function without binding a port", () => {
    const appFn = createGatewayApp();
    expect(typeof appFn).toBe("function");
  });

  test("accepts the optional log option", () => {
    const appFn = createGatewayApp({ log: { info: () => {} } });
    expect(typeof appFn).toBe("function");
  });

  test("the returned app function does not listen or start a server", () => {
    const appFn = createGatewayApp();
    const listen = mock(() => {});
    const mockApp = { on: mock(() => {}), listen };
    appFn(mockApp as never);
    expect(listen).not.toHaveBeenCalled();
  });
});
