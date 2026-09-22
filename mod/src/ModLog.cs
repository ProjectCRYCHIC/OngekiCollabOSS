#if BEPINEX_V5
using BepInEx.Logging;
#elif !BEPINEX
using MelonLoader;
#endif

namespace OngekiCollab.Mod
{
    internal static class ModLog
    {
#if BEPINEX_V5
        private static ManualLogSource source;

        internal static void Initialize(ManualLogSource value)
        {
            source = value;
        }

        internal static void Msg(string message)
        {
            if (source != null) source.LogInfo(message);
        }

        internal static void Warning(string message)
        {
            if (source != null) source.LogWarning(message);
        }
#elif BEPINEX_V4
        internal static void Msg(string message)
        {
            BepInEx.Logger.Log(BepInEx.Logging.LogLevel.Info, "[OngekiCollab] " + message);
        }

        internal static void Warning(string message)
        {
            BepInEx.Logger.Log(BepInEx.Logging.LogLevel.Warning, "[OngekiCollab] " + message);
        }
#elif BEPINEX_V2 || BEPINEX_V3
        internal static void Msg(string message)
        {
            BepInEx.BepInLogger.Log("[OngekiCollab] " + message, false);
        }

        internal static void Warning(string message)
        {
            BepInEx.BepInLogger.Log("[OngekiCollab] WARNING: " + message, false);
        }
#elif BEPINEX_V1
        internal static void Msg(string message)
        {
            UnityEngine.Debug.Log("[OngekiCollab] " + message);
        }

        internal static void Warning(string message)
        {
            UnityEngine.Debug.LogWarning("[OngekiCollab] " + message);
        }
#else
        internal static void Msg(string message)
        {
            MelonLogger.Msg(message);
        }

        internal static void Warning(string message)
        {
            MelonLogger.Warning(message);
        }
#endif
    }
}
