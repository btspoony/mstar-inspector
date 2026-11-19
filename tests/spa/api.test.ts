import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ApiError, fetchJson, postForm, postJson, putJson } from "../../src/spa/api";
import { installDom } from "./dom";

const originalFetch = globalThis.fetch;
let dom: ReturnType<typeof installDom>;

beforeEach(() => {
  dom = installDom("https://inspector.example/dashboard/acme/apps");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  dom.cleanup();
});

const requests: Array<[string, () => Promise<unknown>]> = [
  ["GET", () => fetchJson("/dashboard/acme/api/apps")],
  ["form POST", () => postForm("/dashboard/acme/apps/1/settings", { op: "save" })],
  ["PUT", () => putJson("/dashboard/acme/api/settings", { enabled: true })],
  ["JSON POST", () => postJson("/dashboard/acme/api/apps", { name: "example" })],
];

test.each(requests)("%s rejects an opaque session redirect and navigates to login without reading its body", async (_name, request) => {
  const response = Response.error();
  Object.defineProperty(response, "type", { value: "opaqueredirect" });
  const read = spyOn(response, "text");
  const navigate = spyOn(dom.win.location, "replace").mockImplementation(() => {});
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  await expect(request()).rejects.toBeInstanceOf(ApiError);
  expect(navigate).toHaveBeenCalledWith("/dashboard/login");
  expect(read).not.toHaveBeenCalled();
});

test.each(requests)("%s preserves a successful JSON response", async (name, request) => {
  const body = JSON.stringify({ ok: true });
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  expect(await request()).toEqual(name === "GET" ? { ok: true } : { status: 200, body });
});

test.each(requests)("%s keeps an ordinary 4xx as a refusal without navigation", async (name, request) => {
  const body = JSON.stringify({ message: "Not allowed" });
  const navigate = spyOn(dom.win.location, "replace").mockImplementation(() => {});
  globalThis.fetch = (async () => new Response(body, { status: 403 })) as unknown as typeof fetch;
  if (name === "GET") {
    await expect(request()).rejects.toMatchObject({ status: 403, body });
  } else {
    expect(await request()).toEqual({ status: 403, body });
  }
  expect(navigate).not.toHaveBeenCalled();
});

test("a readable redirect retains its server-provided destination", async () => {
  const navigate = spyOn(dom.win.location, "replace").mockImplementation(() => {});
  globalThis.fetch = (async () => new Response(null, {
    status: 302, headers: { Location: "/dashboard/login" },
  })) as unknown as typeof fetch;
  await expect(postForm("/dashboard/acme/settings", {})).rejects.toMatchObject({ status: 302 });
  expect(navigate).toHaveBeenCalledWith("/dashboard/login");
});

test("an empty successful form response remains successful", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  expect(await postForm("/dashboard/acme/settings", {})).toEqual({ status: 204, body: "" });
});
