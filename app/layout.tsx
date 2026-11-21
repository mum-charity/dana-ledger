import './globals.css';

export const metadata = {
  title: '善款簿',
  description: '记录每月善款：谁交了、交给了谁、还剩多少。',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F7F3EC' },
    { media: '(prefers-color-scheme: dark)', color: '#171411' },
  ],
};

// Android offers its install prompt once, sometimes before the app's code has loaded.
// Catch it here so the 添加到手机主屏幕 button can still use it.
const CATCH_INSTALL_PROMPT = `window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__installPrompt=e;});`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The app sets data-font from her saved setting once it has loaded.
    <html lang="zh-Hans" data-font="large" suppressHydrationWarning>
      <head>
        {/* Relative addresses, so the app also works from a sub-path. */}
        <link rel="manifest" href="manifest.webmanifest" />
        <link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png" />
        <link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="善款簿" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="format-detection" content="telephone=no" />
        <script dangerouslySetInnerHTML={{ __html: CATCH_INSTALL_PROMPT }} />
      </head>
      <body>
        {children}
        <noscript>
          <p style={{ padding: 24, fontSize: 20 }}>请开启 JavaScript 才能使用善款簿。</p>
        </noscript>
      </body>
    </html>
  );
}
