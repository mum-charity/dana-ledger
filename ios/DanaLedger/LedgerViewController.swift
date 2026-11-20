import UIKit
import WebKit

/// The whole app: one web view showing 善款簿 from its own site, so deploying the web app also
/// updates this app. Records are kept in the web view's storage on the phone, as they are in Safari,
/// and the web app backs them up by itself. Nothing here reads or changes them.
final class LedgerViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let startURL: URL
    private let resetFirst: Bool
    private var webView: WKWebView!
    private var bridge: NativeBridge!
    private let offlineView = OfflineView()
    private var hasShownPage = false

    init(startURL: URL, resetFirst: Bool) {
        self.startURL = startURL
        self.resetFirst = resetFirst
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let config = WKWebViewConfiguration()
        // iOS runs the site's service worker, which lets the app open without signal, only for the
        // domains in Info.plist's WKAppBoundDomains, and only while navigation is held to them.
        config.limitsNavigationsToAppBoundDomains = true
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "Mobile/15E148 DanaLedgerApp/1.0"
        let contentController = WKUserContentController()
        config.userContentController = contentController

        webView = WKWebView(frame: .zero, configuration: config)
        bridge = NativeBridge(webView: webView, presenter: self, ownHost: startURL.host)
        bridge.install(in: contentController)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        // The page draws behind the notch and home bar itself (viewport-fit=cover and env(safe-area-inset-*)).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // No white flash in dark mode while the page loads.
        let background = UIColor(named: "LaunchBackground") ?? .systemBackground
        webView.isOpaque = false
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        let root = UIView()
        root.backgroundColor = background
        webView.translatesAutoresizingMaskIntoConstraints = false
        offlineView.translatesAutoresizingMaskIntoConstraints = false
        offlineView.isHidden = true
        offlineView.onRetry = { [weak self] in self?.loadStart() }
        root.addSubview(webView)
        root.addSubview(offlineView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: root.topAnchor),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            offlineView.topAnchor.constraint(equalTo: root.topAnchor),
            offlineView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            offlineView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            offlineView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if resetFirst {
            let store = WKWebsiteDataStore.default()
            store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { [weak self] in
                self?.loadStart()
            }
        } else {
            loadStart()
        }
    }

    private func loadStart() {
        offlineView.isHidden = true
        webView.load(URLRequest(url: startURL))
    }

    private func isOwnSite(_ url: URL) -> Bool {
        url.scheme == startURL.scheme && url.host == startURL.host && url.port == startURL.port
    }

    // MARK: - Where links go

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        if isOwnSite(url) || ["about", "blob", "data"].contains(url.scheme ?? "") { return .allow }
        if url.host == "accounts.google.com" {
            showSignInUnavailable()
            return .cancel
        }
        // Any other site, WhatsApp, phone numbers and the like open outside the app.
        await UIApplication.shared.open(url)
        return .cancel
    }

    /// Links that ask for a new window (target=_blank, window.open) open outside the app.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    /// Google refuses to sign anyone in inside an app's web view, so the family sign-in cannot work
    /// here until it goes through a system sign-in sheet. Say so rather than show a blank page, and
    /// point to where the shared book does work. Not to a setup link: that loads a separate copy
    /// which never follows the family's book.
    private func showSignInUnavailable() {
        let alert = UIAlertController(
            title: "这里还不能用 Google 登入",
            message: "家人共用的账本，请在 Safari 或主屏幕上的「善款簿」登入使用。",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }

    // MARK: - Loading

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasShownPage = true
        offlineView.isHidden = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOfflineIfNeeded(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showOfflineIfNeeded(error)
    }

    private func showOfflineIfNeeded(_ error: Error) {
        let nsError = error as NSError
        // A navigation the app itself cancelled (another site opened outside, a new load started).
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        // Only when there is no page to show. With the offline cache the page opens without signal,
        // and a page already showing stays as it is.
        if !hasShownPage { offlineView.isHidden = false }
    }

    /// iOS may stop the web view's process while the app is in the background. Load it again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        hasShownPage = false
        loadStart()
    }
}

/// Shown when the site cannot be reached and has not been saved for offline use yet (the first
/// opening needs signal).
final class OfflineView: UIView {
    var onRetry: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(named: "LaunchBackground") ?? .systemBackground

        let title = UILabel()
        title.text = "善款簿"
        title.font = .systemFont(ofSize: 30, weight: .semibold)
        let message = UILabel()
        message.text = "现在打不开。请连上网络，再点「重试」。"
        message.font = .systemFont(ofSize: 22)
        message.numberOfLines = 0
        var buttonConfig = UIButton.Configuration.filled()
        buttonConfig.title = "重试"
        buttonConfig.baseBackgroundColor = UIColor(red: 0x9C / 255, green: 0x4A / 255, blue: 0x1E / 255, alpha: 1)
        buttonConfig.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 32, bottom: 14, trailing: 32)
        buttonConfig.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = .systemFont(ofSize: 22, weight: .semibold)
            return attributes
        }
        let retry = UIButton(configuration: buttonConfig, primaryAction: UIAction { [weak self] _ in self?.onRetry?() })
        retry.accessibilityIdentifier = "offline-retry"

        let stack = UIStackView(arrangedSubviews: [title, message, retry])
        stack.axis = .vertical
        stack.alignment = .leading
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor, constant: 48),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}
