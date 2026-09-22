using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using HarmonyLib;
using MU3.Collab;
using MU3.Memory;
using Newtonsoft.Json.Linq;

internal static class OfflineTransportTest
{
    private static string gameDirectory;

    private static int Main(string[] args)
    {
        bool loaderShapeOnly = args.Length == 3 && args[2] == "--loader-shape-only";
        bool selfContainedOnly = args.Length == 3 && args[2] == "--self-contained-only";
        if (args.Length != 2 && !loaderShapeOnly && !selfContainedOnly)
        {
            Console.Error.WriteLine("Usage: OfflineTransportTest game-directory mod-dll [--loader-shape-only|--self-contained-only]");
            return 2;
        }
        gameDirectory = args[0];
        AppDomain.CurrentDomain.AssemblyResolve += ResolveGameAssembly;
        try
        {
            if (loaderShapeOnly || selfContainedOnly)
            {
                Assembly mod = Assembly.LoadFrom(args[1]);
                CheckLoaderEntryShape(mod.GetType("OngekiCollab.Mod.ModEntry", true));
                if (selfContainedOnly) CheckSelfContainedDependencies(mod);
                Console.WriteLine("Loader entry checks passed.");
                return 0;
            }
            Run(args[1]);
            Console.WriteLine("Offline virtual socket checks passed.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static Assembly ResolveGameAssembly(object sender, ResolveEventArgs args)
    {
        string name = new AssemblyName(args.Name).Name + ".dll";
        foreach (string folder in new[] { Path.Combine(gameDirectory, "mu3_Data/Managed"),
            Path.Combine(gameDirectory, "MelonLoader/net35") })
        {
            string candidate = Path.Combine(folder, name);
            if (File.Exists(candidate)) return Assembly.LoadFrom(candidate);
        }
        return null;
    }

    private static void Run(string modPath)
    {
        Assembly mod = Assembly.LoadFrom(modPath);
        Type transport = mod.GetType("OngekiCollab.Mod.NativeTransport", true);
        transport.GetField("<Enabled>k__BackingField", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, true);
        Harmony harmony = new Harmony("host.ongekicollab.mod.offline-test");
        foreach (Type patch in transport.GetNestedTypes(BindingFlags.NonPublic))
        {
            // This getter needs the native daemon library and is checked in the game process.
            if (patch.Name != "LanCapabilityPatch") harmony.PatchAll(patch);
        }

        Type settings = mod.GetType("OngekiCollab.Mod.LocalSettings", true);
        Type client = mod.GetType("OngekiCollab.Mod.RelayClient", true);
        CheckNativeTransportShape(mod, client);
        CheckNativeMatchingShape(mod, harmony);
        CheckDirectoryContracts(mod, client);
        CheckReadyAndStartContracts(mod);
        CheckAlignmentContracts(mod, client);
        CheckIdentityErrorParsing(client);
        CheckStartupFailureDiagnostics(mod);
        CheckSettingsValidation(settings);
        CheckIdentityStore(settings);
        object relay = Activator.CreateInstance(client,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, null,
            new object[] { Activator.CreateInstance(settings, true), Path.Combine(Path.GetTempPath(), "collab-test.json") }, null);
        client.GetField("<PeerId>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(relay, (uint)1);
        CheckControlEncodingContracts(mod, client, relay);
        transport.GetMethod("Attach", BindingFlags.Public | BindingFlags.Static).Invoke(null, new object[] { relay, (uint)1 });
        CheckRuntimeTimingContracts(mod, transport, relay);
        CheckTransportCapacityContracts(transport);

        NFSocket listener = new NFSocket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp, -1);
        listener.Bind(new IPEndPoint(IPAddress.Any, 50000));
        listener.Listen(4);
        NFSocket localClient = new NFSocket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp, -1);
        SocketAsyncEventArgs connect = new SocketAsyncEventArgs();
        connect.RemoteEndPoint = new IPEndPoint(IPAddress.Parse("10.255.0.1"), 50000);
        Check(!localClient.ConnectAsync(connect, -1), "local virtual connect must complete synchronously");
        Check(NFSocket.Poll(listener, SelectMode.SelectRead), "listener must see self connection");
        byte[] message = { 9, 8, 7 };
        Check(localClient.Send(message, 0, message.Length, SocketFlags.None) == 3,
            "self send before accept failed");
        NFSocket localHost = listener.Accept();
        byte[] received = new byte[8];
        SocketError error;
        Check(localHost.Receive(received, 0, received.Length, SocketFlags.None, out error) == 3 &&
            received[0] == 9 && received[1] == 8 && received[2] == 7,
            "self stream bytes sent before accept changed");
        Check(localClient.Send(message, 0, message.Length, SocketFlags.None) == 3, "self send failed");
        Check(NFSocket.Poll(localHost, SelectMode.SelectRead), "self stream was not readable");
        Check(localHost.Receive(received, 0, received.Length, SocketFlags.None, out error) == 3 &&
            received[0] == 9 && received[1] == 8 && received[2] == 7 && error == SocketError.Success,
            "self stream bytes changed");
        localClient.Shutdown(SocketShutdown.Send);
        Check(!NFSocket.Poll(localClient, SelectMode.SelectWrite), "half-closed sender remained writable");
        Check(NFSocket.Poll(localHost, SelectMode.SelectRead), "self stream close was not readable");
        Check(localHost.Receive(received, 0, received.Length, SocketFlags.None, out error) == 0 &&
            error == SocketError.Success, "self stream did not report EOF");
        Check(localClient.Send(message, 0, message.Length, SocketFlags.None) == 0,
            "half-closed sender accepted bytes");

        transport.GetMethod("ReceiveFrame", BindingFlags.Public | BindingFlags.Static)
            .Invoke(null, new object[] { Frame(2, 2, 1, 7, new byte[0]) });
        Check(NFSocket.Poll(listener, SelectMode.SelectRead), "remote stream open was not queued");
        NFSocket remoteHost = listener.Accept();
        Check(((IPEndPoint)remoteHost.RemoteEndPoint).Address.ToString() == "10.255.0.2", "remote virtual address changed");
        transport.GetMethod("ReceiveFrame", BindingFlags.Public | BindingFlags.Static)
            .Invoke(null, new object[] { Frame(3, 2, 1, 7, message) });
        Check(NFSocket.Poll(remoteHost, SelectMode.SelectRead), "remote stream was not readable");
        Check(remoteHost.Receive(received, 0, received.Length, SocketFlags.None, out error) == 3 &&
            received[0] == 9 && received[1] == 8 && received[2] == 7, "remote stream bytes changed");
        transport.GetMethod("ReceiveFrame", BindingFlags.Public | BindingFlags.Static)
            .Invoke(null, new object[] { Frame(4, 2, 1, 7, new byte[0]) });
        Check(NFSocket.Poll(remoteHost, SelectMode.SelectRead), "remote stream close was not readable");
        Check(remoteHost.Receive(received, 0, received.Length, SocketFlags.None, out error) == 0 &&
            error == SocketError.Success, "remote stream did not report EOF");
        transport.GetMethod("ReceiveFrame", BindingFlags.Public | BindingFlags.Static)
            .Invoke(null, new object[] { Frame(3, 2, 1, 7, message) });
        Check(!(bool)transport.GetProperty("TransportFailed", BindingFlags.Public | BindingFlags.Static).GetValue(null, null) &&
            remoteHost.Receive(received, 0, received.Length, SocketFlags.None, out error) == 0,
            "data after a remote close reopened the stream or failed the transport");

        NFSocket receiver = new NFSocket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp, -1);
        receiver.Bind(new IPEndPoint(IPAddress.Any, 50002));
        NFSocket sender = new NFSocket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp, -1);
        sender.SendTo(message, 0, message.Length, SocketFlags.None,
            new IPEndPoint(IPAddress.Parse("10.255.0.1"), 50002));
        Check(NFSocket.Poll(receiver, SelectMode.SelectRead), "local datagram was not readable");
        EndPoint source = new IPEndPoint(IPAddress.Any, 0);
        Check(receiver.ReceiveFrom(received, SocketFlags.None, ref source) == 3 && received[0] == 9 &&
            ((IPEndPoint)source).Address.ToString() == "10.255.0.1", "local datagram changed");

        NFSocket ordinary = new NFSocket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp, -1);
        ordinary.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        Check(((IPEndPoint)ordinary.LocalEndPoint).Port > 0, "non-relay socket was virtualized");
        CheckUserInfoPrivacy(transport);
        localClient.Close(); localHost.Close(); remoteHost.Close(); listener.Close();
        receiver.Close(); sender.Close(); ordinary.Close();
        CheckRemoteOverflowCloseFailure(transport, relay);
        CheckRemoteCloseFailure(transport, relay, false);
        CheckRemoteCloseFailure(transport, relay, true);
        ResetTransport(transport, relay);
        transport.GetMethod("ReceiveFrame", BindingFlags.Public | BindingFlags.Static)
            .Invoke(null, new object[] { new byte[] { 1, 2, 3 } });
        Check((bool)transport.GetProperty("TransportFailed", BindingFlags.Public | BindingFlags.Static).GetValue(null, null),
            "malformed relay frame did not fail the transport closed");
        Check(!(bool)transport.GetProperty("Connected", BindingFlags.Public | BindingFlags.Static).GetValue(null, null),
            "failed transport remained connected");
    }

    private static void CheckControlEncodingContracts(Assembly mod, Type clientType, object relay)
    {
        FieldInfo clientLimit = clientType.GetField("MaximumControlBytes",
            BindingFlags.NonPublic | BindingFlags.Static);
        Type webSocketType = mod.GetType("OngekiCollab.Mod.WinHttpWebSocket", true);
        FieldInfo socketLimit = webSocketType.GetField("MaximumControlBytes",
            BindingFlags.NonPublic | BindingFlags.Static);
        FieldInfo strictField = webSocketType.GetField("StrictUtf8",
            BindingFlags.NonPublic | BindingFlags.Static);
        Encoding strict = strictField == null ? null : strictField.GetValue(null) as Encoding;
        bool invalidRejected = false;
        try { if (strict != null) strict.GetString(new byte[] { 0xc3, 0x28 }); }
        catch (DecoderFallbackException) { invalidRejected = true; }
        Check(clientLimit != null && socketLimit != null && strict != null &&
            (int)clientLimit.GetRawConstantValue() == 16384 &&
            (int)socketLimit.GetRawConstantValue() == 16384 && invalidRejected,
            "relay control frames no longer use strict UTF-8 with the shared 16 KiB limit");

        MethodInfo sendText = clientType.GetMethod("SendText", BindingFlags.Public | BindingFlags.Instance);
        Exception exact = InvokeFailure(sendText, relay, new object[] { new string('\u00e9', 8192) });
        Exception over = InvokeFailure(sendText, relay, new object[] { new string('\u00e9', 8193) });
        Check(exact is InvalidOperationException && exact.Message == "Room WebSocket is not open." &&
            over is InvalidOperationException &&
            over.Message == "Relay control message exceeds 16384 UTF-8 bytes.",
            "outbound control limit counts characters instead of UTF-8 bytes");
    }

    private static void CheckRuntimeTimingContracts(Assembly mod, Type transport, object relay)
    {
        Type entry = mod.GetType("OngekiCollab.Mod.ModEntry", true);
        object startEntry = Activator.CreateInstance(entry, true);
        entry.GetField("activeOnlineMode", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(startEntry, true);
        entry.GetField("nativeRoomJoined", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(startEntry, true);
        entry.GetField("hostPeerId", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(startEntry, (uint)1);
        entry.GetField("relay", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(startEntry, relay);
        MethodInfo requestStart = entry.GetMethod("TryRequestNativeStart", BindingFlags.NonPublic | BindingFlags.Instance);
        FieldInfo deadlineField = entry.GetField("nativeBattleStartDeadline",
            BindingFlags.NonPublic | BindingFlags.Instance);
        DateTime before = DateTime.UtcNow;
        Check((bool)requestStart.Invoke(startEntry, null),
            "joined host Start press was not consumed by the online session");
        DateTime deadline = (DateTime)deadlineField.GetValue(startEntry);
        DateTime after = DateTime.UtcNow;
        Check(deadline >= before.AddSeconds(11) && deadline <= after.AddSeconds(13),
            "native Start timeout was not armed from the Start button press");
        requestStart.Invoke(startEntry, null);
        Check((DateTime)deadlineField.GetValue(startEntry) == deadline,
            "a repeated Start poll restarted the button-press timeout");

        object scoreEntry = Activator.CreateInstance(entry, true);
        entry.GetField("relay", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(scoreEntry, relay);
        entry.GetField("hasLocalPlayScore", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(scoreEntry, true);
        FieldInfo reportField = entry.GetField("nextScoreReport", BindingFlags.NonPublic | BindingFlags.Instance);
        FieldInfo refreshField = entry.GetField("nextScoreRefresh", BindingFlags.NonPublic | BindingFlags.Instance);
        MethodInfo report = entry.GetMethod("ReportScores", BindingFlags.NonPublic | BindingFlags.Instance);
        report.Invoke(scoreEntry, null);
        DateTime firstRefresh = (DateTime)refreshField.GetValue(scoreEntry);
        Check(firstRefresh >= DateTime.UtcNow.AddSeconds(4),
            "first score sample did not arm the five-second refresh");
        reportField.SetValue(scoreEntry, DateTime.MinValue);
        report.Invoke(scoreEntry, null);
        Check((DateTime)refreshField.GetValue(scoreEntry) == firstRefresh,
            "unchanged score refreshed before five seconds elapsed");
        refreshField.SetValue(scoreEntry, DateTime.UtcNow.AddMilliseconds(-1));
        reportField.SetValue(scoreEntry, DateTime.MinValue);
        report.Invoke(scoreEntry, null);
        Check((DateTime)refreshField.GetValue(scoreEntry) >= DateTime.UtcNow.AddSeconds(4),
            "unchanged score was not refreshed after five seconds");
    }

    private static void CheckTransportCapacityContracts(Type transport)
    {
        FieldInfo maximumBytes = transport.GetField("MaximumStreamBufferedBytes",
            BindingFlags.NonPublic | BindingFlags.Static);
        FieldInfo maximumPending = transport.GetField("MaximumPendingStreams",
            BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo datagramTarget = transport.GetMethod("DatagramTarget",
            BindingFlags.NonPublic | BindingFlags.Static);
        Check(maximumBytes != null && maximumPending != null && datagramTarget != null &&
            (int)maximumBytes.GetRawConstantValue() == 65536 &&
            (int)maximumPending.GetRawConstantValue() == 64 &&
            (uint)datagramTarget.Invoke(null, new object[] { IPAddress.Parse("10.255.0.3") }) == 3 &&
            (uint)datagramTarget.Invoke(null, new object[] { IPAddress.Broadcast }) == 0 &&
            (uint)datagramTarget.Invoke(null, new object[] { IPAddress.Loopback }) == 0,
            "virtual stream limits or UDP target-zero routing differ from the Unity client");

        CheckLocalPendingLimit(transport);
        CheckLoopbackOverflow(transport, false);
        CheckLoopbackOverflow(transport, true);
    }

    private static void CheckLocalPendingLimit(Type transport)
    {
        NFSocket listener = CreatePartyListener();
        List<NFSocket> clients = new List<NFSocket>();
        NFSocket rejected = null;
        NFSocket accepted = null;
        try
        {
            for (int i = 0; i < 64; i++) clients.Add(ConnectSelf());
            rejected = new NFSocket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp, -1);
            SocketAsyncEventArgs args = new SocketAsyncEventArgs();
            args.RemoteEndPoint = new IPEndPoint(IPAddress.Parse("10.255.0.1"), 50000);
            bool fullRejected = false;
            try { rejected.ConnectAsync(args, -1); }
            catch (InvalidOperationException) { fullRejected = true; }
            Check(fullRejected && !TransportFailed(transport) && !NFSocket.Poll(rejected, SelectMode.SelectWrite),
                "the 65th loopback stream was not isolated from a healthy transport");
            accepted = listener.Accept();
            Check(accepted != null, "the first 64 loopback streams were not retained");
        }
        finally
        {
            if (accepted != null) accepted.Close();
            if (rejected != null) rejected.Close();
            foreach (NFSocket client in clients) client.Close();
            listener.Close();
        }
    }

    private static void CheckLoopbackOverflow(Type transport, bool acceptFirst)
    {
        NFSocket listener = CreatePartyListener();
        NFSocket client = null;
        NFSocket host = null;
        NFSocket healthyClient = null;
        NFSocket healthyHost = null;
        try
        {
            client = ConnectSelf();
            if (acceptFirst) host = listener.Accept();
            byte[] maximum = new byte[65536];
            Check(client.Send(maximum, 0, maximum.Length, SocketFlags.None) == maximum.Length &&
                client.Send(new byte[1], 0, 1, SocketFlags.None) == 0 && !TransportFailed(transport),
                acceptFirst ? "accepted loopback overflow failed the whole transport" :
                    "pre-Accept loopback overflow failed the whole transport");
            if (!acceptFirst) host = listener.Accept();
            byte[] received = new byte[maximum.Length];
            SocketError error;
            Check(host.Receive(received, 0, received.Length, SocketFlags.None, out error) == maximum.Length &&
                host.Receive(received, 0, 1, SocketFlags.None, out error) == 0,
                acceptFirst ? "accepted loopback overflow did not close only its stream" :
                    "pre-Accept loopback overflow did not close only its stream");

            healthyClient = ConnectSelf();
            healthyHost = listener.Accept();
            byte[] one = { 1 };
            Check(healthyClient.Send(one, 0, 1, SocketFlags.None) == 1 &&
                healthyHost.Receive(one, 0, 1, SocketFlags.None, out error) == 1 && !TransportFailed(transport),
                "an independent loopback stream stopped after another stream overflowed");
        }
        finally
        {
            if (healthyClient != null) healthyClient.Close();
            if (healthyHost != null) healthyHost.Close();
            if (client != null) client.Close();
            if (host != null) host.Close();
            listener.Close();
        }
    }

    private static void CheckRemoteOverflowCloseFailure(Type transport, object relay)
    {
        ResetTransport(transport, relay);
        NFSocket listener = CreatePartyListener();
        NFSocket remote = null;
        try
        {
            MethodInfo receive = transport.GetMethod("ReceiveFrame", BindingFlags.Public | BindingFlags.Static);
            receive.Invoke(null, new object[] { Frame(2, 2, 1, 700, new byte[0]) });
            remote = listener.Accept();
            byte[] block = new byte[4096];
            for (int i = 0; i < 16; i++)
                receive.Invoke(null, new object[] { Frame(3, 2, 1, 700, block) });
            Check(!TransportFailed(transport), "remote stream closed before its 65536-byte boundary");
            receive.Invoke(null, new object[] { Frame(3, 2, 1, 700, new byte[1]) });
            byte[] buffered = new byte[65536];
            SocketError error;
            Check(TransportFailed(transport) &&
                remote.Receive(buffered, 0, buffered.Length, SocketFlags.None, out error) == buffered.Length &&
                remote.Receive(buffered, 0, 1, SocketFlags.None, out error) == 0,
                "remote overflow did not close its stream or a failed rejection frame stayed open");
        }
        finally
        {
            if (remote != null) remote.Close();
            listener.Close();
        }
    }

    private static void CheckRemoteCloseFailure(Type transport, object relay, bool shutdown)
    {
        ResetTransport(transport, relay);
        NFSocket listener = CreatePartyListener();
        NFSocket remote = null;
        try
        {
            transport.GetMethod("ReceiveFrame", BindingFlags.Public | BindingFlags.Static)
                .Invoke(null, new object[] { Frame(2, 2, 1, shutdown ? 702u : 701u, new byte[0]) });
            remote = listener.Accept();
            if (shutdown) remote.Shutdown(SocketShutdown.Send);
            else remote.Close();
            Check(TransportFailed(transport), shutdown ?
                "Shutdown close-frame failure did not fail the transport" :
                "Close close-frame failure did not fail the transport");
        }
        finally
        {
            if (shutdown && remote != null) remote.Close();
            listener.Close();
        }
    }

    private static NFSocket CreatePartyListener()
    {
        NFSocket listener = new NFSocket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp, -1);
        listener.Bind(new IPEndPoint(IPAddress.Any, 50000));
        listener.Listen(64);
        return listener;
    }

    private static NFSocket ConnectSelf()
    {
        NFSocket client = new NFSocket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp, -1);
        SocketAsyncEventArgs args = new SocketAsyncEventArgs();
        args.RemoteEndPoint = new IPEndPoint(IPAddress.Parse("10.255.0.1"), 50000);
        Check(!client.ConnectAsync(args, -1), "loopback virtual connect must complete synchronously");
        return client;
    }

    private static bool TransportFailed(Type transport)
    {
        return (bool)transport.GetProperty("TransportFailed", BindingFlags.Public | BindingFlags.Static)
            .GetValue(null, null);
    }

    private static void ResetTransport(Type transport, object relay)
    {
        transport.GetMethod("Detach", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);
        transport.GetMethod("Attach", BindingFlags.Public | BindingFlags.Static)
            .Invoke(null, new object[] { relay, (uint)1 });
    }

    private static Exception InvokeFailure(MethodInfo method, object target, object[] arguments)
    {
        try { method.Invoke(target, arguments); }
        catch (TargetInvocationException error) { return error.InnerException; }
        return null;
    }

    private static void CheckNativeMatchingShape(Assembly mod, Harmony harmony)
    {
        Type entry = mod.GetType("OngekiCollab.Mod.ModEntry", true);
        CheckLoaderEntryShape(entry);
        Check(entry.GetMethod("OnGUI", BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly) == null,
            "mod still draws a supplemental UI");
        Type matching = typeof(MU3.SceneObject.LocalMatchingCtrl);
        foreach (string name in new[] { "pushMatching", "canStartRecruit", "finishSetting", "battleStart", "battleSingle" })
            Check(matching.GetMethod(name, BindingFlags.Public | BindingFlags.Instance) != null,
                "native matching method is missing: " + name);
        Type nested = matching.GetNestedType("EntryRoomCtrl", BindingFlags.NonPublic);
        Check(nested != null && nested.GetMethod("cancelMatchingAndSelectMusic",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance) != null,
            "native cancel method is missing");
        Type patch = mod.GetType("OngekiCollab.Mod.NativeMatching+CancelPatch", true);
        MethodInfo target = patch.GetMethod("TargetMethod", BindingFlags.NonPublic | BindingFlags.Static);
        Check(target != null && target.Invoke(null, null) != null, "native cancel patch target is missing");
        Type nativeMatching = mod.GetType("OngekiCollab.Mod.NativeMatching", true);
        Type firstPress = mod.GetType("OngekiCollab.Mod.NativeMatching+FirstRecruitPressPatch", true);
        Type confirm = matching.Assembly.GetType("MU3.Scene_32_PrePlayMusic_Confirm", true);
        Check(firstPress != null && confirm.GetMethod("Execute_Select",
            BindingFlags.NonPublic | BindingFlags.Instance) != null &&
            confirm.GetField("_selector", BindingFlags.NonPublic | BindingFlags.Instance) != null &&
            confirm.GetField("_sceneCommonObject", BindingFlags.NonPublic | BindingFlags.Instance) != null &&
            confirm.GetField("_musicViewData", BindingFlags.NonPublic | BindingFlags.Instance) != null,
            "first-press native recruit target is missing");
        Type hostStart = mod.GetType("OngekiCollab.Mod.NativeMatching+HostStartScenePatch", true);
        MethodInfo hostTarget = hostStart.GetMethod("TargetMethod", BindingFlags.NonPublic | BindingFlags.Static);
        Check(hostTarget != null && hostTarget.Invoke(null, null) != null,
            "delayed HostStart scene target is missing");
        Type profilePatch = mod.GetType("OngekiCollab.Mod.NativeMatching+RemotePlayerProfilePatch", true);
        Type matchingInfo = matching.Assembly.GetType("MU3.UIMatchingInfo", true);
        Check(profilePatch != null && matchingInfo.GetMethod("create",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static) != null,
            "remote player profile target is missing");
        Type directoryList = mod.GetType("OngekiCollab.Mod.NativeMatching+DirectoryListPatch", true);
        MethodInfo directoryTarget = directoryList.GetMethod("TargetMethod", BindingFlags.NonPublic | BindingFlags.Static);
        Check(directoryTarget != null && directoryTarget.Invoke(null, null) != null,
            "native recruit-list directory target is missing");
        Check(mod.GetType("OngekiCollab.Mod.NativeMatching+DirectoryJoinPatch", true) != null &&
            mod.GetType("OngekiCollab.Mod.NativeMatching+ReadySelectionPatch", true) != null &&
            mod.GetType("OngekiCollab.Mod.NativeMatching+UnreadyPatch", true) != null &&
            mod.GetType("OngekiCollab.Mod.NativeMatching+LocalPlayScorePatch", true) != null &&
            mod.GetType("OngekiCollab.Mod.NativeMatching+RemotePlayScorePatch", true) != null &&
            profilePatch != null &&
            mod.GetType("OngekiCollab.Mod.NativeMatching+ReadyChartLoadPatch", true) != null &&
            mod.GetType("OngekiCollab.Mod.NativeMatching+BlockUnloadedScoreUpdatePatch", true) != null &&
            matching.GetMethod("startJoin", BindingFlags.Public | BindingFlags.Instance) != null &&
            matching.GetMethod("updateMyUserInfo", BindingFlags.Public | BindingFlags.Static) != null &&
            matching.GetMethod("isWaitRequestResult", BindingFlags.Public | BindingFlags.Static) != null,
            "native directory join/selection/unready/wait targets are missing");
        MethodInfo captureScore = entry.GetMethod("CaptureLocalPlayScore",
            BindingFlags.NonPublic | BindingFlags.Instance);
        MethodInfo applyScores = entry.GetMethod("ApplyRemotePlayScores",
            BindingFlags.NonPublic | BindingFlags.Instance);
        MethodInfo applyProfiles = entry.GetMethod("ApplyRemotePlayerProfiles",
            BindingFlags.NonPublic | BindingFlags.Instance);
        MethodInfo parseStatus = entry.GetMethod("TryPlayStatus",
            BindingFlags.NonPublic | BindingFlags.Static);
        object[] parsed = { "Win", 0 };
        Check(captureScore != null && applyScores != null && applyProfiles != null && parseStatus != null &&
            (bool)parseStatus.Invoke(null, parsed) && (int)parsed[1] == (int)Party.PlayStatus.Win,
            "relay score fallback hooks or play-status parsing are missing");
        Type bootScene = matching.Assembly.GetType("MU3.SceneObject.Scene_12_Initialize", true);
        Check(bootScene.GetMethod("setCollabSettingStatus",
            BindingFlags.Public | BindingFlags.Instance) != null &&
            mod.GetType("OngekiCollab.Mod.BootRelayStatusPatch", true) != null &&
            mod.GetType("OngekiCollab.Mod.RelayProbe", true) != null,
            "boot relay status row patch target is missing");
        Check(mod.GetType("OngekiCollab.Mod.GameSnapshot", true).GetMethod("ReadGameVersion",
            BindingFlags.Public | BindingFlags.Static) != null,
            "relay game version reader is missing");
        foreach (Type nativePatch in nativeMatching.GetNestedTypes(BindingFlags.NonPublic))
        {
            // The standalone game DLL cannot execute this scene's Unity ECall static initializer.
            // Its member shape is checked above; patching runs in the real game runtime.
            if (nativePatch != firstPress && nativePatch != hostStart && nativePatch != profilePatch)
                harmony.PatchAll(nativePatch);
        }
    }

    private static void CheckLoaderEntryShape(Type entry)
    {
        MethodInfo resolveSettingsPath = entry.GetMethod("ResolveSettingsPath",
            BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo resolveSettingsPathFromDataPath = entry.GetMethod("ResolveSettingsPathFromDataPath",
            BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo resolveSettingsPathFromExecutable = entry.GetMethod("ResolveSettingsPathFromExecutable",
            BindingFlags.NonPublic | BindingFlags.Static);
        Check(resolveSettingsPath != null && resolveSettingsPathFromDataPath != null &&
                resolveSettingsPathFromExecutable != null,
            "client.json path resolver is missing");
        string settingsPath = (string)resolveSettingsPath.Invoke(null, null);
        string executableDirectory = Path.GetDirectoryName(
            System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName);
        Check(settingsPath == Path.Combine(executableDirectory, "client.json"),
            "client.json is not resolved beside the game executable");
        string explicitExecutablePath = Path.Combine(
            Path.Combine(Path.GetTempPath(), "ongeki-game"), "mu3.exe");
        Check((string)resolveSettingsPathFromExecutable.Invoke(null,
                new object[] { explicitExecutablePath }) ==
            Path.Combine(Path.GetDirectoryName(explicitExecutablePath), "client.json"),
            "client.json resolver does not use the executable directory");
        string explicitDataPath = Path.Combine(
            Path.Combine(Path.GetTempPath(), "ongeki-game"), "mu3_Data");
        Check((string)resolveSettingsPathFromDataPath.Invoke(null,
                new object[] { explicitDataPath }) ==
            Path.Combine(Path.GetDirectoryName(explicitDataPath), "client.json"),
            "client.json resolver does not use the Unity data directory sibling");
        string slashSeparatedDataPath = "F:/package/mu3_Data";
        Check((string)resolveSettingsPathFromDataPath.Invoke(null,
                new object[] { slashSeparatedDataPath }) ==
            "F:\\package\\client.json",
            "client.json resolver does not normalize Unity's Windows path separators");
        Check(resolveSettingsPathFromDataPath.Invoke(null, new object[] { null }) == null,
            "client.json data-path resolver accepts a missing Unity data directory");
        Type settingsType = entry.Assembly.GetType("OngekiCollab.Mod.LocalSettings", true);
        MethodInfo readSettings = settingsType.GetMethod("Read",
            BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo parseSettings = settingsType.GetMethod("Parse",
            BindingFlags.NonPublic | BindingFlags.Static);
        Check(readSettings != null && parseSettings != null,
            "client.json read and parse stages are missing");
        string temporarySettings = Path.GetTempFileName();
        try
        {
            File.WriteAllText(temporarySettings,
                "{\"origin\":\"https://collab.example/\",\"onlineMode\":true}");
            string rawSettings = (string)readSettings.Invoke(null, new object[] { temporarySettings });
            Check(rawSettings != null && rawSettings.Length != 0,
                "client.json read stage did not return the file contents");
            Check(parseSettings.Invoke(null, new object[] { rawSettings }) != null,
                "client.json parse stage did not return settings");
        }
        finally
        {
            if (File.Exists(temporarySettings)) File.Delete(temporarySettings);
        }
        bool rejectedMissingExecutable = false;
        try
        {
            resolveSettingsPathFromExecutable.Invoke(null, new object[] { null });
        }
        catch (TargetInvocationException error)
        {
            rejectedMissingExecutable = error.InnerException is InvalidOperationException;
        }
        Check(rejectedMissingExecutable,
            "client.json resolver accepts a missing executable path");

        bool bepinExBuild = entry.Assembly.GetName().Name.IndexOf(".BepInEx", StringComparison.Ordinal) >= 0;
        string baseType = entry.BaseType == null ? "" : entry.BaseType.FullName;
        Check(baseType == (bepinExBuild ? "BepInEx.BaseUnityPlugin" : "MelonLoader.MelonMod"),
            "loader entry base type does not match the build target");

        bool referencesBepInEx = false;
        bool referencesMelonLoader = false;
        foreach (AssemblyName reference in entry.Assembly.GetReferencedAssemblies())
        {
            if (reference.Name == "BepInEx") referencesBepInEx = true;
            if (reference.Name == "MelonLoader") referencesMelonLoader = true;
        }
        Check(bepinExBuild
                ? referencesBepInEx && !referencesMelonLoader
                : referencesMelonLoader && !referencesBepInEx,
            "loader build contains a reference to the other loader");

        BindingFlags declared = BindingFlags.Public | BindingFlags.NonPublic |
            BindingFlags.Instance | BindingFlags.DeclaredOnly;
        Check(entry.GetMethod(bepinExBuild ? "Awake" : "OnInitializeMelon", declared) != null &&
            entry.GetMethod(bepinExBuild ? "Update" : "OnUpdate", declared) != null &&
            entry.GetMethod("OnApplicationQuit", declared) != null &&
            (!bepinExBuild || entry.GetMethod("OnDestroy", declared) != null),
            "loader lifecycle entry points are incomplete");

        if (!bepinExBuild) return;
        bool hasPluginAttribute = false;
        foreach (object attribute in entry.GetCustomAttributes(false))
        {
            if (attribute.GetType().FullName == "BepInEx.BepInPlugin")
            {
                hasPluginAttribute = true;
                break;
            }
        }
        Check(hasPluginAttribute, "BepInEx plugin metadata is missing");
    }

    // The relay transport speaks through the native WinHTTP stack; the Mono
    // HTTP/WebSocket libraries must no longer be referenced from the client.
    private static void CheckNativeTransportShape(Assembly mod, Type client)
    {
        Check(mod.GetType("OngekiCollab.Mod.WinHttpNative", false) != null,
            "the native WinHTTP interop type is missing");
        Check(mod.GetType("OngekiCollab.Mod.WinHttpExchange", false) != null,
            "the native HTTP exchange type is missing");
        Type socketType = mod.GetType("OngekiCollab.Mod.WinHttpWebSocket", false);
        Check(socketType != null, "the native WebSocket type is missing");
        FieldInfo socketField = client.GetField("socket", BindingFlags.NonPublic | BindingFlags.Instance);
        Check(socketField != null && socketField.FieldType == socketType,
            "the relay client no longer owns a native WebSocket session");
        Check(client.GetMethod("EnableTls12", BindingFlags.NonPublic | BindingFlags.Static) == null,
            "the relay client still patches ServicePointManager TLS settings");
    }

    private static void CheckSelfContainedDependencies(Assembly mod)
    {
        bool referencesJson = false;
        bool referencesWebSocket = false;
        foreach (AssemblyName reference in mod.GetReferencedAssemblies())
        {
            if (reference.Name == "Newtonsoft.Json") referencesJson = true;
            if (reference.Name == "WebSocketDotNet") referencesWebSocket = true;
        }
        Check(!referencesJson && !referencesWebSocket,
            "self-contained mod still references an external JSON or WebSocket assembly");
        Check(mod.GetType("Newtonsoft.Json.Linq.JObject", false) != null,
            "self-contained mod does not contain the expected dependency types");
        Check(Array.IndexOf(mod.GetManifestResourceNames(),
            "OngekiCollab.ThirdPartyNotices.txt") >= 0,
            "self-contained mod is missing its embedded third-party notices");
    }

    private static void CheckDirectoryContracts(Assembly mod, Type clientType)
    {
        Type directoryType = mod.GetType("OngekiCollab.Mod.RelayDirectory", true);
        MethodInfo stable = directoryType.GetMethod("StableAddressFor", BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo isDirectory = directoryType.GetMethod("IsDirectoryAddress", BindingFlags.NonPublic | BindingFlags.Static);
        uint first = (uint)stable.Invoke(null, new object[] {
            "11111111-1111-1111-1111-111111111111", new List<uint>() });
        uint second = (uint)stable.Invoke(null, new object[] {
            "22222222-2222-2222-2222-222222222222", new List<uint> { first } });
        Check(first != second && (bool)isDirectory.Invoke(null, new object[] { first }) &&
            !(bool)isDirectory.Invoke(null, new object[] { 0x0aff0001u }),
            "directory addresses are not stable and isolated from relay peers");

        string keptRoom = "11111111-1111-1111-1111-111111111111";
        string filteredRoom = "22222222-2222-2222-2222-222222222222";
        JObject page = JObject.FromObject(new
        {
            items = new object[]
            {
                new { id = keptRoom, status = "recruiting", playerCount = 1, maxPlayers = 4,
                    createdAt = 1000L, song = new { id = 100, selectedDifficulty = 2 },
                    players = new[] { new { peerId = 2, name = "Not Host", cardId = 9999 },
                        new { peerId = 1, name = "Host", cardId = 4321 } } },
                new { id = filteredRoom, status = "recruiting", playerCount = 1, maxPlayers = 4,
                    createdAt = 2000L, song = new { id = 101, selectedDifficulty = 3 },
                    players = new[] { new { name = "Filtered" } } }
            }
        });
        object directory = Activator.CreateInstance(directoryType, true);
        directoryType.GetMethod("ApplyPage", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(
            directory, new object[] { page, null, new HashSet<string>(StringComparer.OrdinalIgnoreCase) { keptRoom } });
        IList entries = (IList)directoryType.GetMethod("Snapshot", BindingFlags.NonPublic | BindingFlags.Instance)
            .Invoke(directory, null);
        Check(entries.Count == 1 && (string)entries[0].GetType().GetField("RoomId").GetValue(entries[0]) == keptRoom &&
            (string)entries[0].GetType().GetField("PlayerName").GetValue(entries[0]) == "Host" &&
            (int)entries[0].GetType().GetField("CardId").GetValue(entries[0]) == 4321,
            "a room without current local chart validation reached the native directory");
        uint address = (uint)entries[0].GetType().GetField("Address").GetValue(entries[0]);
        object[] lookup = { address, null };
        Check((bool)directoryType.GetMethod("TryGet", BindingFlags.NonPublic | BindingFlags.Instance)
            .Invoke(directory, lookup) && lookup[1] != null,
            "directory address did not resolve back to its explicit room id");

        FieldInfo maximumEntries = directoryType.GetField("MaximumEntries",
            BindingFlags.NonPublic | BindingFlags.Static);
        JArray manyItems = new JArray();
        HashSet<string> manyValidated = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string retainedRoom = null;
        for (int i = 0; i < 51; i++)
        {
            string roomId = String.Format("{0:x8}-0000-0000-0000-{0:x12}", i + 1);
            if (i == 0) retainedRoom = roomId;
            manyValidated.Add(roomId);
            manyItems.Add(JObject.FromObject(new
            {
                id = roomId,
                status = "recruiting",
                playerCount = 1,
                maxPlayers = 4,
                createdAt = (long)i,
                song = new { id = 100 + i, selectedDifficulty = i % 5 },
                players = new[] { new { peerId = 1, name = "Host " + i, cardId = i } }
            }));
        }
        JObject manyPage = new JObject();
        manyPage["items"] = manyItems;
        MethodInfo applyPage = directoryType.GetMethod("ApplyPage", BindingFlags.NonPublic | BindingFlags.Instance);
        MethodInfo snapshotDirectory = directoryType.GetMethod("Snapshot", BindingFlags.NonPublic | BindingFlags.Instance);
        MethodInfo failPage = directoryType.GetMethod("FailPage", BindingFlags.NonPublic | BindingFlags.Instance);
        applyPage.Invoke(directory, new object[] { manyPage, null, manyValidated });
        entries = (IList)snapshotDirectory.Invoke(directory, null);
        object retained = null;
        foreach (object candidate in entries)
            if ((string)candidate.GetType().GetField("RoomId").GetValue(candidate) == retainedRoom)
                retained = candidate;
        uint retainedAddress = retained == null ? 0u :
            (uint)retained.GetType().GetField("Address").GetValue(retained);
        failPage.Invoke(directory, null);
        Check((int)maximumEntries.GetRawConstantValue() == 50 && entries.Count == 50 &&
            ((IList)snapshotDirectory.Invoke(directory, null)).Count == 0 && retainedAddress != 0,
            "directory page limit or failed-page clearing differs from the 50-room contract");
        applyPage.Invoke(directory, new object[] { manyPage, null, manyValidated });
        entries = (IList)snapshotDirectory.Invoke(directory, null);
        object restored = null;
        foreach (object candidate in entries)
            if ((string)candidate.GetType().GetField("RoomId").GetValue(candidate) == retainedRoom)
                restored = candidate;
        Check(restored != null &&
            (uint)restored.GetType().GetField("Address").GetValue(restored) == retainedAddress,
            "a failed directory refresh discarded the room's stable display address");

        Type snapshotType = mod.GetType("OngekiCollab.Mod.GameSnapshot+SongSnapshot", true);
        object snapshot = Activator.CreateInstance(snapshotType, true);
        string chart = Path.GetTempFileName();
        try
        {
            File.WriteAllText(chart, "directory-chart");
            ((IList)snapshotType.GetField("Difficulties").GetValue(snapshot)).Add(2);
            ((IList)snapshotType.GetField("ChartPaths").GetValue(snapshot)).Add(chart);
            MethodInfo validate = mod.GetType("OngekiCollab.Mod.ModEntry", true).GetMethod(
                "TryValidateDirectorySong", BindingFlags.NonPublic | BindingFlags.Static);
            Check((bool)validate.Invoke(null, new object[] { snapshot }),
                "readable local chart was rejected during directory validation");
            File.Delete(chart);
            Check(!(bool)validate.Invoke(null, new object[] { snapshot }),
                "missing local chart was not filtered during directory validation");
        }
        finally { if (File.Exists(chart)) File.Delete(chart); }

        MethodInfo match = clientType.GetMethod("Match", BindingFlags.Public | BindingFlags.Instance);
        ParameterInfo[] matchParameters = match == null ? null : match.GetParameters();
        Check(matchParameters != null && matchParameters.Length == 5 &&
            matchParameters[4].ParameterType == typeof(string),
            "relay Match no longer accepts an explicit directory room id");
        FieldInfo protocolVersion = clientType.GetField("ProtocolVersion",
            BindingFlags.NonPublic | BindingFlags.Static);
        Check(protocolVersion != null && protocolVersion.IsLiteral &&
            (int)protocolVersion.GetRawConstantValue() == 1,
            "relay Match protocol version changed or is no longer a compile-time constant");

        DateTime endedAt = DateTime.UtcNow;
        MethodInfo shouldRelease = mod.GetType("OngekiCollab.Mod.ModEntry", true).GetMethod(
            "ShouldReleaseAfterPlay", BindingFlags.NonPublic | BindingFlags.Static);
        Check(!(bool)shouldRelease.Invoke(null, new object[] { true, endedAt, endedAt.AddSeconds(10), false, false }) &&
            (bool)shouldRelease.Invoke(null, new object[] { true, endedAt, endedAt, false, true }) &&
            (bool)shouldRelease.Invoke(null, new object[] { true, endedAt, endedAt.AddSeconds(4), false, true }) &&
            !(bool)shouldRelease.Invoke(null, new object[] { false, endedAt, endedAt.AddSeconds(10), false, true }) &&
            (bool)shouldRelease.Invoke(null, new object[] { true, endedAt, endedAt, true, false }),
            "native Result did not release immediately, or cancellation failed to release its native room");
    }

    private static void CheckReadyAndStartContracts(Assembly mod)
    {
        Type entry = mod.GetType("OngekiCollab.Mod.ModEntry", true);
        MethodInfo acknowledge = entry.GetMethod("ReadyStateAcknowledgesEveryPlayer",
            BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo conflict = entry.GetMethod("PlayersHaveChartConflict",
            BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo clamp = entry.GetMethod("ClampReadyRtt", BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo canStart = entry.GetMethod("CanCompleteNativeStart", BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo snapshotAdvanced = entry.GetMethod("MemberSnapshotAdvanced",
            BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo currentReadyWork = entry.GetMethod("IsCurrentReadyWork",
            BindingFlags.NonPublic | BindingFlags.Static);
        Check(acknowledge != null && conflict != null && clamp != null && canStart != null &&
            snapshotAdvanced != null && currentReadyWork != null,
            "ready/start decision helpers are missing");

        Check(!(bool)snapshotAdvanced.Invoke(null, new object[] { (uint)4, (uint)4 }) &&
            (bool)snapshotAdvanced.Invoke(null, new object[] { (uint)5, (uint)4 }),
            "native self-join accepted a previous room's cumulative PartyMemberInfo count");
        Check((bool)currentReadyWork.Invoke(null, new object[] { 7, 7, 3, 3 }) &&
            !(bool)currentReadyWork.Invoke(null, new object[] { 7, 7, 2, 3 }) &&
            !(bool)currentReadyWork.Invoke(null, new object[] { 6, 7, 3, 3 }),
            "an older room-selection hash could overwrite the final Ready difficulty");

        JObject own = JObject.FromObject(new
        {
            id = 100,
            selectedDifficulty = 2,
            charts = new[] { new { difficulty = 2, sha256 = "local-a" } }
        });
        JArray ready = new JArray(
            Player(1, true, true, 100, 2, "local-a"),
            Player(2, true, true, 100, 3, "remote-b"));
        Check((bool)acknowledge.Invoke(null, new object[] { ready, (uint)1, own }),
            "full readyState did not acknowledge the local report");
        ((JObject)ready[1])["ready"] = false;
        Check(!(bool)acknowledge.Invoke(null, new object[] { ready, (uint)1, own }),
            "unready connected peer released native start");

        JArray remoteConflict = new JArray(
            Player(1, true, true, 100, 2, "local-a"),
            Player(2, true, true, 100, 3, "remote-a"),
            Player(3, true, true, 100, 3, "remote-b"));
        Check((bool)conflict.Invoke(null, new object[] { remoteConflict, 100 }),
            "two remote players with the same difficulty and different hashes were not blocked");
        ((JObject)remoteConflict[2])["selectedDifficulty"] = 4;
        Check(!(bool)conflict.Invoke(null, new object[] { remoteConflict, 100 }),
            "different difficulties were incorrectly required to share one hash");
        Check((int)clamp.Invoke(null, new object[] { -1 }) == 0 &&
            (int)clamp.Invoke(null, new object[] { 4000 }) == 3000,
            "Ready RTT clamp differs from the service limit");
        Check(!(bool)canStart.Invoke(null, new object[] { true, false, false, false, 2 }) &&
            !(bool)canStart.Invoke(null, new object[] { true, true, false, false, 1 }) &&
            (bool)canStart.Invoke(null, new object[] { true, true, false, false, 2 }),
            "native start did not gate both readyState and StartOK ordering");

        Type startPatch = mod.GetType("OngekiCollab.Mod.NativeMatching+StartPatch", true);
        MethodInfo prefix = startPatch.GetMethod("Prefix", BindingFlags.NonPublic | BindingFlags.Static);
        Check(prefix != null && (bool)prefix.Invoke(null, null),
            "battleStart was swallowed without an active mod session");
    }

    private static void CheckAlignmentContracts(Assembly mod, Type clientType)
    {
        Type entry = mod.GetType("OngekiCollab.Mod.ModEntry", true);
        MethodInfo verify = entry.GetMethod("ReadyChartMatches", BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo shouldEnd = entry.GetMethod("ShouldSendEndPlay", BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo ingestScore = entry.GetMethod("IngestRemotePlayScore", BindingFlags.NonPublic | BindingFlags.Instance);
        MethodInfo ingestProfile = entry.GetMethod("IngestPeerProfile", BindingFlags.NonPublic | BindingFlags.Instance);
        MethodInfo ingestPlayers = entry.GetMethod("IngestPlayers", BindingFlags.NonPublic | BindingFlags.Instance);
        Check(verify != null && shouldEnd != null && ingestScore != null && ingestProfile != null,
            "aligned chart, room-state, score or peer-profile helpers are missing");
        Check(ingestPlayers != null,
            "full snapshots cannot recover reserved peer profiles before peerConnected");
        object modEntry = Activator.CreateInstance(entry, true);
        Type settingsType = mod.GetType("OngekiCollab.Mod.LocalSettings", true);
        object settings = Activator.CreateInstance(settingsType, true);
        object relay = Activator.CreateInstance(clientType, BindingFlags.Instance | BindingFlags.Public |
            BindingFlags.NonPublic, null, new object[] { settings, "unused-client.json" }, null);
        clientType.GetProperty("PeerId", BindingFlags.Instance | BindingFlags.Public)
            .GetSetMethod(true).Invoke(relay, new object[] { (uint)1 });
        entry.GetField("relay", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(modEntry, relay);
        JObject reservedSnapshot = JObject.FromObject(new
        {
            players = new[]
            {
                new { peerId = 1, name = "Host", cardId = 1001, connected = true, ready = false },
                new { peerId = 2, name = "Guest", cardId = 2042, connected = false, ready = false }
            }
        });
        ingestPlayers.Invoke(modEntry, new object[] { reservedSnapshot });
        FieldInfo profilesField = entry.GetField("remotePlayerProfiles", BindingFlags.NonPublic | BindingFlags.Instance);
        IDictionary profiles = (IDictionary)profilesField.GetValue(modEntry);
        object guestProfile = profiles[(uint)2];
        Check(guestProfile != null &&
            (string)guestProfile.GetType().GetField("PlayerName").GetValue(guestProfile) == "Guest" &&
            (int)guestProfile.GetType().GetField("CardId").GetValue(guestProfile) == 2042,
            "a disconnected reserved seat was discarded from the first snapshot profile cache");
        profiles.Clear();
        entry.GetMethod("OnRoomText", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(modEntry,
            new object[] { "{\"type\":\"peerConnected\",\"peerId\":2,\"name\":\"Guest\",\"cardId\":2042}" });
        guestProfile = profiles[(uint)2];
        Check(guestProfile != null &&
            (string)guestProfile.GetType().GetField("PlayerName").GetValue(guestProfile) == "Guest",
            "peerConnected did not recover a profile after peerJoined was missed");

        string chart = Path.GetTempFileName();
        try
        {
            File.WriteAllText(chart, "ready-chart");
            string digest;
            using (System.Security.Cryptography.SHA256 sha = System.Security.Cryptography.SHA256.Create())
                digest = BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(chart))).Replace("-", "").ToLowerInvariant();
            JObject readySong = JObject.FromObject(new
            {
                id = 123,
                selectedDifficulty = 3,
                charts = new[] { new { difficulty = 3, sha256 = digest } }
            });
            Check((bool)verify.Invoke(null, new object[] { readySong, 123, 3, chart }),
                "unchanged Ready chart was rejected before score load");
            File.AppendAllText(chart, "-changed");
            Check(!(bool)verify.Invoke(null, new object[] { readySong, 123, 3, chart }),
                "changed Ready chart passed score-load verification");
        }
        finally { if (File.Exists(chart)) File.Delete(chart); }

        Check(!(bool)shouldEnd.Invoke(null, new object[] { "recruiting", true }) &&
            (bool)shouldEnd.Invoke(null, new object[] { "playing", true }) &&
            !(bool)shouldEnd.Invoke(null, new object[] { "playing", false }),
            "endPlay is not restricted to a playing host");

        MethodInfo canQueue = clientType.GetMethod("CanQueueSend", BindingFlags.NonPublic | BindingFlags.Static);
        FieldInfo maxFrames = clientType.GetField("MaximumQueuedFrames", BindingFlags.NonPublic | BindingFlags.Static);
        FieldInfo maxBytes = clientType.GetField("MaximumQueuedBytes", BindingFlags.NonPublic | BindingFlags.Static);
        Check(canQueue != null && maxFrames != null && maxBytes != null &&
            (int)maxFrames.GetRawConstantValue() == 512 &&
            (int)maxBytes.GetRawConstantValue() == 2 * 1024 * 1024 &&
            (bool)canQueue.Invoke(null, new object[] { 511, 0, 1 }) &&
            !(bool)canQueue.Invoke(null, new object[] { 512, 0, 1 }) &&
            (bool)canQueue.Invoke(null, new object[] { 0, 2 * 1024 * 1024 - 1, 1 }) &&
            !(bool)canQueue.Invoke(null, new object[] { 0, 2 * 1024 * 1024, 1 }),
            "relay send queue limits differ from 512 frames / 2 MiB");

        Type profile = entry.GetNestedType("RemotePlayerProfile", BindingFlags.NonPublic);
        Type score = entry.GetNestedType("RemotePlayScore", BindingFlags.NonPublic);
        MethodInfo mergeScore = entry.GetMethod("MergeRemotePlayScore", BindingFlags.NonPublic | BindingFlags.Static);
        object partial = score == null ? null : Activator.CreateInstance(score, true);
        bool merged = partial != null && mergeScore != null && (bool)mergeScore.Invoke(null,
            new object[] { partial, JObject.FromObject(new { battleScore = 77 }) });
        Check(profile != null && profile.GetField("Difficulty") == null &&
            score != null && score.GetField("HasTechScore") != null &&
            score.GetField("HasBattleScore") != null && score.GetField("HasBulletHitCount") != null &&
            score.GetField("HasPlayStatus") != null && merged &&
            !(bool)score.GetField("HasTechScore").GetValue(partial) &&
            (bool)score.GetField("HasBattleScore").GetValue(partial) &&
            (int)score.GetField("BattleScore").GetValue(partial) == 77,
            "profile fallback can still overwrite difficulty or scoreState cannot merge partial fields");

        Type loadPatch = mod.GetType("OngekiCollab.Mod.NativeMatching+ReadyChartLoadPatch", true);
        Type updatePatch = mod.GetType("OngekiCollab.Mod.NativeMatching+BlockUnloadedScoreUpdatePatch", true);
        Check(loadPatch.GetCustomAttributes(typeof(HarmonyPatch), false).Length != 0 &&
            updatePatch.GetCustomAttributes(typeof(HarmonyPatch), false).Length != 0,
            "NotesManager score-load verification patches are not registered");
        Check(clientType.GetMethod("SetMatchDeadline", BindingFlags.NonPublic | BindingFlags.Instance) != null,
            "Match/WebSocket/first-snapshot deadline is missing");
    }

    private static JObject Player(uint peerId, bool connected, bool ready,
        int songId, int difficulty, string sha256)
    {
        return JObject.FromObject(new
        {
            peerId,
            connected,
            ready,
            songId,
            selectedDifficulty = difficulty,
            chartSha256 = sha256
        });
    }

    private static void CheckIdentityErrorParsing(Type clientType)
    {
        MethodInfo check = clientType.GetMethod("IsIdentityFieldsChanged", BindingFlags.Static | BindingFlags.NonPublic);
        Check(check != null, "identity error classifier is missing");
        Check((bool)check.Invoke(null, new object[] { "{\"error\":\"Identity fields changed\"}" }),
            "Worker identity mismatch was not recognized");
        Check(!(bool)check.Invoke(null, new object[] { "<html>Forbidden</html>" }),
            "edge 403 was mistaken for an identity mismatch");
        MethodInfo describe = clientType.GetMethod("DescribeServerValidation",
            BindingFlags.Static | BindingFlags.NonPublic);
        Check(describe != null, "server validation classifier is missing");
        Check((string)describe.Invoke(null, new object[] { "{\"error\":\"Invalid gameVersion\"}" }) == "Invalid gameVersion" &&
            (string)describe.Invoke(null, new object[] { "{\"error\":\"Selected difficulty missing\"}" }) == "Selected difficulty missing",
            "static server validation strings were not surfaced");
        Check(describe.Invoke(null, new object[] { "{\"error\":\"https://host/path?key=abc\"}" }) == null &&
            describe.Invoke(null, new object[] { "{\"error\":\"long " + new string('x', 200) + "\"}" }) == null &&
            describe.Invoke(null, new object[] { "<html>Bad Request</html>" }) == null &&
            describe.Invoke(null, new object[] { "{\"error\":\"bad\\u0007control\"}" }) == null,
            "non-static server bodies leaked through the validation classifier");
    }

    private static void CheckStartupFailureDiagnostics(Assembly mod)
    {
        Type entry = mod.GetType("OngekiCollab.Mod.ModEntry", true);
        Type chartMissing = mod.GetType("OngekiCollab.Mod.OfficialChartMissingException", true);
        MethodInfo describe = entry.GetMethod("DescribeFailure", BindingFlags.NonPublic | BindingFlags.Static);
        Check(describe != null, "redacted startup failure diagnostic is missing");
        Exception chart = (Exception)Activator.CreateInstance(chartMissing,
            BindingFlags.Instance | BindingFlags.NonPublic, null,
            new object[] { "unused chart path" }, null);
        string chartDetail = (string)describe.Invoke(null, new object[] { chart });
        string dependencyDetail = (string)describe.Invoke(null,
            new object[] { new FileNotFoundException("unused dependency path") });
        string nestedDetail = (string)describe.Invoke(null, new object[] {
            new TypeInitializationException("unused type", new ArgumentNullException("unused parameter"))
        });
        string redirectDetail = (string)describe.Invoke(null, new object[] {
            new InvalidOperationException("Relay response was HTTP 301; configure the final HTTPS origin.")
        });
        string missingAssemblyDetail = (string)describe.Invoke(null, new object[] {
            new TypeInitializationException("SafeRuntimeType",
                new FileNotFoundException("unused detail", "Safe.Runtime, Version=1.0.0.0"))
        });
        Check(chartDetail == "an official chart file is missing" &&
            dependencyDetail == "FileNotFoundException" &&
            nestedDetail == "TypeInitializationException -> ArgumentNullException" &&
            redirectDetail == "Relay response was HTTP 301; configure the final HTTPS origin." &&
            missingAssemblyDetail == "runtime initializer SafeRuntimeType is missing assembly: Safe.Runtime, Version=1.0.0.0",
            "startup diagnostic conflates chart files, redirect responses, and loader dependencies or exposes exception messages");
    }

    private static void CheckSettingsValidation(Type settingsType)
    {
        object settings = Activator.CreateInstance(settingsType, true);
        settingsType.GetField("onlineMode").SetValue(settings, true);
        settingsType.GetField("origin").SetValue(settings, "https://relay.example/");
        settingsType.GetMethod("Validate").Invoke(settings, null);
        settingsType.GetField("origin").SetValue(settings, "http://192.0.2.10:8787/");
        settingsType.GetMethod("Validate").Invoke(settings, null);
        settingsType.GetField("origin").SetValue(settings, "ftp://invalid.example/");
        bool rejected = false;
        try { settingsType.GetMethod("Validate").Invoke(settings, null); }
        catch (TargetInvocationException error) { rejected = error.InnerException is InvalidOperationException; }
        Check(rejected, "non-HTTP(S) service origin was accepted");
    }

    private static void CheckIdentityStore(Type settingsType)
    {
        string directory = Path.Combine(Path.GetTempPath(), "OngekiCollabOffline-" + Guid.NewGuid().ToString("N"));
        string path = Path.Combine(directory, "client.json");
        try
        {
            object settings = Activator.CreateInstance(settingsType, true);
            settingsType.GetField("identityId").SetValue(settings, "portable-id");
            settingsType.GetField("clientKey").SetValue(settings, Convert.ToBase64String(new byte[32]));
            settingsType.GetMethod("Save").Invoke(settings, new object[] { path });
            settingsType.GetMethod("Save").Invoke(settings, new object[] { path });
            FileSecurity acl = File.GetAccessControl(path);
            Check(acl.AreAccessRulesProtected, "saved client key inherited broad permissions");
            Check(acl.GetOwner(typeof(SecurityIdentifier)).Equals(WindowsIdentity.GetCurrent().User),
                "saved client key is not owned by the current user");
            string json = File.ReadAllText(path);
            Check(json.Contains("portable-id") && json.Contains("clientKey"),
                "client key and identity ID were not persisted");
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
            if (Directory.Exists(directory)) Directory.Delete(directory);
        }
    }

    private static void CheckUserInfoPrivacy(Type transport)
    {
        foreach (uint peer in new uint[] { 1, 2 })
        {
            Party.UserInfo info = new Party.UserInfo();
            info._isJoin = true;
            info._ipAddress = 0x0aff0000u | peer;
            info._userID = 1234567890123L + peer;
            byte[] buffer = new byte[2048];
            Chunk chunk = new Chunk(0, buffer.Length, buffer);
            info.serialize(0, chunk);
            int position = 0;
            Check(chunk.readBool(ref position), "joined flag was lost");
            Check(chunk.readU32(ref position) == info._ipAddress, "virtual address changed");
            Check(chunk.readS64(ref position) == peer, "wire user ID was not the subject peer");
            Check(info._userID == 1234567890123L + peer, "local user ID was not restored");
        }
        Party.UserInfo invalid = new Party.UserInfo();
        invalid._isJoin = true;
        invalid._ipAddress = 0xc0a80102u;
        invalid._userID = 777;
        try
        {
            invalid.serialize(0, new Chunk(0, 2048, new byte[2048]));
            throw new InvalidOperationException("nonvirtual joined identity was allowed on wire");
        }
        catch (InvalidOperationException error)
        {
            if (error.Message == "nonvirtual joined identity was allowed on wire") throw;
        }
        Party.UserInfo empty = new Party.UserInfo();
        empty._isJoin = false;
        empty._ipAddress = 0xc0a80102u;
        empty._userID = 999999;
        Chunk emptyChunk = new Chunk(0, 2048, new byte[2048]);
        empty.serialize(0, emptyChunk);
        int emptyPosition = 0;
        Check(!emptyChunk.readBool(ref emptyPosition) && emptyChunk.readU32(ref emptyPosition) == 0 &&
            emptyChunk.readS64(ref emptyPosition) == 0, "nonjoined identity leaked onto wire");
        Check(empty._userID == 999999 && empty._ipAddress == 0xc0a80102u,
            "nonjoined local identity was not restored");

        Party.UserInfo claimed = new Party.UserInfo();
        claimed._isJoin = true;
        claimed._ipAddress = 0x0aff0003u;
        claimed._userID = 333;
        Chunk claimedChunk = new Chunk(0, 2048, new byte[2048]);
        claimed.serialize(0, claimedChunk);
        FieldInfo source = transport.GetField("decodingPeer", BindingFlags.NonPublic | BindingFlags.Static);
        source.SetValue(null, (uint)2);
        try
        {
            Party.UserInfo received = new Party.UserInfo();
            int position = 0;
            received.deserialize(ref position, claimedChunk);
            Check(!received._isJoin && received._userID == 0 && received._ipAddress == 0,
                "peer source impersonation was accepted");
        }
        finally { source.SetValue(null, (uint)0); }
    }

    private static byte[] Frame(byte kind, uint source, uint target, uint streamId, byte[] payload)
    {
        byte[] frame = new byte[22 + payload.Length];
        frame[0] = 0x4f; frame[1] = 0x43; frame[2] = 1; frame[3] = kind;
        Write(frame, 4, source); Write(frame, 8, target); Write(frame, 12, streamId);
        frame[20] = (byte)(payload.Length >> 8); frame[21] = (byte)payload.Length;
        Buffer.BlockCopy(payload, 0, frame, 22, payload.Length);
        return frame;
    }

    private static void Write(byte[] buffer, int index, uint value)
    {
        buffer[index] = (byte)(value >> 24); buffer[index + 1] = (byte)(value >> 16);
        buffer[index + 2] = (byte)(value >> 8); buffer[index + 3] = (byte)value;
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
