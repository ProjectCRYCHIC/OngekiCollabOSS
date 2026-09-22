#if HARMONY1
using System;

namespace OngekiCollab.Mod
{
    // Harmony 1.0 and 1.1 do not expose the convenient (Type, string)
    // attribute constructor used by Harmony 2. Keep patch declarations shared
    // while emitting a HarmonyAttribute-derived marker for legacy scans.
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = true)]
    internal sealed class LegacyHarmonyPatch : Harmony.HarmonyPatch
    {
        public LegacyHarmonyPatch() { }

#if HARMONY109
        public LegacyHarmonyPatch(Type type, string methodName)
            : base(type, methodName, null) { }

        public LegacyHarmonyPatch(Type type, string methodName, Type[] argumentTypes)
            : base(type, methodName, argumentTypes) { }
#else
        public LegacyHarmonyPatch(Type type, string methodName)
            : base(type, methodName, null, null) { }

        public LegacyHarmonyPatch(Type type, string methodName, Type[] argumentTypes)
            : base(type, methodName, argumentTypes, null) { }
#endif

        public LegacyHarmonyPatch(Type type, Type[] argumentTypes)
            : base(type, argumentTypes) { }
    }
}
#endif
