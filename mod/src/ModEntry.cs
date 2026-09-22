using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
#if BEPINEX
using BepInEx;
#else
using MelonLoader;
#endif
using MU3.Collab;
using MU3.Data;
using MU3.DataStudio;
using MU3.SceneObject;
using MU3.User;
using MU3.Util;
using Newtonsoft.Json.Linq;
using UnityEngine;

#if !BEPINEX
[assembly: MelonInfo(typeof(OngekiCollab.Mod.ModEntry), "OngekiCollab", "0.1.2", "ProjectCRYCHIC", "")]
[assembly: MelonGame(null, null)]
#endif

namespace OngekiCollab.Mod
{
#if BEPINEX
#if BEPINEX_V3 || BEPINEX_V4 || BEPINEX_V5
    [BepInPlugin("jp.anontokyo.ongekicollab", "OngekiCollab", "0.1.2")]
#endif
    public sealed class ModEntry : BaseUnityPlugin
#else
    public sealed class ModEntry : MelonMod
#endif
    {
        internal static ModEntry Instance;

#if BEPINEX_V1
        public override string Name { get { return "OngekiCollab"; } }
#elif BEPINEX_V2
        public override string ID { get { return "jp.anontokyo.ongekicollab"; } }
        public override string Name { get { return "OngekiCollab"; } }
        public override System.Version Version { get { return new System.Version(0, 1, 2); } }
#endif

        private const int MaximumMainThreadEvents = 512;
        private readonly Queue<Action> mainThreadEvents = new Queue<Action>();
        private LocalSettings settings;
        // Read-only view for in-process patches (boot relay probe); never persisted or logged.
        internal LocalSettings Settings { get { return settings; } }
        private RelayClient relay;
        private string settingsPath;
        private JObject matchedSong;
        private LocalMatchingCtrl nativeController;
        private string roomStatus = "";
        private DateTime nativePartyStartDeadline;
        private DateTime nativeJoinDeadline;
        private DateTime nextNativeMemberRefresh;
        private DateTime nativeBattleStartDeadline;
        private DateTime relayHandshakeDeadline;
        private int rttMs;
        private uint hostPeerId;
        private bool activeOnlineMode;
        private bool nativePartyStartPending;
        private bool nativeJoinPending;
        private Party.UserInfo nativePartyUserInfo;
        private uint nativeMemberPacketBaseline;
        private int nativeMemberRefreshAttempts;
        private bool nativeRoomJoined;
        private bool nativeBattleStartPending;
        private bool nativeBattleStartIssued;
        private bool nativeBattleStartAborted;
        private int nativeStartReadFailures;
        private bool nativeWasPlaying;
        private bool nativeStopPending;
        private bool readyPending;
        private bool readyRequested;
        // After a normal end (playEnded) the host may close the room at any moment;
        // that disconnect is expected and must not be reported as a failure.
        private bool playEndedQuietly;
        private bool cancelNativeAfterQuietLeave;
        private DateTime nextScoreReport;
        private DateTime nextScoreRefresh;
        private int lastTechScore = -1;
        private int lastBattleScore = -1;
        private int lastBulletHitCount = -1;
        private string lastPlayStatus;
        private bool hasLocalPlayScore;
        private int localTechScore;
        private int localBattleScore;
        private int localBulletHitCount;
        private int localPlayStatus;
        private sealed class RemotePlayScore
        {
            public int TechScore;
            public int BattleScore;
            public int BulletHitCount;
            public int PlayStatus;
            public bool HasTechScore;
            public bool HasBattleScore;
            public bool HasBulletHitCount;
            public bool HasPlayStatus;
        }
        private readonly Dictionary<uint, RemotePlayScore> remotePlayScores =
            new Dictionary<uint, RemotePlayScore>();
        private sealed class RemotePlayerProfile
        {
            public string PlayerName;
            public int CardId;
        }
        private readonly Dictionary<uint, RemotePlayerProfile> remotePlayerProfiles =
            new Dictionary<uint, RemotePlayerProfile>();
        // Relay ready retries: a lost ready must not drop the chart revalidation.
        // Start timing itself belongs to the native Party state machine; the relay
        // only receives passive playStarted/endPlay notifications from the host.
        private DateTime nextReadyRetry;
        private bool readyAcknowledged;
        private bool readyHashInFlight;
        private int readyHashEpoch;
        private int sessionEpoch;
        // Match captures an initial difficulty, but the native room lets each cabinet
        // change it before Ready. Keep the latest Party UserInfo selection separate and
        // reject worker completions from older selections.
        private int readyMusicId = -1;
        private int readyDifficulty = -1;
        private int readySelectionRevision;

        private sealed class DirectoryCandidate
        {
            public string RoomId;
            public GameSnapshot.SongSnapshot Song;
        }
        private readonly RelayDirectory recruitDirectory = new RelayDirectory();
        private RelayClient directoryRelay;
        private volatile bool directoryBusy;
        private volatile int directoryEpoch;
        private DateTime nextDirectoryPoll;
        private bool nativeDirectoryJoin;
        private DateTime playEndedAt;

        private sealed class PeerChart
        {
            public int SongId;
            public int Difficulty;
            public string Sha256;
        }
        private volatile bool busy;
        private volatile bool eventOverflow;
        private readonly object identityGate = new object();
        private bool startupIdentityAttempted;
        private bool startupIdentityRequired;
        // Chart equality is judged between clients: the relay echoes every ready
        // player's songId and selected-difficulty sha256 in snapshot/readyState, and
        // this client compares them against its own ready report.
        private JObject readySong;
        private bool chartConflict;
        private bool chartAbortPending;
        private string chartAbortMessage;
        private bool relayLeavePending;
        private DateTime relayLeaveDeadline;
        private bool relayLeaveStopNative;
        private bool relayLeaveRollbackUi;
        private bool relayLeavePreserveAbort;
        private bool shutdown;
        private readonly Dictionary<uint, PeerChart> peerCharts = new Dictionary<uint, PeerChart>();

        internal bool NativeMatchPending { get { return nativeController != null || busy; } }
        internal bool HasJoinedNativeRoom { get { return nativeRoomJoined && NativeTransport.Connected; } }
        internal bool PollNativeStartIssued { get { return nativeBattleStartIssued; } }
        internal bool PollNativeStartAborted { get { return nativeBattleStartAborted; } }
        internal bool NativeDirectoryJoinPending
        {
            get { return nativeDirectoryJoin && nativeController != null && !nativeRoomJoined; }
        }

        internal List<RelayDirectory.Entry> SnapshotDirectoryRooms()
        {
            return recruitDirectory.Snapshot();
        }

        private static string ResolveSettingsPath()
        {
            // Awake runs after Unity has initialized this path. It remains
            // reliable when a launcher temporarily exposes no main module.
            try
            {
                string fromDataPath = TryResolveSettingsPathFromUnityDataPath();
                if (!string.IsNullOrEmpty(fromDataPath)) return fromDataPath;
            }
            catch (Exception)
            {
                // The desktop compatibility harness has no Unity runtime. The
                // executable resolver below remains its intentional fallback.
            }
            try
            {
                using (System.Diagnostics.Process process = System.Diagnostics.Process.GetCurrentProcess())
                {
                    if (process.MainModule == null)
                        throw new InvalidOperationException("The game executable is unavailable.");
                    return ResolveSettingsPathFromExecutable(process.MainModule.FileName);
                }
            }
            catch (Exception error)
            {
                throw new InvalidOperationException("Cannot locate client.json beside the game executable.", error);
            }
        }

        private static string TryResolveSettingsPathFromUnityDataPath()
        {
            // Keep the Unity ECall in its own method. The desktop compatibility
            // harness does not provide this internal call, but can still catch
            // its failure at the caller and exercise the executable fallback.
            return ResolveSettingsPathFromDataPath(Application.dataPath);
        }

        private static string ResolveSettingsPathFromDataPath(string dataPath)
        {
            if (string.IsNullOrEmpty(dataPath)) return null;
            string root = Path.GetDirectoryName(dataPath.TrimEnd(Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar));
            if (string.IsNullOrEmpty(root)) return null;
            // Unity returns a '/'-separated data path on this Windows build,
            // whereas the Mono File APIs use '\\'. Normalize before combining
            // the filename so the result is never F:/package\client.json.
            if (Path.DirectorySeparatorChar == '\\')
                root = root.Replace('/', Path.DirectorySeparatorChar);
            return Path.Combine(root, "client.json");
        }

        private static string ResolveSettingsPathFromExecutable(string executablePath)
        {
            string root = string.IsNullOrEmpty(executablePath)
                ? null
                : Path.GetDirectoryName(executablePath);
            if (string.IsNullOrEmpty(root))
                throw new InvalidOperationException("The game executable directory is unavailable.");
            return Path.Combine(root, "client.json");
        }

#if BEPINEX
        private void Awake()
#else
        public override void OnInitializeMelon()
#endif
        {
#if BEPINEX_V5
            ModLog.Initialize(Logger);
#endif
            Instance = this;
            bool configured = false;
            string configurationStep = "locating the game data directory";
            try
            {
                settingsPath = ResolveSettingsPath();
                ModLog.Msg("client.json path: " + settingsPath);
                configurationStep = "opening client.json";
                string settingsText = LocalSettings.Read(settingsPath);
                configurationStep = "parsing client.json";
                settings = LocalSettings.Parse(settingsText);
                configurationStep = "creating client.json";
                if (!File.Exists(settingsPath)) settings.Save(settingsPath);
                configurationStep = "validating client.json";
                settings.Validate();
                configured = true;
            }
            catch (Exception error)
            {
                if (settings == null) settings = new LocalSettings();
                activeOnlineMode = false;
                ReportConfigurationFailure(configurationStep, error);
            }
            if (configured)
            {
                try
                {
                    NativeTransport.Install(settings.onlineMode);
                    activeOnlineMode = settings.onlineMode;
                    ModLog.Msg(activeOnlineMode
                        ? "OngekiCollab online mode: native matching controls are active."
                        : "OngekiCollab LAN mode: native matching is unchanged.");
                }
                catch (Exception error)
                {
                    activeOnlineMode = false;
                    ReportFailure("Native transport initialization", error);
                }
            }
            else
            {
                NativeTransport.Install(false);
                ModLog.Warning("Online mode is disabled until client.json configuration is corrected.");
            }
            relay = NewRelay();
        }

#if BEPINEX
        private void Update()
#else
        public override void OnUpdate()
#endif
        {
            CheckStartupIdentity();
            // Enforce the wall-clock deadline before a late queued snapshot can clear it.
            if (nativeController != null && roomStatus.Length == 0 &&
                relayHandshakeDeadline != default(DateTime) && DateTime.UtcNow >= relayHandshakeDeadline)
            {
                ModLog.Warning("Relay Match/WebSocket/first snapshot timed out; returning to song select.");
                LeaveRoom(true, true, nativeBattleStartPending || nativeBattleStartAborted);
                return;
            }
            for (int count = 0; count < 64; count++)
            {
                Action action;
                lock (mainThreadEvents)
                {
                    if (mainThreadEvents.Count == 0) break;
                    action = mainThreadEvents.Dequeue();
                }
                action();
            }
            if (eventOverflow)
            {
                eventOverflow = false;
                ModLog.Warning("Relay control queue overflow; leaving the room.");
                LeaveRoom(true, true, false);
            }
            if (chartAbortPending)
            {
                chartAbortPending = false;
                AbortNativeStart(chartAbortMessage ?? "The chart selected for play no longer matches the verified Ready chart. Recruit again.");
                return;
            }
            UpdateRecruitDirectory();
            if (activeOnlineMode && nativeController != null && NativeTransport.TransportFailed)
            {
                ModLog.Warning("Relay transport failed; returning to song select.");
                bool preserveAbort = nativeBattleStartPending || nativeBattleStartAborted;
                if (preserveAbort) nativeBattleStartAborted = true;
                LeaveRoom(true, true, preserveAbort);
                return;
            }
            if (nativeStopPending)
            {
                nativeStopPending = false;
                try { if (Party.get() != null) Party.get().cancelBothRecruitJoin(); }
                catch (Exception error) { ReportFailure("Native Party cancellation", error); }
            }
            if (relayLeavePending)
            {
                if (relay == null || relay.OutboundIdle || DateTime.UtcNow >= relayLeaveDeadline)
                {
                    bool stopNative = relayLeaveStopNative;
                    bool rollbackUi = relayLeaveRollbackUi;
                    bool preserveAbort = relayLeavePreserveAbort;
                    relayLeavePending = false;
                    LeaveRoom(stopNative, rollbackUi, preserveAbort);
                }
                return;
            }
            if (nativePartyStartPending) TryStartNativeSession();
            if (nativeJoinPending) TryEnterNativeRoom();
            if (readyPending) TrySendReady();
            TryCompleteNativeStart();
            if (relay != null && relay.PeerId != 0 &&
                ShouldReleaseAfterPlay(playEndedQuietly, playEndedAt, DateTime.UtcNow,
                    cancelNativeAfterQuietLeave, NativeResultReached()))
            {
                LeaveRoom(cancelNativeAfterQuietLeave);
                return;
            }
            if (activeOnlineMode && Party.get() != null)
            {
                bool playing = Party.get().isPlay();
                if (relay.PeerId == hostPeerId)
                {
                    // Rising edge records the play on the relay (passive, nothing is
                    // gated on it); falling edge reports completion. The local room
                    // status flips here because the server does not echo broadcasts.
                    if (playing && !nativeWasPlaying)
                    {
                        roomStatus = "playing";
                        try { relay.PlayStarted(); }
                        catch (Exception error) { ReportFailure("Play start", error); }
                    }
                    else if (!playing && nativeWasPlaying)
                    {
                        try
                        {
                            relay.EndPlay();
                            MarkPlayEndedQuietly(false);
                        }
                        catch (Exception error) { ReportFailure("End play", error); }
                    }
                }
                nativeWasPlaying = playing;
                if (playing) ReportScores();
            }
        }

        // Reports this cabinet's live play state at most once a second and only when
        // something changed. Capture before Party.Host's all-member sample barrier so
        // this recovery path does not depend on the native round trip it recovers.
        private void ReportScores()
        {
            if (DateTime.UtcNow < nextScoreReport) return;
            nextScoreReport = DateTime.UtcNow.AddSeconds(1);
            if (!hasLocalPlayScore) return;
            int techScore = localTechScore;
            int battleScore = localBattleScore;
            int bulletHitCount = localBulletHitCount;
            string playStatus = ((Party.PlayStatus)localPlayStatus).ToString();
            bool unchanged = techScore == lastTechScore && battleScore == lastBattleScore &&
                bulletHitCount == lastBulletHitCount &&
                string.Equals(playStatus ?? "", lastPlayStatus ?? "", StringComparison.Ordinal);
            if (unchanged && DateTime.UtcNow < nextScoreRefresh) return;
            nextScoreRefresh = DateTime.UtcNow.AddSeconds(5);
            lastTechScore = techScore;
            lastBattleScore = battleScore;
            lastBulletHitCount = bulletHitCount;
            lastPlayStatus = playStatus;
            try { relay.SendScore(techScore, battleScore, bulletHitCount, playStatus); }
            catch (Exception error) { ReportFailure("Play score", error); }
        }

        internal void CaptureLocalPlayScore(Party.ClientPlayInfo info)
        {
            if (!activeOnlineMode || relay == null || info == null) return;
            localTechScore = info._techScore;
            localBattleScore = info._battleScore;
            localBulletHitCount = info._bulletHitCount;
            localPlayStatus = info._playStatus;
            hasLocalPlayScore = true;
        }

        internal void ApplyRemotePlayScores()
        {
            if (!activeOnlineMode || relay == null || roomStatus != "playing" || remotePlayScores.Count == 0) return;
            Party.IManager manager = Party.get();
            if (manager == null) return;
            Party.PartyMemberInfo users = manager.getPartyMemberInfo();
            Party.PartyPlayInfo play = manager.getPartyPlayInfo();
            if (users == null || users._userInfo == null || play == null || play._member == null) return;
            int count = Math.Min(users._userInfo.Length, play._member.Length);
            bool applied = false;
            for (int i = 0; i < count; i++)
            {
                Party.UserInfo user = users._userInfo[i];
                Party.MemberPlayInfo member = play._member[i];
                if (user == null || member == null || !user._isJoin) continue;
                uint peerId = PeerFromVirtualAddress(user._ipAddress);
                RemotePlayScore score;
                if (peerId == 0 || peerId == relay.PeerId || !remotePlayScores.TryGetValue(peerId, out score)) continue;
                // Scores are monotonic during a chart. Never replace a healthier,
                // newer native Party value with the relay's one-second fallback.
                if (score.HasBattleScore) { member._battleScore = score.BattleScore; applied = true; }
                if (score.HasTechScore && score.TechScore >= member._techScore)
                { member._techScore = score.TechScore; applied = true; }
                if (score.HasBulletHitCount) { member._bulletHitCount = score.BulletHitCount; applied = true; }
                if (score.HasPlayStatus) { member._playStatus = score.PlayStatus; applied = true; }
            }
            if (!applied) return;
            int[] values = new int[play._member.Length];
            byte[] ranks = new byte[play._member.Length];
            for (int i = 0; i < play._member.Length; i++) values[i] = play._member[i]._techScore;
            Party.getRank(values, ranks);
            for (int i = 0; i < play._member.Length; i++) play._member[i]._ranking = ranks[i];
        }

        internal void ApplyRemotePlayerProfiles()
        {
            if (!activeOnlineMode || relay == null || remotePlayerProfiles.Count == 0) return;
            Party.IManager manager = Party.get();
            if (manager == null) return;
            Party.PartyMemberInfo party = manager.getPartyMemberInfo();
            if (party == null || party._userInfo == null) return;
            foreach (Party.UserInfo user in party._userInfo)
            {
                if (user == null || !user._isJoin) continue;
                uint peerId = PeerFromVirtualAddress(user._ipAddress);
                RemotePlayerProfile profile;
                if (peerId == 0 || peerId == relay.PeerId ||
                    !remotePlayerProfiles.TryGetValue(peerId, out profile)) continue;
                if (System.String.IsNullOrEmpty(user._playerName) && !System.String.IsNullOrEmpty(profile.PlayerName))
                    user._playerName = profile.PlayerName;
                if (profile.CardId != 0 && user._cardID == 0) user._cardID = profile.CardId;
            }
        }

        private static uint PeerFromVirtualAddress(uint address)
        {
            uint peerId = address & 0xffu;
            return (address & 0xffffff00u) == 0x0aff0000u && peerId >= 1 && peerId <= 4 ? peerId : 0u;
        }

        private void IngestRemotePlayScore(JObject message)
        {
            if (roomStatus != "playing" || relay == null) return;
            uint peerId = message.Value<uint?>("peerId") ?? 0;
            if (peerId < 1 || peerId > 4 || peerId == relay.PeerId) return;
            RemotePlayScore score;
            if (!remotePlayScores.TryGetValue(peerId, out score)) score = new RemotePlayScore();
            if (MergeRemotePlayScore(score, message)) remotePlayScores[peerId] = score;
        }

        private static bool MergeRemotePlayScore(RemotePlayScore score, JObject message)
        {
            if (score == null || message == null) return false;
            bool changed = false;
            int value;
            if (TryScore(message["techScore"], out value))
            { score.TechScore = value; score.HasTechScore = true; changed = true; }
            if (TryScore(message["battleScore"], out value))
            { score.BattleScore = value; score.HasBattleScore = true; changed = true; }
            if (TryScore(message["bulletHitCount"], out value))
            { score.BulletHitCount = value; score.HasBulletHitCount = true; changed = true; }
            if (TryPlayStatus(message.Value<string>("playStatus"), out value))
            { score.PlayStatus = value; score.HasPlayStatus = true; changed = true; }
            return changed;
        }

        private static bool TryScore(JToken token, out int value)
        {
            value = -1;
            if (token == null) return false;
            try { value = token.Value<int>(); }
            catch { return false; }
            return value >= 0 && value <= 99999999;
        }

        private static bool TryPlayStatus(string value, out int result)
        {
            result = 0;
            if (System.String.IsNullOrEmpty(value)) return false;
            try
            {
                Party.PlayStatus parsed = (Party.PlayStatus)Enum.Parse(typeof(Party.PlayStatus), value, false);
                if (parsed < Party.PlayStatus.None || parsed >= Party.PlayStatus.MAX) return false;
                result = (int)parsed;
                return true;
            }
            catch { return false; }
        }

        private void CheckStartupIdentity()
        {
            if (!activeOnlineMode || Singleton<MU3.Operation.OperationManager>.instance == null ||
                !Singleton<MU3.Operation.OperationManager>.instance.isAliveServer) return;
            UserManager user = Singleton<UserManager>.instance;
            if (user == null || user.LoginStatus != 1 || user.IsGuest)
            {
                startupIdentityAttempted = false;
                startupIdentityRequired = false;
                return;
            }
            if (startupIdentityAttempted || busy) return;
            if (startupIdentityRequired)
            {
                startupIdentityAttempted = true;
                VerifyStartupIdentity();
                return;
            }
            startupIdentityAttempted = true;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    bool required;
                    using (RelayClient preflight = new RelayClient(settings, settingsPath))
                        required = preflight.RequiresIdentity();
                    if (!required)
                    {
                        Enqueue(delegate { ModLog.Msg("Relay startup identity check is disabled by the service."); });
                        return;
                    }
                    Enqueue(delegate
                    {
                        startupIdentityRequired = true;
                        startupIdentityAttempted = false;
                    });
                }
                catch (Exception error)
                {
                    Enqueue(delegate { ReportFailure("Relay startup identity mode", error); });
                }
            });
        }

        private void VerifyStartupIdentity()
        {
            CurrentIdentity identity;
            try { identity = GameSnapshot.ReadIdentity(); }
            catch (InvalidOperationException) { startupIdentityAttempted = false; return; }
            catch (NullReferenceException) { startupIdentityAttempted = false; return; }
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    lock (identityGate)
                    {
                        using (RelayClient preflight = new RelayClient(settings, settingsPath))
                            preflight.Authenticate(identity);
                    }
                    Enqueue(delegate { ModLog.Msg("Relay startup identity verified."); });
                }
                catch (Exception error)
                {
                    Enqueue(delegate { ReportFailure("Relay startup identity", error); });
                }
            });
        }

        private void Enqueue(Action action)
        {
            lock (mainThreadEvents)
            {
                if (mainThreadEvents.Count >= MaximumMainThreadEvents) { eventOverflow = true; return; }
                mainThreadEvents.Enqueue(action);
            }
        }

        // The public directory is loaded without a supplemental UI. Unity objects are
        // captured on this thread, then every existing official chart is hashed on a
        // worker before the room may appear in the game's native recruit list.
        private void UpdateRecruitDirectory()
        {
            if (!activeOnlineMode || directoryBusy || NativeMatchPending ||
                DateTime.UtcNow < nextDirectoryPoll || Party.get() == null) return;
            int epoch = ++directoryEpoch;
            directoryBusy = true;
            nextDirectoryPoll = DateTime.UtcNow.AddSeconds(5);
            RelayClient client = new RelayClient(settings, settingsPath);
            directoryRelay = client;
            ThreadPool.QueueUserWorkItem(delegate
            {
                JObject page = null;
                Exception failure = null;
                try { page = client.GetRooms(settings.pool, null); }
                catch (Exception error) { failure = error; }
                Enqueue(delegate
                {
                    if (epoch != directoryEpoch || !System.Object.ReferenceEquals(directoryRelay, client))
                    {
                        client.Dispose();
                        return;
                    }
                    directoryRelay = null;
                    client.Dispose();
                    if (failure != null)
                    {
                        directoryBusy = false;
                        recruitDirectory.FailPage();
                        ReportFailure("Relay recruit directory", failure);
                        nextDirectoryPoll = DateTime.UtcNow.AddSeconds(10);
                        return;
                    }
                    BeginDirectoryValidation(page, epoch);
                });
            });
        }

        private void BeginDirectoryValidation(JObject page, int epoch)
        {
            if (epoch != directoryEpoch || NativeMatchPending)
            {
                directoryBusy = false;
                recruitDirectory.Clear();
                return;
            }
            List<DirectoryCandidate> candidates = new List<DirectoryCandidate>();
            JArray items = page == null ? null : page["items"] as JArray;
            if (items != null)
            {
                foreach (JToken token in items)
                {
                    JObject item = token as JObject;
                    JToken song = item == null ? null : item["song"];
                    string roomId = item == null ? null : item.Value<string>("id");
                    int? musicId = song == null ? null : song.Value<int?>("id");
                    int? difficulty = song == null ? null : song.Value<int?>("selectedDifficulty");
                    if (System.String.IsNullOrEmpty(roomId) || musicId == null || difficulty == null ||
                        difficulty < 0 || difficulty > 4) continue;
                    try
                    {
                        DataManager data = SingletonStateMachine<DataManager, DataManager.EState>.instance;
                        MU3.Data.MusicData music = data == null ? null : data.getMusicData(musicId.Value);
                        GameSnapshot.SongSnapshot snapshot = GameSnapshot.CaptureSong(
                            music, (FumenDifficulty)difficulty.Value);
                        if (snapshot.Id == musicId.Value && snapshot.SelectedDifficulty == difficulty.Value)
                            candidates.Add(new DirectoryCandidate { RoomId = roomId, Song = snapshot });
                    }
                    catch (Exception)
                    {
                        // Missing, custom or unreadable local chart data is deliberately
                        // filtered without exposing a stale room in the native list.
                    }
                }
            }
            ThreadPool.QueueUserWorkItem(delegate
            {
                HashSet<string> validRooms = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (DirectoryCandidate candidate in candidates)
                {
                    if (epoch != directoryEpoch) return;
                    if (TryValidateDirectorySong(candidate.Song)) validRooms.Add(candidate.RoomId);
                }
                Enqueue(delegate
                {
                    if (epoch != directoryEpoch) return;
                    try { recruitDirectory.ApplyPage(page, relay == null ? null : relay.RoomId, validRooms); }
                    catch (Exception error)
                    {
                        recruitDirectory.Clear();
                        ReportFailure("Relay recruit directory", error);
                    }
                    finally
                    {
                        directoryBusy = false;
                        nextDirectoryPoll = DateTime.UtcNow.AddSeconds(5);
                    }
                });
            });
        }

        private void CancelDirectoryWork(bool clear)
        {
            directoryEpoch++;
            directoryBusy = false;
            RelayClient client = directoryRelay;
            directoryRelay = null;
            if (client != null) client.Dispose();
            if (clear) recruitDirectory.Clear();
            nextDirectoryPoll = DateTime.UtcNow;
        }

        internal static bool TryValidateDirectorySong(GameSnapshot.SongSnapshot song)
        {
            try { GameSnapshot.HashSong(song); return true; }
            catch (Exception) { return false; }
        }

        internal static bool ShouldReleaseAfterPlay(bool ended, DateTime endedAt, DateTime now,
            bool cancelNative, bool nativeResult)
        {
            // A normal end is released as soon as native Party reaches Result. The
            // result state, not a fixed wall-clock delay, is the synchronization gate.
            return ended && (cancelNative || nativeResult);
        }

        private RelayClient NewRelay()
        {
            RelayClient client = new RelayClient(settings, settingsPath);
            client.OnText = delegate(string message)
            {
                Enqueue(delegate { if (System.Object.ReferenceEquals(relay, client)) OnRoomText(message); });
            };
            client.OnBinary = delegate(byte[] frame)
            {
                if (System.Object.ReferenceEquals(relay, client)) NativeTransport.ReceiveFrame(frame);
            };
            client.OnState = delegate(string state)
            {
                // The RelayClient state deliberately contains only lifecycle text and
                // a WebSocket close code here; never forward its room identifier.
                if (System.String.IsNullOrEmpty(state) ||
                    (!state.StartsWith("Disconnected:", StringComparison.Ordinal) &&
                     !state.StartsWith("Closing:", StringComparison.Ordinal))) return;
                ModLog.Warning("Relay WebSocket " + state);
            };
            client.OnClosed = delegate
            {
                Enqueue(delegate
                {
                    if (!System.Object.ReferenceEquals(relay, client)) return;
                    if (playEndedQuietly)
                    {
                        bool resultReached = NativeResultReached();
                        // A close after Result is routine. Before Result it is a real
                        // transport failure, so cancel the incomplete native session.
                        LeaveRoom(cancelNativeAfterQuietLeave || !resultReached);
                        return;
                    }
                    ModLog.Warning("Relay room disconnected.");
                    LeaveRoom(true, true, nativeBattleStartPending || nativeBattleStartAborted);
                });
            };
            return client;
        }

        internal void BeginNativeMatch(LocalMatchingCtrl controller, MU3.Data.MusicData music, FumenDifficulty difficulty)
        {
            BeginNativeMatch(controller, music, difficulty, null, false);
        }

        internal bool BeginNativeDirectoryMatch(LocalMatchingCtrl controller, uint directoryAddress,
            FumenDifficulty difficulty)
        {
            RelayDirectory.Entry entry;
            if (!activeOnlineMode || !RelayDirectory.IsDirectoryAddress(directoryAddress) ||
                !recruitDirectory.TryGet(directoryAddress, out entry)) return false;
            DataManager data = SingletonStateMachine<DataManager, DataManager.EState>.instance;
            MU3.Data.MusicData music = data == null ? null : data.getMusicData(entry.MusicId);
            return BeginNativeMatch(controller, music, difficulty, entry.RoomId, true);
        }

        private bool BeginNativeMatch(LocalMatchingCtrl controller, MU3.Data.MusicData music,
            FumenDifficulty difficulty, string roomId, bool directoryJoin)
        {
            if (!activeOnlineMode || NativeMatchPending || controller == null || music == null) return false;
            DateTime matchDeadline = DateTime.UtcNow.AddSeconds(15);
            try
            {
                if (Party.get() == null) throw new InvalidOperationException("Native Party manager is unavailable.");
                GameSnapshot.SongSnapshot song = GameSnapshot.CaptureSong(music, difficulty);
                string gameVersion = GameSnapshot.ReadGameVersion();
                CancelDirectoryWork(true);
                relay.Dispose();
                NativeTransport.Detach();
                relay = NewRelay();
                RelayClient client = relay;
                relayHandshakeDeadline = matchDeadline;
                client.SetMatchDeadline(relayHandshakeDeadline);
                sessionEpoch++;
                nativeController = controller;
                matchedSong = null;
                readyMusicId = song.Id;
                readyDifficulty = song.SelectedDifficulty;
                readySelectionRevision++;
                roomStatus = "";
                readyPending = false;
                readyRequested = false;
                readyAcknowledged = false;
                nativeBattleStartPending = false;
                nativeBattleStartIssued = false;
                nativeBattleStartAborted = false;
                nativeDirectoryJoin = directoryJoin;
                busy = true;
                ModLog.Msg(directoryJoin
                    ? "Native recruit list requested an explicit relay room join."
                    : "Native recruit requested relay matching.");
                ThreadPool.QueueUserWorkItem(delegate
                {
                    try
                    {
                        bool required = client.RequiresIdentity();
                        Enqueue(delegate { CompleteNativeMatch(client, song, gameVersion, required, roomId); });
                    }
                    catch (Exception error)
                    {
                        Enqueue(delegate
                        {
                            if (!System.Object.ReferenceEquals(relay, client)) return;
                            ReportFailure("Relay matching", error);
                            LeaveRoom(false, true, false);
                            busy = false;
                        });
                    }
                });
                return true;
            }
            catch (Exception error)
            {
                ReportFailure("Native recruit", error);
                if (!directoryJoin) NativeMatching.RollbackToSongSelect(controller);
                return false;
            }
        }

        private void CompleteNativeMatch(RelayClient client, GameSnapshot.SongSnapshot song, string gameVersion,
            bool identityRequired, string roomId)
        {
            if (!System.Object.ReferenceEquals(relay, client)) return;
            CurrentIdentity identity;
            try { identity = identityRequired ? GameSnapshot.ReadIdentity() : GameSnapshot.ReadPlayerName(); }
            catch (Exception error)
            {
                ReportFailure("Native recruit", error);
                LeaveRoom(false, true, false);
                busy = false;
                return;
            }
            ThreadPool.QueueUserWorkItem(delegate
            {
                JObject hashedSong = null;
                try
                {
                    hashedSong = GameSnapshot.HashSong(song);
                }
                catch (Exception error)
                {
                    Enqueue(delegate
                    {
                        if (!System.Object.ReferenceEquals(relay, client)) return;
                        ReportFailure("Relay match chart verification", error);
                        LeaveRoom(false, true, false);
                        busy = false;
                    });
                }
                if (hashedSong == null) return;
                Enqueue(delegate { BeginRelayMatch(client, identity, hashedSong, gameVersion, identityRequired, roomId); });
            });
        }

        private void BeginRelayMatch(RelayClient client, CurrentIdentity identity, JObject song,
            string gameVersion, bool identityRequired, string roomId)
        {
            if (!System.Object.ReferenceEquals(relay, client)) { client.Dispose(); return; }
            matchedSong = song;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    lock (identityGate) client.Match(identity, song, gameVersion, identityRequired, roomId);
                    if (!System.Object.ReferenceEquals(relay, client)) client.Dispose();
                }
                catch (Exception error)
                {
                    Enqueue(delegate
                    {
                        if (!System.Object.ReferenceEquals(relay, client)) return;
                        ReportFailure("Relay matching", error);
                        LeaveRoom(false, true, false);
                    });
                }
                finally
                {
                    Enqueue(delegate
                    {
                        if (System.Object.ReferenceEquals(relay, client)) busy = false;
                    });
                }
            });
        }

        internal void NativeSelectionChanged(MU3.Data.MusicData music, FumenDifficulty difficulty)
        {
            if (!activeOnlineMode || nativeController == null || matchedSong == null || music == null) return;
            int musicId = music.id;
            int difficultyValue = (int)difficulty;
            if (musicId != matchedSong.Value<int>("id"))
            {
                AbortNativeStart("The selected song changed after joining the online room. Recruit again.");
                return;
            }
            if (difficultyValue < 0 || difficultyValue > 4)
            {
                AbortNativeStart("The selected chart difficulty is invalid. Recruit again.");
                return;
            }
            if (readyMusicId == musicId && readyDifficulty == difficultyValue) return;
            readyMusicId = musicId;
            readyDifficulty = difficultyValue;
            readySelectionRevision++;
            readyPending = readyRequested;
            readyAcknowledged = false;
            readySong = null;
            ClearChartState();
            ModLog.Msg("Ready selection updated from the latest native Party user info.");
        }

        internal void NativeReady()
        {
            if (!activeOnlineMode || nativeController == null) return;
            readyRequested = true;
            readyPending = true;
            TrySendReady();
        }

        internal void NativeUnready()
        {
            if (!activeOnlineMode || nativeController == null) return;
            readyRequested = false;
            readyPending = false;
            readyAcknowledged = false;
            readySelectionRevision++;
            readySong = null;
            ClearChartState();
            try { relay.Unready(); }
            catch (Exception error)
            {
                ReportFailure("Relay unready", error);
                LeaveRoom(true, true, false);
            }
        }

        private void TrySendReady()
        {
            if (!readyPending || DateTime.UtcNow < nextReadyRetry) return;
            if (!NativeTransport.Connected || Party.get() == null || !Party.get().isJoin()) return;
            if (readyHashInFlight) return;
            try
            {
                if (matchedSong == null || readyMusicId < 1 || readyDifficulty < 0 || readyDifficulty > 4)
                    throw new InvalidOperationException("The matched song is unavailable.");
                int musicId = readyMusicId;
                int difficulty = readyDifficulty;
                if (musicId != matchedSong.Value<int>("id"))
                    throw new InvalidOperationException("The selected song changed after joining the room.");
                DataManager data = SingletonStateMachine<DataManager, DataManager.EState>.instance;
                MU3.Data.MusicData music = data == null ? null : data.getMusicData(musicId);
                if (music == null) throw new InvalidOperationException("The matched official song is unavailable locally.");
                // The latest native Party UserInfo selection is authoritative. Capture
                // Unity state here, then hash only immutable paths on a worker.
                GameSnapshot.SongSnapshot snapshot = GameSnapshot.CaptureSong(music, (FumenDifficulty)difficulty);
                int epoch = sessionEpoch;
                readyHashEpoch = epoch;
                int selectionRevision = readySelectionRevision;
                readyHashInFlight = true;
                readyPending = false;
                readyAcknowledged = false;
                readySong = null;
                ClearChartState();
                ThreadPool.QueueUserWorkItem(delegate
                {
                    JObject current = null;
                    Exception failure = null;
                    try { current = GameSnapshot.HashSong(snapshot); }
                    catch (Exception error) { failure = error; }
                    Enqueue(delegate
                    {
                        if (epoch != sessionEpoch || epoch != readyHashEpoch) return;
                        readyHashInFlight = false;
                        if (!IsCurrentReadyWork(epoch, sessionEpoch, selectionRevision,
                            readySelectionRevision)) return;
                        if (failure != null)
                        {
                            ReportFailure("Relay ready chart verification", failure);
                            AbortNativeStart("Chart verification failed. Return to song select and recruit again.");
                            return;
                        }
                        try
                        {
                            relay.Ready(current, ClampReadyRtt(rttMs));
                            readySong = current;
                            ModLog.Msg("Native ready sent to relay.");
                        }
                        catch (Exception error)
                        {
                            ReportFailure("Relay ready", error);
                            readyPending = true;
                            nextReadyRetry = DateTime.UtcNow.AddSeconds(1);
                        }
                    });
                });
            }
            catch (Exception error)
            {
                ReportFailure("Relay ready", error);
                AbortNativeStart("Chart verification could not start. Return to song select and recruit again.");
            }
            finally { nextReadyRetry = DateTime.UtcNow.AddSeconds(1); }
        }

        // True means the online mod consumed LocalMatchingCtrl.battleStart. A missing or
        // not-yet-joined room returns false so the Harmony prefix never swallows a native
        // call without an active session.
        internal bool TryRequestNativeStart()
        {
            if (!activeOnlineMode || !HasJoinedNativeRoom || relay == null || relay.PeerId != hostPeerId)
                return false;
            if (nativeBattleStartIssued) return true;
            nativeBattleStartPending = true;
            nativeBattleStartAborted = false;
            if (nativeBattleStartDeadline == default(DateTime))
                nativeBattleStartDeadline = DateTime.UtcNow.AddSeconds(12);
            if (chartConflict)
            {
                ModLog.Warning("Start refused: relay peers report different files for the same official chart.");
                AbortNativeStart("Players have different files for the same official chart. Recruit again.");
                return true;
            }
            ModLog.Msg(readySong == null
                ? "Native start queued while the local chart is verified."
                : "Native start queued until every connected player and Party acknowledge readiness.");
            TryCompleteNativeStart();
            return true;
        }

        internal void NativeCancelled()
        {
            if (!activeOnlineMode) return;
            if (ShouldSendEndPlay(roomStatus, relay != null && relay.PeerId == hostPeerId))
            {
                try
                {
                    relay.EndPlay("cancelled");
                    ScheduleLeaveAfterRelaySend(false, false, false);
                    return;
                }
                catch (Exception error) { ReportFailure("Relay cancel notification", error); }
            }
            LeaveRoom(false, false, false);
        }

        private void TryCompleteNativeStart()
        {
            if (!nativeBattleStartPending || nativeBattleStartIssued) return;
            if (nativeBattleStartDeadline != default(DateTime) &&
                DateTime.UtcNow >= nativeBattleStartDeadline)
            {
                AbortNativeStart("Timed out waiting for every cabinet to finish the game room setup. Recruit again.");
                return;
            }
            if (!readyAcknowledged || chartConflict || !HasJoinedNativeRoom) return;
            int startOk;
            try
            {
                startOk = LocalMatchingCtrl.getStartOKNumber();
                nativeStartReadFailures = 0;
            }
            catch (Exception error)
            {
                nativeStartReadFailures++;
                ModLog.Warning("Native StartOK read failed " + nativeStartReadFailures + "/3: " + error.GetType().Name);
                if (nativeStartReadFailures >= 3)
                    AbortNativeStart("Could not read the game room readiness state. Recruit again.");
                return;
            }
            if (!CanCompleteNativeStart(nativeBattleStartPending, readyAcknowledged,
                chartConflict, nativeBattleStartIssued, startOk))
            {
                return;
            }
            try
            {
                Party.IManager manager = Party.get();
                if (manager == null || !manager.isJoinAndActive())
                    throw new InvalidOperationException("Native Party is no longer joined.");
                manager.battleStart();
                nativeBattleStartPending = false;
                nativeBattleStartIssued = true;
                nativeBattleStartAborted = false;
                nativeBattleStartDeadline = default(DateTime);
                ModLog.Msg("Native Party battleStart issued after relay and Party readiness acknowledgements.");
            }
            catch (Exception error)
            {
                ReportFailure("Native battle start", error);
                AbortNativeStart("Could not start the game room. Recruit again.");
            }
        }

        internal static bool CanCompleteNativeStart(bool requested, bool acknowledged,
            bool conflict, bool issued, int nativeStartOkCount)
        {
            return requested && acknowledged && !conflict && !issued && nativeStartOkCount >= 2;
        }

        private void AbortNativeStart(string message)
        {
            nativeBattleStartPending = false;
            nativeBattleStartIssued = false;
            nativeBattleStartAborted = true;
            ModLog.Warning(message);
            RelayClient old = relay;
            if (old != null && ShouldSendEndPlay(roomStatus, old.PeerId == hostPeerId))
            {
                try
                {
                    old.EndPlay("chart_verification_failed");
                    nativeStopPending = true;
                    ScheduleLeaveAfterRelaySend(true, true, true);
                    return;
                }
                catch (Exception error) { ReportFailure("Relay abort notification", error); }
            }
            LeaveRoom(true, true, true);
        }

        private void ScheduleLeaveAfterRelaySend(bool stopNative, bool rollbackUi, bool preserveAbort)
        {
            relayLeavePending = true;
            relayLeaveDeadline = DateTime.UtcNow.AddSeconds(1);
            relayLeaveStopNative = stopNative;
            relayLeaveRollbackUi = rollbackUi;
            relayLeavePreserveAbort = preserveAbort;
        }

        internal static bool ShouldSendEndPlay(string status, bool isHost)
        {
            return isHost && System.String.Equals(status, "playing", StringComparison.Ordinal);
        }

        private void LeaveRoom(bool stopNative)
        {
            LeaveRoom(stopNative, false, false);
        }

        private void LeaveRoom(bool stopNative, bool rollbackUi, bool preserveStartAbort)
        {
            sessionEpoch++;
            readySelectionRevision++;
            CancelDirectoryWork(true);
            LocalMatchingCtrl controller = nativeController;
            if (relay != null) relay.Dispose();
            NativeTransport.Detach();
            busy = false;
            nativeStopPending = stopNative;
            relay = NewRelay();
            nativeController = null;
            matchedSong = null;
            readyMusicId = readyDifficulty = -1;
            readySong = null;
            ClearChartState();
            roomStatus = "";
            hostPeerId = 0;
            nativePartyStartPending = nativeWasPlaying = false;
            nativeJoinPending = false;
            nativePartyUserInfo = null;
            nativeMemberPacketBaseline = 0;
            nativeMemberRefreshAttempts = 0;
            nextNativeMemberRefresh = default(DateTime);
            nativeRoomJoined = false;
            nativeDirectoryJoin = false;
            nativeBattleStartPending = false;
            nativeBattleStartIssued = false;
            if (!preserveStartAbort) nativeBattleStartAborted = false;
            nativeBattleStartDeadline = default(DateTime);
            relayHandshakeDeadline = default(DateTime);
            nativeStartReadFailures = 0;
            nativeJoinDeadline = default(DateTime);
            readyPending = false;
            readyRequested = false;
            readyAcknowledged = false;
            readyHashInFlight = false;
            readyHashEpoch = sessionEpoch;
            playEndedQuietly = false;
            cancelNativeAfterQuietLeave = false;
            playEndedAt = default(DateTime);
            nextScoreReport = default(DateTime);
            lastTechScore = lastBattleScore = lastBulletHitCount = -1;
            lastPlayStatus = null;
            hasLocalPlayScore = false;
            localTechScore = localBattleScore = localBulletHitCount = localPlayStatus = 0;
            remotePlayScores.Clear();
            remotePlayerProfiles.Clear();
            chartAbortPending = false;
            chartAbortMessage = null;
            relayLeavePending = false;
            relayLeaveDeadline = default(DateTime);
            relayLeaveStopNative = relayLeaveRollbackUi = relayLeavePreserveAbort = false;
            if (rollbackUi && controller != null) NativeMatching.RollbackToSongSelect(controller);
        }

        private void OnRoomText(string json)
        {
            try
            {
                JObject message = JObject.Parse(json);
                string type = (string)message["type"];
                if (type == "snapshot")
                {
                    hostPeerId = (uint)message.Value<int>("hostPeerId");
                    if (hostPeerId < 1 || hostPeerId > 4) throw new InvalidOperationException("Invalid relay host peer.");
                    string snapshotStatus = message.Value<string>("status");
                    if (snapshotStatus != "recruiting" && snapshotStatus != "playing")
                        throw new InvalidOperationException("Invalid relay room status.");
                    roomStatus = snapshotStatus;
                    IngestPlayers(message);
                    NativeTransport.Attach(relay, hostPeerId);
                    nativePartyStartPending = true;
                    nativePartyStartDeadline = DateTime.UtcNow.AddSeconds(10);
                    relay.Ping(UtcMilliseconds());
                    relayHandshakeDeadline = default(DateTime);
                }
                else if (type == "readyState")
                {
                    IngestPlayers(message);
                }
                else if (type == "peerLeft")
                {
                    uint? leftPeer = (uint?)message.Value<uint?>("peerId");
                    if (leftPeer != null)
                    {
                        peerCharts.Remove(leftPeer.Value);
                        remotePlayScores.Remove(leftPeer.Value);
                        remotePlayerProfiles.Remove(leftPeer.Value);
                    }
                    readyAcknowledged = false;
                    EvaluateChartConflict();
                    if (!nativeBattleStartIssued && readySong != null && roomStatus == "recruiting")
                    {
                        readyPending = true;
                        nextReadyRetry = default(DateTime);
                    }
                }
                else if (type == "peerConnected")
                {
                    // A seat can be reserved before this cabinet's WebSocket opens.
                    // In that order peerJoined was missed, so peerConnected carries
                    // the same bounded display profile as a second recovery source.
                    IngestPeerProfile(message);
                    readyAcknowledged = false;
                }
                else if (type == "peerJoined")
                {
                    IngestPeerProfile(message);
                    readyAcknowledged = false;
                }
                else if (type == "start")
                {
                    // Legacy relay-scheduled start from a room whose host still runs the
                    // old gated client; local start timing no longer waits on it.
                    roomStatus = "playing";
                    remotePlayScores.Clear();
                    hasLocalPlayScore = false;
                    nextScoreRefresh = DateTime.MinValue;
                    ModLog.Msg("Relay confirmed a legacy scheduled start.");
                }
                else if (type == "playStarted")
                {
                    roomStatus = "playing";
                    remotePlayScores.Clear();
                    hasLocalPlayScore = false;
                    nextScoreRefresh = DateTime.MinValue;
                }
                else if (type == "scoreState")
                {
                    IngestRemotePlayScore(message);
                }
                else if (type == "pong")
                {
                    long elapsed = UtcMilliseconds() - (long)message["sentAt"];
                    if (elapsed >= 0 && elapsed < 60000) rttMs = ClampReadyRtt((int)elapsed);
                }
                else if (type == "playEnded" || type == "playCancelled")
                {
                    roomStatus = "recruiting";
                    nativeWasPlaying = false;
                    MarkPlayEndedQuietly(type == "playCancelled");
                    readyPending = false;
                    readyRequested = false;
                    readyAcknowledged = false;
                    nativeBattleStartPending = false;
                    nativeBattleStartIssued = false;
                    readySong = null;
                    ClearChartState();
                    nextScoreRefresh = DateTime.MinValue;
                }
                else if (type == "error")
                {
                    string code = message.Value<string>("code");
                    if (code == "bad_rtt")
                    {
                        // Ignore a delayed rejection for a Ready that the player already
                        // cancelled by returning to the room settings.
                        if (!readyRequested) return;
                        rttMs = 0;
                        readyAcknowledged = false;
                        readyPending = true;
                        nextReadyRetry = DateTime.UtcNow.AddMilliseconds(250);
                        relay.Ping(UtcMilliseconds());
                        ModLog.Warning("Relay rejected Ready RTT; clamped retry scheduled.");
                    }
                    else ModLog.Warning("Relay rejected room action: " + (code ?? "unknown"));
                }
            }
            catch (Exception error)
            {
                ReportFailure("Relay control message", error);
                LeaveRoom(true, true, nativeBattleStartPending || nativeBattleStartAborted);
            }
        }

        // snapshot/readyState always carry the full player list. Start acknowledgement
        // and chart equality are judged over every connected Ready player, including
        // conflicts between two remote players on a difficulty this cabinet did not pick.
        private void IngestPlayers(JObject message)
        {
            JArray players = message["players"] as JArray;
            if (players == null) return;
            uint self = relay != null ? relay.PeerId : 0;
            readyAcknowledged = ReadyStateAcknowledgesEveryPlayer(players, self, readySong);
            peerCharts.Clear();
            remotePlayerProfiles.Clear();
            foreach (JToken token in players)
            {
                JObject player = token as JObject;
                if (player == null) continue;
                uint? peerId = player.Value<uint?>("peerId");
                if (peerId == null || peerId < 1 || peerId > 4) continue;
                // Display data belongs to the reserved seat, not only to its current
                // socket. Keeping it from the first snapshot closes the host-first
                // connection race while Ready/chart gates below stay connected-only.
                IngestPeerProfile(player);
                if (player.Value<bool?>("connected") != true) continue;
                if (player.Value<bool?>("ready") != true) continue;
                int? songId = player.Value<int?>("songId");
                int? difficulty = player.Value<int?>("selectedDifficulty");
                string sha256 = player.Value<string>("chartSha256");
                if (songId == null || difficulty == null || string.IsNullOrEmpty(sha256)) continue;
                PeerChart chart = new PeerChart();
                chart.SongId = songId.Value;
                chart.Difficulty = difficulty.Value;
                chart.Sha256 = sha256;
                peerCharts[peerId.Value] = chart;
            }
            SetChartConflict(PlayersHaveChartConflict(players,
                readySong == null ? 0 : readySong.Value<int>("id")));
            TryCompleteNativeStart();
        }

        private void IngestPeerProfile(JObject message)
        {
            uint? peerId = message == null ? null : message.Value<uint?>("peerId");
            if (peerId == null || peerId < 1 || peerId > 4 || relay == null || peerId.Value == relay.PeerId) return;
            string playerName = message.Value<string>("name");
            int cardId = BoundedProfileValue(message, "cardId", 0, 999999);
            if (System.String.IsNullOrEmpty(playerName) && cardId == 0) return;
            remotePlayerProfiles[peerId.Value] = new RemotePlayerProfile
            {
                PlayerName = playerName,
                CardId = cardId
            };
        }

        private static int BoundedProfileValue(JObject player, string name, int min, int max)
        {
            int? value = player == null ? null : player.Value<int?>(name);
            return value != null && value.Value >= min && value.Value <= max ? value.Value : min;
        }

        internal bool VerifyReadyChart(int musicId, int difficulty, string path)
        {
            if (!activeOnlineMode) return true;
            bool matches = ReadyChartMatches(readySong, musicId, difficulty, path);
            if (matches) return true;
            ModLog.Warning("Ready chart verification blocked score loading; the online room will be cancelled.");
            chartAbortMessage = "The chart selected for play no longer matches the verified Ready chart. Recruit again.";
            chartAbortPending = true;
            if (nativeBattleStartPending || nativeBattleStartIssued) nativeBattleStartAborted = true;
            return false;
        }

        internal static bool ReadyChartMatches(JObject verifiedSong, int musicId, int difficulty, string path)
        {
            if (verifiedSong == null || verifiedSong.Value<int?>("id") != musicId ||
                verifiedSong.Value<int?>("selectedDifficulty") != difficulty ||
                System.String.IsNullOrEmpty(path) || !Path.IsPathRooted(path)) return false;
            string expected = SelectedChartSha256(verifiedSong, difficulty);
            if (System.String.IsNullOrEmpty(expected)) return false;
            try
            {
                return System.String.Equals(GameSnapshot.HashFile(path), expected, StringComparison.Ordinal);
            }
            catch { return false; }
        }

        private void EvaluateChartConflict()
        {
            bool conflict = false;
            if (readySong != null)
            {
                int expectedSongId = readySong.Value<int>("id");
                Dictionary<string, string> hashes = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (PeerChart peer in peerCharts.Values)
                {
                    if (peer.SongId != expectedSongId) { conflict = true; break; }
                    string key = peer.SongId + ":" + peer.Difficulty;
                    string existing;
                    if (hashes.TryGetValue(key, out existing) &&
                        !string.Equals(existing, peer.Sha256, StringComparison.Ordinal))
                    {
                        conflict = true;
                        break;
                    }
                    hashes[key] = peer.Sha256;
                }
            }
            SetChartConflict(conflict);
        }

        internal static bool ReadyStateAcknowledgesEveryPlayer(JArray players, uint self, JObject localReadySong)
        {
            if (players == null || self == 0 || localReadySong == null) return false;
            int? ownSongId = localReadySong.Value<int?>("id");
            int? ownDifficulty = localReadySong.Value<int?>("selectedDifficulty");
            string ownSha256 = ownDifficulty == null ? null : SelectedChartSha256(localReadySong, ownDifficulty.Value);
            if (ownSongId == null || ownDifficulty == null || System.String.IsNullOrEmpty(ownSha256)) return false;
            int connectedCount = 0;
            bool selfAcknowledged = false;
            foreach (JToken token in players)
            {
                JObject player = token as JObject;
                if (player == null || player.Value<bool?>("connected") != true) continue;
                connectedCount++;
                uint? peerId = player.Value<uint?>("peerId");
                int? songId = player.Value<int?>("songId");
                int? difficulty = player.Value<int?>("selectedDifficulty");
                string sha256 = player.Value<string>("chartSha256");
                if (peerId == null || player.Value<bool?>("ready") != true || songId == null ||
                    difficulty == null || System.String.IsNullOrEmpty(sha256)) return false;
                if (peerId.Value == self)
                {
                    if (songId != ownSongId || difficulty != ownDifficulty ||
                        !System.String.Equals(sha256, ownSha256, StringComparison.Ordinal)) return false;
                    selfAcknowledged = true;
                }
            }
            return connectedCount >= 2 && selfAcknowledged;
        }

        internal static bool PlayersHaveChartConflict(JArray players, int expectedSongId)
        {
            if (players == null || expectedSongId <= 0) return false;
            Dictionary<string, string> hashes = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (JToken token in players)
            {
                JObject player = token as JObject;
                if (player == null || player.Value<bool?>("connected") != true ||
                    player.Value<bool?>("ready") != true) continue;
                int? songId = player.Value<int?>("songId");
                int? difficulty = player.Value<int?>("selectedDifficulty");
                string sha256 = player.Value<string>("chartSha256");
                if (songId == null || difficulty == null || System.String.IsNullOrEmpty(sha256)) continue;
                if (songId.Value != expectedSongId) return true;
                string key = songId.Value + ":" + difficulty.Value;
                string existing;
                if (hashes.TryGetValue(key, out existing) &&
                    !System.String.Equals(existing, sha256, StringComparison.Ordinal)) return true;
                hashes[key] = sha256;
            }
            return false;
        }

        internal static int ClampReadyRtt(int value)
        {
            return Math.Max(0, Math.Min(3000, value));
        }

        private void SetChartConflict(bool conflict)
        {
            if (conflict == chartConflict) return;
            chartConflict = conflict;
            if (conflict)
            {
                ModLog.Warning("Relay peers report different files for the same official chart; the host start is blocked until they match again.");
                if (nativeBattleStartPending)
                    AbortNativeStart("Players have different files for the same official chart. Recruit again.");
            }
            else ModLog.Msg("Relay chart files match again; the host start is allowed.");
        }

        private void ClearChartState()
        {
            // Silent on purpose: leaving the room or finishing a play is routine, and
            // a "charts match again" line there would be noise.
            peerCharts.Clear();
            chartConflict = false;
        }

        private void MarkPlayEndedQuietly(bool cancelNative)
        {
            playEndedQuietly = true;
            cancelNativeAfterQuietLeave = cancelNative;
            playEndedAt = DateTime.UtcNow;
        }

        private static bool NativeResultReached()
        {
            try { return Party.get() != null && Party.get().isResult(); }
            catch (Exception error)
            {
                ModLog.Warning("Native Party result probe failed: " + error.GetType().Name);
                return false;
            }
        }

        private static string SelectedChartSha256(JObject song, int difficulty)
        {
            JArray charts = song["charts"] as JArray;
            if (charts == null) return null;
            foreach (JToken token in charts)
            {
                if (token.Value<int?>("difficulty") == difficulty)
                    return token.Value<string>("sha256");
            }
            return null;
        }

        private void TryStartNativeSession()
        {
            try
            {
                Party.IManager manager = Party.get();
                if (manager == null || matchedSong == null) return;
                int musicId = (int)matchedSong["id"];
                int difficulty = (int)matchedSong["selectedDifficulty"];
                DataManager data = SingletonStateMachine<DataManager, DataManager.EState>.instance;
                MU3.Data.MusicData music = data.getMusicData(musicId);
                if (music == null) throw new InvalidOperationException("Matched official song is unavailable locally.");
                UserManager user = Singleton<UserManager>.instance;
                Party.UserInfo info = new Party.UserInfo(user.UserId, user.userDetail,
                    user.userOption, music, (FumenDifficulty)difficulty);
                bool host = relay.PeerId == hostPeerId;
                uint memberPacketBaseline = manager.getClientRecvCount(Command.PartyMemberInfo);
                bool started = host
                    ? manager.startRecruit(info, Party.RecruitStance.EveryOne)
                    : manager.startJoin(new IpAddress(0x0aff0000u | hostPeerId), info);
                if (!started)
                {
                    if (DateTime.UtcNow >= nativePartyStartDeadline)
                        throw new InvalidOperationException("Native Party did not start before timeout.");
                    return;
                }
                nativePartyStartPending = false;
                nativeJoinPending = true;
                nativePartyUserInfo = info;
                nativeMemberPacketBaseline = memberPacketBaseline;
                nativeMemberRefreshAttempts = 0;
                nextNativeMemberRefresh = DateTime.UtcNow.AddMilliseconds(500);
                nativeJoinDeadline = DateTime.UtcNow.AddSeconds(10);
            }
            catch (Exception error)
            {
                ReportFailure("Native Party setup", error);
                LeaveRoom(true, true, false);
            }
        }

        private void TryEnterNativeRoom()
        {
            try
            {
                Party.IManager manager = Party.get();
                if (manager == null || !manager.isJoinAndActive())
                {
                    if (DateTime.UtcNow >= nativeJoinDeadline)
                        throw new InvalidOperationException("Native Party self-join timed out.");
                    return;
                }
                uint memberPackets = manager.getClientRecvCount(Command.PartyMemberInfo);
                if (!MemberSnapshotAdvanced(memberPackets, nativeMemberPacketBaseline))
                {
                    if (nativePartyUserInfo != null && nativeMemberRefreshAttempts < 3 &&
                        DateTime.UtcNow >= nextNativeMemberRefresh)
                    {
                        nativeMemberRefreshAttempts++;
                        nextNativeMemberRefresh = DateTime.UtcNow.AddSeconds(1);
                        manager.sendUserInfo(nativePartyUserInfo);
                    }
                    if (DateTime.UtcNow >= nativeJoinDeadline)
                        throw new InvalidOperationException("Native Party member confirmation timed out.");
                    return;
                }
                Party.PartyMemberInfo members = manager.getPartyMemberInfo();
                uint ownAddress = 0x0aff0000u | relay.PeerId;
                bool host = relay.PeerId == hostPeerId;
                bool present = false;
                if (members != null && members._userInfo != null)
                {
                    if (host)
                        present = members._userInfo.Length > 0 && members._userInfo[0] != null &&
                            members._userInfo[0]._isJoin && members._userInfo[0]._ipAddress == ownAddress;
                    else
                        foreach (Party.UserInfo member in members._userInfo)
                            if (member != null && member._isJoin && member._ipAddress == ownAddress)
                            { present = true; break; }
                }
                if (!present)
                {
                    if (DateTime.UtcNow >= nativeJoinDeadline)
                        throw new InvalidOperationException("Native Party member confirmation timed out.");
                    return;
                }
                // A WebSocket snapshot and startRecruit/startJoin are not a joined game
                // room. Enter exactly once, after the native roster confirms this cabinet.
                if (!nativeDirectoryJoin)
                    NativeMatching.EnterRoom(nativeController, host);
                nativeJoinPending = false;
                nativeRoomJoined = true;
                ModLog.Msg("Relay room joined through native matching.");
            }
            catch (Exception error)
            {
                ReportFailure("Native Party self-join", error);
                LeaveRoom(true, true, false);
            }
        }

        internal static bool MemberSnapshotAdvanced(uint currentCount, uint attemptBaseline)
        {
            // Party Analyzer counters live for the process lifetime. A non-zero count
            // from the previous room cannot prove that this room received its roster.
            return currentCount != attemptBaseline;
        }

        internal static bool IsCurrentReadyWork(int completedEpoch, int currentEpoch,
            int completedSelectionRevision, int currentSelectionRevision)
        {
            return completedEpoch == currentEpoch && completedSelectionRevision == currentSelectionRevision;
        }

        internal static string DescribeFailure(Exception error)
        {
            // Never log the service URL, identity values, client key, session or room ticket.
            if (error == null) return "unknown failure";
            if (error is OfficialChartMissingException) return "an official chart file is missing";
            if (error is UnauthorizedAccessException) return "an official chart cannot be read";
            if (error is IdentityBindingChangedException)
                return "game identity differs from its registered binding; use the original AIME and title server or request administrator reset";
            if (error is InvalidOperationException && error.Message.StartsWith("Game identity is missing ", StringComparison.Ordinal))
                return error.Message;
            if (error is InvalidOperationException && error.Message.StartsWith("Configure a valid ", StringComparison.Ordinal))
                return error.Message;
            if (error is InvalidOperationException && error.Message.StartsWith("Service rejected request:", StringComparison.Ordinal))
                return error.Message;
            // The native transport suffix carries only redacted WinHTTP error
            // names (Timeout, ConnectFailure, NativeErrorN), never hosts or URLs.
            if (error is InvalidOperationException && error.Message.StartsWith("Unable to reach the service:", StringComparison.Ordinal))
                return error.Message;
            if (error is InvalidOperationException && error.Message.StartsWith("Relay response was ", StringComparison.Ordinal))
                return error.Message;
            FileNotFoundException missing = FindSafeMissingAssembly(error);
            if (missing != null)
            {
                TypeInitializationException initializer = FindTypeInitialization(error);
                return initializer == null
                    ? "missing runtime assembly: " + missing.FileName
                    : "runtime initializer " + initializer.TypeName + " is missing assembly: " + missing.FileName;
            }

            // Messages and file names can contain service, user or launcher data. A
            // short type chain still distinguishes missing dependencies from chart
            // data and preserves the useful inner cause of loader startup failures.
            string detail = "";
            int depth = 0;
            for (Exception current = error; current != null && depth < 4; current = current.InnerException, depth++)
            {
                if (detail.Length != 0) detail += " -> ";
                detail += current.GetType().Name;
            }
            return detail;
        }

        private static FileNotFoundException FindSafeMissingAssembly(Exception error)
        {
            for (Exception current = error; current != null; current = current.InnerException)
            {
                FileNotFoundException missing = current as FileNotFoundException;
                if (missing == null || System.String.IsNullOrEmpty(missing.FileName)) continue;
                if (missing.FileName.IndexOf('\\') >= 0 || missing.FileName.IndexOf('/') >= 0) return null;
                return missing;
            }
            return null;
        }

        private static TypeInitializationException FindTypeInitialization(Exception error)
        {
            for (Exception current = error; current != null; current = current.InnerException)
            {
                TypeInitializationException initializer = current as TypeInitializationException;
                if (initializer != null && !System.String.IsNullOrEmpty(initializer.TypeName)) return initializer;
            }
            return null;
        }

        private static void ReportFailure(string stage, Exception error)
        {
            string detail = DescribeFailure(error);
            ModLog.Warning(stage + ": " + detail);
        }

        private static void ReportConfigurationFailure(string step, Exception error)
        {
            ReportFailure("Configuration (" + step + ")", error);
            for (Exception current = error; current != null; current = current.InnerException)
            {
                FileNotFoundException missing = current as FileNotFoundException;
                if (missing == null || string.IsNullOrEmpty(missing.FileName)) continue;
                ModLog.Warning("Configuration missing path or assembly: " + missing.FileName);
                break;
            }
        }

#if BEPINEX
        private void OnApplicationQuit()
        {
            Shutdown();
        }

        private void OnDestroy()
        {
            Shutdown();
        }
#else
        public override void OnApplicationQuit()
        {
            Shutdown();
        }
#endif

        private void Shutdown()
        {
            if (shutdown) return;
            shutdown = true;
            CancelDirectoryWork(true);
            if (relay != null) relay.Dispose();
            NativeTransport.Detach();
            Instance = null;
        }

        private static long UtcMilliseconds()
        {
            return (DateTime.UtcNow.Ticks - new DateTime(1970, 1, 1).Ticks) / TimeSpan.TicksPerMillisecond;
        }
    }
}
