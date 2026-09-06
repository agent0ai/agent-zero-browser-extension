import { readFileSync } from 'node:fs';

const installation = JSON.parse(readFileSync(new URL('../src/installation-platforms.json', import.meta.url), 'utf8'));

export function renderGuide() {
  const data = JSON.stringify(installation).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Set up Agent Zero in Chrome</title>
<style>
@font-face{font-family:Rubik;src:url(extension/fonts/rubik-variable.ttf)}
:root{color-scheme:dark;font-family:Rubik,system-ui,sans-serif;background:#131313;color:#eee;line-height:1.6}
*{box-sizing:border-box}body{margin:0}main{max-width:760px;margin:auto;padding:40px 24px 64px}
header{display:flex;gap:14px;align-items:center;border-bottom:1px solid #383838;padding-bottom:24px}header img{width:40px;height:40px}
h1{font-size:25px;line-height:1.25;margin:0}h2{font-size:18px;margin:0 0 12px}p{margin:8px 0 14px}header p{margin:6px 0 0}
p,li{font-size:14px}small,.muted{color:#b4b4b4}section{padding:26px 0;border-bottom:1px solid #383838}
label{display:grid;gap:6px;font-size:13px;max-width:340px;margin:16px 0}select,button,.button{border:1px solid #444;border-radius:6px;padding:10px 14px;font:inherit;color:inherit;background:#232323;min-height:44px}
select{width:100%}button,.button{cursor:pointer}a{color:#a8c7ff}a.button{display:inline-block;text-decoration:none;background:#2b58b8;border-color:#2b58b8;color:white}
:focus-visible{outline:2px solid #a8c7ff;outline-offset:3px}ol{padding-left:24px}li{padding:4px 0}code{background:#222;border-radius:4px;padding:3px 5px;overflow-wrap:anywhere}
.notice{padding:14px 16px;border-left:3px solid #6b9cff;background:#1d2533;border-radius:4px}.notice p:last-child{margin-bottom:0}
.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.copy-result{font-size:12px;color:#b4b4b4}summary{cursor:pointer;min-height:44px;padding:10px 0;font-size:14px}
[hidden]{display:none!important}@media(max-width:480px){main{padding:24px 18px}h1{font-size:22px}.actions>*{max-width:100%}}
</style></head><body><main>
<header><img src="extension/icons/icon48.png" alt=""><div><h1>Agent Zero in your Chrome</h1><p class="muted">Set up once. Use it across your chats.</p></div></header>
<section aria-labelledby="computer-heading"><h2 id="computer-heading">Start on the computer running Chrome</h2>
<p>Agent Zero can run in Docker or on another server. The extension and its small companion stay on <strong>your Chrome computer</strong>, not inside Docker, WSL, or the server.</p>
<label>Your Chrome computer<select id="platform"><option value="">Choose your operating system</option><option value="macos">macOS</option><option value="windows">Windows</option><option value="linux">Linux</option></select></label>
<p class="muted">This offline guide does not inspect your browser, change settings, or send telemetry.</p></section>
<section aria-labelledby="companion-heading"><h2 id="companion-heading">1. Install the companion</h2>
<div id="platform-help" aria-live="polite"><p>Choose your operating system above to see the right instructions.</p></div>
<a id="download" class="button" hidden target="_blank" rel="noopener noreferrer">Download companion</a>
<p><a href="${installation.guide_url}" target="_blank" rel="noopener noreferrer">Check current platform availability</a></p>
<p class="muted">Keep operating-system security checks enabled. Do not disable Gatekeeper, SmartScreen, or script security to install this software.</p></section>
<section aria-labelledby="extension-heading"><h2 id="extension-heading">2. Add the extension to Chrome</h2>
<p>The same extension folder works on macOS, Windows, and Linux. It is not in the Web Store yet, so Chrome requires these manual steps.</p>
<ol><li>Extract the entire ZIP. Keep this folder somewhere permanent, such as <strong>Documents → Agent Zero Browser</strong>, not inside a temporary folder or the ZIP preview.</li>
<li>In your normal Chrome profile, open <code>chrome://extensions</code> and turn on <strong>Developer mode</strong>.</li>
<li>Choose <strong>Load unpacked</strong>, then select the <strong>extension</strong> folder beside this guide. Select the folder containing <code>manifest.json</code>, not this guide’s parent folder.</li>
<li>Pin <strong>Agent Zero Chrome Bridge</strong> using Chrome’s Extensions menu if you want it in the toolbar.</li></ol>
<div class="actions"><button type="button" data-copy="chrome://extensions">Copy Chrome setup address</button><span class="copy-result" role="status"></span></div>
<p class="muted">Chrome calls this Developer mode; the supplied extension still has the production identity. No terminal, source build, or administrator access is needed to load it. A managed browser may prevent unpacked extensions; ask its administrator rather than changing browser policies.</p></section>
<section aria-labelledby="pairing-heading"><h2 id="pairing-heading">3. Pair once with Agent Zero</h2>
<p id="pairing-prerequisite" class="notice">Install the companion before creating a pairing code.</p>
<ol><li>Open your Agent Zero WebUI. In <strong>Browser settings → Chrome extension</strong>, create and copy a pairing code.</li>
<li>Open the extension’s <strong>Options</strong>. Paste the Agent Zero address you normally use and the code, then choose <strong>Pair this browser</strong>. Codes expire after five minutes.</li>
<li>Return to Agent Zero Browser settings and choose this browser as the <strong>default</strong>. This applies across chats; an explicitly chosen project browser stays unchanged.</li>
<li>Options reconnects automatically. Wait until <strong>Browser control</strong> reports ready—not merely “Pairing saved.”</li></ol>
<p>For Docker, use the published WebUI address that opens in Chrome—for example <code>http://localhost:50080</code>. Do not use a container-only hostname. Never paste pairing codes into support issues.</p>
<p>Site access is separate from pairing. You can explicitly enable <strong>All websites</strong> in Agent Zero Browser settings to avoid repeated site prompts. Purchases, submissions, and other consequential actions still need their own approval.</p></section>
<section><h2>You’re ready when Browser control says ready</h2><p>Ask Agent Zero in any chat to use Chrome. Its own tabs appear in a blue tab group, with the illuminated cursor on the page it is using. Your other tabs are not automatically shared.</p>
<p>Closing Options or the side panel does not disconnect the companion or stop the agent. Pairing stays saved in this Chrome profile.</p></section>
<section><details><summary>Updating without pairing again</summary><p>Keep the same Chrome profile and extension folder location. Back up the old extension files, then replace the <code>extension</code> folder at that same location with the new package’s folder. In <code>chrome://extensions</code>, click <strong>Reload</strong>. Do not remove the extension or use “Disconnect profile.” Use the companion installer to update the native component separately.</p></details>
<details><summary>If connection is not ready</summary><p>Check the four connection rows in Options. “Local companion missing” needs the installer for the Chrome computer. “Pairing saved” means the code is already accepted—do not pair again; check the default browser selection and WebUI address. If the companion is not released for your OS, repeated connection checks cannot make it available.</p></details></section>
</main><script>
const installation=${data};
const choice=document.getElementById('platform');
const suggestion=navigator.platform;
choice.value=/android|iphone|ipad|cros/i.test(suggestion)?'':/win/i.test(suggestion)?'windows':/mac/i.test(suggestion)?'macos':/linux|x11/i.test(suggestion)?'linux':'';
function showPlatform(){
 const item=installation.platforms[choice.value],help=document.getElementById('platform-help'),download=document.getElementById('download');
 help.replaceChildren();download.hidden=true;download.removeAttribute('href');
 const requirement=document.createElement('p');requirement.textContent=item?item.requirement:'Choose your operating system above to see the right instructions.';help.append(requirement);
 if(item){const description=document.createElement('p');description.textContent=item.description;help.append(description);}
 help.className=item&&!item.available?'notice':'';
 if(item&&item.download_url){download.href=item.download_url;download.textContent='Download '+item.label+' companion';download.hidden=false;}
 document.getElementById('pairing-prerequisite').textContent=item&&!item.available?'Pause here before pairing: the '+item.label+' companion is not released yet. Loading the extension alone does not enable browser control.':'Install the companion before creating a pairing code.';
}
choice.addEventListener('change',showPlatform);showPlatform();
for(const button of document.querySelectorAll('[data-copy]'))button.addEventListener('click',async()=>{
 const status=button.nextElementSibling;
 try{await navigator.clipboard.writeText(button.dataset.copy);status.textContent='Copied. Paste into Chrome’s address bar.';}
 catch{status.textContent='Copy this address manually: '+button.dataset.copy;}
});
</script></body></html>`;
}
