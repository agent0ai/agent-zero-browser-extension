# Install Chrome Bridge once

The Web Store item is still a draft. Use the supplied **unpacked ZIP** to load
the extension without building source. Open `START-HERE.html` after extracting
the entire ZIP; it provides an offline, operating-system-aware walkthrough.
The separate **store-candidate ZIP** is for the publisher dashboard, not this guide.

## What works on each system

| Chrome computer | Extension folder | Native companion |
| --- | --- | --- |
| macOS 13+, Intel or Apple Silicon | Same unpacked package | Signed/notarized 2.12.3 installer available |
| Windows | Same unpacked package | Installer and native platform verification incomplete |
| Linux x86-64 / ARM64 | Same unpacked package | Candidate builds exist; production installer not released |

Loading an extension is not the same as having working browser control.
**Windows and Linux end-to-end support is not complete.** Do not try a Mac
installer on those systems or repeatedly create pairing codes to resolve a
missing native companion. Linux requires desktop Secret Service and conventional
Chrome packaging; Snap/Flatpak integration is not supported.

## 1. Install the companion on the Chrome computer

On macOS, [download Agent Zero Browser Setup 2.12.3](https://raw.githubusercontent.com/TerminallyLazy/agent-zero-browser-releases/native-v2.12.3-macos/v2.12.3/a0-browser-bridge-2.12.3-macos-universal2.dmg).
Open the disk image, open **Agent Zero Browser Setup**, and choose
**Install browser companion**. No administrator password is needed.
Keep Gatekeeper, SmartScreen, and other OS protections enabled.

If Agent Zero runs in Docker, install the companion on your normal desktop,
not inside the container. A remote Docker server also does not own your local
Chrome installation. WSL is not a substitute for a Windows Chrome companion.

## 2. Load the supplied extension

1. Extract the entire unpacked ZIP. On Windows, use **Extract All**; on macOS,
   open the ZIP; on Linux, use your desktop archive manager.
2. Keep `Agent-Zero-Browser` in a permanent location such as Documents. Do not
   load from an archive preview, temporary folder, or a folder you will delete.
3. In your normal Chrome profile, open `chrome://extensions`, enable
   **Developer mode**, and choose **Load unpacked**.
4. Select the package's `extension` folder—the one containing `manifest.json`.
5. Pin **Agent Zero Chrome Bridge** from Chrome's Extensions menu if desired.

Chrome requires these user-operated steps before Web Store distribution. We
do not edit Chrome profiles, force enterprise policies, or disable safeguards.
“Developer mode” here is Chrome's unpacked-loading switch, not the extension's
separate Development channel. The production ID remains
`nhliclifilepdkoolioacpjpijomfplj`.

## 3. Pair and choose the default once

1. In Agent Zero, open **Browser settings → Chrome extension** and create a code.
2. Open the extension's **Options**, enter the WebUI address you normally use,
   paste the code, and choose **Pair this browser**. Codes last five minutes;
   create one only after installation. Never share it in a support issue.
3. In Agent Zero Browser settings, choose this browser as the **default**.
   It applies across chats, while existing explicit project choices remain intact.
4. Options checks the connection automatically. Wait for **Browser control** to
   report ready; “Pairing saved” alone is not sufficient.

For Docker, use the published address that opens in Chrome, such as
`http://localhost:50080`, not a container-only hostname. Pairing is remembered
for this Chrome profile across chats and ordinary updates. You can close the
side panel or Options without stopping the agent or disconnecting the companion.

Site permissions are separate from pairing. To avoid per-site prompts, you
can explicitly enable **All websites** in Agent Zero Browser settings. Purchases,
submissions, and other consequential actions still require their own approval.
Agent-owned tabs use blue Chrome tab groups; existing user tabs are not shared
or closed implicitly.

## Update without resetting pairing

Back up the old `extension` folder, then replace it with the new package's
`extension` folder **at the same location**. Click **Reload** on Chrome's
Extensions page. Do not remove the extension, disconnect the profile, delete
credentials, or create a new pairing just to update. Update the companion
separately through its installer. Unpacked extensions do not get Web Store updates.

## For maintainers

Build the dashboard ZIP, then wrap that exact inspected build for direct users:

```sh
node scripts/package-store-candidate.mjs /absolute/new/store-candidate
node scripts/package-unpacked.mjs /absolute/new/store-candidate /absolute/new/direct-install
```

Both tools require fresh output directories. The dashboard ZIP has the manifest
at its root; the direct-install ZIP adds only the offline guide, notices, and
integrity receipt around an identical `extension` directory. It includes no
native executable, secrets, browser profile, source-build requirement, or
automatic change to platform release trust. Local hashes detect corruption;
they are not signatures or proof of native release readiness.

Chrome's distribution rules: [distribution options](https://developer.chrome.com/docs/extensions/how-to/distribute).
Dashboard packaging rules: [prepare an extension](https://developer.chrome.com/docs/webstore/prepare).
