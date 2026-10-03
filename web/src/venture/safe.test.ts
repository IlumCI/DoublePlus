import { describe, expect, it } from "vitest";

import { safeImageUrl, safeLinkUrl } from "./safe";

describe("safeImageUrl", () => {
  it("keeps inline images and https", () => {
    expect(safeImageUrl("data:image/png;base64,iVBORw0KGgo=")).not.toBe("");
    expect(safeImageUrl("data:image/svg+xml;base64,PHN2Zz4=")).not.toBe("");
    expect(safeImageUrl("https://cdn.example/logo.png")).not.toBe("");
  });
  it("drops everything a creator could abuse", () => {
    for (const u of [
      "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "http://tracker.example/p.gif",
      "https://x.example/a\"onerror=\"alert(1)", "//evil.example/x.png", "data:image/png,<svg onload=alert(1)>",
      "vbscript:msgbox", "file:///etc/passwd", " https://x.example/a.png", "", undefined,
    ]) expect(safeImageUrl(u as string), String(u)).toBe("");
  });
});

describe("safeLinkUrl", () => {
  it("keeps http(s) and refuses script schemes", () => {
    expect(safeLinkUrl("https://x.com/coin")).toBe("https://x.com/coin");
    expect(safeLinkUrl("http://site.example")).toBe("http://site.example");
    for (const u of ["javascript:alert(document.cookie)", " javascript:alert(1)", "data:text/html,<script>", "java\tscript:alert(1)", "https://a.example/\"><script>"]) {
      expect(safeLinkUrl(u), u).toBe("");
    }
  });
});
