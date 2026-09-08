import { expect, test } from "bun:test";
import rootPackage from "../../../package.json";
import { VERSION } from "./index";

test("exports the version string from the root package.json", () => {
  expect(typeof VERSION).toBe("string");
  expect(VERSION.length).toBeGreaterThan(0);
  expect(VERSION).toBe(rootPackage.version);
});
