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
}

let errors: [(String, String)] = [
    ("something went wrong", "something_went_wrong"),
    ("there was an error generating", "generation_error"),
    ("network error", "network_error"),
    ("an error occurred", "generation_error"),
    ("發生錯誤", "generation_error"),
    ("網路錯誤", "network_error"),
]

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

func accessibleStrings(_ window: AXUIElement) -> [String] {
    var stack = [(window, 0)]
    var scanned = 0
    var result: [String] = []
    while let (element, depth) = stack.popLast(), scanned < 600 {
        scanned += 1
        for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            if let value = text(attribute(element, key as String)), !value.isEmpty {
                result.append(String(value.prefix(250)))
            }
        }
        if depth < 5, let children = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] {
            for child in children.prefix(80).reversed() { stack.append((child, depth + 1)) }
        }
    }
    return result
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
                            accessibilityErrorCode: nil), nil, nil)
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
                            accessibilityErrorCode: axError), nil, nil)
    }

    // Only use the first visible window for title and observation. Other
    // conversations and background tabs cannot be inferred from this result.
    let window = windows.first
    let title = window.flatMap { text(attribute($0, kAXTitleAttribute as String)) }
    let values = window.map(accessibleStrings) ?? []
    let matched = errors.first { phrase, _ in
        values.contains { $0.lowercased().contains(phrase) }
    }?.1
    let hash = String(SHA256.hash(data: Data(values.joined(separator: "\n").utf8))
                        .map { String(format: "%02x", $0) }.joined().prefix(32))
    let changedAt = previousHash == hash ? (unchangedSince ?? now) : now
    let seconds = max(0, Int(now.timeIntervalSince(changedAt)))
    // UI inactivity alone is not proof the model is stuck. Mark for review;
    // no automatic click or refresh may be based solely on this timer.
    let state = matched != nil ? "error_detected"
        : seconds >= 300 ? "unchanged_needs_review" : "observing"
    return (Observation(state: state, permissionGranted: true,
                        observedAt: timestamp, appRunning: true,
                        windowCount: visibleCount, conversationTitle: title,
                        errorHint: matched, unchangedSeconds: seconds,
                        uiFingerprint: hash, coverage: "visible_chatgpt_windows_only",
                        windowSource: source, accessibilityErrorCode: axError), hash, changedAt)
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
if args.count != 3 || args[1] != "--watch" {
    fputs("Usage: Flyto2ChatSupervisor --watch <status-file>\n", stderr)
    exit(2)
}
var previous: String? = nil
var changed: Date? = nil
while true {
    let (result, fingerprint, changedAt) = observation(previousHash: previous, unchangedSince: changed)
    previous = fingerprint
    changed = changedAt
    save(result, to: args[2])
    Thread.sleep(forTimeInterval: 15)
}
