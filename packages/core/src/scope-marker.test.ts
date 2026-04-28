import { describe, it, expect } from "vitest";
import { parseScopeMarker } from "./scope-marker.js";

describe("parseScopeMarker", () => {
  it("returns null when no marker present", () => {
    expect(parseScopeMarker("Just a regular issue body.")).toBeNull();
    expect(parseScopeMarker("")).toBeNull();
    expect(parseScopeMarker(undefined as unknown as string)).toBeNull();
  });

  it("parses a single glob", () => {
    expect(parseScopeMarker("Body\n<!-- ao-scope: src/sports/** -->\nMore"))
      .toEqual(["src/sports/**"]);
  });

  it("parses multiple comma-separated globs", () => {
    expect(parseScopeMarker("<!-- ao-scope: src/sports/**, !src/sports/apis/** -->"))
      .toEqual(["src/sports/**", "!src/sports/apis/**"]);
  });

  it("trims whitespace inside the marker", () => {
    expect(parseScopeMarker("<!--   ao-scope:   src/a/**  ,   src/b/**   -->"))
      .toEqual(["src/a/**", "src/b/**"]);
  });

  it("ignores marker content that is empty", () => {
    expect(parseScopeMarker("<!-- ao-scope: -->")).toBeNull();
    expect(parseScopeMarker("<!-- ao-scope:    -->")).toBeNull();
  });

  it("returns the first marker when multiple present", () => {
    expect(parseScopeMarker("<!-- ao-scope: src/a/** -->\n<!-- ao-scope: src/b/** -->"))
      .toEqual(["src/a/**"]);
  });

  it("is case-insensitive on the keyword", () => {
    expect(parseScopeMarker("<!-- AO-SCOPE: src/x/** -->"))
      .toEqual(["src/x/**"]);
  });
});
