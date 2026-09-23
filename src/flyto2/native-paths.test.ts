import assert from "node:assert/strict";
import test from "node:test";
import { flyto2NativeRuntimeHome } from "./native-paths.js";

test("native Runtime storage uses each platform's standard user data root", () => {
  assert.equal(
    flyto2NativeRuntimeHome("/Users/chester", {}, "darwin"),
    "/Users/chester/Library/Application Support/Flyto2 Runtime",
  );
  assert.equal(
    flyto2NativeRuntimeHome(
      "C:\\Users\\chester",
      { LOCALAPPDATA: "D:\\Local" },
      "win32",
    ),
    "D:\\Local\\Flyto2 Runtime",
  );
  assert.equal(
    flyto2NativeRuntimeHome("/home/chester", { XDG_DATA_HOME: "/data" }, "linux"),
    "/data/flyto2-runtime",
  );
});
