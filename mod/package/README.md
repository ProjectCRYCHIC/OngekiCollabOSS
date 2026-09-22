# OngekiCollab

Online relay matching client for ONGEKI using BepInEx 5.4.23.2.

The package installs `OngekiCollab.BepInEx5.dll` under
`BepInEx/plugins/OngekiCollab`. The configuration is `client.json` beside
`mu3.exe`, not in a STARTLINER profile or plugin folder. For example, with
`F:\package\mu3.exe`, edit `F:\package\client.json`; the startup log prints the
resolved absolute path. Set the root HTTP(S) `origin`, `pool`, and `onlineMode`
there, preserve generated identity/key fields, then restart the game. Public
relays need TLS 1.2; TLS negotiation runs through the OS WinHTTP/Schannel
stack instead of Unity 5.6 Mono.

Install only this BepInEx 5 build of OngekiCollab. Do not load the MelonLoader
variant at the same time.

This package depends on the matching BepInEx 5.4.23.2 runtime and its HarmonyX
2.9 core. Install it through STARTLINER/Rainycolor so the declared dependency is
present; do not replace it with the retained `0Harmony20` compatibility shim.
