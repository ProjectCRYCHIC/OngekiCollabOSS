using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Threading;
#if HARMONY1
using Harmony;
using HarmonyPatch = OngekiCollab.Mod.LegacyHarmonyPatch;
#else
using HarmonyLib;
#endif
using MU3.Collab;

namespace OngekiCollab.Mod
{
    // The game owns all Party/Advertise state machines. This adapter changes only their
    // NFSocket transport while the user has explicitly selected online mode at startup.
    internal static class NativeTransport
    {
        private const int MaximumStreamBufferedBytes = 65536;
        private const int MaximumPendingStreams = 64;
        private const int MaximumDatagramsPerSocket = 256;

        private sealed class Datagram
        {
            public uint Sender;
            public byte[] Bytes;
        }
        private sealed class PendingStream
        {
            public uint Sender;
            public uint StreamId;
            public readonly Queue<byte> Bytes = new Queue<byte>();
            public bool RemoteClosed;
        }

        private sealed class VirtualSocket
        {
            public SocketType Type;
            public ushort Port;
            public bool Active;
            public bool Listening;
            public bool RemoteClosed;
            public bool SendClosed;
            public uint RemotePeer;
            public uint StreamId;
            public readonly Queue<Datagram> Datagrams = new Queue<Datagram>();
            public readonly Queue<PendingStream> Pending = new Queue<PendingStream>();
            public readonly Queue<byte> StreamBytes = new Queue<byte>();
        }

        private static readonly object Sync = new object();
        private static readonly Dictionary<NFSocket, VirtualSocket> Sockets = new Dictionary<NFSocket, VirtualSocket>();
        private static readonly Queue<PendingStream> PendingRemote = new Queue<PendingStream>();
        private static RelayClient relay;
        private static int streamCounter;
        private static volatile bool transportFailed;
        [ThreadStatic] private static uint decodingPeer;
        public static bool Enabled { get; private set; }
        public static uint PeerId { get; private set; }
        public static uint HostPeerId { get; private set; }
        public static bool Connected { get { return Enabled && !transportFailed && relay != null && PeerId >= 1 && PeerId <= 4; } }
        public static bool TransportFailed { get { return transportFailed; } }

        public static void Install(bool enabled)
        {
            Enabled = enabled;
            if (!enabled) return;
#if HARMONY1
            try { HarmonyInstance.Create("host.ongekicollab.mod.transport").PatchAll(typeof(NativeTransport).Assembly); }
            catch
            {
                // Harmony 1.0, bundled by BepInEx 1/2, has no unpatch API. The
                // loader must discard the failed process instead of continuing.
                Enabled = false;
                throw;
            }
#else
            HarmonyLib.Harmony harmony = new HarmonyLib.Harmony("host.ongekicollab.mod.transport");
            try { harmony.PatchAll(typeof(NativeTransport).Assembly); }
            catch
            {
                Enabled = false;
                HarmonyLib.Harmony.UnpatchID("host.ongekicollab.mod.transport");
                throw;
            }
#endif
        }

        public static void Attach(RelayClient client, uint hostPeerId)
        {
            lock (Sync)
            {
                relay = client;
                PeerId = client.PeerId;
                HostPeerId = hostPeerId;
                transportFailed = false;
            }
        }

        public static void Detach()
        {
            lock (Sync)
            {
                relay = null;
                PeerId = 0;
                HostPeerId = 0;
                foreach (VirtualSocket socket in Sockets.Values)
                {
                    socket.Datagrams.Clear();
                    socket.Pending.Clear();
                    socket.StreamBytes.Clear();
                    socket.RemoteClosed = true;
                    socket.SendClosed = true;
                }
                PendingRemote.Clear();
                transportFailed = false;
            }
        }

        private static void FailTransport()
        {
            transportFailed = true;
            lock (Sync)
            {
                foreach (VirtualSocket socket in Sockets.Values)
                {
                    if (socket.Type == SocketType.Stream && !socket.Listening)
                    {
                        socket.RemoteClosed = true;
                        socket.SendClosed = true;
                    }
                    foreach (PendingStream pending in socket.Pending) pending.RemoteClosed = true;
                }
                foreach (PendingStream pending in PendingRemote) pending.RemoteClosed = true;
            }
        }

        private static void FailStream(VirtualSocket socket)
        {
            if (socket == null) return;
            socket.RemoteClosed = true;
            socket.SendClosed = true;
        }

        private static bool Deliver(Queue<byte> queue, byte[] payload)
        {
            if (payload == null || queue.Count > MaximumStreamBufferedBytes - payload.Length)
                return false;
            foreach (byte value in payload) queue.Enqueue(value);
            return true;
        }

        private static void SendCloseFrameOrFail(uint remote, uint streamId)
        {
            try { relay.SendBinary(4, remote, streamId, new byte[0]); }
            catch { FailTransport(); }
        }

        private static void CloseLocalStream(uint streamId, VirtualSocket source)
        {
            lock (Sync)
            {
                foreach (VirtualSocket other in Sockets.Values)
                {
                    if (other != source && other.Type == SocketType.Stream &&
                        other.RemotePeer == PeerId && other.StreamId == streamId)
                        other.RemoteClosed = true;
                    if (!other.Listening) continue;
                    foreach (PendingStream pending in other.Pending)
                        if (pending.Sender == PeerId && pending.StreamId == streamId)
                            pending.RemoteClosed = true;
                }
            }
        }

        public static void ReceiveFrame(byte[] frame)
        {
            byte kind; uint sender, target, streamId; byte[] payload;
            if (!RelayClient.TryReadFrame(frame, out kind, out sender, out target, out streamId, out payload))
            { FailTransport(); return; }
            if (kind < 1 || kind > 4 || sender < 1 || sender > 4 || target > 4 ||
                (kind == 1 && streamId != 50000 && streamId != 50002) ||
                ((kind == 2 || kind == 4) && payload.Length != 0))
            { FailTransport(); return; }
            if (!Connected || sender == PeerId || (target != 0 && target != PeerId)) return;
            bool rejectStream = false;
            lock (Sync)
            {
                if (kind == 1)
                {
                    foreach (VirtualSocket socket in Sockets.Values)
                        if (socket.Active && socket.Type == SocketType.Dgram && socket.Port == streamId &&
                            socket.Datagrams.Count < MaximumDatagramsPerSocket)
                            socket.Datagrams.Enqueue(new Datagram { Sender = sender, Bytes = payload });
                    return;
                }
                if (kind == 2)
                {
                    if (PendingRemote.Count < MaximumPendingStreams)
                        PendingRemote.Enqueue(new PendingStream { Sender = sender, StreamId = streamId });
                    else rejectStream = true;
                }
                else
                {
                    bool delivered = false;
                    foreach (VirtualSocket socket in Sockets.Values)
                    {
                        if (!socket.Active || socket.Type != SocketType.Stream || socket.Listening ||
                            socket.RemotePeer != sender || socket.StreamId != streamId) continue;
                        if (kind == 3 && !socket.RemoteClosed && !socket.SendClosed &&
                            !Deliver(socket.StreamBytes, payload))
                        { FailStream(socket); rejectStream = true; }
                        else if (kind == 4) socket.RemoteClosed = true;
                        delivered = true;
                    }
                    if (!delivered)
                    {
                        foreach (PendingStream pending in PendingRemote)
                        {
                            if (pending.Sender != sender || pending.StreamId != streamId) continue;
                            if (kind == 3 && !pending.RemoteClosed && !Deliver(pending.Bytes, payload))
                            { pending.RemoteClosed = true; rejectStream = true; }
                            else if (kind == 4) pending.RemoteClosed = true;
                            break;
                        }
                    }
                }
            }
            if (rejectStream) SendCloseFrameOrFail(sender, streamId);
        }

        private static uint VirtualIp(uint peer)
        {
            return 0x0aff0000u | peer;
        }

        private static uint PeerFromIp(IPAddress ip)
        {
            byte[] bytes = ip.GetAddressBytes();
            return bytes.Length == 4 && bytes[0] == 10 && bytes[1] == 255 && bytes[2] == 0 &&
                bytes[3] >= 1 && bytes[3] <= 4 ? (uint)bytes[3] : 0u;
        }

        private static uint DatagramTarget(IPAddress address)
        {
            return address == null ? 0u : PeerFromIp(address);
        }

        private static uint PeerFromAddressValue(uint value)
        {
            return (value & 0xffffff00u) == 0x0aff0000u && (value & 0xffu) >= 1 &&
                (value & 0xffu) <= 4 ? value & 0xffu : 0u;
        }

        private static IPAddress Ip(uint peer)
        {
            return new IPAddress(new byte[] { 10, 255, 0, (byte)peer });
        }

        [HarmonyPatch(typeof(MU3.Sys.Config), "get_isUseLocalCollab")]
        private static class OnlineConfigPatch
        {
            private static bool Prefix(ref bool __result)
            {
                if (!Enabled) return true;
                __result = true;
                return false;
            }
        }

        [HarmonyPatch(typeof(AMDaemon.Network), "get_IsLanAvailable")]
        private static class LanCapabilityPatch
        {
            private static bool Prefix(ref bool __result)
            {
                if (!Enabled) return true;
                __result = true;
                return false;
            }
        }

        [HarmonyPatch(typeof(MU3.Collab.Util), "MyIpAddress", new Type[] { typeof(int) })]
        private static class OwnIpPatch
        {
            private static bool Prefix(ref IPAddress __result)
            {
                if (!Enabled) return true;
                __result = Ip(Connected ? PeerId : 254);
                return false;
            }
        }

        [HarmonyPatch(typeof(MU3.Collab.Util), "LoopbackAddress", new Type[] { typeof(int) })]
        private static class LoopbackIpPatch
        {
            private static bool Prefix(ref IPAddress __result)
            {
                if (!Enabled || !Connected) return true;
                __result = Ip(PeerId);
                return false;
            }
        }

        // Online rooms ignore the cabinet's real machine group the same way WorldLink
        // forces one: every relay client starts Party and Advertise with a single fixed
        // group so the native group filters pass across strangers (including cabinets
        // configured with OFF). LAN mode is untouched.
        [HarmonyPatch]
        private static class ForceGroupPatches
        {
            private static IEnumerable<MethodBase> TargetMethods()
            {
                Type partyManager = typeof(Party).GetNestedType("Manager", BindingFlags.NonPublic);
                Type advertiseManager = typeof(Advertise).GetNestedType("Manager", BindingFlags.NonPublic);
                MethodBase start = partyManager == null ? null : partyManager.GetMethod("start",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null,
                    new Type[] { typeof(MU3.DB.MachineGroupID) }, null);
                MethodBase initialize = advertiseManager == null ? null : advertiseManager.GetMethod("initialize",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null,
                    new Type[] { typeof(MU3.DB.MachineGroupID) }, null);
                if (start != null) yield return start;
                if (initialize != null) yield return initialize;
            }

            private static void Prefix(ref MU3.DB.MachineGroupID __0)
            {
                if (!Enabled) return;
                __0 = MU3.DB.MachineGroupID.A;
            }
        }

        private struct UserInfoState { public long Id; public uint Ip; }

        [HarmonyPatch(typeof(Party.UserInfo), "serialize")]
        private static class UserInfoPrivacyPatch
        {
            private static void Prefix(Party.UserInfo __instance, out UserInfoState __state)
            {
                __state = new UserInfoState { Id = __instance._userID, Ip = __instance._ipAddress };
                if (!Connected) return;
                uint subject = PeerFromAddressValue(__instance._ipAddress);
                if (subject == 0 && __instance._isJoin)
                    throw new InvalidOperationException("Party identity has no virtual room address.");
                __instance._userID = subject;
                __instance._ipAddress = subject == 0 ? 0 : VirtualIp(subject);
            }

            private static void Postfix(Party.UserInfo __instance, UserInfoState __state)
            {
                __instance._userID = __state.Id;
                __instance._ipAddress = __state.Ip;
            }
        }

        [HarmonyPatch(typeof(Packet), "deserialize")]
        private static class PacketSourcePatch
        {
            private static void Prefix(Packet __instance, out uint __state)
            {
                __state = decodingPeer;
                decodingPeer = Connected ? PeerFromIp(new IPAddress(__instance.getAddress().GetAddressBytes())) : 0;
            }

            private static void Postfix(uint __state)
            {
                decodingPeer = __state;
            }
        }

        [HarmonyPatch(typeof(Party.UserInfo), "deserialize")]
        private static class UserInfoReceivePatch
        {
            private static void Postfix(Party.UserInfo __instance)
            {
                if (!Connected) return;
                uint subject = PeerFromAddressValue(__instance._ipAddress);
                if (subject == 0 || (decodingPeer != HostPeerId && subject != decodingPeer))
                {
                    __instance._userID = 0;
                    __instance._ipAddress = 0;
                    __instance._isJoin = false;
                    return;
                }
                __instance._userID = subject;
                __instance._ipAddress = VirtualIp(subject);
            }
        }

#if HARMONY1
        [HarmonyPatch(typeof(NFSocket),
            new Type[] { typeof(AddressFamily), typeof(SocketType), typeof(ProtocolType), typeof(int) })]
#else
        [HarmonyPatch(typeof(NFSocket), MethodType.Constructor,
            new Type[] { typeof(AddressFamily), typeof(SocketType), typeof(ProtocolType), typeof(int) })]
#endif
        private static class ConstructPatch
        {
            private static void Postfix(NFSocket __instance, SocketType socketType)
            {
                if (!Enabled) return;
                lock (Sync) Sockets[__instance] = new VirtualSocket { Type = socketType };
            }
        }

        [HarmonyPatch(typeof(NFSocket), "Bind")]
        private static class BindPatch
        {
            private static bool Prefix(NFSocket __instance, EndPoint localEndP)
            {
                if (!Enabled) return true;
                // {50000,50002} only by design: Setting (50001) and DeliveryChecker
                // (50003) never enter the relay (WorldLink reference behavior — local
                // SKIP/native paths); do not widen this whitelist for them.
                IPEndPoint endpoint = localEndP as IPEndPoint;
                bool useVirtual = endpoint != null && (endpoint.Port == 50000 || endpoint.Port == 50002);
                lock (Sync)
                {
                    VirtualSocket socket;
                    if (Sockets.TryGetValue(__instance, out socket) && endpoint != null)
                    {
                        socket.Port = (ushort)endpoint.Port;
                        socket.Active = useVirtual;
                    }
                }
                return !useVirtual;
            }
        }

        [HarmonyPatch(typeof(NFSocket), "Listen")]
        private static class ListenPatch
        {
            private static bool Prefix(NFSocket __instance)
            {
                if (!Enabled) return true;
                lock (Sync)
                {
                    VirtualSocket socket;
                    if (!Sockets.TryGetValue(__instance, out socket) || !socket.Active) return true;
                    socket.Listening = true;
                }
                return false;
            }
        }

        [HarmonyPatch(typeof(NFSocket), "ConnectAsync")]
        private static class ConnectPatch
        {
            private static bool Prefix(NFSocket __instance, SocketAsyncEventArgs e, ref bool __result)
            {
                if (!Enabled) return true;
                IPEndPoint endpoint = e.RemoteEndPoint as IPEndPoint;
                if (endpoint == null || endpoint.Port != 50000) return true;
                uint remote = PeerFromIp(endpoint.Address);
                if (!Connected || remote == 0)
                    throw new InvalidOperationException("Online Party can connect only to a room peer.");
                uint id = unchecked((uint)Interlocked.Increment(ref streamCounter));
                if (id == 0) id = unchecked((uint)Interlocked.Increment(ref streamCounter));
                lock (Sync)
                {
                    VirtualSocket socket;
                    if (!Sockets.TryGetValue(__instance, out socket)) throw new InvalidOperationException("Unknown Party socket.");
                    socket.RemotePeer = remote;
                    socket.StreamId = id;
                    socket.RemoteClosed = false;
                    socket.SendClosed = false;
                    socket.Active = true;
                    if (remote == PeerId)
                    {
                        VirtualSocket listener = null;
                        foreach (VirtualSocket candidate in Sockets.Values)
                            if (candidate.Active && candidate.Listening && candidate.Port == 50000) { listener = candidate; break; }
                        if (listener == null) throw new InvalidOperationException("Local Party listener is not ready.");
                        if (listener.Pending.Count >= MaximumPendingStreams)
                        {
                            FailStream(socket);
                            throw new InvalidOperationException("Local Party accept queue is full.");
                        }
                        listener.Pending.Enqueue(new PendingStream { Sender = PeerId, StreamId = id });
                    }
                }
                if (remote != PeerId)
                {
                    try { relay.SendBinary(2, remote, id, new byte[0]); }
                    catch { FailTransport(); throw; }
                }
                __result = false;
                return false;
            }
        }

        [HarmonyPatch(typeof(NFSocket), "Accept")]
        private static class AcceptPatch
        {
            private static bool Prefix(NFSocket __instance, ref NFSocket __result)
            {
                if (!Enabled) return true;
                PendingStream pending;
                lock (Sync)
                {
                    VirtualSocket listener;
                    if (!Sockets.TryGetValue(__instance, out listener) || !listener.Active) return true;
                    if (
                        (listener.Pending.Count == 0 && PendingRemote.Count == 0))
                    { __result = null; return false; }
                    pending = listener.Pending.Count != 0 ? listener.Pending.Dequeue() : PendingRemote.Dequeue();
                }
                NFSocket accepted = new NFSocket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp, -1);
                lock (Sync)
                {
                    VirtualSocket stream = Sockets[accepted];
                    stream.RemotePeer = pending.Sender;
                    stream.StreamId = pending.StreamId;
                    stream.Port = 50000;
                    stream.Active = true;
                    stream.RemoteClosed = pending.RemoteClosed;
                    foreach (byte value in pending.Bytes) stream.StreamBytes.Enqueue(value);
                }
                __result = accepted;
                return false;
            }
        }

        [HarmonyPatch(typeof(NFSocket), "Poll")]
        private static class PollPatch
        {
            private static bool Prefix(NFSocket socket, SelectMode mode, ref bool __result)
            {
                if (!Enabled) return true;
                lock (Sync)
                {
                    VirtualSocket virtualSocket;
                    if (!Sockets.TryGetValue(socket, out virtualSocket)) return true;
                    if (!virtualSocket.Active)
                    {
                        if (virtualSocket.Type == SocketType.Dgram && virtualSocket.Port == 0 && mode == SelectMode.SelectWrite)
                        { __result = true; return false; }
                        return true;
                    }
                    if (mode == SelectMode.SelectWrite) __result = Connected && !virtualSocket.SendClosed;
                    else if (virtualSocket.Listening) __result = virtualSocket.Pending.Count != 0 || PendingRemote.Count != 0;
                    else if (virtualSocket.Type == SocketType.Dgram) __result = virtualSocket.Datagrams.Count != 0;
                    else __result = virtualSocket.StreamBytes.Count != 0 || virtualSocket.RemoteClosed;
                    return false;
                }
            }
        }

        [HarmonyPatch(typeof(NFSocket), "get_RemoteEndPoint")]
        private static class RemoteEndpointPatch
        {
            private static bool Prefix(NFSocket __instance, ref EndPoint __result)
            {
                if (!Enabled) return true;
                lock (Sync)
                {
                    VirtualSocket socket;
                    if (!Sockets.TryGetValue(__instance, out socket) || !socket.Active) return true;
                    if (socket.RemotePeer == 0)
                    { __result = null; return false; }
                    __result = new IPEndPoint(Ip(socket.RemotePeer), 50000);
                    return false;
                }
            }
        }

        [HarmonyPatch(typeof(NFSocket), "get_LocalEndPoint")]
        private static class LocalEndpointPatch
        {
            private static bool Prefix(NFSocket __instance, ref EndPoint __result)
            {
                if (!Enabled) return true;
                lock (Sync)
                {
                    VirtualSocket socket;
                    if (!Sockets.TryGetValue(__instance, out socket) || !socket.Active) return true;
                    __result = new IPEndPoint(Ip(Connected ? PeerId : 254), socket.Port);
                    return false;
                }
            }
        }

        [HarmonyPatch(typeof(NFSocket), "Send")]
        private static class SendPatch
        {
            private static bool Prefix(NFSocket __instance, byte[] buffer, int offset, int size, ref int __result)
            {
                if (!Enabled) return true;
                VirtualSocket socket;
                lock (Sync) if (!Sockets.TryGetValue(__instance, out socket) || !socket.Active) return true;
                if (buffer == null) throw new ArgumentNullException("buffer");
                if (size < 0 || offset < 0 || offset > buffer.Length - size)
                    throw new ArgumentOutOfRangeException("size");
                if (!Connected || socket.RemotePeer == 0 || socket.SendClosed)
                { __result = 0; return false; }
                byte[] payload = new byte[size];
                Buffer.BlockCopy(buffer, offset, payload, 0, size);
                if (socket.RemotePeer == PeerId)
                {
                    lock (Sync)
                    {
                        bool delivered = false;
                        foreach (KeyValuePair<NFSocket, VirtualSocket> pair in Sockets)
                        {
                            VirtualSocket other = pair.Value;
                            if (pair.Key == __instance || other.Type != SocketType.Stream ||
                                other.RemotePeer != PeerId || other.StreamId != socket.StreamId) continue;
                            if (!Deliver(other.StreamBytes, payload))
                            {
                                FailStream(socket);
                                FailStream(other);
                                __result = 0;
                                return false;
                            }
                            delivered = true;
                        }
                        if (!delivered)
                        {
                            foreach (VirtualSocket listener in Sockets.Values)
                            {
                                if (!listener.Active || !listener.Listening || listener.Port != 50000) continue;
                                foreach (PendingStream pending in listener.Pending)
                                {
                                    if (pending.Sender != PeerId || pending.StreamId != socket.StreamId) continue;
                                    if (!Deliver(pending.Bytes, payload))
                                    {
                                        FailStream(socket);
                                        pending.RemoteClosed = true;
                                        __result = 0;
                                        return false;
                                    }
                                    delivered = true;
                                    break;
                                }
                                if (delivered) break;
                            }
                        }
                        if (!delivered)
                        {
                            socket.RemoteClosed = true;
                            socket.SendClosed = true;
                            __result = 0;
                            return false;
                        }
                    }
                }
                else
                {
                    for (int sent = 0; sent < size; sent += 4096)
                    {
                        int length = Math.Min(4096, size - sent);
                        byte[] framePayload = new byte[length];
                        Buffer.BlockCopy(payload, sent, framePayload, 0, length);
                        try { relay.SendBinary(3, socket.RemotePeer, socket.StreamId, framePayload); }
                        catch
                        {
                            socket.RemoteClosed = true;
                            socket.SendClosed = true;
                            FailTransport();
                            __result = 0;
                            return false;
                        }
                    }
                }
                __result = size;
                return false;
            }
        }

        [HarmonyPatch(typeof(NFSocket), "Receive")]
        private static class ReceivePatch
        {
            private static bool Prefix(NFSocket __instance, byte[] buffer, int offset, int size,
                out SocketError errorCode, ref int __result)
            {
                errorCode = SocketError.Success;
                if (!Enabled) { __result = 0; return true; }
                lock (Sync)
                {
                    VirtualSocket socket;
                    if (!Sockets.TryGetValue(__instance, out socket) || !socket.Active) return true;
                    int count = Math.Min(size, socket.StreamBytes.Count);
                    for (int i = 0; i < count; i++) buffer[offset + i] = socket.StreamBytes.Dequeue();
                    __result = count;
                    return false;
                }
            }
        }

        [HarmonyPatch(typeof(NFSocket), "SendTo")]
        private static class SendToPatch
        {
            private static bool Prefix(byte[] buffer, int offset, int size, EndPoint remoteEP, ref int __result)
            {
                if (!Enabled) return true;
                IPEndPoint routed = remoteEP as IPEndPoint;
                if (routed == null || (routed.Port != 50000 && routed.Port != 50002)) return true;
                if (buffer == null) throw new ArgumentNullException("buffer");
                if (size < 0 || offset < 0 || offset > buffer.Length - size)
                    throw new ArgumentOutOfRangeException("size");
                bool sent = false;
                if (Connected)
                {
                    IPEndPoint endpoint = routed;
                    uint target = endpoint == null ? 0 : DatagramTarget(endpoint.Address);
                    uint port = endpoint == null ? 50000u : (uint)endpoint.Port;
                    byte[] payload = new byte[size];
                    Buffer.BlockCopy(buffer, offset, payload, 0, size);
                    if (target == PeerId)
                    {
                        lock (Sync)
                            foreach (VirtualSocket receiver in Sockets.Values)
                                if (receiver.Active && receiver.Type == SocketType.Dgram && receiver.Port == port &&
                                    receiver.Datagrams.Count < MaximumDatagramsPerSocket)
                                {
                                    receiver.Datagrams.Enqueue(new Datagram { Sender = PeerId, Bytes = payload });
                                }
                        sent = true;
                    }
                    else
                    {
                        // A non-peer destination is the native broadcast path. The
                        // relay protocol reserves target 0 for UDP fan-out.
                        try { relay.SendBinary(1, target, port, payload); sent = true; }
                        catch { FailTransport(); }
                    }
                }
                __result = sent ? size : 0;
                return false;
            }
        }

        [HarmonyPatch(typeof(NFSocket), "ReceiveFrom")]
        private static class ReceiveFromPatch
        {
            private static bool Prefix(NFSocket __instance, byte[] buffer, ref EndPoint remoteEP, ref int __result)
            {
                if (!Enabled) return true;
                lock (Sync)
                {
                    VirtualSocket socket;
                    if (!Sockets.TryGetValue(__instance, out socket) || !socket.Active) return true;
                    if (socket.Datagrams.Count == 0)
                    { __result = 0; return false; }
                    Datagram packet = socket.Datagrams.Dequeue();
                    if (packet.Bytes.Length > buffer.Length) { __result = 0; return false; }
                    Buffer.BlockCopy(packet.Bytes, 0, buffer, 0, packet.Bytes.Length);
                    remoteEP = new IPEndPoint(Ip(packet.Sender), socket.Port);
                    __result = packet.Bytes.Length;
                    return false;
                }
            }
        }

        [HarmonyPatch(typeof(NFSocket), "Close")]
        private static class ClosePatch
        {
            private static void Prefix(NFSocket __instance)
            {
                if (!Enabled) return;
                VirtualSocket socket;
                lock (Sync)
                {
                    if (!Sockets.TryGetValue(__instance, out socket)) return;
                    Sockets.Remove(__instance);
                }
                if (Connected && socket.Type == SocketType.Stream && !socket.Listening &&
                    socket.RemotePeer != 0 && !socket.SendClosed)
                {
                    if (socket.RemotePeer == PeerId)
                        CloseLocalStream(socket.StreamId, socket);
                    else SendCloseFrameOrFail(socket.RemotePeer, socket.StreamId);
                }
            }
        }

        [HarmonyPatch(typeof(NFSocket), "Shutdown")]
        private static class ShutdownPatch
        {
            private static bool Prefix(NFSocket __instance, SocketShutdown how)
            {
                if (!Enabled) return true;
                uint remote;
                uint streamId;
                lock (Sync)
                {
                    VirtualSocket socket;
                    if (!Sockets.TryGetValue(__instance, out socket) || !socket.Active) return true;
                    if (socket.Type != SocketType.Stream || socket.RemotePeer == 0 ||
                        socket.SendClosed || (how != SocketShutdown.Send && how != SocketShutdown.Both)) return false;
                    socket.SendClosed = true;
                    remote = socket.RemotePeer;
                    streamId = socket.StreamId;
                    if (remote == PeerId)
                    {
                        CloseLocalStream(streamId, socket);
                        return false;
                    }
                }
                if (Connected) SendCloseFrameOrFail(remote, streamId);
                return false;
            }
        }
    }
}
