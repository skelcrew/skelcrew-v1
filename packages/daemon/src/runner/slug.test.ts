import { expect, test } from "bun:test";
import { branchName, SLUG_MAX_LENGTH, slug } from "./slug";

test("lower-cases and turns each run of non-alphanumerics into one dash", () => {
  expect(slug("Add login page")).toBe("add-login-page");
  expect(slug("Fix: the  Thing (again)!")).toBe("fix-the-thing-again");
  expect(slug("naïve café")).toBe("na-ve-caf");
});

test("no leading or trailing dash, even after truncation", () => {
  expect(slug("  --Spaced out-- ")).toBe("spaced-out");
  const long = `${"a".repeat(39)} b`;
  expect(slug(long)).toBe("a".repeat(39));
  expect(slug("x".repeat(100))).toBe("x".repeat(SLUG_MAX_LENGTH));
  expect(slug("x".repeat(100)).length).toBe(40);
});

test("an all-symbol title leaves no slug, and the branch is just the id", () => {
  expect(slug("!!! ???")).toBe("");
  expect(branchName(7, "!!! ???")).toBe("skelcrew/7");
  expect(branchName(1, "Add login page")).toBe("skelcrew/1-add-login-page");
});
