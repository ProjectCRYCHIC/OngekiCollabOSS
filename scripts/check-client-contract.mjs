import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = join(root, "contracts", "public-collab-v1", "contract.json");
const digestPath = join(root, "contracts", "public-collab-v1", "digest.json");
const bytes = readFileSync(contractPath);
const contract = JSON.parse(bytes.toString("utf8"));
const digest = JSON.parse(readFileSync(digestPath, "utf8"));
const actual = createHash("sha256").update(bytes).digest("hex");

function check(value, message) {
  if (!value) throw new Error(message);
}

function integer(value, label, minimum = 0) {
  check(Number.isInteger(value) && value >= minimum, `${label} must be an integer >= ${minimum}.`);
  return value;
}

function numericConstant(source, name) {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*([^;]+);`));
  check(match, `Missing implementation constant ${name}.`);
  const expression = match[1].trim();
  check(/^[0-9+*/()\s-]+$/.test(expression), `Unsafe implementation constant ${name}.`);
  return Function(`"use strict"; return (${expression});`)();
}

check(contract.contract === "public-collab-client" && contract.version === 1 && contract.protocolVersion === 1,
  "Unexpected public Collab contract identity.");
check(/^[0-9a-f]{64}$/.test(digest.currentDigest) && digest.algorithm === "sha256" &&
  Array.isArray(digest.acceptedDigests) && digest.acceptedDigests.every((item) => /^[0-9a-f]{64}$/.test(item)) &&
  digest.currentDigest === actual && digest.acceptedDigests.includes(actual),
  "Public Collab contract digest is stale or malformed.");

const frame = contract.binaryFrame;
check(frame.magicHex === "4f43" && frame.version === 1 &&
  integer(frame.headerBytes, "binaryFrame.headerBytes", 1) === 22 &&
  integer(frame.maximumPayloadBytes, "binaryFrame.maximumPayloadBytes", 1) === 4096,
  "Binary frame header contract is invalid.");
check(JSON.stringify(frame.kinds) === JSON.stringify({ advertiseDatagram: 1, partyStreamOpen: 2,
  partyStreamData: 3, partyStreamClose: 4 }) &&
  JSON.stringify(frame.datagramPorts) === JSON.stringify([50000, 50002]),
  "Binary frame kind or datagram-port contract is invalid.");
const golden = Buffer.from(frame.goldenHex, "hex");
check(/^[0-9a-f]+$/.test(frame.goldenHex) && frame.goldenHex.length % 2 === 0 &&
  golden.length === frame.headerBytes + 3 && golden.readUInt16BE(0) === 0x4f43 &&
  golden[2] === frame.version && golden[3] === frame.kinds.advertiseDatagram &&
  golden.readUInt32BE(4) === 1 && golden.readUInt32BE(8) === contract.peers.broadcastTarget &&
  golden.readUInt32BE(12) === 50002 && golden.readUInt32BE(16) === 1 &&
  golden.readUInt16BE(20) === 3 && golden.subarray(22).toString("hex") === "010203",
  "Binary frame golden vector is invalid.");

check(contract.peers.minimum === 1 && contract.peers.maximum === 4 &&
  contract.peers.virtualIpv4Prefix === "10.255.0." && contract.peers.broadcastTarget === 0 &&
  contract.peers.directoryIpv4Cidr === "10.254.0.0/16", "Peer-address contract is invalid.");
for (const [name, value] of Object.entries(contract.limits)) integer(value, `limits.${name}`, 1);
for (const [name, value] of Object.entries(contract.timeoutsMilliseconds))
  integer(value, `timeoutsMilliseconds.${name}`, 1);
check(contract.behavior.webSocketRetries === 1 && contract.behavior.nativeStartReadFailures === 3 &&
  contract.behavior.sendByteAccounting === "binaryPayloadOnly", "Behavior contract is invalid.");

const modDirectory = readFileSync(join(root, "mod", "src", "RelayDirectory.cs"), "utf8");
const modClient = readFileSync(join(root, "mod", "src", "RelayClient.cs"), "utf8");
const modTransport = readFileSync(join(root, "mod", "src", "NativeTransport.cs"), "utf8");
const modSocket = readFileSync(join(root, "mod", "src", "WinHttpNative.cs"), "utf8");
const modEntry = readFileSync(join(root, "mod", "src", "ModEntry.cs"), "utf8");
const workerProtocol = readFileSync(join(root, "src", "core", "protocol.ts"), "utf8");
const workerEngine = readFileSync(join(root, "src", "core", "rooms", "engine.ts"), "utf8");

check(numericConstant(modDirectory, "MaximumEntries") === contract.limits.directoryEntries,
  "Standalone directory capacity differs from the contract.");
check(modClient.includes(`rooms?limit=${contract.limits.directoryEntries}`),
  "Standalone directory request limit differs from the contract.");
check(numericConstant(modClient, "MaximumQueuedFrames") === contract.limits.sendFrames &&
  numericConstant(modClient, "MaximumQueuedBytes") === contract.limits.sendBytes &&
  numericConstant(modClient, "ProtocolVersion") === contract.protocolVersion &&
  numericConstant(modClient, "MaximumControlBytes") === contract.limits.controlMessageBytes &&
  numericConstant(modClient, "MaximumDirectoryResponseBytes") === contract.limits.directoryResponseBytes &&
  modClient.includes("Binary = frame, Size = payload.Length") &&
  modClient.includes('request["protocolVersion"] = ProtocolVersion'),
  "Standalone send queue differs from the contract.");
check(numericConstant(modTransport, "MaximumStreamBufferedBytes") === contract.limits.streamBufferedBytes &&
  numericConstant(modTransport, "MaximumPendingStreams") === contract.limits.pendingStreams &&
  numericConstant(modTransport, "MaximumDatagramsPerSocket") === contract.limits.datagramsPerSocket &&
  modTransport.includes("relay.SendBinary(1, target, port, payload)") &&
  modTransport.includes("return address == null ? 0u : PeerFromIp(address)") &&
  modTransport.includes("if (rejectStream) SendCloseFrameOrFail(sender, streamId)") &&
  modTransport.includes("catch { FailTransport(); }"),
  "Standalone virtual stream limits differ from the contract.");
check(numericConstant(modSocket, "MaximumControlBytes") === contract.limits.controlMessageBytes &&
  modSocket.includes("new UTF8Encoding(false, true)"),
  "Standalone control-message validation differs from the contract.");
check(modEntry.includes(`MaximumMainThreadEvents = ${contract.limits.receiveMessages}`) &&
  modEntry.includes(`Math.Min(${contract.limits.readyRttMilliseconds}, value)`) &&
  modEntry.includes("return ended && (cancelNative || nativeResult)") &&
  !modEntry.includes("ShouldAutoLeaveAfterPlay") && modDirectory.includes("internal void FailPage()"),
  "Standalone lifecycle or receive limits differ from the contract.");
check(modEntry.includes(`AddMilliseconds(${contract.timeoutsMilliseconds.webSocketRetryDelay})`) ||
  modClient.includes(`RoomConnectRetryDelayMilliseconds = ${contract.timeoutsMilliseconds.webSocketRetryDelay}`),
  "Standalone WebSocket retry delay differs from the contract.");
check(modEntry.includes(`nativeBattleStartDeadline = DateTime.UtcNow.AddSeconds(${contract.timeoutsMilliseconds.nativeStartFromRequest / 1000})`) &&
  modEntry.indexOf("DateTime.UtcNow >= nativeBattleStartDeadline") <
    modEntry.indexOf("if (!readyAcknowledged || chartConflict || !HasJoinedNativeRoom) return;"),
  "Standalone native-start deadline differs from the contract.");
check(modClient.includes("response.Body.Length > MaximumDirectoryResponseBytes"),
  "Standalone directory response limit differs from the contract.");
check(numericConstant(workerProtocol, "FRAME_HEADER_BYTES") === frame.headerBytes &&
  numericConstant(workerProtocol, "MAX_FRAME_PAYLOAD") === frame.maximumPayloadBytes &&
  numericConstant(workerProtocol, "COLLAB_PROTOCOL_VERSION") === contract.protocolVersion &&
  numericConstant(workerProtocol, "MAX_CONTROL_MESSAGE_BYTES") === contract.limits.controlMessageBytes &&
  workerProtocol.includes('protocolVersion: integer(raw.protocolVersion, "protocolVersion", COLLAB_PROTOCOL_VERSION, COLLAB_PROTOCOL_VERSION)') &&
  workerProtocol.includes("view.setUint16(0, 0x4f43)") && workerProtocol.includes("view.setUint8(2, 1)") &&
  workerEngine.includes("utf8Size(message) > MAX_CONTROL_MESSAGE_BYTES") &&
  workerEngine.includes("frame.streamId !== 50000 && frame.streamId !== 50002"),
  "Worker control-message validation differs from the contract.");
check(workerEngine.includes("const mergedPlay =") && workerEngine.includes("...play") &&
  workerEngine.includes("finiteNumberOrNull(play?.techScore)"),
  "Worker partial-score merge or null projection differs from the contract.");

const siblingRoot = resolve(root, "..", "ongeki");
const siblingContract = join(siblingRoot, "Sa" + "GEKIPatches", "jp.anontokyo.sa" + "geki.patches",
  "Tests~", "ContractFixtures", "OngekiCollab", "v1", "contract.json");
const requireSibling = process.argv.includes("--require-sibling") || process.env.COLLAB_REQUIRE_SIBLING === "1";
if (existsSync(siblingContract)) {
  check(Buffer.compare(bytes, readFileSync(siblingContract)) === 0,
    "The Unity client's vendored public Collab contract differs from the canonical bytes.");
  const siblingDigest = join(dirname(siblingContract), "digest.json");
  check(existsSync(siblingDigest) &&
    Buffer.compare(readFileSync(digestPath), readFileSync(siblingDigest)) === 0,
    "The Unity client's vendored public Collab digest differs from the canonical bytes.");
} else check(!requireSibling, "The Unity-client sibling checkout is required for strict contract comparison.");

console.log(`Public Collab client contract ${actual} passed.`);
