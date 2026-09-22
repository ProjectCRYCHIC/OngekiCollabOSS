using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using AMDaemon;
using MU3;
using MU3.Data;
using MU3.DataStudio;
using MU3.Operation;
using MU3.Sys;
using MU3.User;
using MU3.Util;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace OngekiCollab.Mod
{
    // A chart path is captured only from the game's official catalog. Keep this
    // distinct from FileNotFoundException raised by the loader or a dependency so
    // startup diagnostics cannot falsely accuse a missing chart.
    internal sealed class OfficialChartMissingException : Exception
    {
        internal OfficialChartMissingException(string message) : base(message) { }
        internal OfficialChartMissingException(string message, Exception inner) : base(message, inner) { }
    }

    internal static class GameSnapshot
    {
        internal sealed class SongSnapshot
        {
            public int Id;
            public string Title;
            public string Artist;
            public string Genre;
            public string Version;
            public int SelectedDifficulty;
            public double Level;
            public double Bpm;
            public string Designer;
            public readonly List<int> Difficulties = new List<int>();
            public readonly List<string> ChartPaths = new List<string>();
        }

        // The relay stores the game's ALLS application version. Unity's
        // bundleVersion is empty on arcade builds, while AMDaemon's AppImage
        // version backs the game's own versionNo and its string parser can
        // only fall back to 1.0.0, never throw.
        public static string ReadGameVersion()
        {
            try
            {
                string version = AppImage.CurrentVersion.ToString();
                if (!System.String.IsNullOrEmpty(version)) return version;
            }
            catch { }
            string unity = Application.version;
            return System.String.IsNullOrEmpty(unity) ? "unknown" : unity;
        }

        public static CurrentIdentity ReadPlayerName()
        {
            UserManager user = Singleton<UserManager>.instance;
            if (user == null) throw new InvalidOperationException("Game player is unavailable.");
            CurrentIdentity identity = new CurrentIdentity { username = string.IsNullOrEmpty(user.UserName) ? "Player" : user.UserName };
            ReadDisplayProfile(user, identity);
            return identity;
        }

        public static CurrentIdentity ReadIdentity()
        {
            UserManager user = Singleton<UserManager>.instance;
            MU3.Sys.System system = Singleton<MU3.Sys.System>.instance;
            CurrentIdentity identity = new CurrentIdentity();
            identity.keychipid = AMDaemon.System.KeychipId.Value;
            identity.accessCode = user.AccessCodeByReader;
            identity.userId = user.UserId.ToString(CultureInfo.InvariantCulture);
            identity.server = system.config.serverUri;
            if (System.String.IsNullOrEmpty(identity.server))
                identity.server = Singleton<OperationManager>.instance.getBaseUri();
            identity.username = user.UserName;
            ReadDisplayProfile(user, identity);
            identity.Validate();
            return identity;
        }

        private static void ReadDisplayProfile(UserManager user, CurrentIdentity identity)
        {
            if (user == null || identity == null || user.userDetail == null) return;
            // The relay contract bounds cardId to 0..999999 (server parseMatch);
            // the title server can hand out larger ids, so clamp out-of-range
            // values to 0 the same way the in-game client does.
            int card = user.userDetail.CardID;
            identity.cardId = card >= 0 && card <= 999999 ? card : 0;
        }

        public static JObject ReadSelectedSong()
        {
            return HashSong(CaptureSelectedSong());
        }

        // Unity/DataManager objects are captured on the game thread. Only the immutable
        // paths and primitive metadata below may cross to a hashing worker.
        public static SongSnapshot CaptureSelectedSong()
        {
            UIMusicSelector selector = UnityEngine.Object.FindObjectOfType(typeof(UIMusicSelector)) as UIMusicSelector;
            if (selector == null || selector.selectedMusicSelectViewData == null ||
                selector.selectedMusicViewData == null || selector.selectedMusicViewData.data == null)
                throw new InvalidOperationException("Select an official song in the music selection screen first.");
            return CaptureSong(selector.selectedMusicViewData.data, selector.selectedMusicSelectViewData.difficulty);
        }

        public static JObject ReadSong(MU3.Data.MusicData music, FumenDifficulty selected)
        {
            return HashSong(CaptureSong(music, selected));
        }

        public static SongSnapshot CaptureSong(MU3.Data.MusicData music, FumenDifficulty selected)
        {
            if (music == null) throw new InvalidOperationException("Select an official song first.");
            if (music.id < 1 || music.id > 999999 || IsCustomSong(music.id))
                throw new InvalidOperationException("Only ordinary official songs can enter online matching.");
            int selectedIndex = (int)selected;
            if (music.fumenData == null || selectedIndex < 0 || selectedIndex >= music.fumenData.Length ||
                music.fumenData[selectedIndex] == null || !music.fumenData[selectedIndex].isExist)
                throw new InvalidOperationException("The selected difficulty has no official chart.");

            SongSnapshot snapshot = new SongSnapshot();
            snapshot.Id = music.id;
            snapshot.Title = music.name;
            snapshot.Artist = music.artistName;
            snapshot.Genre = music.genreName;
            snapshot.Version = !System.String.IsNullOrEmpty(music.versionTitle) ? music.versionTitle : music.version.ToString();
            snapshot.SelectedDifficulty = selectedIndex;
            snapshot.Level = music.fumenData[selectedIndex].fumenConst;
            snapshot.Bpm = music.fumenData[selectedIndex].bpm;
            snapshot.Designer = music.fumenData[selectedIndex].notesDesignerName;
            DataManager data = SingletonStateMachine<DataManager, DataManager.EState>.instance;
            for (int i = 0; i < music.fumenData.Length; i++)
            {
                MU3.Data.FumenData fumen = music.fumenData[i];
                if (fumen == null || !fumen.isExist) continue;
                string path = data.getOgkrPath(music.id, (FumenDifficulty)i);
                if (System.String.IsNullOrEmpty(path) || !File.Exists(path))
                    throw new OfficialChartMissingException("Official chart is missing for difficulty " + i + ".");
                snapshot.Difficulties.Add(i);
                snapshot.ChartPaths.Add(path);
            }
            if (snapshot.ChartPaths.Count == 0) throw new InvalidOperationException("This song has no readable official charts.");
            return snapshot;
        }

        public static JObject HashSong(SongSnapshot snapshot)
        {
            if (snapshot == null) throw new ArgumentNullException("snapshot");
            JArray charts = new JArray();
            for (int i = 0; i < snapshot.ChartPaths.Count; i++)
            {
                string digest = HashFile(snapshot.ChartPaths[i]);
                JObject chart = new JObject();
                chart["difficulty"] = snapshot.Difficulties[i];
                chart["sha256"] = digest;
                charts.Add(chart);
            }
            if (charts.Count == 0) throw new InvalidOperationException("This song has no readable official charts.");
            JObject result = new JObject();
            result["id"] = snapshot.Id;
            result["title"] = snapshot.Title;
            result["artist"] = snapshot.Artist;
            result["genre"] = snapshot.Genre;
            result["version"] = snapshot.Version;
            result["selectedDifficulty"] = snapshot.SelectedDifficulty;
            result["level"] = snapshot.Level;
            result["bpm"] = snapshot.Bpm;
            result["designer"] = snapshot.Designer;
            result["charts"] = charts;
            return result;
        }

        internal static string HashFile(string path)
        {
            if (System.String.IsNullOrEmpty(path))
                throw new InvalidOperationException("Official chart path is invalid.");
            try
            {
                using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (SHA256 sha = SHA256.Create())
                    return BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
            }
            catch (FileNotFoundException error)
            {
                throw new OfficialChartMissingException("Official chart disappeared before it could be hashed.", error);
            }
            catch (DirectoryNotFoundException error)
            {
                throw new OfficialChartMissingException("Official chart directory disappeared before it could be hashed.", error);
            }
        }

        private static bool IsCustomSong(int musicId)
        {
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = assembly.GetTypes(); }
                catch (ReflectionTypeLoadException error) { types = error.Types; }
                catch { continue; }
                foreach (Type type in types)
                {
                    if (type == null || !type.IsClass) continue;
                    MethodInfo probe = type.GetMethod("IsCustomSong", BindingFlags.Public | BindingFlags.Static,
                        null, new Type[] { typeof(int) }, null);
                    if (probe == null || probe.ReturnType != typeof(bool) ||
                        type.GetMethod("GetSongIdAt", BindingFlags.Public | BindingFlags.Static,
                            null, new Type[] { typeof(int) }, null) == null ||
                        type.GetProperty("Count", BindingFlags.Public | BindingFlags.Static) == null) continue;
                    try { if ((bool)probe.Invoke(null, new object[] { musicId })) return true; }
                    catch { throw new InvalidOperationException("The custom-song catalog could not be checked."); }
                }
            }
            return false;
        }
    }
}
