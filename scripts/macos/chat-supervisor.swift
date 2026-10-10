import AppKit
import ApplicationServices
import CryptoKit
import Foundation

// Separately signed, opt-in macOS observer. It never clicks, types, reloads,
// deletes conversations or records their contents. Accessibility permission
// belongs to this app identity, not to Flyto2 Runtime's Node process.
struct Observation: Codable {
    let state: String
    let permissionGranted: Bool
    let observedAt: String
    let appRunning: Bool
    let windowCount: Int
    let conversationTitle: String?
    let errorHint: String?
    let unchangedSeconds: Int?
    let uiFingerprint: String?
    let coverage: String
    let windowSource: String?
    let accessibilityErrorCode: Int32?
    let stopControlVisible: Bool?
}

let errors: [(String, String)] = [
    ("something went wrong", "something_went_wrong"),
    ("there was an error generating", "generation_error"),
    ("network error", "network_error"),
    ("an error occurred", "generation_error"),
    ("發生錯誤", "generation_error"),
    ("網路錯誤", "network_error"),
]

let hardLimitPhrases = [
    "你已達到本次對話的長度上限",
    "you've reached the maximum length for this conversation",
    "you have reached the maximum length for this conversation",
    "you've reached the length limit for this conversation",
    "this conversation has reached its maximum length",
]

let softLimitPhrases = [
    "你已達到本次對話的長度上限",
    "maximum length for this conversation",
    "length limit for this conversation",
]

let connectionInterruptedPhrases = [
    "連線已中斷",
    "正在等待完整回覆",
    "connection interrupted",
    "waiting for the full response",
]

// These labels identify the recovery button in a terminal conversation-limit
// banner. The ordinary sidebar "New chat" button does not count as evidence.
let terminalNewChatButtons = ["開始新對話", "start new chat", "start a new chat"]

struct AccessibleSnapshot {
    let strings: [String]
    let buttons: [String]
    let stopVisible: Bool
}

struct ChatFault {
    let state: String
    let hint: String
}

func classifyChatFault(_ snapshot: AccessibleSnapshot) -> ChatFault? {
    let strings = snapshot.strings.map { $0.lowercased() }
    let buttons = snapshot.buttons.map { $0.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) }
    let hasHardLimitText = strings.contains { value in
        hardLimitPhrases.contains { value.contains($0) }
    }
    let hasNewChatAction = buttons.contains { label in
        terminalNewChatButtons.contains(label)
    }
    // An ordinary message discussing conversation limits must not trigger
    // automatic handoff. Require the specific system banner AND its action.
    if hasHardLimitText && hasNewChatAction {
        return ChatFault(state: "conversation_limit_reached", hint: "conversation_limit")
    }
    if strings.contains(where: { value in
        softLimitPhrases.contains(where: value.contains)
    }) {
        return ChatFault(state: "conversation_limit_needs_review", hint: "possible_conversation_limit")
    }
    if strings.contains(where: { value in
        connectionInterruptedPhrases.contains(where: value.contains)
    }) {
        return ChatFault(state: "connection_interrupted", hint: "connection_interrupted")
    }
    for (phrase, hint) in errors {
        if strings.contains(where: { $0.contains(phrase) }) {
            return ChatFault(state: "error_detected", hint: hint)
        }
    }
    return nil
}

// AXWindows isn't implemented consistently by every WebKit/Electron host.
// The WindowServer can confirm a visible app window without Screen Recording
// permission, but this fallback must never claim it can read conversation text.
func visibleWindowCount(pid: pid_t) -> Int {
    guard let rows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] else { return 0 }
    return rows.filter { row in
        (row[kCGWindowOwnerPID as String] as? Int32) == pid
          && (row[kCGWindowLayer as String] as? Int) == 0
    }.count
}

func applicationWindows(_ app: AXUIElement) -> ([AXUIElement], Int32?) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    if error == .success, let windows = value as? [AXUIElement], !windows.isEmpty {
        return (windows, nil)
    }
    // Some apps support only MainWindow or FocusedWindow.
    for key in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
        if let value = attribute(app, key as String),
           CFGetTypeID(value) == AXUIElementGetTypeID() {
            return ([value as! AXUIElement], nil)
        }
    }
    return ([], error == .success ? nil : error.rawValue)
}

func attribute(_ element: AXUIElement, _ key: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}

func text(_ value: AnyObject?) -> String? {
    value as? String
}

func accessibleSnapshot(_ window: AXUIElement) -> AccessibleSnapshot {
    var stack = [(window, 0)]
    var scanned = 0
    var result: [String] = []
    var buttons: [String] = []
    var stopVisible = false
    while let (element, depth) = stack.popLast(), scanned < 950 {
        scanned += 1
        let role = text(attribute(element, kAXRoleAttribute as String)) ?? ""
        for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            if let value = text(attribute(element, key as String)), !value.isEmpty {
                result.append(String(value.prefix(250)))
                if role == "AXButton" {
                    buttons.append(value.lowercased().trimmingCharacters(in: .whitespacesAndNewlines))
                    if ["停止", "停止產生", "stop", "stop generating"].contains(value.lowercased()) {
                        stopVisible = true
                    }
                }
            }
        }
        if depth < 9, let children = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] {
            // Visit the newest trailing UI nodes first. The terminal warning
            // sits below a potentially huge conversation, and an older-first
            // scan could exhaust the bounded traversal before reaching it.
            for child in children.suffix(80) { stack.append((child, depth + 1)) }
        }
    }
    return AccessibleSnapshot(strings: result, buttons: buttons, stopVisible: stopVisible)
}

func observation(previousHash: String?, unchangedSince: Date?) -> (Observation, String?, Date?) {
    let now = Date()
    let timestamp = ISO8601DateFormatter().string(from: now)
    let permission = AXIsProcessTrusted()
    let apps = NSWorkspace.shared.runningApplications.filter {
        $0.bundleIdentifier == "com.openai.chat" || $0.localizedName == "ChatGPT"
    }
    let chat = apps.first
    let base = (appRunning: chat != nil, permission: permission)
    guard permission, let chat else {
        return (Observation(state: !permission ? "permission_required" : "app_not_running",
                            permissionGranted: permission, observedAt: timestamp,
                            appRunning: base.appRunning, windowCount: 0,
                            conversationTitle: nil, errorHint: nil,
                            unchangedSeconds: nil, uiFingerprint: nil,
                            coverage: "visible_chatgpt_windows_only", windowSource: nil,
                            accessibilityErrorCode: nil, stopControlVisible: nil), nil, nil)
    }

    let app = AXUIElementCreateApplication(chat.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 2.0)
    let (windows, axError) = applicationWindows(app)
    let visibleCount = max(windows.count, visibleWindowCount(pid: chat.processIdentifier))
    let source = windows.isEmpty ? "window_server_only" : "accessibility"
    guard !windows.isEmpty else {
        return (Observation(state: visibleCount > 0 ? "window_detected_unreadable" : "no_visible_window",
                            permissionGranted: true, observedAt: timestamp,
                            appRunning: true, windowCount: visibleCount,
                            conversationTitle: nil, errorHint: nil,
                            unchangedSeconds: nil, uiFingerprint: nil,
                            coverage: "visible_chatgpt_windows_only", windowSource: source,
                            accessibilityErrorCode: axError, stopControlVisible: nil), nil, nil)
    }

    // Only use the first visible window for title and observation. Other
    // conversations and background tabs cannot be inferred from this result.
    let window = windows.first
    let title = window.flatMap { text(attribute($0, kAXTitleAttribute as String)) }
    let snapshot = window.map(accessibleSnapshot)
        ?? AccessibleSnapshot(strings: [], buttons: [], stopVisible: false)
    let values = snapshot.strings
    let fault = classifyChatFault(snapshot)
    let hash = String(SHA256.hash(data: Data(values.joined(separator: "\n").utf8))
                        .map { String(format: "%02x", $0) }.joined().prefix(32))
    let changedAt = previousHash == hash ? (unchangedSince ?? now) : now
    let seconds = max(0, Int(now.timeIntervalSince(changedAt)))
    // UI inactivity alone is not proof the model is stuck. Mark for review;
    // no automatic click or refresh may be based solely on this timer.
    let state = fault?.state ?? (seconds >= 300 && snapshot.stopVisible
        ? "unchanged_needs_review" : "observing")
    return (Observation(state: state, permissionGranted: true,
                        observedAt: timestamp, appRunning: true,
                        windowCount: visibleCount, conversationTitle: title,
                        errorHint: fault?.hint, unchangedSeconds: seconds,
                        uiFingerprint: hash, coverage: "visible_chatgpt_windows_only",
                        windowSource: source, accessibilityErrorCode: axError,
                        stopControlVisible: snapshot.stopVisible), hash, changedAt)
}

func save(_ value: Observation, to path: String) {
    guard let bytes = try? JSONEncoder().encode(value) else { return }
    let target = URL(fileURLWithPath: path)
    try? FileManager.default.createDirectory(at: target.deletingLastPathComponent(),
                                             withIntermediateDirectories: true,
                                             attributes: [.posixPermissions: 0o700])
    let temporary = target.appendingPathExtension("tmp")
    guard FileManager.default.createFile(atPath: temporary.path, contents: bytes,
                                         attributes: [.posixPermissions: 0o600]) else { return }
    _ = try? FileManager.default.replaceItemAt(target, withItemAt: temporary)
    if !FileManager.default.fileExists(atPath: target.path) {
        try? FileManager.default.moveItem(at: temporary, to: target)
    }
}

let args = CommandLine.arguments
if args.count == 2 && args[1] == "--self-test" {
    func expect(_ condition: Bool, _ description: String) {
        guard condition else {
            fputs("Chat Supervisor self-test FAILED: \(description)\n", stderr)
            exit(1)
        }
    }
    let capped = AccessibleSnapshot(strings: ["你已達到本次對話的長度上限，但是你可以開始新聊天以持續對話。"],
                                    buttons: ["開始新對話"], stopVisible: false)
    expect(classifyChatFault(capped)?.state == "conversation_limit_reached", "Traditional Chinese limit banner")
    let cappedEN = AccessibleSnapshot(strings: ["You've reached the maximum length for this conversation"],
                                      buttons: ["Start new chat"], stopVisible: false)
    expect(classifyChatFault(cappedEN)?.state == "conversation_limit_reached", "English limit banner")
    let quoteOnly = AccessibleSnapshot(strings: ["你已達到本次對話的長度上限"],
                                       buttons: ["新聊天"], stopVisible: false)
    expect(classifyChatFault(quoteOnly)?.state == "conversation_limit_needs_review", "quoted limit without action")
    let disconnected = AccessibleSnapshot(strings: ["連線已中斷。正在等待完整回覆"],
                                          buttons: [], stopVisible: true)
    expect(classifyChatFault(disconnected)?.state == "connection_interrupted", "network disconnect")
    expect(classifyChatFault(AccessibleSnapshot(strings: ["正常執行"], buttons: [], stopVisible: false)) == nil,
           "no false detection in normal chat")
    print("Chat Supervisor fault classification tests passed")
    exit(0)
}
if args.count != 3 || args[1] != "--watch" {
    fputs("Usage: Flyto2ChatSupervisor --watch <status-file> | --self-test\n", stderr)
    exit(2)
}
// Ask macOS to display its native Accessibility consent UI when this freshly
// installed app is started. This is a request, not a permission bypass. Only
// perform it once per process launch to avoid repeated system prompts.
let promptOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
_ = AXIsProcessTrustedWithOptions(promptOptions)
var previous: String? = nil
var changed: Date? = nil
while true {
    let (result, fingerprint, changedAt) = observation(previousHash: previous, unchangedSince: changed)
    previous = fingerprint
    changed = changedAt
    save(result, to: args[2])
    Thread.sleep(forTimeInterval: 15)
}
