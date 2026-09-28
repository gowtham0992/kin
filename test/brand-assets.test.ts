import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const asset = (name: string) => readFileSync(new URL(`../simulator/${name}`, import.meta.url));

it("uses the approved lockup and accessible image across every web entry point", () => {
  for (const name of ["home.html", "invite.html", "how-kin-works.html", "story.html", "index.html"]) {
    const html = asset(name).toString("utf8");
    expect(html).toContain('class="brand-logo" src="/kin-logo.png" alt="Kin"');
    expect(html).toContain('rel="icon" href="/kin-icon.png"');
    expect(html).toContain('rel="apple-touch-icon" href="/kin-phone-icon.png"');
    expect(html).not.toContain("brand-mark");
  }
  expect(asset("kin-logo.png")).toEqual(readFileSync(new URL("../design/brand/kin-care-logo-concept-v1.png", import.meta.url)));
});

it("declares the real PNG dimensions and shares the app icon with notifications", () => {
  const manifest = JSON.parse(asset("kin.webmanifest").toString("utf8"));
  const icon = asset("kin-icon.png");
  expect(icon.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const phone = asset("kin-phone-icon.png");
  expect(manifest.icons).toEqual([
    { src: "/kin-icon.png", sizes: `${icon.readUInt32BE(16)}x${icon.readUInt32BE(20)}`, type: "image/png", purpose: "any" },
    { src: "/kin-phone-icon.png", sizes: `${phone.readUInt32BE(16)}x${phone.readUInt32BE(20)}`, type: "image/png", purpose: "maskable" },
  ]);
  expect(asset("kin-sw.js").toString("utf8")).toContain('icon: "/kin-icon.png"');
});
