import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /// The address the app opens. A test build can point it at the Mac with `-startURL http://localhost:41871/`,
    /// where the web app keeps records to itself and never sends them to the backup server.
    static var startURL: URL {
        #if DEBUG
        if let text = UserDefaults.standard.string(forKey: "startURL"), let url = URL(string: text) { return url }
        #endif
        return URL(string: "https://mum.franklee.asia/")!
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = LedgerViewController(startURL: Self.startURL, resetFirst: Self.resetRequested)
        window.makeKeyAndVisible()
        self.window = window
    }

    /// The UI tests start some runs from an empty phone with `-resetData YES`. Never in the App Store build.
    private static var resetRequested: Bool {
        #if DEBUG
        return UserDefaults.standard.bool(forKey: "resetData")
        #else
        return false
        #endif
    }
}
