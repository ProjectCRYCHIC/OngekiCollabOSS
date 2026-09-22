using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace OngekiCollab.Mod
{
    // The relay transport speaks HTTP and WS/WSS through winhttp.dll instead of
    // the Unity 5.6 Mono networking stack. TLS is delegated to the operating
    // system Schannel, which carries current protocol and certificate support on
    // the Windows 10 cabinets this game runs on. All entry points are used in
    // synchronous mode; blocking calls are cancelled by closing their handle,
    // which makes the in-flight call fail with a WinHTTP error immediately.
    internal static class WinHttpNative
    {
        private const int AccessTypeDefaultProxy = 0;
        internal const int FlagSecure = 0x00800000;
        // WinHttpOpenRequest has no "disable redirects" flag; that policy is a
        // DWORD option on the request handle instead.
        private const int OptionRedirectPolicy = 88;
        private const int OptionRedirectPolicyNever = 0;
        private const int OptionUpgradeToWebSocket = 114;
        internal const int QueryStatusCode = 19 | 0x20000000;
        internal const int QueryContentType = 1;
        private const int ErrorInsufficientBuffer = 122;

        internal const int BufferBinaryMessage = 0;
        internal const int BufferBinaryFragment = 1;
        internal const int BufferTextMessage = 2;
        internal const int BufferTextFragment = 3;
        internal const int BufferClose = 4;

        private const int ErrorWinHttpTimeout = 12002;
        private const int ErrorWinHttpNameNotResolved = 12007;
        private const int ErrorWinHttpOperationCancelled = 12017;
        private const int ErrorWinHttpCannotConnect = 12029;
        private const int ErrorWinHttpConnectionError = 12030;
        private const int ErrorWinHttpSecureFailure = 12175;

        private static IntPtr sharedSession;
        private static readonly object sessionLock = new object();

        // One process-wide session keeps the DNS and connection caches warm for
        // the directory polling and relay requests, matching the ServicePoint
        // pooling the Mono stack provided. Sessions are never closed; the OS
        // reclaims them at process exit.
        internal static IntPtr AcquireSession()
        {
            lock (sessionLock)
            {
                if (sharedSession == IntPtr.Zero)
                    sharedSession = WinHttpOpen("OngekiCollab", AccessTypeDefaultProxy, null, null, 0);
                if (sharedSession == IntPtr.Zero)
                    throw new InvalidOperationException("Unable to reach the service: " +
                        DescribeError(Marshal.GetLastWin32Error()));
                return sharedSession;
            }
        }

        internal static IntPtr OpenConnection(IntPtr session, Uri target)
        {
            int port = target.Port;
            if (port == -1) port = target.Scheme == "wss" ? 443 : 80;
            IntPtr connect = WinHttpConnect(session, target.Host, (ushort)port, 0);
            if (connect == IntPtr.Zero) throw Fail();
            return connect;
        }

        internal static IntPtr OpenRequest(IntPtr connect, Uri target, string method)
        {
            IntPtr request = WinHttpOpenRequest(connect, method, target.PathAndQuery, "HTTP/1.1",
                null, null, target.Scheme == Uri.UriSchemeHttps ? FlagSecure : 0);
            if (request == IntPtr.Zero) throw Fail();
            int never = OptionRedirectPolicyNever;
            if (!WinHttpSetOptionDword(request, OptionRedirectPolicy, ref never, 4))
            {
                WinHttpCloseHandle(request);
                throw Fail();
            }
            return request;
        }

        internal static void ApplyTimeouts(IntPtr request, int timeoutMs)
        {
            if (!WinHttpSetTimeouts(request, timeoutMs, timeoutMs, timeoutMs, timeoutMs)) throw Fail();
        }

        internal static void ApplyUpgrade(IntPtr request)
        {
            if (!WinHttpSetOption(request, OptionUpgradeToWebSocket, IntPtr.Zero, 0)) throw Fail();
        }

        internal static void AddHeaders(IntPtr request, string headers)
        {
            if (!WinHttpAddRequestHeaders(request, headers, -1, 0)) throw Fail();
        }

        internal static void SendAndReceive(IntPtr request, byte[] body)
        {
            int bodyLength = body == null ? 0 : body.Length;
            if (!WinHttpSendRequest(request, null, 0, body, bodyLength, bodyLength, IntPtr.Zero) ||
                !WinHttpReceiveResponse(request, IntPtr.Zero))
                throw Fail();
        }

        internal static int QueryHeaderNumber(IntPtr request, int infoLevel)
        {
            int value = 0;
            int length = 4;
            int index = 0;
            if (!WinHttpQueryHeadersNumber(request, infoLevel, null, ref value, ref length, ref index))
                throw Fail();
            return value;
        }

        internal static string QueryHeaderString(IntPtr request, int infoLevel)
        {
            int length = 0;
            int index = 0;
            if (!WinHttpQueryHeadersString(request, infoLevel, null, null, ref length, ref index))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != ErrorInsufficientBuffer) return "";
            }
            StringBuilder buffer = new StringBuilder(length > 0 ? length : 1);
            if (!WinHttpQueryHeadersString(request, infoLevel, null, buffer, ref length, ref index))
                return "";
            return buffer.ToString();
        }

        // Reads one complete response body.
        internal static byte[] ReadBody(IntPtr request)
        {
            using (MemoryStream output = new MemoryStream())
            {
                byte[] chunk = new byte[8192];
                while (true)
                {
                    int available;
                    if (!WinHttpQueryDataAvailable(request, out available)) throw Fail();
                    if (available == 0) break;
                    if (available > chunk.Length) available = chunk.Length;
                    int read;
                    if (!WinHttpReadData(request, chunk, available, out read)) throw Fail();
                    if (read <= 0) break;
                    output.Write(chunk, 0, read);
                }
                return output.ToArray();
            }
        }

        // Short redacted names in the style of the WebExceptionStatus strings the
        // Mono stack produced; never include host names, URLs or payload text.
        internal static string DescribeError(int error)
        {
            switch (error)
            {
                case ErrorWinHttpTimeout: return "Timeout";
                case ErrorWinHttpNameNotResolved: return "NameResolutionFailure";
                case ErrorWinHttpOperationCancelled: return "RequestCanceled";
                case ErrorWinHttpCannotConnect: return "ConnectFailure";
                case ErrorWinHttpConnectionError: return "ConnectionError";
                case ErrorWinHttpSecureFailure: return "SecureChannelFailure";
                default: return "NativeError" + error.ToString();
            }
        }

        private static Exception Fail()
        {
            return new InvalidOperationException("Unable to reach the service: " +
                DescribeError(Marshal.GetLastWin32Error()));
        }

        [DllImport("winhttp.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr WinHttpOpen(string agent, int accessType, string proxy,
            string proxyBypass, int flags);
        [DllImport("winhttp.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr WinHttpConnect(IntPtr session, string serverName,
            ushort serverPort, int reserved);
        [DllImport("winhttp.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr WinHttpOpenRequest(IntPtr connect, string verb,
            string objectName, string version, string referrer, string[] acceptTypes, int flags);
        [DllImport("winhttp.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool WinHttpAddRequestHeaders(IntPtr request, string headers,
            int headersLength, int modifiers);
        [DllImport("winhttp.dll", SetLastError = true)]
        private static extern bool WinHttpSendRequest(IntPtr request, string headers,
            int headersLength, byte[] optional, int optionalLength, int totalLength, IntPtr context);
        [DllImport("winhttp.dll", SetLastError = true)]
        private static extern bool WinHttpReceiveResponse(IntPtr request, IntPtr reserved);
        [DllImport("winhttp.dll", SetLastError = true)]
        private static extern bool WinHttpSetTimeouts(IntPtr handle, int resolveTimeout,
            int connectTimeout, int sendTimeout, int receiveTimeout);
        [DllImport("winhttp.dll", SetLastError = true)]
        private static extern bool WinHttpSetOption(IntPtr handle, int option, IntPtr buffer,
            int bufferLength);
        [DllImport("winhttp.dll", SetLastError = true, EntryPoint = "WinHttpSetOption")]
        private static extern bool WinHttpSetOptionDword(IntPtr handle, int option,
            ref int buffer, int bufferLength);
        [DllImport("winhttp.dll", SetLastError = true)]
        internal static extern bool WinHttpCloseHandle(IntPtr handle);

        [DllImport("winhttp.dll", SetLastError = true, EntryPoint = "WinHttpQueryHeaders")]
        private static extern bool WinHttpQueryHeadersNumber(IntPtr request, int infoLevel,
            string name, ref int buffer, ref int bufferLength, ref int index);
        [DllImport("winhttp.dll", CharSet = CharSet.Unicode, SetLastError = true,
            EntryPoint = "WinHttpQueryHeaders")]
        private static extern bool WinHttpQueryHeadersString(IntPtr request, int infoLevel,
            string name, StringBuilder buffer, ref int bufferLength, ref int index);
        [DllImport("winhttp.dll", SetLastError = true)]
        private static extern bool WinHttpQueryDataAvailable(IntPtr request, out int bytesAvailable);
        [DllImport("winhttp.dll", SetLastError = true)]
        private static extern bool WinHttpReadData(IntPtr request, byte[] buffer,
            int bytesToRead, out int bytesRead);

        [DllImport("winhttp.dll", SetLastError = true)]
        internal static extern IntPtr WinHttpWebSocketCompleteUpgrade(IntPtr request, IntPtr context);
        [DllImport("winhttp.dll", SetLastError = true)]
        internal static extern int WinHttpWebSocketSend(IntPtr socket, int bufferType,
            byte[] buffer, int bufferLength);
        [DllImport("winhttp.dll", SetLastError = true)]
        internal static extern int WinHttpWebSocketReceive(IntPtr socket, byte[] buffer,
            int bufferLength, out int bytesRead, out int bufferType);
        [DllImport("winhttp.dll", SetLastError = true)]
        internal static extern int WinHttpWebSocketShutdown(IntPtr socket, ushort status,
            byte[] reason, int reasonLength);
        [DllImport("winhttp.dll", SetLastError = true)]
        internal static extern int WinHttpWebSocketQueryCloseStatus(IntPtr socket,
            out ushort status, byte[] reason, int reasonLength, out int reasonLengthConsumed);
    }

    internal sealed class WinHttpResponse
    {
        public readonly int StatusCode;
        public readonly string ContentType;
        public readonly byte[] Body;

        internal WinHttpResponse(int statusCode, string contentType, byte[] body)
        {
            StatusCode = statusCode;
            ContentType = contentType ?? "";
            Body = body ?? new byte[0];
        }
    }

    // One synchronous HTTP exchange. Single use: create, register with the
    // relay client while in flight, Run once, then dispose.
    internal sealed class WinHttpExchange : IDisposable
    {
        private IntPtr request;
        private readonly object requestLock = new object();

        public WinHttpResponse Run(Uri target, string method, string contentType,
            string bearer, byte[] body, int timeoutMs)
        {
            IntPtr session = WinHttpNative.AcquireSession();
            IntPtr connect = WinHttpNative.OpenConnection(session, target);
            try
            {
                IntPtr current = WinHttpNative.OpenRequest(connect, target, method);
                lock (requestLock) request = current;
                try
                {
                    WinHttpNative.ApplyTimeouts(current, timeoutMs);
                    StringBuilder headers = new StringBuilder();
                    if (!String.IsNullOrEmpty(bearer))
                        headers.Append("Authorization: Bearer ").Append(bearer).Append("\r\n");
                    if (!String.IsNullOrEmpty(contentType))
                        headers.Append("Content-Type: ").Append(contentType).Append("\r\n");
                    if (headers.Length > 0) WinHttpNative.AddHeaders(current, headers.ToString());
                    WinHttpNative.SendAndReceive(current, body);
                    int status = WinHttpNative.QueryHeaderNumber(current, WinHttpNative.QueryStatusCode);
                    string responseType = WinHttpNative.QueryHeaderString(current, WinHttpNative.QueryContentType);
                    byte[] responseBody = WinHttpNative.ReadBody(current);
                    return new WinHttpResponse(status, responseType, responseBody);
                }
                finally
                {
                    // Closing the request also unblocks any in-flight call on a
                    // concurrent Cancel, so both paths converge on this close.
                    lock (requestLock)
                    {
                        if (request != IntPtr.Zero) WinHttpNative.WinHttpCloseHandle(request);
                        request = IntPtr.Zero;
                    }
                }
            }
            finally { WinHttpNative.WinHttpCloseHandle(connect); }
        }

        // Unblocks an in-flight Run the same way HttpWebRequest.Abort did: the
        // blocked call fails and Run throws.
        public void Cancel()
        {
            lock (requestLock)
            {
                if (request != IntPtr.Zero)
                {
                    WinHttpNative.WinHttpCloseHandle(request);
                    request = IntPtr.Zero;
                }
            }
        }

        public void Dispose() { Cancel(); }
    }

    // One ws:// or wss:// room connection with a blocking receive thread. WinHTTP
    // generates the WebSocket upgrade headers itself once the upgrade option is
    // set, and validates the handshake before CompleteUpgrade hands over the
    // session handle.
    internal sealed class WinHttpWebSocket : IDisposable
    {
        public Action<string> OnText;
        public Action<byte[]> OnBinary;
        public Action<string> OnState;
        public Action OnClosed;

        private IntPtr connect;
        private IntPtr request;
        private IntPtr socket;
        private readonly object lifecycleLock = new object();
        private volatile bool open;
        private volatile bool disposed;
        private const int MaximumControlBytes = 16384;
        private const int MaximumBinaryBytes = 22 + 4096;
        private const int CloseNormal = 1000;
        private const int CloseAbnormal = 1006;
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        public bool IsOpen { get { return open; } }

        public void Connect(Uri target, int timeoutMs)
        {
            IntPtr session = WinHttpNative.AcquireSession();
            IntPtr newConnect = WinHttpNative.OpenConnection(session, target);
            try
            {
                IntPtr newRequest = WinHttpNative.OpenRequest(newConnect, target, "GET");
                try
                {
                    WinHttpNative.ApplyTimeouts(newRequest, timeoutMs);
                    WinHttpNative.ApplyUpgrade(newRequest);
                    WinHttpNative.SendAndReceive(newRequest, null);
                    int status = WinHttpNative.QueryHeaderNumber(newRequest, WinHttpNative.QueryStatusCode);
                    if (status != 101)
                        throw new InvalidOperationException("Service rejected request: HTTP " + status);
                    IntPtr newSocket = WinHttpNative.WinHttpWebSocketCompleteUpgrade(newRequest, IntPtr.Zero);
                    if (newSocket == IntPtr.Zero) throw Fail();
                    connect = newConnect;
                    request = newRequest;
                    lock (lifecycleLock) socket = newSocket;
                    open = true;
                    Thread receiver = new Thread(ReceiveLoop);
                    receiver.IsBackground = true;
                    receiver.Start();
                }
                catch
                {
                    WinHttpNative.WinHttpCloseHandle(newRequest);
                    throw;
                }
            }
            catch
            {
                WinHttpNative.WinHttpCloseHandle(newConnect);
                throw;
            }
        }

        public void SendText(string value)
        {
            if (value == null) throw new ArgumentNullException("value");
            SendFrame(WinHttpNative.BufferTextMessage, Encoding.UTF8.GetBytes(value));
        }

        public void SendBinary(byte[] value)
        {
            if (value == null) throw new ArgumentNullException("value");
            SendFrame(WinHttpNative.BufferBinaryMessage, value);
        }

        // Sends a close frame without waiting for the peer's reply; the receive
        // thread delivers the reply through OnClosed exactly once.
        public void SendClose(string reason)
        {
            IntPtr current = TakeSocket();
            if (current == IntPtr.Zero) return;
            open = false;
            byte[] encoded = reason == null ? null : Encoding.UTF8.GetBytes(reason);
            if (encoded != null && encoded.Length > 123) encoded = null;
            WinHttpNative.WinHttpWebSocketShutdown(current, CloseNormal, encoded,
                encoded == null ? 0 : encoded.Length);
        }

        private void SendFrame(int bufferType, byte[] payload)
        {
            IntPtr current = TakeSocket();
            if (!open || current == IntPtr.Zero)
                throw new InvalidOperationException("Room WebSocket is not open.");
            int error = WinHttpNative.WinHttpWebSocketSend(current, bufferType, payload, payload.Length);
            if (error != 0)
            {
                open = false;
                throw Fail(error);
            }
        }

        private IntPtr TakeSocket()
        {
            lock (lifecycleLock) return socket;
        }

        private void ReceiveLoop()
        {
            byte[] buffer = new byte[16384];
            MemoryStream aggregate = new MemoryStream();
            int fragmentType = -1;
            try
            {
                while (true)
                {
                    IntPtr current = TakeSocket();
                    if (current == IntPtr.Zero) return;
                    int bytesRead;
                    int bufferType;
                    int error = WinHttpNative.WinHttpWebSocketReceive(current, buffer, buffer.Length,
                        out bytesRead, out bufferType);
                    if (error != 0) { ClosedUnexpectedly(); return; }
                    if (bufferType == WinHttpNative.BufferClose) { ClosedNormally(current); return; }
                    int partKind;
                    bool complete;
                    if (bufferType == WinHttpNative.BufferBinaryMessage)
                    { partKind = 0; complete = true; }
                    else if (bufferType == WinHttpNative.BufferBinaryFragment)
                    { partKind = 0; complete = false; }
                    else if (bufferType == WinHttpNative.BufferTextMessage)
                    { partKind = 1; complete = true; }
                    else if (bufferType == WinHttpNative.BufferTextFragment)
                    { partKind = 1; complete = false; }
                    else { ClosedUnexpectedly(); return; }
                    if (fragmentType < 0) fragmentType = partKind;
                    else if (fragmentType != partKind) { ClosedUnexpectedly(); return; }
                    int limit = fragmentType == 0 ? MaximumBinaryBytes : MaximumControlBytes;
                    if (bytesRead < 0 || aggregate.Length > limit - bytesRead)
                    { ClosedUnexpectedly(); return; }
                    if (bytesRead > 0) aggregate.Write(buffer, 0, bytesRead);
                    if (complete)
                    {
                        byte[] message = aggregate.ToArray();
                        aggregate.SetLength(0);
                        int completedKind = fragmentType;
                        fragmentType = -1;
                        if (completedKind == 1)
                        {
                            Action<string> handler = OnText;
                            if (handler != null) handler(StrictUtf8.GetString(message));
                        }
                        else
                        {
                            Action<byte[]> handler = OnBinary;
                            if (handler != null) handler(message);
                        }
                    }
                }
            }
            catch { ClosedUnexpectedly(); }
        }

        private void ClosedNormally(IntPtr current)
        {
            open = false;
            ushort code = CloseAbnormal;
            byte[] reason = new byte[123];
            int consumed;
            ushort reported;
            if (WinHttpNative.WinHttpWebSocketQueryCloseStatus(current, out reported, reason,
                reason.Length, out consumed) == 0)
                code = reported;
            State("Disconnected: " + code);
            NotifyClosed();
        }

        private void ClosedUnexpectedly()
        {
            open = false;
            // A dispose-initiated cancellation must not surface as a relay close;
            // Dispose deliberately terminates the session without events.
            if (disposed) return;
            State("Disconnected: " + CloseAbnormal);
            NotifyClosed();
        }

        private void State(string message)
        {
            Action<string> handler = OnState;
            if (handler != null) { try { handler(message); } catch { } }
        }

        private void NotifyClosed()
        {
            Action handler = OnClosed;
            if (handler != null) { try { handler(); } catch { } }
        }

        public void Dispose()
        {
            disposed = true;
            open = false;
            lock (lifecycleLock)
            {
                if (socket != IntPtr.Zero)
                {
                    WinHttpNative.WinHttpCloseHandle(socket);
                    socket = IntPtr.Zero;
                }
            }
            // The socket handle must be closed before its ancestors; closing a
            // parent handle would have invalidated the live child first.
            if (request != IntPtr.Zero) { WinHttpNative.WinHttpCloseHandle(request); request = IntPtr.Zero; }
            if (connect != IntPtr.Zero) { WinHttpNative.WinHttpCloseHandle(connect); connect = IntPtr.Zero; }
        }

        private static Exception Fail()
        {
            return new InvalidOperationException("Unable to reach the service: " +
                WinHttpNative.DescribeError(Marshal.GetLastWin32Error()));
        }

        private static Exception Fail(int error)
        {
            return new InvalidOperationException("Unable to reach the service: " +
                WinHttpNative.DescribeError(error));
        }
    }
}
