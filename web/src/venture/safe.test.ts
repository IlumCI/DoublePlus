import { describe, expect, it } from "vitest";

import { cleanText, parseMeta, safeImageUrl, safeLinkUrl } from "./safe";

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

describe("parseMeta", () => {
  it("returns an empty object for anything that isn't a JSON object", () => {
    for (const raw of ["", "null", "123", "[1,2,3]", '"string"', "true", "not json {{{", undefined, null]) {
      expect(parseMeta(raw), String(raw)).toEqual({});
    }
  });
  it("keeps only known string fields, cleaned", () => {
    const m = parseMeta(JSON.stringify({ pitch: { nested: true }, description: 42, website: ["https://a.example"], twitter: null, logo: 7, sector: false, evil: "x" }));
    expect(m).toEqual({});
    const ok = parseMeta(JSON.stringify({ pitch: "  hi\u202E there ", website: "https://a.example", github: "javascript:alert(1)" }));
    expect(ok).toEqual({ pitch: "hi there", website: "https://a.example" });
  });
  it("ignores prototype keys and never pollutes Object", () => {
    const m = parseMeta('{"__proto__":{"polluted":"yes","pitch":"from proto"},"constructor":{"prototype":{"polluted":"yes"}},"pitch":"own"}');
    expect(m.pitch).toBe("own");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("cleanText", () => {
  it("removes bidi overrides and invisible marks that spoof or flip text", () => {
    expect(cleanText("\u202Egnp.exe", 64)).toBe("gnp.exe");
    expect(cleanText("a\u200Bb\u2066c\u2069d\uFEFF", 64)).toBe("abcd");
    expect(cleanText("Line\nBreak\tName\u0000", 64)).toBe("Line Break Name");
    expect(cleanText("keep\n\n\n\nparagraphs", 64, true)).toBe("keep\n\nparagraphs");
  });
  it("caps length on whole characters, never splitting an emoji", () => {
    const t = cleanText("\u{1F680}".repeat(100), 10);
    expect([...t].length).toBe(11); // 10 + ellipsis
    expect(t.startsWith("\u{1F680}")).toBe(true);
  });
  it("turns non-strings into empty text", () => {
    expect(cleanText(42, 10)).toBe("");
    expect(cleanText({ a: 1 }, 10)).toBe("");
  });
});
