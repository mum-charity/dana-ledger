import XCTest

// These drive the iPhone app in the simulator against the web app built from this repo and served
// from the Mac at http://localhost:41871 (ios/test.sh starts it). At localhost the web app keeps
// records on the device only and never sends anything to the family's backup server.

private let startURL = ProcessInfo.processInfo.environment["DANA_TEST_URL"] ?? "http://localhost:41871/"

@MainActor
private func launch(_ url: String = startURL, reset: Bool) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-startURL", url]
    if reset { app.launchArguments += ["-resetData", "YES"] }
    app.launch()
    return app
}

/// An empty book opens on 公开账目. This goes on to the empty book's own home page.
@MainActor
private func openEmptyBook(_ app: XCUIApplication) -> XCUIElement {
    let ownBook = app.webViews.descendants(matching: .any)["不登入，在这部手机另开一本簿子"].firstMatch
    XCTAssertTrue(ownBook.waitForExistence(timeout: 30), "an empty book opens on the public accounts")
    let add = app.webViews.buttons["＋ 新增项目"].firstMatch
    // Right after launch the page redraws when the public accounts' request comes back, and a tap
    // at that moment can land on nothing. Tap again, as she would.
    for _ in 1...3 where !add.exists {
        if ownBook.exists { ownBook.tap() }
        _ = add.waitForExistence(timeout: 5)
    }
    XCTAssertTrue(add.exists, "the empty book's home page shows")
    return add
}

@MainActor
private func keepScreenshot(_ app: XCUIApplication, _ name: String, in test: XCTestCase) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    test.add(shot)
}

/// Run while the web app is being served. The tests run in name order.
final class OnlineTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    @MainActor
    func test1_OpensAsAnInstalledApp() {
        let app = launch(reset: true)
        _ = openEmptyBook(app)
        // The page believes it is installed, so it does not ask her to add it to the home screen.
        XCTAssertFalse(app.webViews.buttons["添加到手机主屏幕"].exists)
        keepScreenshot(app, "home", in: self)
    }

    @MainActor
    func test2_ExportAndPrintOpenTheSystemSheets() {
        let app = launch(reset: true)
        openEmptyBook(app).tap()
        let name = app.webViews.textFields["项目名称"].firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.typeText("Test fund")
        // The keyboard covers 保存; put it away first, as she would.
        for done in ["完成", "Done"] where app.buttons[done].exists {
            app.buttons[done].tap()
            break
        }
        // An iPad keyboard has no 完成 bar: tapping outside the field puts it away.
        if app.keyboards.firstMatch.exists { app.webViews.staticTexts["新增项目"].firstMatch.tap() }
        XCTAssertTrue(waitForGone(app.keyboards.firstMatch), "the keyboard is put away")
        let save = app.webViews.buttons["保存"].firstMatch
        XCTAssertTrue(save.isHittable)
        save.tap()
        XCTAssertTrue(waitForGone(save), "the fund is saved and the sheet closes")

        let yearTab = app.webViews.buttons["全年表"].firstMatch
        XCTAssertTrue(yearTab.waitForExistence(timeout: 10))
        yearTab.tap()

        let export = app.webViews.buttons["导出 Excel 表格"].firstMatch
        XCTAssertTrue(export.waitForExistence(timeout: 10))
        export.tap()
        let shareSheet = app.otherElements["ActivityListView"].firstMatch
        XCTAssertTrue(shareSheet.waitForExistence(timeout: 10), "the share sheet opens with the CSV file")
        keepScreenshot(app, "share-csv", in: self)
        let fileName = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Test fund-")).firstMatch
        XCTAssertTrue(fileName.waitForExistence(timeout: 5), "the file keeps its name")
        dismissSheet(app)
        XCTAssertTrue(waitForGone(shareSheet))

        let print = app.webViews.buttons["打印 / 存成 PDF"].firstMatch
        XCTAssertTrue(print.waitForExistence(timeout: 10))
        print.tap()
        XCTAssertTrue(printOptions(app).waitForExistence(timeout: 10), "the print sheet opens")
        keepScreenshot(app, "print", in: self)
    }

    @MainActor
    private func dismissSheet(_ app: XCUIApplication) {
        for label in ["关闭", "Close"] where app.buttons[label].exists {
            app.buttons[label].tap()
            return
        }
        app.swipeDown(velocity: .fast)
    }

    @MainActor
    private func waitForGone(_ element: XCUIElement) -> Bool {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
        return XCTWaiter().wait(for: [gone], timeout: 10) == .completed
    }

    @MainActor
    private func printOptions(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label IN %@ OR identifier IN %@", ["打印选项", "Print Options", "选项", "Options"], ["Print Options", "UIPrintPanelView"])).firstMatch
    }
}

/// Run after the server has been stopped, so nothing can be fetched.
final class OfflineTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    /// Opened once with signal (OnlineTests), it opens again without, with the records still there.
    @MainActor
    func test1_OpensWithoutSignalAfterTheFirstTime() {
        let app = launch(reset: false)
        // The fund is a button on the home page: 「Test fund 本月已收 0 / 0 人 …」.
        let fund = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Test fund")).firstMatch
        XCTAssertTrue(fund.waitForExistence(timeout: 30), "the saved fund shows")
        XCTAssertFalse(app.buttons["offline-retry"].exists)
        keepScreenshot(app, "offline-home", in: self)
    }

    /// Never opened with signal: a plain page with a retry button instead of a blank screen.
    @MainActor
    func test2_SaysSoWhenItHasNeverOpened() {
        let app = launch("http://localhost:41872/", reset: true)
        XCTAssertTrue(app.buttons["offline-retry"].waitForExistence(timeout: 30))
        keepScreenshot(app, "never-opened", in: self)
    }
}

/// Opens the real site, https://mum.franklee.asia/, from an empty book and only reads: it types
/// nothing, so nothing is sent to the backup server. Skipped unless asked for:
///   TEST_RUNNER_DANA_LIVE_CHECKS=1 xcodebuild ... -only-testing:DanaLedgerUITests/LiveChecks test
final class LiveChecks: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(ProcessInfo.processInfo.environment["DANA_LIVE_CHECKS"] == "1", "only when asked for")
    }

    /// Google refuses sign-in inside an app's web view, so the button says so instead of leaving a blank page.
    @MainActor
    func test_GoogleSignInExplainsWhyNot() {
        let app = launch("https://mum.franklee.asia/", reset: true)
        let signIn = app.webViews.buttons["用 Google 帐号登入"].firstMatch
        XCTAssertTrue(signIn.waitForExistence(timeout: 30))
        // The public accounts came from the backup server, so the app can reach it.
        XCTAssertTrue(app.webViews.staticTexts["手上应有"].firstMatch.waitForExistence(timeout: 15))
        signIn.tap()
        XCTAssertTrue(app.alerts["这里还不能用 Google 登入"].waitForExistence(timeout: 10))
        keepScreenshot(app, "sign-in-alert", in: self)
        app.alerts.buttons["好"].tap()
        XCTAssertTrue(signIn.waitForExistence(timeout: 5), "still on the app's page, not Google's")
    }
}
