using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;

namespace OngekiCollab.Mod
{
    // Public directory rooms are represented in the stock recruit list by display-only
    // 10.254.x.x addresses. They are never sent to Party or used as relay peer addresses;
    // a click resolves the address back to the room UUID before Match is called.
    internal sealed class RelayDirectory
    {
        internal sealed class Entry
        {
            public uint Address;
            public string RoomId;
            public int MusicId;
            public int Difficulty;
            public string PlayerName;
            public int CardId;
            public int JoinCount;
            public long CreatedAtMilliseconds;
        }

        private const int MaximumEntries = 50;
        private readonly Dictionary<string, uint> addressByRoom =
            new Dictionary<string, uint>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<uint, string> roomByAddress = new Dictionary<uint, string>();
        private readonly List<Entry> current = new List<Entry>();

        internal static bool IsDirectoryAddress(uint address)
        {
            return (address & 0xffff0000u) == 0x0afe0000u;
        }

        internal static uint StableAddressFor(string roomId, ICollection<uint> occupied)
        {
            if (String.IsNullOrEmpty(roomId)) throw new ArgumentException("Room ID is required.", "roomId");
            byte[] hash;
            using (SHA256 sha = SHA256.Create())
                hash = sha.ComputeHash(Encoding.UTF8.GetBytes(roomId));
            ushort seed = (ushort)((hash[0] << 8) | hash[1]);
            for (int attempt = 0; attempt < 65536; attempt++)
            {
                uint address = 0x0afe0000u | (uint)unchecked((ushort)(seed + attempt));
                if (occupied == null || !occupied.Contains(address)) return address;
            }
            throw new InvalidOperationException("Relay directory address space exhausted.");
        }

        internal void ApplyPage(JObject page, string ownRoomId, HashSet<string> locallyValidatedRooms)
        {
            if (page == null) throw new ArgumentNullException("page");
            if (locallyValidatedRooms == null) throw new ArgumentNullException("locallyValidatedRooms");
            List<Entry> next = new List<Entry>();
            JArray items = page["items"] as JArray;
            if (items != null)
            {
                foreach (JToken token in items)
                {
                    if (next.Count >= MaximumEntries) break;
                    Entry entry = ParseEntry(token, ownRoomId, locallyValidatedRooms);
                    if (entry != null) next.Add(entry);
                }
            }
            next.Sort(delegate(Entry left, Entry right)
            {
                int byTime = left.CreatedAtMilliseconds.CompareTo(right.CreatedAtMilliseconds);
                return byTime != 0 ? byTime : String.Compare(left.RoomId, right.RoomId,
                    StringComparison.OrdinalIgnoreCase);
            });

            Dictionary<string, uint> keptByRoom =
                new Dictionary<string, uint>(StringComparer.OrdinalIgnoreCase);
            Dictionary<uint, string> keptByAddress = new Dictionary<uint, string>();
            foreach (Entry entry in next)
            {
                uint address;
                string mapped;
                if (!addressByRoom.TryGetValue(entry.RoomId, out address) ||
                    !roomByAddress.TryGetValue(address, out mapped) ||
                    !String.Equals(mapped, entry.RoomId, StringComparison.OrdinalIgnoreCase))
                    address = StableAddressFor(entry.RoomId, roomByAddress.Keys);
                // Reserve immediately so two new rooms with the same 16-bit hash seed
                // cannot receive one display address in this page generation.
                roomByAddress[address] = entry.RoomId;
                entry.Address = address;
                keptByRoom[entry.RoomId] = address;
                keptByAddress[address] = entry.RoomId;
            }
            addressByRoom.Clear();
            foreach (KeyValuePair<string, uint> pair in keptByRoom) addressByRoom[pair.Key] = pair.Value;
            roomByAddress.Clear();
            foreach (KeyValuePair<uint, string> pair in keptByAddress) roomByAddress[pair.Key] = pair.Value;
            current.Clear();
            current.AddRange(next);
        }

        internal void Clear()
        {
            current.Clear();
            addressByRoom.Clear();
            roomByAddress.Clear();
        }

        internal void FailPage()
        {
            // Match the Unity recruit board: remove stale visible rooms, but retain
            // their stable display-address assignments for the next successful poll.
            current.Clear();
        }

        internal List<Entry> Snapshot()
        {
            return new List<Entry>(current);
        }

        internal bool TryGet(uint address, out Entry found)
        {
            found = current.Find(delegate(Entry entry) { return entry.Address == address; });
            return found != null;
        }

        private static Entry ParseEntry(JToken token, string ownRoomId,
            HashSet<string> locallyValidatedRooms)
        {
            JObject item = token as JObject;
            if (item == null) return null;
            string roomId = item.Value<string>("id");
            if (String.IsNullOrEmpty(roomId) || item.Value<string>("status") != "recruiting" ||
                String.Equals(roomId, ownRoomId, StringComparison.OrdinalIgnoreCase) ||
                !locallyValidatedRooms.Contains(roomId)) return null;
            JToken song = item["song"];
            int? musicId = song == null ? null : song.Value<int?>("id");
            int? difficulty = song == null ? null : song.Value<int?>("selectedDifficulty");
            int? playerCount = item.Value<int?>("playerCount");
            int? maxPlayers = item.Value<int?>("maxPlayers");
            if (musicId == null || musicId < 1 || difficulty == null || difficulty < 0 || difficulty > 4 ||
                playerCount == null || maxPlayers == null || playerCount < 1 ||
                maxPlayers < 1 || playerCount >= maxPlayers) return null;
            JArray players = item["players"] as JArray;
            if (players == null || players.Count == 0) return null;
            JToken host = players[0];
            foreach (JToken player in players)
                if (player.Value<int?>("peerId") == 1) { host = player; break; }
            string playerName = host.Value<string>("name");
            if (String.IsNullOrEmpty(playerName) || playerName.Trim().Length == 0) playerName = "Player";
            int cardId = Bounded(host, "cardId", 0, 999999);
            return new Entry
            {
                RoomId = roomId,
                MusicId = musicId.Value,
                Difficulty = difficulty.Value,
                PlayerName = playerName,
                CardId = cardId,
                JoinCount = playerCount.Value,
                CreatedAtMilliseconds = item.Value<long?>("createdAt") ?? 0
            };
        }

        private static int Bounded(JToken token, string name, int min, int max)
        {
            int? value = token == null ? null : token.Value<int?>(name);
            return value != null && value.Value >= min && value.Value <= max ? value.Value : min;
        }
    }
}
