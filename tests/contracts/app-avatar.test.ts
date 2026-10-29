/**
 * The App icon URL contract (src/contracts/app-avatar.ts).
 *
 * Both consumers — the dashboard's metadata sync and the SPA's read-time
 * fallback — assert through the shared function, which pins the WIRING but
 * cannot notice a change to the URL itself (both sides would move together).
 * The format is therefore written out literally here, once: a change to the
 * derivation has to be a deliberate edit to this expectation.
 */
import { describe, expect, test } from "bun:test";
import { APP_AVATAR_BASE_URL, appAvatarUrl } from "../../src/contracts/app-avatar";

describe("appAvatarUrl", () => {
  test("builds GitHub's CDN URL for the numeric App id", () => {
    expect(appAvatarUrl(1234)).toBe("https://avatars.githubusercontent.com/in/1234?s=120&v=4");
    // The real-world shape the derivation was verified against.
    expect(appAvatarUrl(4803300)).toBe("https://avatars.githubusercontent.com/in/4803300?s=120&v=4");
  });

  test("only the path segment carries the id — the rest of the URL is fixed", () => {
    const a = appAvatarUrl(1);
    const b = appAvatarUrl(987654);
    expect(a).toBe("https://avatars.githubusercontent.com/in/1?s=120&v=4");
    expect(b).toBe("https://avatars.githubusercontent.com/in/987654?s=120&v=4");
    expect(a.replace("/in/1?", "/in/X?")).toBe(b.replace("/in/987654?", "/in/X?"));
    expect(APP_AVATAR_BASE_URL).toBe("https://avatars.githubusercontent.com/in");
  });

  test("is always an https URL on GitHub's avatar host", () => {
    for (const id of [0, 1, 15368, 29110, Number.MAX_SAFE_INTEGER]) {
      const url = new URL(appAvatarUrl(id));
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("avatars.githubusercontent.com");
      expect(url.pathname).toBe(`/in/${id}`);
    }
  });
});
