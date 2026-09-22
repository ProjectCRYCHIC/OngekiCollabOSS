import type Redis from "ioredis";
import { runCleanup } from "../../../core/cleanup.js";
import type { CleanupStore } from "../../../core/ports.js";

const JOBS_KEY = "collab:jobs";
const RETRIES_KEY = "collab:job-retries";
const CLAIM_LUA = `local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 16)
local claimed = {}
for i = 1, #due do
  if redis.call('ZREM', KEYS[1], due[i]) == 1 then claimed[#claimed + 1] = due[i] end
end
return claimed`;

interface RoomAlarmJob { kind: "room-alarm"; roomId: string }

/** Delayed jobs and periodic work for the self-hosted runtime. The ZSET member
 *  is the room id, so re-scheduling an alarm overwrites the previous one just
 *  like a Durable Object's single alarm slot. ZREM-claiming guarantees exactly
 *  one instance runs each job. */
export class RedisScheduler {
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly redis: Redis, private readonly onRoomAlarm: (roomId: string) => Promise<void>, private readonly cleanup: CleanupStore) {}

  scheduleRoomAlarm(roomId: string, at: number): void {
    const member = JSON.stringify({ kind: "room-alarm", roomId } satisfies RoomAlarmJob);
    void this.redis.multi().zadd(JOBS_KEY, String(at), member).hdel(RETRIES_KEY, roomId).exec()
      .catch(() => { console.warn("Scheduling room alarm failed"); });
  }

  start(): void {
    this.timers.push(setInterval(() => { void this.poll(); }, 1000));
    this.timers.push(setInterval(() => { void this.maybeRunCleanup(); }, 60_000));
    for (const timer of this.timers) timer.unref();
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private async poll(): Promise<void> {
    let claimed: string[];
    try {
      claimed = await this.redis.eval(CLAIM_LUA, 1, JOBS_KEY, String(Date.now())) as string[];
    } catch { return; }
    for (const raw of claimed) {
      let job: RoomAlarmJob | null = null;
      try {
        job = JSON.parse(raw) as RoomAlarmJob;
        if (job.kind === "room-alarm") await this.onRoomAlarm(job.roomId);
        await this.redis.hdel(RETRIES_KEY, job.roomId);
      } catch (cause) {
        console.warn("Scheduled job failed", cause instanceof Error ? cause.name : "unknown");
        if (job?.kind === "room-alarm") {
          const attempt = await this.redis.hincrby(RETRIES_KEY, job.roomId, 1).catch(() => 1);
          const delay = Math.min(60_000, 1000 * (2 ** Math.min(attempt, 6)));
          // LT preserves a newer, earlier normal schedule if one raced this retry.
          await this.redis.zadd(JOBS_KEY, "LT", String(Date.now() + delay), raw).catch(() => undefined);
        }
      }
    }
  }

  /** Hourly housekeeping; the hour-bucket lock keeps one instance executing it. */
  private async maybeRunCleanup(): Promise<void> {
    const bucket = new Date().toISOString().slice(0, 13);
    const acquired = await this.redis.set(`collab:cron:cleanup:${bucket}`, "1", "PX", 3_600_000, "NX").catch(() => null);
    if (acquired !== "OK") return;
    try {
      await runCleanup(this.cleanup, Date.now());
    } catch (cause) {
      console.warn("Cleanup failed", cause instanceof Error ? cause.name : "unknown");
    }
  }
}
