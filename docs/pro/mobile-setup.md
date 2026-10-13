# Use ctrlyoke on your phone

With Pro (or the 14-day remote-access trial), you can open the ctrlyoke
dashboard on a phone or tablet and install it as an app. The app connects to the
VS Code window running on your computer, so you can watch and take control of a
running workflow away from your desk.

Setup has three parts: turn on HTTPS on your computer, trust ctrlyoke's
certificate on the phone, then install the app. HTTPS is what lets the phone
install ctrlyoke as an app and receive push notifications, and the phone only
accepts it once it trusts the certificate.

Steps 1 and 2 are the same for every phone. After that, follow the section for
your device: [iPhone and iPad](#iphone-and-ipad) or [Android](#android).

## 1. Set up the server on your computer

In VS Code, open the ctrlyoke dashboard, select the gear icon (**Global
Settings**), and open the **Server** tab.

<details>
<summary>Watch the computer setup (30 seconds)</summary>

<video src="/screenshots/desktop-server-setup-1300x1000.mp4" controls muted playsinline preload="none" width="650"></video>

</details>

1. Set **Bind address** to **All interfaces (0.0.0.0)** so other devices on your
   network can reach the server.

   ![The Server tab with the Bind address list open on All interfaces](/screenshots/desktop-server-setup-01-bind-all-interfaces-628x690.png)

2. Turn on **Enable HTTPS**.

   ![HTTPS / TLS settings with Enable HTTPS turned on](/screenshots/desktop-server-setup-02-enable-https-628x340.png)

3. Select **Generate self-signed certificate**. Check that the list of
   addresses under **Cert generated** includes your computer's network address
   (such as `192.168.x.x`), not only `localhost` and `127.0.0.1`. ctrlyoke
   shows a warning under the certificate when it doesn't.

   ![A generated certificate listing localhost, 127.0.0.1, and the computer's network addresses](/screenshots/desktop-server-setup-03-certificate-generated-628x400.png)

4. Select **Start server**. If the server was already running, select **Stop
   server** first, then **Start server**, so the new settings take effect.
   Optionally, turn on **Auto Start** so the server starts whenever VS Code
   does.

   ![The server running, with the Connect via address and the server link](/screenshots/desktop-server-setup-04-server-running-628x350.png)

Do these in order. The certificate only covers the network addresses your
computer has when you generate it, and it only includes them when **Bind
address** is already **All interfaces**. If your computer's IP address changes
later, or you see a certificate warning after installing the certificate,
generate a new certificate, restart the server, and install the new one on
your phone.

The phone must be on the same network as your computer, or connected to it
through a VPN. To use it away from home, set up the VPN first, then follow
[Connect from anywhere](/pro/remote-access) before installing the app: the app
belongs to the address you install it from.

## 2. Open ctrlyoke on the phone

1. On your computer, select the QR code button next to the server link. If your
   computer has more than one network address, choose the one your phone can
   reach under **Connect via** first.

   ![The QR code shown below the server link](/screenshots/desktop-server-setup-05-qr-code-628x620.png)

2. Scan the QR code with the phone's camera and open the link: Safari on iPhone
   or iPad, Chrome on Android.
3. The browser warns that the connection isn't private. This is expected,
   because the phone doesn't trust ctrlyoke's certificate yet. Continue to the
   site (**Show Details → visit this website** in Safari, **Advanced → Proceed**
   in Chrome).

The link contains an access token that works like a password. Share it only
with people you trust, and select **Regenerate token** if it's exposed. Each
workspace has its own token, so regenerating it only changes that workspace's
link, and only its home-screen app needs to be added again.

Select any screenshot below to open it full size.

## iPhone and iPad

Requires iOS 18.2 or later. iOS 18.0 and 18.1 never show the full-trust switch
in step 4.

<details>
<summary>Watch the whole iPhone setup (1 minute)</summary>

![Animated walkthrough of the iPhone setup, from downloading the certificate to the ctrlyoke icon on the home screen](/screenshots/ios-pwa-setup-390x796.webp)

</details>

### Trust the certificate

1. In the dashboard on the phone, open **Global Settings → Server** and tap
   **Download certificate**. Tap **Allow** to download the configuration
   profile, then **Close**.

   <div class="device-shots">

   [![ctrlyoke Server settings with the Download certificate button](/screenshots/ios-pwa-setup-01-download-certificate-750x1532.png)](/screenshots/ios-pwa-setup-01-download-certificate-750x1532.png)
   [![Safari asking to allow the configuration profile download](/screenshots/ios-pwa-setup-02-allow-profile-download-750x1532.png)](/screenshots/ios-pwa-setup-02-allow-profile-download-750x1532.png)
   [![Profile Downloaded message with a Close button](/screenshots/ios-pwa-setup-03-profile-downloaded-750x1532.png)](/screenshots/ios-pwa-setup-03-profile-downloaded-750x1532.png)

   </div>

2. Open the Settings app and tap **Profile Downloaded** near the top (or go to
   **Settings → General → VPN & Device Management**), then tap the ctrlyoke
   profile.

   <div class="device-shots">

   [![Settings app with the Profile Downloaded row near the top](/screenshots/ios-pwa-setup-04-settings-profile-downloaded-750x1532.png)](/screenshots/ios-pwa-setup-04-settings-profile-downloaded-750x1532.png)

   </div>

3. Tap **Install**, enter your passcode, tap **Install** on the root
   certificate warning, then **Install** again to confirm.

   <div class="device-shots">

   [![Install Profile screen for ctrlyoke Local CA](/screenshots/ios-pwa-setup-05-install-profile-750x1532.png)](/screenshots/ios-pwa-setup-05-install-profile-750x1532.png)
   [![Unmanaged root certificate warning with an Install button](/screenshots/ios-pwa-setup-06-root-certificate-warning-750x1532.png)](/screenshots/ios-pwa-setup-06-root-certificate-warning-750x1532.png)
   [![Confirmation sheet with an Install button](/screenshots/ios-pwa-setup-07-confirm-install-750x1532.png)](/screenshots/ios-pwa-setup-07-confirm-install-750x1532.png)
   [![Profile Installed screen](/screenshots/ios-pwa-setup-08-profile-installed-750x1532.png)](/screenshots/ios-pwa-setup-08-profile-installed-750x1532.png)

   </div>

4. Go to **Settings → General → About**, scroll to the bottom, and tap
   **Certificate Trust Settings**. Turn on full trust for **ctrlyoke Local CA**,
   then tap **Continue**.

   <div class="device-shots">

   [![Settings, General, with About highlighted](/screenshots/ios-pwa-setup-09-general-about-750x1532.png)](/screenshots/ios-pwa-setup-09-general-about-750x1532.png)
   [![The About screen scrolled to Certificate Trust Settings](/screenshots/ios-pwa-setup-10-about-certificate-trust-settings-750x1532.png)](/screenshots/ios-pwa-setup-10-about-certificate-trust-settings-750x1532.png)
   [![Certificate Trust Settings with the ctrlyoke Local CA switch off](/screenshots/ios-pwa-setup-11-full-trust-toggle-750x1532.png)](/screenshots/ios-pwa-setup-11-full-trust-toggle-750x1532.png)
   [![Root certificate warning with a Continue button](/screenshots/ios-pwa-setup-12-full-trust-continue-750x1532.png)](/screenshots/ios-pwa-setup-12-full-trust-continue-750x1532.png)
   [![Certificate Trust Settings with full trust turned on](/screenshots/ios-pwa-setup-13-full-trust-enabled-750x1532.png)](/screenshots/ios-pwa-setup-13-full-trust-enabled-750x1532.png)

   </div>

Step 4 is the one most often missed. Installing the profile alone isn't enough.

### Install the app

1. Open the ctrlyoke link in Safari again. There should be no certificate
   warning this time.
2. Tap **⋯ → Share**, then **Add to Home Screen**.
3. Name the app, leave **Open as Web App** on, and tap **Add**.

<div class="device-shots">

[![Safari's menu with Share highlighted](/screenshots/ios-pwa-setup-14-safari-share-750x1532.png)](/screenshots/ios-pwa-setup-14-safari-share-750x1532.png)
[![Share sheet with Add to Home Screen](/screenshots/ios-pwa-setup-15-add-to-home-screen-750x1532.png)](/screenshots/ios-pwa-setup-15-add-to-home-screen-750x1532.png)
[![Add to Home Screen with the app name and Open as Web App switched on](/screenshots/ios-pwa-setup-16-name-web-app-750x1532.png)](/screenshots/ios-pwa-setup-16-name-web-app-750x1532.png)
[![The ctrlyoke icon on the home screen](/screenshots/ios-pwa-setup-17-home-screen-icon-750x1532.png)](/screenshots/ios-pwa-setup-17-home-screen-icon-750x1532.png)

</div>

Open ctrlyoke from the home screen. It connects to the workflow running on your
computer.

## Android

The screenshots are from a Samsung tablet. Menu names and locations differ on
other devices and Android versions; the text below covers the common
variations.

<details>
<summary>Watch the whole Android setup (1 minute)</summary>

![Animated walkthrough of the Android setup, from downloading the certificate to opening the installed app](/screenshots/android-pwa-setup-390x626.webp)

</details>

### Trust the certificate

Tapping the downloaded file doesn't install it: Android only installs CA
certificates from the Settings app.

1. In the dashboard on the phone, open **Global Settings → Server** and tap
   **Download certificate**. Chrome saves `ctrlyoke.crt` to Downloads.

   <div class="device-shots">

   [![ctrlyoke Server settings in Chrome with the Download certificate button](/screenshots/android-pwa-setup-01-download-certificate-750x1202.png)](/screenshots/android-pwa-setup-01-download-certificate-750x1202.png)
   [![Chrome's File downloaded message for the certificate](/screenshots/android-pwa-setup-02-file-downloaded-750x1202.png)](/screenshots/android-pwa-setup-02-file-downloaded-750x1202.png)

   </div>

2. Open the Settings app and go to **Security & privacy → More security
   settings**. The next step depends on your phone:
   - **Samsung:** under **Credential storage**, tap **Install from device
     storage → CA certificate**.
   - **Pixel and most other phones:** tap **Encryption & credentials → Install
     a certificate → CA certificate**.

   If you can't find either, search Settings for "CA certificate".

   <div class="device-shots">

   [![Security and privacy settings with More security settings at the bottom](/screenshots/android-pwa-setup-03-more-security-settings-750x1202.png)](/screenshots/android-pwa-setup-03-more-security-settings-750x1202.png)
   [![More security settings with Install from device storage under Credential storage](/screenshots/android-pwa-setup-04-install-from-device-storage-750x1202.png)](/screenshots/android-pwa-setup-04-install-from-device-storage-750x1202.png)
   [![Install from device storage with CA certificate at the top](/screenshots/android-pwa-setup-05-ca-certificate-750x1202.png)](/screenshots/android-pwa-setup-05-ca-certificate-750x1202.png)

   </div>

3. Tap **Install anyway** on the warning. In the file picker, open the
   **Download** folder, select `ctrlyoke.crt`, and tap **Done**. Android shows
   **CA certificate installed**.

   <div class="device-shots">

   [![CA certificate warning with Install anyway](/screenshots/android-pwa-setup-06-install-anyway-750x1202.png)](/screenshots/android-pwa-setup-06-install-anyway-750x1202.png)
   [![File picker showing the Download folder](/screenshots/android-pwa-setup-07-open-download-folder-750x1202.png)](/screenshots/android-pwa-setup-07-open-download-folder-750x1202.png)
   [![File picker with ctrlyoke.crt selected and the Done button](/screenshots/android-pwa-setup-08-select-certificate-750x1202.png)](/screenshots/android-pwa-setup-08-select-certificate-750x1202.png)
   [![CA certificate installed message](/screenshots/android-pwa-setup-09-certificate-installed-750x1202.png)](/screenshots/android-pwa-setup-09-certificate-installed-750x1202.png)

   </div>

4. Optional: to check it worked, open **User certificates** (Samsung, under
   **Credential storage**) or **Encryption & credentials → Trusted credentials
   → User**. The ctrlyoke certificate should be listed.
5. Fully quit Chrome: open Recent apps and swipe every Chrome window away, or
   tap **Close all**. Chrome keeps treating the certificate as untrusted until
   it restarts, even after it's installed.

   <div class="device-shots">

   [![Recent apps with the Close all button](/screenshots/android-pwa-setup-10-close-all-chrome-windows-750x1202.png)](/screenshots/android-pwa-setup-10-close-all-chrome-windows-750x1202.png)

   </div>

### Install the app

1. Open Chrome and the ctrlyoke link again. There should be no certificate
   warning this time.
2. Tap the **⋮** menu → **Install and create shortcut**, then **Install**, and
   **Install** again to confirm. Older Chrome versions call this **Install
   app** or **Add to home screen**.

   Choose **Install**, not **Create shortcut**: a shortcut only opens ctrlyoke
   in a Chrome tab, and **Install** doesn't work until the certificate is
   trusted.

<div class="device-shots">

[![Chrome's menu with Install and create shortcut at the bottom](/screenshots/android-pwa-setup-11-chrome-menu-install-750x1202.png)](/screenshots/android-pwa-setup-11-chrome-menu-install-750x1202.png)
[![Install and create shortcut sheet with Install and Create shortcut options](/screenshots/android-pwa-setup-12-choose-install-750x1202.png)](/screenshots/android-pwa-setup-12-choose-install-750x1202.png)
[![Install app dialog for ctrlyoke with an Install button](/screenshots/android-pwa-setup-13-install-app-750x1202.png)](/screenshots/android-pwa-setup-13-install-app-750x1202.png)
[![Chrome's ctrlyoke App installed message](/screenshots/android-pwa-setup-14-app-installed-750x1202.png)](/screenshots/android-pwa-setup-14-app-installed-750x1202.png)
[![The installed ctrlyoke app running full screen without Chrome's address bar](/screenshots/android-pwa-setup-15-installed-app-750x1202.png)](/screenshots/android-pwa-setup-15-installed-app-750x1202.png)

</div>

Open ctrlyoke from the home screen or app drawer. It connects to the workflow
running on your computer.

## Troubleshooting

- **The warning is still there after installing the certificate.** On Android,
  fully quit and reopen Chrome. Otherwise, the certificate may not cover the
  address you're using: generate a new one (see step 1), restart the server,
  and install it again.
- **Android Chrome only offers "Create shortcut".** The certificate isn't
  trusted yet. Finish [Trust the certificate](#trust-the-certificate-1),
  including restarting Chrome.
- **The app can't connect.** Check that VS Code is open with the ctrlyoke server
  running, and that the phone is on the same network as your computer.
