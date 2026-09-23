import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deleteWindowsScheduledTask,
  queryWindowsScheduledTaskXml,
  registerWindowsScheduledTask,
  renderWindowsScheduledTaskXml,
  windowsScheduledTaskExists,
  windowsTaskPrincipal,
} from "./windows-task.js";

test("Windows scheduled task is login-persistent and self-restarting", () => {
  const xml = renderWindowsScheduledTaskXml({
    command: "C:\\Program Files\\Flyto2\\runtime.exe",
    arguments: '--config "C:\\Users\\Chester Hsu\\runtime.json"',
    workingDirectory: "C:\\Program Files\\Flyto2",
    principal: "EXAMPLE\\chester",
    restartIntervalMinutes: 1,
    restartCount: 255,
  });

  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<UserId>EXAMPLE\\chester<\/UserId>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, /<Interval>PT1M<\/Interval>/);
  assert.match(xml, /<Count>255<\/Count>/);
  assert.match(xml, /C:\\Program Files\\Flyto2\\runtime\.exe/);
  assert.match(xml, /Chester Hsu/);
});

test("Windows Task Scheduler accepts the generated XML on a real Windows runner", {
  skip: platform() !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-task-"));
  const taskName = `Flyto2 Runtime CI ${process.pid}`;
  t.after(async () => {
    try {
      deleteWindowsScheduledTask(taskName);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const xmlPath = join(root, "task.xml");
  await writeFile(
    xmlPath,
    renderWindowsScheduledTaskXml({
      command: "cmd.exe",
      arguments: "/d /c exit 0",
      principal: windowsTaskPrincipal(),
      restartIntervalMinutes: 1,
      restartCount: 2,
    }),
    "utf8",
  );

  registerWindowsScheduledTask(taskName, xmlPath);
  assert.equal(windowsScheduledTaskExists(taskName), true);
  assert.match(queryWindowsScheduledTaskXml(taskName) ?? "", /Flyto2 Runtime managed task/);
});

test("Windows task principal keeps local and domain users explicit", () => {
  assert.equal(
    windowsTaskPrincipal({ USERNAME: "chester", USERDOMAIN: "WORKSTATION" }),
    "WORKSTATION\\chester",
  );
  assert.equal(
    windowsTaskPrincipal({ USERNAME: "chester" }),
    "chester",
  );
});
