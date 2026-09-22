# Standalone loader clients

The same Mono/.NET 3.5 relay and native-matching core builds for MelonLoader 0.7.1 or BepInEx major versions 1 through 5. Install exactly one loader and exactly one matching OngekiCollab variant; loading multiple variants in the same game process would install the same Harmony patches twice.

## MelonLoader

`build.ps1 -GameDirectory F:\package` reads the game and MelonLoader assemblies and writes the self-contained `build/OngekiCollab.Mod.dll`. Place that single DLL in the game's `Mods` directory. It embeds `Newtonsoft.Json` assembly version `13.0.0.0`; do not copy a separate copy beside the mod. HTTP, TLS, and WebSocket traffic go through the operating system's `winhttp.dll` directly, so no managed networking library ships with the mod.

`test.ps1 -GameDirectory F:\package` compiles the MelonLoader build and runs the isolated checks described below.

## BepInEx 1–5

Each BepInEx major generation has a separate ABI-compatible DLL; one DLL cannot safely implement the incompatible metadata, logger, and Harmony APIs of all five generations. Build one generation, or all five:

```powershell
.\build-bepinex.ps1 -GameDirectory F:\package -BepInExMajor 5 -DependencyDirectory C:\path\to\dependencies
.\build-all-bepinex.ps1 -GameDirectory F:\package -DependencyDirectory C:\path\to\dependencies
```

`-BepInExMajor` accepts `1`, `2`, `3`, `4`, or `5` and defaults to `5`. Builds use pinned official reference baselines so a newer local loader cannot accidentally raise the output's minimum ABI:

| Loader generation | Reference ABI | Harmony ABI | Output |
| --- | --- | --- | --- |
| BepInEx 1 | `BepInEx 1.0.0.0` | `0Harmony 1.0.9.1` | `build\bepinex\v1\OngekiCollab.BepInEx1.dll` |
| BepInEx 2 | historical `BepInEx 1.0.0.0` identity | `0Harmony 1.0.9.1` | `build\bepinex\v2\OngekiCollab.BepInEx2.dll` |
| BepInEx 3 | `BepInEx 3.2.0.0` | `0Harmony 1.1.0.0` | `build\bepinex\v3\OngekiCollab.BepInEx3.dll` |
| BepInEx 4 | `BepInEx 4.1.2.0` | `0Harmony 1.1.0.0` | `build\bepinex\v4\OngekiCollab.BepInEx4.dll` |
| BepInEx 5 | `BepInEx 5.4.23.2` | `HarmonyX / 0Harmony 2.9.0.0` | `build\bepinex\v5\OngekiCollab.BepInEx5.dll` |

The pinned official archives are downloaded into the ignored `build/tools` cache and verified by SHA-256. For an offline build, extract the exact baseline archive yourself and pass it with `-BepInExReferenceDirectory`. BepInEx 6 is not supported.

The build input assembly must be supplied with `-DependencyDirectory`. The verified baseline is `Newtonsoft.Json` assembly version `13.0.0.0`; it is merged into every final plugin and is not a separate runtime file.

```powershell
.\test-bepinex.ps1 -GameDirectory F:\package -DependencyDirectory C:\path\to\dependencies
```

Build the BepInEx 5 DLL and a STARTLINER/Thunderstore-style release archive with:

```powershell
.\build-package-bepinex5.ps1 -GameDirectory F:\package -DependencyDirectory F:\package\MelonLoader\net35
```

The archive is written to `build/packages` with `manifest.json`, a 256x256 icon,
the package README, and `app/BepInEx/plugins/OngekiCollab/OngekiCollab.BepInEx5.dll`.
The `mod-bepinex5-package` GitHub Actions workflow runs the same command on a
Windows x64 self-hosted runner and uploads the ZIP as a CI artifact.

Install only the DLL matching the loader's major generation. BepInEx 1–4 historically scan their configured `BepInEx` plugin directory; BepInEx 5 normally uses `BepInEx\plugins\OngekiCollab`. Do not copy a separate `Newtonsoft.Json.dll` file, and do not copy `BepInEx.dll`, `0Harmony.dll`, game assemblies, or MelonLoader assemblies into the plugin directory.

BepInEx 1–3 are historical patcher-based loader distributions. The repository verifies their plugin metadata, inherited base type, legacy Harmony marker, reference versions, and merged dependencies, but has not modified a game installation to run those chainloaders. Their outputs are ABI compatibility builds, not a claim that the ancient loader itself starts on this Ongeki build. BepInEx 4/5 likewise still need live loader startup and gameplay validation.

The build scripts merge only the exact approved dependency bytes: `Newtonsoft.Json.dll` `13.0.0.0`. Its SHA-256 value is pinned by `merge-dependencies.ps1`; a different binary fails the build even if it has the same assembly version. ILRepack `2.0.48` is downloaded from NuGet into the ignored `build/tools` cache and its package hash is also pinned. For an offline build, pass a trusted local executable with `-ILRepackPath`. The final DLL embeds `THIRD-PARTY-NOTICES.txt` as `OngekiCollab.ThirdPartyNotices.txt`.

“Self-contained” here applies only to those two libraries. The mod still requires the selected loader, Harmony, Unity, and the game's managed assemblies at runtime; those host assemblies are deliberately not merged.

`test.ps1` runs the full isolated core suite against the unmerged intermediate assembly, then verifies that the final MelonLoader DLL has no external references to the two embedded libraries and contains both expected type families and the license resource. `test-bepinex.ps1` builds all five BepInEx generations and checks each one's exact BepInEx/Harmony references, metadata form, lifecycle, merged types, and notice resource without invoking Harmony under the desktop CLR. The BepInEx 5 package targets its declared `5.4.23.2` dependency and `0Harmony 2.9.0.0`, so STARTLINER loads it directly instead of shimming it to `0Harmony20`. Pass `-BepInEx5RuntimeDirectory` to also check that exact installed runtime. Test executables and loader references are created in an isolated system temporary directory and removed after the run. Passing both checks does not replace loader startup or a real two-client gameplay test.

### STARTLINER configuration and Unity 5.6 TLS

There is no mod UI or F8 shortcut. The configuration is always `client.json` beside `mu3.exe`. For example, when the game executable is `F:\package\mu3.exe`, edit exactly `F:\package\client.json`; it is not in `UserData`, a STARTLINER profile, or the BepInEx plugin directory. Startup logs print `client.json path: <absolute path>` before opening the file.

Edit the relay fields and restart the game:

```json
{
  "origin": "https://collab.example.com",
  "pool": "",
  "identityId": "",
  "clientKey": "",
  "anonymousKey": "",
  "onlineMode": true
}
```

`origin` must be a plain final root HTTP(S) origin with no path, user info, query, fragment, or Markdown wrapper. The client deliberately does not follow an HTTP-to-HTTPS redirect, so enter the final HTTPS address for a public relay. An empty `pool` selects the public pool; a named pool accepts 1–64 letters, digits, `_`, or `-`. Preserve generated `identityId`, `clientKey`, and `anonymousKey`. `onlineMode: false` preserves native LAN; `true` makes the game's own Recruit, Ready, Start, and Cancel controls use the relay exclusively. One press of the native Recruit selector creates the local player's room in online mode; the stock second-press Recruit confirmation is bypassed.

Unity 5.6 Mono uses the mod's compatibility JSON path, while relay HTTP/WS traffic and TLS negotiation run through the operating system's WinHTTP/Schannel stack (`winhttp.dll`, Windows 8 or newer for WebSocket). Modern TLS 1.2/1.3 and ECDSA certificates work without extra configuration. Do not work around transport failures with HTTP fallback or certificate-verification bypass, and never follow redirects to the relay.

During boot, the initialize screen's collab-setting row is relabeled `OngekiCollab RELAY` while online mode is enabled and shows the measured HTTP round trip to the configured origin instead of the stock LAN probe verdict.

While no room is active, the mod refreshes the service directory and mirrors joinable rooms into the game's existing recruit music list. Before a room is published there, the mod captures its explicit song/difficulty on the Unity thread and hashes every locally existing official OGKR on a worker; missing, custom, or unreadable local songs are filtered out. The shown 10.254.x.x address is display-only. Selecting that native list entry resolves it back to the room UUID and sends the UUID in Match, then the stock matching wait screen remains until the real Party roster confirms this cabinet. Once inside the room, each player may use the stock difficulty selection; the mod mirrors the last local Party UserInfo selection and builds Ready from that final song/difficulty, discarding older selection revisions. Returning from Ready to settings sends `unready`, clears the previous server acknowledgement, and requires a fresh Ready before the host can start. The directory does not expose remote hashes, so cross-cabinet equality is still enforced later from each client's Ready report. The mod compares every connected Ready player's selected-difficulty hash with other players on the same `(songId, difficulty)` and blocks the host's native start on a conflict. The service stores those reports but does not make the hash decision.

When identity verification is required, the mod reads the current logged-in game identity before matching. The Unity thread captures immutable official OGKR paths and primitive song metadata; a worker hashes every existing difficulty before Match and again at Ready. Immediately before and after `NotesManager.loadScore`, the selected OGKR is hashed once more and must still match the landed Ready report or loading is blocked and cancellation is scheduled on the Unity thread. When the configured game `ServerURI` is empty, its effective `OperationManager.getBaseUri()` is used for identity registration. A 32-byte portable client key is saved before registration with a current-user Windows ACL, and the server identity ID is saved after registration; the four raw game identity fields are never written to it. Back up the client key before reinstalling; if lost, the binding needs an administrator reset. Errors appear only in the MelonLoader log and never expose identity values, server response bodies or tickets. Match, identity authentication, the WebSocket handshake, one handshake retry after 1.5 seconds, and the first room snapshot share a 15-second deadline; native Party self-join retains its separate ten-second deadline. After normal `playEnded`, the mod keeps the relay transport until native Party reaches Result, then leaves the relay without cancelling result state; `playCancelled` cancels the native room on the next update so an immediate Recruit cannot reuse it. If the relay closes before Result, the incomplete native room is cancelled and the result guard supplies a zero reward only to avoid the stock null dereference.

For the BepInEx variant, the same redacted failures are written to the BepInEx log instead of the MelonLoader log.

After the first successful non-guest online GameLogin, the mod checks the service's `/api/v1/identity-mode`. When `required` is true, it verifies the complete identity in the background without creating a room or showing UI. AIME fields do not exist before card login. Recruit checks the mode again: when `required` is false, matching uses the player's display name and official chart hashes without identity registration, challenge, or session requests. A missing or invalid mode response stops matching. LAN and offline sessions do not trigger this check; required-mode Recruit re-verifies the identity and serializes with any startup registration. Failed startup verification is logged once and retried on explicit Recruit or the next login.

Anonymous matching also generates a separate 32-byte random `anonymousKey` in the owner-only `client.json` before the first Match and sends it only while identity verification is disabled. The service uses this key to recognize and ban a single anonymous installation. Back up the settings file to preserve that identity; deleting or replacing the key can evade an anonymous ban, so this is not a strong account identity.

Every Match request includes `protocolVersion: 1`. The relay validates it before creating or joining a room; this value is independent from the cabinet's `gameVersion`.

An identity-stage HTTP 403 is classified as a changed registered game identity only when the Worker returns its exact expected JSON error; other 403 responses remain generic. Use the originally bound AIME and title server, or request an administrator reset if the identity was intentionally changed. Do not delete the local key file to retry.

The game API URI is still sent to the Worker, which binds only its hostname for identity purposes. A changing path on the same host therefore does not change a new binding. A legacy `private-host` binding requires administrator review rather than automatic migration.

The opt-in native adapter redirects Party TCP and Party/Advertise UDP through WS/WSS logical streams and datagrams; ports used by game setting and delivery retain their local paths. Control messages are strict UTF-8 and capped at 16 KiB. Outbound control and binary messages share one ordered worker queue capped at 512 frames, while the 2 MiB byte budget counts binary payload bytes; overflow or an actual send failure closes the transport. Each TCP stream buffers at most 64 KiB, and a stream overflow closes that stream without dropping already accepted bytes or failing an otherwise healthy room. It maps room peers to 10.255.0.x, uses target zero for UDP broadcast, and replaces original game user IDs during Party serialization. After a room snapshot, the native matching screen opens only when Party confirms this player's virtual address in its roster (the host must occupy slot zero); a ten-second failure leaves the room rather than displaying an empty host. Relay profile fallback fills only blank names and zero card icons, never the locally selected difficulty; partial `scoreState` messages merge only fields they carry. **This adapter has not passed a two-client runtime gameplay test.** Successful offline compilation and isolated Harmony patch checks verify compatibility and patch shape only; they do not establish synchronized play or production safety.
