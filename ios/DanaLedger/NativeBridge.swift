import UIKit
import WebKit

/// What a home-screen web app on iPhone gets from Safari and a plain web view does not:
/// the share sheet for files and text (导出 Excel 表格, the WhatsApp summary), printing
/// (打印 / 存成 PDF), and being treated as already installed, so the page does not ask her to
/// add it to the home screen. The web app's code is unchanged; it calls the usual browser
/// functions and this answers them.
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var webView: WKWebView?
    private weak var presenter: UIViewController?
    private let ownHost: String?

    init(webView: WKWebView, presenter: UIViewController, ownHost: String?) {
        self.webView = webView
        self.presenter = presenter
        self.ownHost = ownHost
    }

    func install(in contentController: WKUserContentController) {
        contentController.addUserScript(WKUserScript(source: Self.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        contentController.addScriptMessageHandler(WeakHandler(self), contentWorld: .page, name: "danaLedger")
    }

    /// Runs in the page before its own code. Replies: true when shared, false when she cancelled.
    private static let script = #"""
    (() => {
      const post = (message) => window.webkit.messageHandlers.danaLedger.postMessage(message);
      const toBase64 = (buffer) => {
        const bytes = new Uint8Array(buffer);
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(text);
      };
      const set = (target, name, value) => Object.defineProperty(target, name, { value, configurable: true, writable: true });
      set(navigator, 'canShare', (data) => !!data && !!(data.text || data.url || (data.files && data.files.length)));
      set(navigator, 'share', async (data = {}) => {
        const files = [];
        for (const file of data.files || []) {
          files.push({ name: String(file.name || 'file'), base64: toBase64(await file.arrayBuffer()) });
        }
        const shared = await post({ kind: 'share', title: data.title || null, text: data.text || null, url: data.url || null, files });
        if (!shared) throw new DOMException('Share canceled', 'AbortError');
      });
      set(window, 'print', () => { post({ kind: 'print' }); });
      Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
    })();
    """#

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        // Only the app's own page, never a frame or another site, may ask.
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == ownHost,
              let body = message.body as? [String: Any], let kind = body["kind"] as? String else {
            return (nil, "not allowed")
        }
        switch kind {
        case "share":
            return (await share(body), nil)
        case "print":
            printPage()
            return (true, nil)
        default:
            return (nil, "unknown request")
        }
    }

    // MARK: - Share sheet

    private func share(_ body: [String: Any]) async -> Bool {
        guard let presenter, let webView else { return false }
        var items: [Any] = []
        var folder: URL?
        if let files = body["files"] as? [[String: Any]], !files.isEmpty {
            // Shared as real files with their own names, so WhatsApp and Files show 「项目-2026.csv」.
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            folder = dir
            for file in files {
                guard let base64 = file["base64"] as? String, let data = Data(base64Encoded: base64) else { continue }
                let url = dir.appendingPathComponent(Self.safeFileName(file["name"] as? String))
                if (try? data.write(to: url)) != nil { items.append(url) }
            }
        }
        if let text = body["text"] as? String, !text.isEmpty { items.append(text) }
        if let link = body["url"] as? String, let url = URL(string: link) { items.append(url) }
        guard !items.isEmpty else { return false }

        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = webView
            popover.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.maxY - 80, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        let shared = await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            var answered = false
            sheet.completionWithItemsHandler = { _, completed, _, _ in
                guard !answered else { return }
                answered = true
                done.resume(returning: completed)
            }
            presenter.present(sheet, animated: true)
        }
        if let folder { try? FileManager.default.removeItem(at: folder) }
        return shared
    }

    /// A file name from the page, made safe to use as one: no folders, never empty.
    static func safeFileName(_ name: String?) -> String {
        let cleaned = (name ?? "").components(separatedBy: CharacterSet(charactersIn: "/\\:\0")).joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty || cleaned.hasPrefix(".") ? "善款簿-\(cleaned)" : cleaned
    }

    // MARK: - Printing

    /// The year table's print layout (A4 landscape) prints, or saves as PDF from the print sheet.
    private func printPage() {
        guard let webView, let presenter else { return }
        let info = UIPrintInfo(dictionary: nil)
        info.jobName = webView.title ?? "善款簿"
        info.outputType = .general
        info.orientation = .landscape
        let controller = UIPrintInteractionController.shared
        controller.printInfo = info
        controller.printFormatter = webView.viewPrintFormatter()
        if presenter.traitCollection.userInterfaceIdiom == .pad {
            let rect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1)
            controller.present(from: rect, in: webView, animated: true)
        } else {
            controller.present(animated: true)
        }
    }
}

/// The web view keeps its message handlers for as long as it lives; this stops it keeping the bridge too.
private final class WeakHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: NativeBridge?
    init(_ target: NativeBridge) { self.target = target }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let target else { return (nil, "closed") }
        return await target.userContentController(userContentController, didReceive: message)
    }
}
