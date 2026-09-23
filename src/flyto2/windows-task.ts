import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export interface WindowsScheduledTaskDefinition {
  command: string;
  arguments?: string;
  workingDirectory?: string;
  principal?: string;
  logonTrigger?: boolean;
  restartIntervalMinutes?: number;
  restartCount?: number;
}

export function renderWindowsScheduledTaskXml(
  definition: WindowsScheduledTaskDefinition,
): string {
  const principal = definition.principal ?? windowsTaskPrincipal();
  const restartMinutes = Math.min(44_640, Math.max(1, Math.floor(definition.restartIntervalMinutes ?? 1)));
  const restartCount = Math.min(255, Math.max(1, Math.floor(definition.restartCount ?? 255)));
  const trigger = definition.logonTrigger === false
    ? ""
    : [
        "  <Triggers>",
        "    <LogonTrigger>",
        "      <Enabled>true</Enabled>",
        `      <UserId>${xmlEscape(principal)}</UserId>`,
        "    </LogonTrigger>",
        "  </Triggers>",
      ].join("\n");
  const workingDirectory = definition.workingDirectory
    ? `      <WorkingDirectory>${xmlEscape(definition.workingDirectory)}</WorkingDirectory>\n`
    : "";

  return [
    '<?xml version="1.0"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Flyto2 Runtime managed task</Description>",
    "  </RegistrationInfo>",
    trigger,
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${xmlEscape(principal)}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>4</Priority>",
    "    <RestartOnFailure>",
    `      <Interval>PT${restartMinutes}M</Interval>`,
    `      <Count>${restartCount}</Count>`,
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xmlEscape(definition.command)}</Command>`,
    definition.arguments
      ? `      <Arguments>${xmlEscape(definition.arguments)}</Arguments>`
      : "",
    workingDirectory.trimEnd(),
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].filter(Boolean).join("\n");
}

export function windowsScheduledTaskExists(taskName: string): boolean {
  if (platform() !== "win32") return false;
  return runSchtasks(["/Query", "/TN", taskName]).status === 0;
}

export function queryWindowsScheduledTaskXml(taskName: string): string | undefined {
  assertWindows();
  const result = runSchtasks(["/Query", "/TN", taskName, "/XML"]);
  if (result.status !== 0) return undefined;
  return result.stdout || undefined;
}

export function registerWindowsScheduledTask(taskName: string, xmlPath: string): void {
  assertWindows();
  // schtasks.exe interprets XML files through the Windows Unicode parser and
  // can reject a valid UTF-8 file with "unable to switch the encoding".
  // PowerShell reads the file explicitly as UTF-8 and hands Task Scheduler
  // the decoded XML string, making registration independent of file encoding.
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; $xml=Get-Content -LiteralPath $env:FLYTO2_TASK_XML -Raw -Encoding UTF8; Register-ScheduledTask -TaskName $env:FLYTO2_TASK_NAME -Xml $xml -Force | Out-Null",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        FLYTO2_TASK_NAME: taskName,
        FLYTO2_TASK_XML: xmlPath,
      },
    },
  );
  if (result.status !== 0) {
    const detail = typeof result.stderr === "string"
      ? result.stderr.trim()
      : "PowerShell failed.";
    throw new Error(
      `Failed to register Windows scheduled task "${taskName}"${detail ? `: ${detail}` : "."}`,
    );
  }
}

export function runWindowsScheduledTask(taskName: string): void {
  assertWindows();
  const result = runSchtasks(["/Run", "/TN", taskName]);
  if (result.status !== 0) throw taskError("start", taskName, result);
}

export function endWindowsScheduledTask(taskName: string): void {
  assertWindows();
  if (!windowsScheduledTaskExists(taskName)) return;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; Stop-ScheduledTask -TaskName $env:FLYTO2_TASK_NAME",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, FLYTO2_TASK_NAME: taskName },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to stop Windows scheduled task "${taskName}": ${typeof result.stderr === "string" ? result.stderr.trim() : "PowerShell failed."}`,
    );
  }
}

export function deleteWindowsScheduledTask(taskName: string): void {
  assertWindows();
  if (!windowsScheduledTaskExists(taskName)) return;
  const result = runSchtasks(["/Delete", "/TN", taskName, "/F"]);
  if (result.status !== 0) throw taskError("delete", taskName, result);
}

export function windowsTaskPrincipal(env: NodeJS.ProcessEnv = process.env): string {
  const username = env.USERNAME?.trim();
  if (!username) {
    throw new Error("Unable to determine the Windows user for Task Scheduler.");
  }
  const domain = env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${username}` : username;
}

interface WindowsCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSchtasks(args: string[]): WindowsCommandResult {
  const result = spawnSync("schtasks.exe", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function taskError(
  operation: string,
  taskName: string,
  result: WindowsCommandResult,
): Error {
  const detail = (result.stderr || result.stdout || "").trim();
  return new Error(
    `Failed to ${operation} Windows scheduled task "${taskName}"${detail ? `: ${detail}` : "."}`,
  );
}

function assertWindows(): void {
  if (platform() !== "win32") {
    throw new Error("Windows Task Scheduler management is available on Windows only.");
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
