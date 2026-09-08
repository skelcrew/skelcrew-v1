import { expect, test } from "bun:test";
import { VERSION } from "@skelcrew/shared";
import rootPackage from "../../../package.json";

test("resolves the version string from @skelcrew/shared", () => {
  expect(VERSION).toBe(rootPackage.version);
});
