using System;
using System.IO;
using System.Reflection;

internal static class BepInExCompatibilityTest
{
    private static string gameDirectory;

    private static int Main(string[] args)
    {
        if (args.Length != 3)
        {
            Console.Error.WriteLine("Usage: BepInExCompatibilityTest game-directory mod-dll major");
            return 2;
        }

        gameDirectory = args[0];
        AppDomain.CurrentDomain.AssemblyResolve += ResolveAssembly;
        try
        {
            CheckAssembly(args[1], args[2]);
            Console.WriteLine("BepInEx " + args[2] + " compatibility checks passed.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static Assembly ResolveAssembly(object sender, ResolveEventArgs args)
    {
        string name = new AssemblyName(args.Name).Name + ".dll";
        string[] probes = {
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, name),
            Path.Combine(gameDirectory, "mu3_Data\\Managed\\" + name)
        };
        foreach (string probe in probes)
            if (File.Exists(probe)) return Assembly.LoadFrom(probe);
        return null;
    }

    private static void CheckAssembly(string path, string major)
    {
        Assembly mod = Assembly.LoadFrom(path);
        Type entry = mod.GetType("OngekiCollab.Mod.ModEntry", true);
        Check(entry.BaseType != null && entry.BaseType.FullName == "BepInEx.BaseUnityPlugin",
            "loader entry does not inherit BepInEx.BaseUnityPlugin");
        MethodInfo resolveSettingsPath = entry.GetMethod("ResolveSettingsPath",
            BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo resolveSettingsPathFromDataPath = entry.GetMethod("ResolveSettingsPathFromDataPath",
            BindingFlags.NonPublic | BindingFlags.Static);
        MethodInfo resolveSettingsPathFromExecutable = entry.GetMethod("ResolveSettingsPathFromExecutable",
            BindingFlags.NonPublic | BindingFlags.Static);
        Check(resolveSettingsPath != null && resolveSettingsPathFromDataPath != null &&
                resolveSettingsPathFromExecutable != null,
            "client.json path resolver is missing");
        string executableDirectory = Path.GetDirectoryName(
            System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName);
        Check((string)resolveSettingsPath.Invoke(null, null) ==
            Path.Combine(executableDirectory, "client.json"),
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

        string expectedBepVersion = major == "1" || major == "2" ? "1.0.0.0" :
            major == "3" ? "3.2.0.0" : major == "4" ? "4.1.2.0" : "5.4.23.2";
        string expectedHarmonyVersion = major == "1" || major == "2" ? "1.0.9.1" :
            major == "3" || major == "4" ? "1.1.0.0" : "2.9.0.0";
        bool foundBep = false;
        bool foundHarmony = false;
        foreach (AssemblyName reference in mod.GetReferencedAssemblies())
        {
            Check(reference.Name != "Newtonsoft.Json" && reference.Name != "WebSocketDotNet",
                "self-contained output still references an external JSON or WebSocket assembly");
            if (reference.Name == "BepInEx")
            {
                foundBep = true;
                Check(reference.Version.ToString() == expectedBepVersion,
                    "unexpected BepInEx reference " + reference.Version);
            }
            if (reference.Name == "0Harmony")
            {
                foundHarmony = true;
                Check(reference.Version.ToString() == expectedHarmonyVersion,
                    "unexpected Harmony reference " + reference.Version);
            }
        }
        Check(foundBep && foundHarmony, "loader or Harmony reference is missing");

        bool hasPluginAttribute = false;
        foreach (CustomAttributeData attribute in CustomAttributeData.GetCustomAttributes(entry))
            if (attribute.Constructor.DeclaringType.FullName == "BepInEx.BepInPlugin") hasPluginAttribute = true;
        Check((major == "3" || major == "4" || major == "5") == hasPluginAttribute,
            "plugin metadata shape does not match this BepInEx generation");

        if (major == "1") CheckOverride(entry, "Name");
        if (major == "2")
        {
            CheckOverride(entry, "ID");
            CheckOverride(entry, "Name");
            CheckOverride(entry, "Version");
        }
        foreach (string lifecycle in new string[] { "Awake", "Update", "OnApplicationQuit", "OnDestroy" })
            Check(entry.GetMethod(lifecycle, BindingFlags.Instance | BindingFlags.NonPublic) != null,
                "missing lifecycle method " + lifecycle);

        Check(mod.GetType("Newtonsoft.Json.Linq.JObject", false) != null,
            "merged dependency types are missing");
        Check(Array.IndexOf(mod.GetManifestResourceNames(),
            "OngekiCollab.ThirdPartyNotices.txt") >= 0,
            "embedded third-party notices are missing");
        Check((major == "5") == (mod.GetType("OngekiCollab.Mod.LegacyHarmonyPatch", false) == null),
            "Harmony compatibility marker does not match this BepInEx generation");

        Type patch = mod.GetType("OngekiCollab.Mod.NativeTransport+OnlineConfigPatch", true);
        bool hasHarmonyMarker = false;
        foreach (CustomAttributeData attribute in CustomAttributeData.GetCustomAttributes(patch))
        {
            Type attributeType = attribute.Constructor.DeclaringType;
            while (attributeType != null)
            {
                if ((major == "5" && attributeType.FullName == "HarmonyLib.HarmonyPatch") ||
                    (major != "5" && attributeType.FullName == "Harmony.HarmonyAttribute"))
                    hasHarmonyMarker = true;
                attributeType = attributeType.BaseType;
            }
        }
        Check(hasHarmonyMarker, "patch metadata is not recognized by this Harmony generation");
    }

    private static void CheckOverride(Type entry, string propertyName)
    {
        PropertyInfo property = entry.GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
        Check(property != null && property.DeclaringType == entry && property.GetGetMethod().IsVirtual,
            "missing legacy metadata override " + propertyName);
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
