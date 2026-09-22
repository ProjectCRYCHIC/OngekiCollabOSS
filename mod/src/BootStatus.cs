using System;
using System.Diagnostics;
using System.Threading;
#if HARMONY1
using Harmony;
using HarmonyPatch = OngekiCollab.Mod.LegacyHarmonyPatch;
#else
using HarmonyLib;
#endif
using MU3.SceneObject;

namespace OngekiCollab.Mod
{
    // One HTTP round trip to the configured relay origin, measured on a worker
    // while the boot screen is still on the collab-setting row. The probe is
    // started on the row's first paint and sampled again on every repaint until
    // it completes, so the row can settle on a millisecond value.
    internal static class RelayProbe
    {
        private const int StateIdle = 0;
        private const int StateRunning = 1;
        private const int StateDone = 2;
        private static int state;
        private static long roundTripMilliseconds = -1;

        internal static void Sample()
        {
            if (Interlocked.CompareExchange(ref state, StateRunning, StateIdle) != StateIdle) return;
            ModEntry entry = ModEntry.Instance;
            LocalSettings settings = entry == null ? null : entry.Settings;
            if (settings == null || settings.origin.Length == 0)
            {
                Interlocked.Exchange(ref state, StateDone);
                return;
            }
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    Uri root = new Uri(settings.origin.TrimEnd('/') + "/");
                    if (root.Scheme != Uri.UriSchemeHttps && root.Scheme != Uri.UriSchemeHttp)
                        throw new InvalidOperationException("invalid origin");
                    WinHttpExchange exchange = new WinHttpExchange();
                    Stopwatch watch = Stopwatch.StartNew();
                    try
                    {
                        exchange.Run(new Uri(root, "api/v1/identity-mode"), "GET",
                            null, null, null, 5000);
                    }
                    finally { exchange.Dispose(); }
                    watch.Stop();
                    Interlocked.Exchange(ref roundTripMilliseconds, watch.ElapsedMilliseconds);
                }
                catch
                {
                    // An unreachable relay reports BAD; never log origin or error detail here.
                }
                finally { Interlocked.Exchange(ref state, StateDone); }
            });
        }

        internal static string DescribeStatus()
        {
            if (Thread.VolatileRead(ref state) != StateDone) return "CHECK";
            long milliseconds = Interlocked.Read(ref roundTripMilliseconds);
            return milliseconds >= 0 ? milliseconds.ToString() + "ms" : "BAD";
        }
    }

    // The boot screen's collab-setting row describes the stock LAN standard-
    // machine probe (port 50001), which reads as local multiplayer activity
    // while the mod owns matching. Relabel the row as the relay connection and
    // replace the GOOD/CHECK verdict with the measured HTTP round trip.
    [HarmonyPatch(typeof(Scene_12_Initialize), "setCollabSettingStatus")]
    internal static class BootRelayStatusPatch
    {
        private static void Prefix(ref string label, ref string status)
        {
            if (!NativeTransport.Enabled || ModEntry.Instance == null) return;
            RelayProbe.Sample();
            label = "OngekiCollab RELAY";
            status = RelayProbe.DescribeStatus();
        }
    }
}
