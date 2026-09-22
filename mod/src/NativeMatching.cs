using System;
using System.Reflection;
#if HARMONY1
using Harmony;
using HarmonyPatch = OngekiCollab.Mod.LegacyHarmonyPatch;
#else
using HarmonyLib;
#endif
using MU3;
using MU3.Collab;
using MU3.Data;
using MU3.DataStudio;
using MU3.Game;
using MU3.Notes;
using MU3.SceneObject;
using MU3.Sequence;
using MU3.Util;
using MU3.ViewData;

namespace OngekiCollab.Mod
{
    // In online mode the game's own controls drive the relay; no mod overlay is required.
    internal static class NativeMatching
    {
        [ThreadStatic]
        private static bool rollbackInProgress;
        private static NotesManager scoreLoadBlocked;

        // Verify the exact OGKR selected at Ready immediately before and after the
        // stock score loader. Both callbacks run on the Unity thread; a failure only
        // schedules room cancellation for the next ModEntry update.
        [HarmonyPatch(typeof(NotesManager), "loadScore")]
        private static class ReadyChartLoadPatch
        {
            private static bool Prefix(NotesManager __instance, SessionInfo sessionInfo,
                ref bool __result, out string __state)
            {
                __state = null;
                // A new load attempt supersedes the previous failed instance. Keeping
                // that old Unity object referenced would serve no gate and leak it.
                scoreLoadBlocked = null;
                if (!NativeTransport.Enabled || ModEntry.Instance == null || sessionInfo.isTutorial) return true;
                if (sessionInfo.musicData == null)
                {
                    ModEntry.Instance.VerifyReadyChart(-1, (int)sessionInfo.musicLevel, null);
                    __result = false;
                    scoreLoadBlocked = __instance;
                    return false;
                }
                DataManager data = SingletonStateMachine<DataManager, DataManager.EState>.instance;
                string path = data == null ? null : data.getOgkrPath(
                    sessionInfo.musicData.id, sessionInfo.musicLevel);
                if (!ModEntry.Instance.VerifyReadyChart(sessionInfo.musicData.id,
                    (int)sessionInfo.musicLevel, path))
                {
                    scoreLoadBlocked = __instance;
                    __result = false;
                    return false;
                }
                __state = path;
                return true;
            }

            private static void Postfix(NotesManager __instance, SessionInfo sessionInfo,
                ref bool __result, string __state)
            {
                if (!__result)
                {
                    scoreLoadBlocked = __instance;
                    return;
                }
                if (__state == null || ModEntry.Instance == null) return;
                if (!ModEntry.Instance.VerifyReadyChart(sessionInfo.musicData.id,
                    (int)sessionInfo.musicLevel, __state))
                {
                    scoreLoadBlocked = __instance;
                    __result = false;
                    return;
                }
                if (System.Object.ReferenceEquals(scoreLoadBlocked, __instance)) scoreLoadBlocked = null;
            }
        }

        [HarmonyPatch(typeof(NotesManager), "update")]
        private static class BlockUnloadedScoreUpdatePatch
        {
            private static bool Prefix(NotesManager __instance)
            {
                return !System.Object.ReferenceEquals(scoreLoadBlocked, __instance);
            }
        }

        // The relay snapshot is the recovery source for static opponent profile
        // fields too. Apply it before UIMatchingInfo copies Party.UserInfo into the
        // battle HUD so a delayed native roster cannot produce blank names/cards.
        [HarmonyPatch(typeof(UIMatchingInfo), "create")]
        private static class RemotePlayerProfilePatch
        {
            private static void Prefix()
            {
                if (NativeTransport.Enabled && ModEntry.Instance != null)
                    ModEntry.Instance.ApplyRemotePlayerProfiles();
            }
        }

        // Native Party publishes a full PartyPlayInfo only after every active member
        // has supplied the same sample number. Capture before that barrier, then merge
        // relay scoreState fallbacks immediately before PlayMusic renders the HUD.
        [HarmonyPatch]
        private static class LocalPlayScorePatch
        {
            private static MethodBase TargetMethod()
            {
                return typeof(PlayMusic).GetMethod("createClientPlayInfo",
                    BindingFlags.Instance | BindingFlags.NonPublic);
            }

            private static void Postfix(Party.ClientPlayInfo __result)
            {
                if (NativeTransport.Enabled && ModEntry.Instance != null)
                    ModEntry.Instance.CaptureLocalPlayScore(__result);
            }
        }

        [HarmonyPatch]
        private static class RemotePlayScorePatch
        {
            private static MethodBase TargetMethod()
            {
                return typeof(PlayMusic).GetMethod("updatePartyPlayInfo",
                    BindingFlags.Instance | BindingFlags.NonPublic);
            }

            private static void Prefix()
            {
                if (NativeTransport.Enabled && ModEntry.Instance != null)
                    ModEntry.Instance.ApplyRemotePlayScores();
            }
        }

        // Party.Manager is private, so the standalone mod targets it by reflection and
        // appends locally validated relay rooms to the copy returned to the stock music
        // selection UI. No synthetic address is ever passed to Party.startJoin.
        [HarmonyPatch]
        private static class DirectoryListPatch
        {
            private static MethodBase TargetMethod()
            {
                Type manager = typeof(Party).GetNestedType("Manager", BindingFlags.NonPublic);
                return manager == null ? null : manager.GetMethod("getRecruitListForMusicList",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            }

            private static void Postfix(ref Party.RecruitList __result)
            {
                ModEntry mod = ModEntry.Instance;
                Party.IManager manager = Party.get();
                if (!NativeTransport.Enabled || mod == null || manager == null || __result == null) return;
                foreach (RelayDirectory.Entry room in mod.SnapshotDirectoryRooms())
                {
                    Party.RecruitInfo info = new Party.RecruitInfo();
                    info._userInfo._isJoin = true;
                    info._userInfo._ipAddress = room.Address;
                    info._userInfo._playerName = room.PlayerName;
                    info._userInfo._cardID = room.CardId;
                    info._userInfo._musicID = room.MusicId;
                    info._userInfo._fumenDif = room.Difficulty;
                    info._musicID = room.MusicId;
                    info._groupID = (int)manager.getGroup();
                    info._eventModeID = manager.getEventMode();
                    info._joinNumber = room.JoinCount;
                    info._partyStance = (int)Party.RecruitStance.EveryOne;
                    info._startTime = DirectoryStartTime(room.CreatedAtMilliseconds);
                    info._recvTime = DateTime.Now;
                    int existing = __result.FindIndex(delegate(Party.RecruitInfo candidate)
                    {
                        return candidate != null && candidate.ipU32 == room.Address;
                    });
                    if (existing >= 0) __result[existing] = info;
                    else __result.Add(info);
                }
            }
        }

        private static DateTime DirectoryStartTime(long unixMilliseconds)
        {
            if (unixMilliseconds <= 0) return DateTime.Now;
            try
            {
                return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)
                    .AddMilliseconds((double)unixMilliseconds).ToLocalTime();
            }
            catch (ArgumentOutOfRangeException) { return DateTime.Now; }
        }

        [HarmonyPatch(typeof(LocalMatchingCtrl), "startJoin")]
        private static class DirectoryJoinPatch
        {
            private static bool Prefix(LocalMatchingCtrl __instance, int index,
                FumenDifficulty fumenDif, ref bool __result)
            {
                if (!NativeTransport.Enabled || ModEntry.Instance == null) return true;
                uint address = __instance.getHostIPByIndex(index);
                if (!RelayDirectory.IsDirectoryAddress(address)) return true;
                __result = ModEntry.Instance.BeginNativeDirectoryMatch(__instance, address, fumenDif);
                return false;
            }
        }

        [HarmonyPatch(typeof(LocalMatchingCtrl), "isWaitRequestResult")]
        private static class DirectoryWaitPatch
        {
            private static void Postfix(ref bool __result)
            {
                if (NativeTransport.Enabled && ModEntry.Instance != null &&
                    ModEntry.Instance.NativeDirectoryJoinPending) __result = true;
            }
        }

        // The stock confirm screen asks for a second press before calling pushMatching.
        // In online mode the first native Recruit press starts the relay request directly.
        [HarmonyPatch(typeof(Scene_32_PrePlayMusic_Confirm), "Execute_Select")]
        private static class FirstRecruitPressPatch
        {
            private static readonly FieldInfo SelectorField = AccessTools.Field(
                typeof(Scene_32_PrePlayMusic_Confirm), "_selector");
            private static readonly FieldInfo SceneField = AccessTools.Field(
                typeof(Scene_32_PrePlayMusic_Confirm), "_sceneCommonObject");
            private static readonly FieldInfo MusicField = AccessTools.Field(
                typeof(Scene_32_PrePlayMusic_Confirm), "_musicViewData");

            private static bool Prefix(Scene_32_PrePlayMusic_Confirm __instance)
            {
                if (!NativeTransport.Enabled || ModEntry.Instance == null) return true;
                if (SelectorField == null || SceneField == null || MusicField == null) return true;
                UISelector selector = SelectorField.GetValue(__instance) as UISelector;
                if (selector == null || !selector.isPressed || selector.selectIndex != 0) return true;
                Scene_32_PrePlayMusic scene = SceneField.GetValue(__instance) as Scene_32_PrePlayMusic;
                MusicViewData view = MusicField.GetValue(__instance) as MusicViewData;
                if (scene == null || scene.localMatchingCtrl == null || view == null || view.data == null ||
                    !scene.localMatchingCtrl.canStartRecruit()) return true;
                ModEntry.Instance.BeginNativeMatch(scene.localMatchingCtrl, view.data, __instance._fumenDifficulty);
                return false;
            }
        }

        public static void EnterRoom(LocalMatchingCtrl controller, bool host)
        {
            if (controller == null) throw new InvalidOperationException("The native matching screen is no longer available.");
            FieldInfo field = AccessTools.Field(typeof(LocalMatchingCtrl), "_entryRoomCtrl");
            object entry = field == null ? null : field.GetValue(controller);
            MethodInfo method = entry == null ? null : entry.GetType().GetMethod(
                host ? "enterMatchingRoomAsHost" : "enterMatchingRoomAsClient",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
                null, new Type[] { typeof(bool) }, null);
            if (method == null) throw new InvalidOperationException("The native matching screen is incompatible.");
            method.Invoke(entry, new object[] { true });
        }

        public static void RollbackToSongSelect(LocalMatchingCtrl controller)
        {
            if (controller == null || rollbackInProgress) return;
            rollbackInProgress = true;
            try { controller.cancelMatchingAndSelectMusic(); }
            catch { }
            finally { rollbackInProgress = false; }
        }

        [HarmonyPatch(typeof(LocalMatchingCtrl), "pushMatching")]
        private static class RecruitPatch
        {
            private static bool Prefix(LocalMatchingCtrl __instance, MU3.Data.MusicData musicData, FumenDifficulty fumenDif)
            {
                if (!NativeTransport.Enabled) return true;
                ModEntry mod = ModEntry.Instance;
                if (mod != null) mod.BeginNativeMatch(__instance, musicData, fumenDif);
                return false;
            }
        }

        [HarmonyPatch(typeof(LocalMatchingCtrl), "canStartRecruit")]
        private static class RecruitAvailablePatch
        {
            private static void Postfix(ref bool __result)
            {
                if (NativeTransport.Enabled && ModEntry.Instance != null && ModEntry.Instance.NativeMatchPending)
                    __result = false;
            }
        }

        [HarmonyPatch(typeof(LocalMatchingCtrl), "finishSetting")]
        private static class ReadyPatch
        {
            private static void Postfix()
            {
                if (NativeTransport.Enabled && ModEntry.Instance != null) ModEntry.Instance.NativeReady();
            }
        }

        [HarmonyPatch(typeof(LocalMatchingCtrl), "battleStart")]
        private static class StartPatch
        {
            private static bool Prefix()
            {
                if (NativeTransport.Enabled && ModEntry.Instance != null)
                    return !ModEntry.Instance.TryRequestNativeStart();
                return true;
            }
        }

        [HarmonyPatch(typeof(LocalMatchingCtrl), "updateMyUserInfo")]
        private static class ReadySelectionPatch
        {
            private static void Postfix(MU3.Data.MusicData musicData, FumenDifficulty cursorfumenDif)
            {
                if (NativeTransport.Enabled && ModEntry.Instance != null)
                    ModEntry.Instance.NativeSelectionChanged(musicData, cursorfumenDif);
            }
        }

        [HarmonyPatch(typeof(LocalMatchingCtrl), "cancelClientOK")]
        private static class UnreadyPatch
        {
            private static void Postfix()
            {
                if (NativeTransport.Enabled && ModEntry.Instance != null)
                    ModEntry.Instance.NativeUnready();
            }
        }

        // Execute_HostStart normally advances to HostWaitParty immediately after the
        // LocalMatchingCtrl call. In online mode that call only queues the request, so
        // suppress the original method until Party.battleStart was actually issued.
        [HarmonyPatch]
        private static class HostStartScenePatch
        {
            private static readonly FieldInfo SceneField = AccessTools.Field(
                typeof(Scene_32_PrePlayMusic_Confirm), "_sceneCommonObject");
            private static readonly MethodInfo SetNextStateMethod = FindMethod(
                typeof(Scene_32_PrePlayMusic_Confirm), "setNextState");

            private static MethodBase TargetMethod()
            {
                return FindMethod(typeof(Scene_32_PrePlayMusic_Confirm), "Execute_HostStart");
            }

            private static MethodInfo FindMethod(Type type, string name)
            {
                while (type != null)
                {
                    MethodInfo method = type.GetMethod(name,
                        BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic |
                        BindingFlags.DeclaredOnly);
                    if (method != null) return method;
                    type = type.BaseType;
                }
                return null;
            }

            private static bool Prefix(Scene_32_PrePlayMusic_Confirm __instance)
            {
                if (!NativeTransport.Enabled || ModEntry.Instance == null) return true;
                ModEntry mod = ModEntry.Instance;
                if (SetNextStateMethod == null || SceneField == null) return true;
                if (mod.PollNativeStartAborted || !mod.HasJoinedNativeRoom)
                {
                    SetNextStateMethod.Invoke(__instance,
                        new object[] { Scene_32_PrePlayMusic_Confirm.EState.SelectAgain });
                    return false;
                }
                if (!LocalMatchingCtrl.isWaitSettingAsHost())
                {
                    Scene_32_PrePlayMusic scene = SceneField.GetValue(__instance) as Scene_32_PrePlayMusic;
                    if (scene == null || scene.localMatchingCtrl == null) return true;
                    scene.localMatchingCtrl.battleStart();
                    if (mod.PollNativeStartIssued)
                        SetNextStateMethod.Invoke(__instance,
                            new object[] { Scene_32_PrePlayMusic_Confirm.EState.HostWaitParty });
                }
                return false;
            }
        }

        [HarmonyPatch]
        private static class CancelPatch
        {
            private static MethodBase TargetMethod()
            {
                Type entry = typeof(LocalMatchingCtrl).GetNestedType("EntryRoomCtrl", BindingFlags.NonPublic);
                return entry == null ? null : entry.GetMethod("cancelMatchingAndSelectMusic",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            }

            private static void Prefix()
            {
                if (!rollbackInProgress && NativeTransport.Enabled && ModEntry.Instance != null)
                    ModEntry.Instance.NativeCancelled();
            }
        }

        [HarmonyPatch(typeof(LocalMatchingCtrl), "battleSingle")]
        private static class SinglePlayPatch
        {
            private static void Postfix()
            {
                if (NativeTransport.Enabled && ModEntry.Instance != null) ModEntry.Instance.NativeCancelled();
            }
        }

        // Chart verification can end PlayMusic before CalcResult initializes reward.
        // Give the stock result method an empty reward so it follows its zero-reward
        // exit path without granting anything or dereferencing null.
        [HarmonyPatch]
        private static class MissingResultRewardPatch
        {
            private static MethodBase TargetMethod()
            {
                return typeof(Scene_37_Result_Score).GetMethod("TechReward_Init",
                    BindingFlags.Instance | BindingFlags.NonPublic);
            }

            private static void Prefix()
            {
                PlayInfo playInfo = Singleton<PlayInfo>.instance;
                if (playInfo == null || playInfo.sessionResult == null || playInfo.sessionResult.reward != null) return;
                playInfo.sessionResult.reward = new MU3.Battle.Reward();
                ModLog.Warning("Result reward was unavailable; skipping reward presentation.");
            }
        }
    }
}
