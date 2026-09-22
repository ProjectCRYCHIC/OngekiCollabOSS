using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace OngekiCollab.Mod
{
    internal sealed class IdentityBindingChangedException : Exception
    {
        public IdentityBindingChangedException() : base("Registered game identity differs from current identity.") { }
    }

    internal sealed class LocalSettings
    {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
            string descriptor, uint revision, out IntPtr securityDescriptor, out uint size);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetFileSecurity(string path, uint securityInformation, IntPtr securityDescriptor);
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        // Empty by default: online mode stays disabled until an explicit origin is set.
        public string origin = "";
        public string pool = "";
        public string identityId = "";
        public string clientKey = "";
        public string anonymousKey = "";
        public bool onlineMode = false;

        public static LocalSettings Load(string path)
        {
            return Parse(Read(path));
        }

        internal static string Read(string path)
        {
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }

        internal static LocalSettings Parse(string text)
        {
            if (text == null) return new LocalSettings();
            // JsonConvert's object-contract path loads System.Runtime.Serialization,
            // which Unity 5.6's Mono profile does not include. Keep this simple
            // settings document on the JObject reader/writer path instead.
            JObject document = JObject.Parse(text);
            LocalSettings result = new LocalSettings();
            result.origin = ReadString(document, "origin");
            result.pool = ReadString(document, "pool");
            result.identityId = ReadString(document, "identityId");
            result.clientKey = ReadString(document, "clientKey");
            result.anonymousKey = ReadString(document, "anonymousKey");
            JToken onlineMode = document["onlineMode"];
            if (onlineMode != null && onlineMode.Type == JTokenType.Boolean)
                result.onlineMode = (bool)onlineMode;
            return result;
        }

        private static string ReadString(JObject document, string name)
        {
            JToken value = document[name];
            return value == null || value.Type == JTokenType.Null ? "" : (string)value;
        }

        public void Validate()
        {
            if (!onlineMode) return;
            Uri uri;
            // Both deployments speak the same protocol; a LAN self-hosted server
            // is plain HTTP and its room socket is ws://, cloud deployments are
            // HTTPS/wss. The scheme only decides the socket scheme below.
            if (!Uri.TryCreate(origin, UriKind.Absolute, out uri) ||
                (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) ||
                uri.AbsolutePath != "/" || !String.IsNullOrEmpty(uri.UserInfo) ||
                !String.IsNullOrEmpty(uri.Query) || !String.IsNullOrEmpty(uri.Fragment))
                throw new InvalidOperationException("Configure a valid HTTP(S) service origin in client.json.");
            if (!String.IsNullOrEmpty(pool) && !Regex.IsMatch(pool, "^[A-Za-z0-9_-]{1,64}$"))
                throw new InvalidOperationException("Configure a valid matching pool in client.json.");
        }

        public void Save(string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string temporary = path + ".tmp";
            try
            {
                JObject document = new JObject();
                document["origin"] = origin ?? "";
                document["pool"] = pool ?? "";
                document["identityId"] = identityId ?? "";
                document["clientKey"] = clientKey ?? "";
                document["anonymousKey"] = anonymousKey ?? "";
                document["onlineMode"] = onlineMode;
                File.WriteAllText(temporary, document.ToString(Formatting.Indented));
                ProtectLocalKeyFile(temporary);
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        private static void ProtectLocalKeyFile(string path)
        {
            IntPtr descriptor;
            uint size;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;FA;;;OW)", 1,
                out descriptor, out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                if (!SetFileSecurity(path, 0x00000004, descriptor))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally { LocalFree(descriptor); }
        }
    }

    internal sealed class CurrentIdentity
    {
        public string keychipid;
        public string accessCode;
        public string userId;
        public string server;
        public string username;
        public int cardId;

        public JObject ToWire()
        {
            JObject identity = new JObject();
            identity["keychipid"] = keychipid;
            identity["accessCode"] = accessCode;
            identity["userId"] = userId;
            identity["server"] = server;
            return identity;
        }

        public void Validate()
        {
            if (String.IsNullOrEmpty(keychipid)) throw new InvalidOperationException("Game identity is missing keychipid.");
            if (String.IsNullOrEmpty(accessCode)) throw new InvalidOperationException("Game identity is missing accessCode; select an AIME card first.");
            if (String.IsNullOrEmpty(userId)) throw new InvalidOperationException("Game identity is missing userId.");
            if (String.IsNullOrEmpty(server)) throw new InvalidOperationException("Game identity is missing server.");
        }
    }

    internal sealed class RelayClient : IDisposable
    {
        internal const int ProtocolVersion = 1;
        private readonly LocalSettings settings;
        private readonly string settingsPath;
        private WinHttpWebSocket socket;
        private readonly object sendLock = new object();
        private sealed class PendingSend
        {
            public string Text;
            public byte[] Binary;
            public int Size;
        }
        internal const int MaximumQueuedFrames = 512;
        internal const int MaximumQueuedBytes = 2 * 1024 * 1024;
        internal const int MaximumControlBytes = 16384;
        internal const int MaximumDirectoryResponseBytes = 256 * 1024;
        internal const int RoomConnectRetryDelayMilliseconds = 1500;
        private readonly Queue<PendingSend> sendQueue = new Queue<PendingSend>();
        private int queuedBytes;
        private bool sendWorkerActive;
        private bool sendFailed;
        private int closeNotified;
        private readonly object requestLock = new object();
        private WinHttpExchange activeDirectoryExchange;
        private WinHttpExchange activeControlExchange;
        private int nextSequence;
        private DateTime matchDeadlineUtc;

        public Action<string> OnText;
        public Action<byte[]> OnBinary;
        public Action<string> OnState;
        public Action OnClosed;
        public uint PeerId { get; private set; }
        public string RoomId { get; private set; }
        internal bool OutboundIdle
        {
            get { lock (sendLock) return sendQueue.Count == 0 && !sendWorkerActive; }
        }

        public RelayClient(LocalSettings settings, string settingsPath)
        {
            // TLS version negotiation and certificate validation live in the OS
            // Schannel through WinHTTP; there is no Mono ServicePointManager to
            // configure any more.
            this.settings = settings;
            this.settingsPath = settingsPath;
        }

        internal void SetMatchDeadline(DateTime deadlineUtc)
        {
            matchDeadlineUtc = deadlineUtc;
        }

        private Uri ServiceRoot()
        {
            Uri root = new Uri(settings.origin.TrimEnd('/') + "/");
            if ((root.Scheme != Uri.UriSchemeHttps && root.Scheme != Uri.UriSchemeHttp) || root.AbsolutePath != "/")
                throw new InvalidOperationException("The service origin must be an HTTP(S) hostname.");
            return root;
        }

        private static void EnsureSuccess(WinHttpResponse response)
        {
            int status = response.StatusCode;
            if (status < 200 || status >= 300)
                throw new InvalidOperationException("Service rejected request: HTTP " + status);
        }

        public bool RequiresIdentity()
        {
            Uri root = ServiceRoot();
            DateTime deadline = matchDeadlineUtc == default(DateTime)
                ? DateTime.UtcNow.AddSeconds(15) : matchDeadlineUtc;
            WinHttpExchange exchange = new WinHttpExchange();
            lock (requestLock) activeControlExchange = exchange;
            try
            {
                WinHttpResponse response = exchange.Run(new Uri(root, "api/v1/identity-mode"), "GET",
                    null, null, null, RemainingTimeout(deadline));
                EnsureSuccess(response);
                JObject mode = ReadJsonResponse(response);
                JToken required = mode["required"];
                if (required == null || required.Type != JTokenType.Boolean)
                    throw new InvalidOperationException("Service response lacks a valid identity mode.");
                return (bool)required;
            }
            finally
            {
                lock (requestLock)
                    if (System.Object.ReferenceEquals(activeControlExchange, exchange)) activeControlExchange = null;
                exchange.Dispose();
            }
        }

        // The .NET 3.5 baseline predates C# 4 optional parameters; callers pass roomId explicitly.
        public void Match(CurrentIdentity identity, JObject song, string gameVersion, bool identityRequired, string roomId)
        {
            if (song == null) throw new ArgumentNullException("song");
            if (identity == null) throw new ArgumentNullException("identity");
            // The service keeps rooms strictly isolated; entering another player's room
            // requires naming it. Leaving roomId null recruits into the caller's own room.
            if (!String.IsNullOrEmpty(roomId) && !Regex.IsMatch(roomId, "^[0-9a-fA-F-]{36}$"))
                throw new InvalidOperationException("The room id must be a UUID.");
            DateTime deadline = matchDeadlineUtc == default(DateTime)
                ? DateTime.UtcNow.AddSeconds(15) : matchDeadlineUtc;
            matchDeadlineUtc = deadline;
            string token = identityRequired ? Authenticate(identity, deadline) : null;
            JObject request = new JObject();
            request["protocolVersion"] = ProtocolVersion;
            request["pool"] = String.IsNullOrEmpty(settings.pool) ? null : settings.pool;
            request["roomId"] = String.IsNullOrEmpty(roomId) ? null : roomId.ToLowerInvariant();
            request["gameVersion"] = gameVersion;
            request["username"] = identity.username;
            request["cardId"] = identity.cardId;
            request["song"] = song.DeepClone();
            if (!identityRequired) request["anonymousKey"] = EnsureAnonymousKey();
            JObject match = Post("/api/v1/match", request, token, deadline);
            RoomId = RequireString(match, "roomId");
            PeerId = (uint)match.Value<int>("peerId");
            string path = RequireString(match, "wsPath");
            string ticket = RequireString(match, "ticket");
            if (!path.StartsWith("/room", StringComparison.Ordinal) ||
                path.Contains("?") || path.Contains("#"))
                throw new InvalidOperationException("Server returned an invalid room path.");
            Uri root = new Uri(settings.origin.TrimEnd('/') + "/");
            if ((root.Scheme != Uri.UriSchemeHttps && root.Scheme != Uri.UriSchemeHttp) ||
                !String.IsNullOrEmpty(root.AbsolutePath.Trim('/')))
                throw new InvalidOperationException("The service origin must be an HTTP(S) hostname.");
            string websocketScheme = root.Scheme == Uri.UriSchemeHttps ? "wss://" : "ws://";
            string websocketUrl = websocketScheme + root.Authority + path + "?ticket=" + Uri.EscapeDataString(ticket);
            State("Connecting to " + RoomId);
            WinHttpWebSocket session = ConnectRoomWithRetry(new Uri(websocketUrl), deadline);
            socket = session;
            State("Connected to " + RoomId);
        }

        private WinHttpWebSocket ConnectRoomWithRetry(Uri target, DateTime deadline)
        {
            Exception first = null;
            for (int attempt = 0; attempt < 2; attempt++)
            {
                WinHttpWebSocket session = new WinHttpWebSocket();
                session.OnText = delegate(string message)
                {
                    JObject control = JObject.Parse(message);
                    if (String.IsNullOrEmpty(control.Value<string>("type")))
                        throw new InvalidDataException("Relay control type is missing.");
                    if (OnText != null) OnText(message);
                };
                session.OnBinary = delegate(byte[] bytes) { if (OnBinary != null) OnBinary(bytes); };
                session.OnState = delegate(string message) { State(message); };
                session.OnClosed = NotifyClosedOnce;
                try
                {
                    session.Connect(target, RemainingTimeout(deadline));
                    return session;
                }
                catch (Exception error)
                {
                    session.Dispose();
                    if (attempt != 0) throw;
                    first = error;
                    State("Room WebSocket handshake failed; retrying once.");
                    int remaining = RemainingTimeout(deadline);
                    if (remaining <= RoomConnectRetryDelayMilliseconds) throw;
                    Thread.Sleep(RoomConnectRetryDelayMilliseconds);
                }
            }
            throw first ?? new InvalidOperationException("Room WebSocket handshake failed.");
        }

        // Identity-only startup check; does not create a room or display any UI.
        public string Authenticate(CurrentIdentity identity)
        {
            return Authenticate(identity, DateTime.UtcNow.AddSeconds(15));
        }

        private string Authenticate(CurrentIdentity identity, DateTime deadline)
        {
            identity.Validate();
            byte[] key = EnsureKey();
            if (String.IsNullOrEmpty(settings.identityId))
            {
                JObject initial = identity.ToWire();
                initial["clientKey"] = Convert.ToBase64String(key);
                JObject registered = Post("/api/v1/identity/register", initial, null, deadline);
                settings.identityId = RequireString(registered, "identityId");
                settings.Save(settingsPath);
            }
            JObject challengeRequest = new JObject();
            challengeRequest["identityId"] = settings.identityId;
            JObject challenge = Post("/api/v1/identity/challenge", challengeRequest, null, deadline);
            string challengeId = RequireString(challenge, "challengeId");
            string nonce = RequireString(challenge, "nonce");
            string toSign = "OngekiCollab/v1/session\n" + challengeId + "\n" + nonce;
            string proof;
            using (HMACSHA256 hmac = new HMACSHA256(key))
                proof = Convert.ToBase64String(hmac.ComputeHash(Encoding.UTF8.GetBytes(toSign)));
            JObject sessionRequest = new JObject();
            sessionRequest["identityId"] = settings.identityId;
            sessionRequest["challengeId"] = challengeId;
            sessionRequest["proof"] = proof;
            sessionRequest["identity"] = identity.ToWire();
            JObject session = Post("/api/v1/identity/session", sessionRequest, null, deadline);
            return RequireString(session, "token");
        }

        public void Ready(JObject song, int rttMs)
        {
            if (song == null) throw new ArgumentNullException("song");
            JObject payload = new JObject();
            payload["type"] = "ready";
            payload["song"] = song.DeepClone();
            payload["rttMs"] = rttMs;
            SendText(payload.ToString(Formatting.None));
        }

        public void Unready()
        {
            SendText("{\"type\":\"unready\"}");
        }

        public void RequestStart()
        {
            SendText("{\"type\":\"startRequest\"}");
        }

        public void PlayStarted()
        {
            SendText("{\"type\":\"playStarted\"}");
        }

        public void SendScore(int techScore, int battleScore, int bulletHitCount, string playStatus)
        {
            var payload = new Newtonsoft.Json.Linq.JObject();
            payload["type"] = "score";
            payload["techScore"] = techScore;
            payload["battleScore"] = battleScore;
            payload["bulletHitCount"] = bulletHitCount;
            if (!string.IsNullOrEmpty(playStatus)) payload["playStatus"] = playStatus;
            SendText(payload.ToString(Formatting.None));
        }

        public void EndPlay()
        {
            EndPlay("completed");
        }

        public void EndPlay(string reason)
        {
            if (String.IsNullOrEmpty(reason)) reason = "cancelled";
            JObject payload = new JObject();
            payload["type"] = "endPlay";
            payload["reason"] = reason;
            SendText(payload.ToString(Formatting.None));
        }

        public void Ping(long sentAt)
        {
            JObject payload = new JObject();
            payload["type"] = "ping";
            payload["sentAt"] = sentAt;
            SendText(payload.ToString(Formatting.None));
        }

        public JObject GetRooms(string pool, string cursor)
        {
            Uri root = ServiceRoot();
            string query = "api/v1/rooms?limit=50";
            if (!String.IsNullOrEmpty(pool)) query += "&pool=" + Uri.EscapeDataString(pool);
            if (!String.IsNullOrEmpty(cursor)) query += "&cursor=" + Uri.EscapeDataString(cursor);
            WinHttpExchange exchange = new WinHttpExchange();
            lock (requestLock) activeDirectoryExchange = exchange;
            try
            {
                WinHttpResponse response = exchange.Run(new Uri(root, query), "GET",
                    null, null, null, 10000);
                EnsureSuccess(response);
                if (response.Body.Length > MaximumDirectoryResponseBytes)
                    throw new InvalidDataException("Relay room directory is too large.");
                return ReadJsonResponse(response);
            }
            finally
            {
                lock (requestLock)
                    if (System.Object.ReferenceEquals(activeDirectoryExchange, exchange))
                        activeDirectoryExchange = null;
                exchange.Dispose();
            }
        }

        public void SendText(string value)
        {
            if (value == null) throw new ArgumentNullException("value");
            int bytes = Encoding.UTF8.GetByteCount(value);
            if (bytes > MaximumControlBytes)
                throw new InvalidOperationException("Relay control message exceeds 16384 UTF-8 bytes.");
            // The Unity client's 2 MiB transport budget counts binary payload bytes. Control
            // messages have their own 16 KiB limit and still count toward 512 frames.
            EnqueueSend(new PendingSend { Text = value, Size = 0 });
        }

        public void SendBinary(byte kind, uint target, uint streamId, byte[] payload)
        {
            if (payload == null) throw new ArgumentNullException("payload");
            if (payload.Length > 4096) throw new InvalidOperationException("Relay frame exceeds 4096 bytes.");
            byte[] frame = new byte[22 + payload.Length];
            frame[0] = 0x4f; frame[1] = 0x43;
            frame[2] = 1; frame[3] = kind;
            WriteU32(frame, 4, PeerId);
            WriteU32(frame, 8, target);
            WriteU32(frame, 12, streamId);
            WriteU32(frame, 16, unchecked((uint)System.Threading.Interlocked.Increment(ref nextSequence)));
            frame[20] = (byte)(payload.Length >> 8);
            frame[21] = (byte)payload.Length;
            Buffer.BlockCopy(payload, 0, frame, 22, payload.Length);
            EnqueueSend(new PendingSend { Binary = frame, Size = payload.Length });
        }

        internal static bool CanQueueSend(int currentFrames, int currentBytes, int nextBytes)
        {
            return currentFrames >= 0 && currentBytes >= 0 && nextBytes >= 0 &&
                currentFrames < MaximumQueuedFrames && nextBytes <= MaximumQueuedBytes &&
                currentBytes <= MaximumQueuedBytes - nextBytes;
        }

        private void EnqueueSend(PendingSend pending)
        {
            bool startWorker = false;
            bool overflow = false;
            lock (sendLock)
            {
                if (socket == null || !socket.IsOpen || sendFailed)
                    throw new InvalidOperationException("Room WebSocket is not open.");
                if (!CanQueueSend(sendQueue.Count, queuedBytes, pending.Size))
                {
                    FailSendLocked();
                    overflow = true;
                }
                else
                {
                    sendQueue.Enqueue(pending);
                    queuedBytes += pending.Size;
                    if (!sendWorkerActive) { sendWorkerActive = true; startWorker = true; }
                }
            }
            if (overflow)
            {
                CloseFailedSocket();
                NotifyClosedOnce();
                throw new InvalidOperationException("Relay send queue capacity was exceeded.");
            }
            if (startWorker) ThreadPool.QueueUserWorkItem(delegate { DrainSendQueue(); });
        }

        private void DrainSendQueue()
        {
            while (true)
            {
                PendingSend pending;
                WinHttpWebSocket current;
                lock (sendLock)
                {
                    if (sendQueue.Count == 0) { sendWorkerActive = false; return; }
                    // Keep the in-flight item accounted against both limits until its
                    // synchronous WebSocket send has actually completed.
                    pending = sendQueue.Peek();
                    current = socket;
                    if (current == null || !current.IsOpen || sendFailed)
                    { FailSendLocked(); return; }
                }
                try
                {
                    if (pending.Text != null) current.SendText(pending.Text);
                    else current.SendBinary(pending.Binary);
                    lock (sendLock)
                    {
                        if (sendFailed) return;
                        if (sendQueue.Count == 0 || !System.Object.ReferenceEquals(sendQueue.Peek(), pending))
                        { FailSendLocked(); return; }
                        sendQueue.Dequeue();
                        queuedBytes -= pending.Size;
                    }
                }
                catch
                {
                    lock (sendLock) FailSendLocked();
                    CloseFailedSocket();
                    NotifyClosedOnce();
                    return;
                }
            }
        }

        private void FailSendLocked()
        {
            sendFailed = true;
            sendQueue.Clear();
            queuedBytes = 0;
            sendWorkerActive = false;
        }

        private void NotifyClosedOnce()
        {
            if (Interlocked.Exchange(ref closeNotified, 1) == 0 && OnClosed != null) OnClosed();
        }

        private void CloseFailedSocket()
        {
            WinHttpWebSocket failed;
            lock (sendLock) { failed = socket; socket = null; }
            if (failed != null)
            {
                try { failed.SendClose("Send failure"); }
                catch { }
            }
        }

        public static bool TryReadFrame(byte[] frame, out byte kind, out uint sender,
            out uint target, out uint streamId, out byte[] payload)
        {
            kind = 0; sender = target = streamId = 0; payload = null;
            if (frame == null || frame.Length < 22 || frame[0] != 0x4f || frame[1] != 0x43 || frame[2] != 1)
                return false;
            int length = (frame[20] << 8) | frame[21];
            if (length > 4096 || frame.Length != length + 22) return false;
            kind = frame[3]; sender = ReadU32(frame, 4); target = ReadU32(frame, 8);
            streamId = ReadU32(frame, 12);
            payload = new byte[length];
            Buffer.BlockCopy(frame, 22, payload, 0, length);
            return true;
        }

        private byte[] EnsureKey()
        {
            if (!String.IsNullOrEmpty(settings.clientKey))
            {
                byte[] existing = Convert.FromBase64String(settings.clientKey);
                if (existing.Length != 32) throw new InvalidOperationException("Saved client key is invalid.");
                return existing;
            }
            if (!String.IsNullOrEmpty(settings.identityId))
                throw new InvalidOperationException("Client key is missing; ask an administrator to reset the binding.");
            byte[] key = new byte[32];
            RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider();
            rng.GetBytes(key);
            settings.clientKey = Convert.ToBase64String(key);
            settings.Save(settingsPath);
            return key;
        }

        private string EnsureAnonymousKey()
        {
            if (!String.IsNullOrEmpty(settings.anonymousKey))
            {
                byte[] existing;
                try { existing = Convert.FromBase64String(settings.anonymousKey); }
                catch (FormatException) { throw new InvalidOperationException("Saved anonymous key is invalid."); }
                if (existing.Length != 32) throw new InvalidOperationException("Saved anonymous key is invalid.");
                return settings.anonymousKey;
            }
            byte[] key = new byte[32];
            // Old Mono RandomNumberGenerator is not IDisposable; the RNG needs no deterministic release.
            RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider();
            rng.GetBytes(key);
            settings.anonymousKey = Convert.ToBase64String(key);
            try { settings.Save(settingsPath); }
            catch { settings.anonymousKey = ""; throw; }
            return settings.anonymousKey;
        }

        private JObject Post(string path, JObject body, string bearer)
        {
            return Post(path, body, bearer, DateTime.UtcNow.AddSeconds(15));
        }

        private JObject Post(string path, JObject body, string bearer, DateTime deadline)
        {
            Uri root = ServiceRoot();
            byte[] content = Encoding.UTF8.GetBytes(body.ToString(Formatting.None));
            WinHttpExchange exchange = new WinHttpExchange();
            lock (requestLock) activeControlExchange = exchange;
            try
            {
                WinHttpResponse response = exchange.Run(new Uri(root, path.TrimStart('/')), "POST",
                    "application/json", String.IsNullOrEmpty(bearer) ? null : bearer,
                    content, RemainingTimeout(deadline));
                try
                {
                    EnsureSuccess(response);
                }
                catch (InvalidOperationException)
                {
                    if (path == "/api/v1/identity/session" && response.StatusCode == 403 &&
                        response.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
                    {
                        string errorBody = Encoding.UTF8.GetString(response.Body);
                        if (IsIdentityFieldsChanged(errorBody))
                            throw new IdentityBindingChangedException();
                    }
                    if (response.StatusCode == 400 &&
                        response.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
                    {
                        // Surface only the service's own static validation strings
                        // ("Invalid level", "Selected difficulty missing"); anything
                        // else stays unlogged to preserve the redaction contract.
                        string reason = DescribeServerValidation(Encoding.UTF8.GetString(response.Body));
                        if (reason != null)
                            throw new InvalidOperationException(
                                "Service rejected request: HTTP 400 (" + reason + ")");
                    }
                    throw;
                }
                return ReadJsonResponse(response);
            }
            finally
            {
                lock (requestLock)
                    if (System.Object.ReferenceEquals(activeControlExchange, exchange)) activeControlExchange = null;
                exchange.Dispose();
            }
        }

        private static int RemainingTimeout(DateTime deadline)
        {
            long milliseconds = (long)(deadline - DateTime.UtcNow).TotalMilliseconds;
            if (milliseconds <= 0) throw new TimeoutException("Relay Match/WebSocket deadline expired.");
            return (int)Math.Min(15000L, Math.Max(1L, milliseconds));
        }

        internal static bool IsIdentityFieldsChanged(string errorBody)
        {
            if (String.IsNullOrEmpty(errorBody) || errorBody.Length > 1024) return false;
            try { return (string)JObject.Parse(errorBody)["error"] == "Identity fields changed"; }
            catch (JsonException) { return false; }
        }

        // Returns the service's validation reason only when the whole body is a
        // short {"error": <letters-and-punctuation>} document matching the
        // server's static failure() messages. Any other shape, control
        // characters or overlong text is treated as unloggable.
        internal static string DescribeServerValidation(string errorBody)
        {
            if (String.IsNullOrEmpty(errorBody) || errorBody.Length > 256) return null;
            try
            {
                string reason = (string)JObject.Parse(errorBody)["error"];
                if (String.IsNullOrEmpty(reason) || reason.Length > 80) return null;
                foreach (char c in reason)
                {
                    bool allowed = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                        (c >= '0' && c <= '9') || c == ' ' || c == ',' || c == '.' ||
                        c == ':' || c == '(' || c == ')' || c == '/' || c == '\'' || c == '-';
                    if (!allowed) return null;
                }
                return reason;
            }
            catch (JsonException) { return null; }
        }

        private static JObject ReadJsonResponse(WinHttpResponse response)
        {
            string contentType = response.ContentType ?? "";
            if (!contentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Relay response was not JSON; configure the final HTTPS origin.");
            return JObject.Parse(Encoding.UTF8.GetString(response.Body));
        }

        private static string RequireString(JObject data, string name)
        {
            string value = (string)data[name];
            if (String.IsNullOrEmpty(value)) throw new InvalidOperationException("Service response lacks " + name + ".");
            return value;
        }

        private void State(string message) { if (OnState != null) OnState(message); }
        private static void WriteU32(byte[] b, int i, uint v)
        { b[i] = (byte)(v >> 24); b[i + 1] = (byte)(v >> 16); b[i + 2] = (byte)(v >> 8); b[i + 3] = (byte)v; }
        private static uint ReadU32(byte[] b, int i)
        { return ((uint)b[i] << 24) | ((uint)b[i + 1] << 16) | ((uint)b[i + 2] << 8) | b[i + 3]; }

        public void Dispose()
        {
            lock (requestLock)
            {
                if (activeDirectoryExchange != null)
                {
                    try { activeDirectoryExchange.Cancel(); }
                    catch { }
                    activeDirectoryExchange = null;
                }
                if (activeControlExchange != null)
                {
                    try { activeControlExchange.Cancel(); }
                    catch { }
                    activeControlExchange = null;
                }
            }
            WinHttpWebSocket dying;
            lock (sendLock)
            {
                FailSendLocked();
                dying = socket;
                socket = null;
            }
            if (dying != null)
            {
                // Send the close frame first, then release the native handles;
                // the receive thread exits silently afterwards and must not
                // surface this teardown as a relay close event.
                try { dying.SendClose("Leaving room"); }
                catch { }
                try { dying.Dispose(); }
                catch { }
            }
        }
    }
}
