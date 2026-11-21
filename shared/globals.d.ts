/*
 * What the app looks for on `window`, beyond what a browser puts there. This file has no imports
 * or exports, so what it declares is known everywhere: to the app and to the browser tests.
 */

/** Android's install prompt, held until 添加到手机主屏幕 is tapped. Not in TypeScript's own list. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
}

interface Window {
  /** Set by the tests: the stand-in backup server to use, not the real one. */
  LEDGER_BACKUP_SERVER?: string;
  /** Set by the tests: a stand-in for Google's sign-in page. */
  LEDGER_GOOGLE_AUTH?: string;
  /** The install prompt, if Android offered it before the app's code loaded (see app/layout.tsx). */
  __installPrompt?: BeforeInstallPromptEvent;
}

interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent;
}

interface Navigator {
  /** iPhone only: true when opened from the home screen icon. */
  standalone?: boolean;
}
