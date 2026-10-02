import { claimNextApplication, processApplicationScreening } from "./screening.js";
import { sendNextMessage } from "./messaging.js";
import { claimDueInterview, sendDueReminders, startInterviewCall, sweepStuckInterviews } from "./interview.js";

// Vahlay HR background work, all database-queued (no Redis): resume
// screening, approved outbound messages, reminders, and interview calls.
export function startHrWorker(concurrency = 3) {
  let running = 0;
  const screen = async () => {
    while (running < concurrency) {
      const id = await claimNextApplication().catch(() => null);
      if (!id) return;
      running++;
      processApplicationScreening(id)
        .catch((err) => console.error("[hr] screening", (err as Error).message))
        .finally(() => {
          running--;
          void screen();
        });
    }
  };
  setInterval(() => void screen(), 3000);
  void screen();

  let sending = false;
  setInterval(async () => {
    if (sending) return;
    sending = true;
    try {
      for (let i = 0; i < 50 && (await sendNextMessage()); i++);
    } catch (err) {
      console.error("[hr] messages", (err as Error).message);
    } finally {
      sending = false;
    }
  }, 5000);

  let calling = false;
  setInterval(async () => {
    if (calling) return;
    calling = true;
    try {
      await sendDueReminders();
      for (let i = 0; i < 5; i++) {
        const id = await claimDueInterview();
        if (!id) break;
        await startInterviewCall(id);
      }
    } catch (err) {
      console.error("[hr] interviews", (err as Error).message);
    } finally {
      calling = false;
    }
  }, 30_000);

  setInterval(() => void sweepStuckInterviews().catch((err) => console.error("[hr] sweep", (err as Error).message)), 120_000);
}
